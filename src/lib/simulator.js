/*
 * ReproChip — simulador de ELM327 + centralita diésel (Citroën C4 1.6 HDi 92 cv, Bosch EDC17C10).
 * Todos los datos son ficticios. Responde con tramas CAN reales (ISO 15765-4, 11 bit, 500 kbaud),
 * incluidas respuestas multitrama, para probar el driver de punta a punta sin coche.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RCSim = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const h2 = n => n.toString(16).toUpperCase().padStart(2, '0');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const asciiBytes = (s, len) => {
    const out = [];
    for (let i = 0; i < (len || s.length); i++) out.push(i < s.length ? s.charCodeAt(i) : 0x00);
    return out;
  };
  const be16 = v => { const x = clamp(Math.round(v), 0, 0xffff); return [x >> 8, x & 0xff]; };

  function bitmap(base, pids) {
    const b = [0, 0, 0, 0];
    for (const p of pids) {
      const i = p - base - 1;
      if (i >= 0 && i < 32) b[i >> 3] |= 0x80 >> (i & 7);
    }
    return b;
  }

  function encodeDTC(code) {
    const L = 'PCBU'.indexOf(code[0]);
    const d1 = parseInt(code[1], 16);
    const rest = parseInt(code.slice(2), 16);
    return [(L << 6) | (d1 << 4) | (rest >> 8), rest & 0xff];
  }

  const PROTO_DESC = {
    '1': 'SAE J1850 PWM', '2': 'SAE J1850 VPW', '3': 'ISO 9141-2', '4': 'ISO 14230-4 (KWP 5BAUD)',
    '5': 'ISO 14230-4 (KWP FAST)', '6': 'ISO 15765-4 (CAN 11/500)', '7': 'ISO 15765-4 (CAN 29/500)',
    '8': 'ISO 15765-4 (CAN 11/250)', '9': 'ISO 15765-4 (CAN 29/250)'
  };

  class SimEngineECU {
    constructor() {
      this.t0 = Date.now();
      this.last = this.t0;
      this.rpm = 830;
      this.speed = 0;
      this.stored = ['P0299', 'P0101'];
      this.pending = ['P0401'];
      this.permanent = ['P0299'];
      this.mil = true;
      this.kmMil = 137;
      this.kmClear = 2480;
      this.warmups = 41;
      this.vin = 'VF7SIMULADOR00001';
      this.calid = 'SIM_EDC17C10_P01';
      this.cvn = [0x1a, 0x2b, 0x3c, 0x4d];
      this.ecuName = 'ECM-EngineControl';
      this.supported01 = [0x01, 0x04, 0x05, 0x0b, 0x0c, 0x0d, 0x0f, 0x10, 0x1c, 0x1f, 0x20, 0x21, 0x23, 0x2c, 0x30, 0x31, 0x33, 0x40, 0x42, 0x46, 0x49, 0x60, 0x62];
      this.dids = {
        0xf190: this.vin,
        0xf187: 'SIM9678000080',
        0xf188: 'SIM1037000001',
        0xf18a: 'BOSCH',
        0xf18c: 'SIM00012345',
        0xf191: '0281SIM0001',
        0xf194: '1037SIM0001',
        0xf195: 'P01'
      };
    }

    /** Par a plena carga del 1.6 HDi 92 cv simulado: 230 Nm de 1750 a 2500 rpm, 92 cv a 4000 rpm. */
    static torqueAt(rpm) {
      if (rpm < 1750) return Math.max(90, 150 + (rpm - 1250) * 0.16);
      if (rpm < 2500) return 230;
      return 230 - (rpm - 2500) * 0.046;
    }

    state() {
      const now = Date.now();
      const dt = clamp((now - this.last) / 1000, 0, 1);
      this.last = now;
      const t = (now - this.t0) / 1000;
      // Ciclo de 24 s: ralentí, rodando suave en 3.ª, tirón a fondo (~1500 → 4400 rpm), soltar y ralentí.
      const cyc = t % 24;
      let pedal, rpmTarget;
      if (cyc < 6) { pedal = 0; rpmTarget = 830; }
      else if (cyc < 8) { pedal = 18; rpmTarget = 1500; }
      else if (cyc < 18.5) { pedal = 100; rpmTarget = null; }
      else if (cyc < 20.5) { pedal = 15; rpmTarget = 1800; }
      else { pedal = 0; rpmTarget = 830; }
      if (rpmTarget == null) {
        // En 3.ª (≈ 23,8 km/h a 1000 rpm), 1400 kg: el régimen sube según el par del motor y las resistencias.
        const kms = 1 / (42 * 3.6); // m/s por rpm
        for (let s = 0; s < 10; s++) {
          const v = this.rpm * kms;
          const pw = SimEngineECU.torqueAt(this.rpm) * this.rpm * 2 * Math.PI / 60 * 0.85;
          const a = (pw / Math.max(v, 1) - 0.5 * 1.2 * 0.68 * v * v - 0.012 * 1400 * 9.81) / 1400;
          this.rpm = Math.min(4400, this.rpm + (a / kms) * dt / 10);
        }
      } else this.rpm += (rpmTarget - this.rpm) * Math.min(1, dt * 1.6);
      const rpm = this.rpm + (Math.random() - 0.5) * 14;
      if (pedal > 0) this.speed = this.rpm / 42; // en marcha: la velocidad va ligada al régimen
      else this.speed += (0 - this.speed) * Math.min(1, dt * 0.35);
      const baro = 99;
      // Turbo: entra hacia 1300 rpm, plena presión de 2200 a 3500 rpm y cae un poco arriba.
      const curve = rpm < 1300 ? 0 : rpm < 2200 ? (rpm - 1300) / 900 : rpm < 3500 ? 1 : 1 - ((rpm - 3500) / 3000) * 0.3;
      const boost = 118 * curve * Math.pow(pedal / 100, 0.6);
      const map = clamp(baro + boost + (Math.random() - 0.5) * 2, 0, 255);
      return {
        rpm,
        pedal,
        speed: clamp(this.speed, 0, 200),
        map,
        baro,
        maf: 8 + (rpm / 1000) * 6 + (map - baro) * 0.35,
        rail: clamp(280 + pedal * 9 + rpm * 0.06 + (Math.random() - 0.5) * 10, 0, 1800),
        egr: pedal === 0 ? 45 : Math.max(0, 35 - pedal * 0.8),
        load: pedal === 0 ? 18 : 20 + pedal * 0.75,
        torque: pedal === 0 ? 6 : pedal === 100 ? Math.min(100, (SimEngineECU.torqueAt(rpm) / 235) * 100) : Math.min(100, 12 + curve * 86 * Math.pow(pedal / 100, 0.8)),
        coolant: Math.min(89, 45 + t * 0.25),
        iat: 26 + (map - baro) * 0.05,
        amb: 14,
        volt: 14.1 + (Math.random() - 0.5) * 0.1,
        runtime: Math.floor(t) + 12
      };
    }

    dtcPayload(list) {
      const out = [list.length];
      for (const c of list) out.push(...encodeDTC(c));
      return out;
    }

    mode01(pids) {
      const s = this.state();
      const out = [0x41];
      for (const pid of pids) {
        let d = null;
        switch (pid) {
          case 0x00: d = bitmap(0x00, this.supported01); break;
          case 0x20: d = bitmap(0x20, this.supported01); break;
          case 0x40: d = bitmap(0x40, this.supported01); break;
          case 0x60: d = bitmap(0x60, this.supported01); break;
          case 0x01: d = [(this.mil ? 0x80 : 0) | this.stored.length, 0x0d, 0x00, 0x00]; break;
          case 0x04: d = [Math.round((s.load * 255) / 100)]; break;
          case 0x05: d = [Math.round(s.coolant + 40)]; break;
          case 0x0b: d = [Math.round(s.map)]; break;
          case 0x0c: d = be16(s.rpm * 4); break;
          case 0x0d: d = [Math.round(s.speed)]; break;
          case 0x0f: d = [Math.round(s.iat + 40)]; break;
          case 0x10: d = be16(s.maf * 100); break;
          case 0x1c: d = [0x06]; break;
          case 0x1f: d = be16(s.runtime); break;
          case 0x21: d = be16(this.kmMil); break;
          case 0x23: d = be16(s.rail * 10); break;
          case 0x2c: d = [Math.round((s.egr * 255) / 100)]; break;
          case 0x30: d = [this.warmups]; break;
          case 0x31: d = be16(this.kmClear); break;
          case 0x33: d = [s.baro]; break;
          case 0x42: d = be16(s.volt * 1000); break;
          case 0x46: d = [s.amb + 40]; break;
          case 0x49: d = [Math.round((s.pedal * 255) / 100)]; break;
          case 0x62: d = [Math.round(s.torque + 125)]; break;
          default: d = null;
        }
        if (d) out.push(pid, ...d);
      }
      return out.length > 1 ? out : null;
    }

    mode09(pid) {
      switch (pid) {
        case 0x00: return [0x49, 0x00, ...bitmap(0x00, [0x02, 0x04, 0x06, 0x0a])];
        case 0x02: return [0x49, 0x02, 0x01, ...asciiBytes(this.vin)];
        case 0x04: return [0x49, 0x04, 0x01, ...asciiBytes(this.calid, 16)];
        case 0x06: return [0x49, 0x06, 0x01, ...this.cvn];
        case 0x0a: return [0x49, 0x0a, 0x01, ...asciiBytes(this.ecuName, 20)];
        default: return null;
      }
    }

    respond(req) {
      const sid = req[0];
      switch (sid) {
        case 0x01: return this.mode01(req.slice(1, 7));
        case 0x03: return [0x43, ...this.dtcPayload(this.stored)];
        case 0x07: return [0x47, ...this.dtcPayload(this.pending)];
        case 0x0a: return [0x4a, ...this.dtcPayload(this.permanent)];
        case 0x04:
          this.stored = [];
          this.pending = [];
          this.mil = false;
          this.kmMil = 0;
          this.kmClear = 0;
          this.warmups = 0;
          return [0x44];
        case 0x09: return this.mode09(req[1]);
        case 0x22: {
          const did = (req[1] << 8) | req[2];
          const v = this.dids[did];
          if (!v) return [0x7f, 0x22, 0x31];
          return [0x62, req[1], req[2], ...asciiBytes(v)];
        }
        case 0x10:
          if (req[1] === 0x01 || req[1] === 0x03) return [0x50, req[1], 0x00, 0x32, 0x01, 0xf4];
          return [0x7f, 0x10, 0x22];
        case 0x3e: return [0x7e, 0x00];
        default: return [0x7f, sid, 0x11];
      }
    }
  }

  class ELMSimulator {
    constructor() {
      this.ecu = new SimEngineECU();
      this.reset();
    }

    reset() {
      this.echo = true;
      this.lf = false;
      this.spaces = true;
      this.headers = false;
      this.protoSetting = '0';
      this.active = null;
      this.header = null;
    }

    delayFor(cmd) {
      const c = cmd.replace(/\s+/g, '').toUpperCase();
      if (c === 'ATZ') return 350;
      if (c.startsWith('AT') || c.startsWith('ST')) return 6;
      return 25 + Math.random() * 25;
    }

    handle(cmdRaw) {
      const cmd = String(cmdRaw).replace(/\s+/g, '').toUpperCase();
      let body;
      if (!cmd) body = '';
      else if (cmd.startsWith('AT')) body = this.at(cmd.slice(2));
      else if (cmd.startsWith('ST')) body = '?';
      else if (/^[0-9A-F]+$/.test(cmd) && cmd.length % 2 === 0) body = this.obd(cmd);
      else body = '?';
      const eol = this.lf ? '\r\n' : '\r';
      return (this.echo ? cmdRaw + eol : '') + body.split('\n').join(eol) + eol + eol + '>';
    }

    at(c) {
      let m;
      if (c === 'Z') { this.reset(); return '\nELM327 v1.5'; }
      if (c === 'WS') { this.reset(); return '\nELM327 v1.5'; }
      if (c === 'D') { this.reset(); return 'OK'; }
      if (c === 'I') return 'ELM327 v1.5';
      if (c === '@1') return 'OBDII to RS232 Interpreter (simulador ReproChip)';
      if ((m = c.match(/^E([01])$/))) { this.echo = m[1] === '1'; return 'OK'; }
      if ((m = c.match(/^L([01])$/))) { this.lf = m[1] === '1'; return 'OK'; }
      if ((m = c.match(/^S([01])$/))) { this.spaces = m[1] === '1'; return 'OK'; }
      if ((m = c.match(/^H([01])$/))) { this.headers = m[1] === '1'; return 'OK'; }
      if (/^AT[012]$/.test(c)) return 'OK';
      if ((m = c.match(/^(?:SP|TP)A?([0-9A-C])$/))) {
        this.protoSetting = m[1];
        this.active = m[1] === '0' ? null : m[1];
        return 'OK';
      }
      if (c === 'DP') {
        if (!this.active) return 'AUTO';
        return (this.protoSetting === '0' ? 'AUTO, ' : '') + (PROTO_DESC[this.active] || this.active);
      }
      if (c === 'DPN') {
        if (!this.active) return 'A0';
        return (this.protoSetting === '0' ? 'A' : '') + this.active;
      }
      if (c === 'RV') {
        const running = !!this.active;
        return ((running ? 14.1 : 12.5) + (Math.random() - 0.5) * 0.2).toFixed(1) + 'V';
      }
      if ((m = c.match(/^SH([0-9A-F]{3}|[0-9A-F]{6})$/))) { this.header = m[1]; return 'OK'; }
      if (/^(CAF[01]|CRA.*|ST[0-9A-F]{2}|CP[0-9A-F]{2}|PC|M[01]|CFC[01]|AL|NL|R[01]|BI|FE|MA)$/.test(c)) return 'OK';
      return '?';
    }

    obd(cmd) {
      let prefix = '';
      if (!this.active) {
        prefix = 'SEARCHING...\n';
        this.active = '6';
      }
      if (this.active !== '6') {
        if (['3', '4', '5'].includes(this.active)) return prefix + 'BUS INIT: ...ERROR';
        if (['8', '9'].includes(this.active)) return prefix + 'CAN ERROR';
        return prefix + 'NO DATA';
      }
      const target = this.header || '7DF';
      if (target !== '7DF' && target !== '7E0') return prefix + 'NO DATA';
      const bytes = [];
      for (let i = 0; i < cmd.length; i += 2) bytes.push(parseInt(cmd.substr(i, 2), 16));
      const payload = this.ecu.respond(bytes);
      if (!payload) return prefix + 'NO DATA';
      return prefix + this.formatCAN('7E8', payload);
    }

    formatCAN(header, payload) {
      const sep = this.spaces ? ' ' : '';
      const frames = [];
      if (payload.length <= 7) frames.push([payload.length, ...payload]);
      else {
        frames.push([0x10 | (payload.length >> 8), payload.length & 0xff, ...payload.slice(0, 6)]);
        let seq = 1;
        for (let i = 6; i < payload.length; i += 7) {
          frames.push([0x20 | (seq & 0x0f), ...payload.slice(i, i + 7)]);
          seq++;
        }
      }
      frames.forEach(f => { while (f.length < 8) f.push(0x00); });
      if (this.headers) return frames.map(f => header + sep + f.map(h2).join(sep)).join('\n');
      if (payload.length <= 7) return payload.map(h2).join(sep);
      const lines = [payload.length.toString(16).toUpperCase().padStart(3, '0')];
      lines.push('0:' + sep + payload.slice(0, 6).map(h2).join(sep));
      let seq = 1;
      for (let i = 6; i < payload.length; i += 7) {
        lines.push((seq & 0x0f).toString(16).toUpperCase() + ':' + sep + payload.slice(i, i + 7).map(h2).join(sep));
        seq++;
      }
      return lines.join('\n');
    }
  }

  return { ELMSimulator, SimEngineECU };
});
