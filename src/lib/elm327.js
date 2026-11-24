/*
 * ReproChip — driver ELM327 / STN (OBDLink).
 * Envía comandos, espera el prompt '>' y convierte las respuestas en mensajes por centralita.
 * Funciona con cualquier transporte que tenga: write(str), onData = fn(str), close().
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RCELM = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class ELMError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  const PROTOCOLS = {
    '0': 'Automático',
    '1': 'SAE J1850 PWM',
    '2': 'SAE J1850 VPW',
    '3': 'ISO 9141-2',
    '4': 'ISO 14230-4 KWP (inicio 5 baudios)',
    '5': 'ISO 14230-4 KWP (inicio rápido)',
    '6': 'ISO 15765-4 CAN (11 bit, 500 kbaud)',
    '7': 'ISO 15765-4 CAN (29 bit, 500 kbaud)',
    '8': 'ISO 15765-4 CAN (11 bit, 250 kbaud)',
    '9': 'ISO 15765-4 CAN (29 bit, 250 kbaud)',
    'A': 'SAE J1939 CAN'
  };

  const ERRORS = [
    [/^NO DATA/i, 'NO_DATA', 'La centralita no respondió (NO DATA).'],
    [/UNABLE TO CONNECT/i, 'UNABLE', 'No se pudo comunicar con el vehículo. Comprueba que el contacto está puesto.'],
    [/^CAN ERROR/i, 'CAN_ERROR', 'Error en el bus CAN (¿protocolo o velocidad incorrectos?).'],
    [/BUS INIT.*ERROR/i, 'BUS_INIT', 'Falló la inicialización del bus K-Line.'],
    [/^BUS ERROR/i, 'BUS_ERROR', 'Error en el bus de diagnóstico.'],
    [/^BUS BUSY/i, 'BUS_BUSY', 'Bus ocupado.'],
    [/^FB ERROR/i, 'FB_ERROR', 'Error de retroalimentación en el bus.'],
    [/^DATA ERROR/i, 'DATA_ERROR', 'Datos con error de comprobación.'],
    [/^BUFFER FULL/i, 'BUFFER_FULL', 'El búfer del adaptador se llenó.'],
    [/^STOPPED/i, 'STOPPED', 'El adaptador interrumpió la petición.'],
    [/^<RX ERROR/i, 'RX_ERROR', 'Error de recepción.'],
    [/^ERR\d+/i, 'ERR', 'Error interno del adaptador.'],
    [/^(ACT ALERT|LV RESET|LP ALERT)/i, 'ALERT', 'El adaptador se ha reiniciado o ha entrado en reposo.'],
    [/^\?$/, 'UNKNOWN_CMD', 'Comando no reconocido por el adaptador.']
  ];

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const hex2 = n => n.toString(16).toUpperCase().padStart(2, '0');

  function isCANProtocol(p) {
    return ['6', '7', '8', '9'].includes(String(p || '').toUpperCase());
  }
  function is29bit(p) {
    return ['7', '9'].includes(String(p || '').toUpperCase());
  }

  /** Limpia la respuesta en bruto: quita eco, prompt, "SEARCHING..." y líneas vacías. */
  function cleanLines(raw, cmd) {
    const norm = s => s.replace(/\s+/g, '').toUpperCase();
    const c = cmd ? norm(cmd) : null;
    return String(raw || '')
      .replace(/>/g, '')
      .split(/[\r\n]+/)
      .map(l => l.replace(/\0/g, '').trim())
      .filter(l => l.length > 0)
      .filter(l => !(c && norm(l) === c))
      .map(l => l.replace(/^SEARCHING\.\.\.\s*/i, '').replace(/^BUS INIT:\s*\.*\s*OK\s*/i, ''))
      .filter(l => l.length > 0);
  }

  function isDataLine(l) {
    return /^[0-9A-F\s]+$/i.test(l) && l.replace(/\s+/g, '').length >= 4;
  }

  function findError(lines) {
    if (lines.some(isDataLine)) return null;
    for (const l of lines) {
      for (const [re, code, msg] of ERRORS) {
        if (re.test(l)) return new ELMError(code, msg);
      }
    }
    return null;
  }

  function hexToBytes(h) {
    const out = [];
    for (let i = 0; i + 1 < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16));
    return out;
  }

  /**
   * Convierte líneas con cabeceras (ATH1) en mensajes completos.
   * CAN: reensambla ISO-TP (tramas simple, primera y consecutivas) por centralita.
   * K-Line/J1850: cabecera de 3 bytes + datos + checksum.
   * Devuelve [{ ecu: '7E8', data: [bytes], complete: bool }].
   */
  function parseFrames(lines, protocol) {
    const can = isCANProtocol(protocol);
    const long = is29bit(protocol);
    const messages = [];
    const current = {};
    for (const line of lines) {
      if (!isDataLine(line)) continue;
      const hx = line.replace(/\s+/g, '').toUpperCase();
      if (can) {
        const hlen = long ? 8 : 3;
        if (hx.length < hlen + 2) continue;
        const ecu = hx.slice(0, hlen);
        const b = hexToBytes(hx.slice(hlen));
        if (!b.length) continue;
        const type = b[0] >> 4;
        if (type === 0) {
          const len = b[0] & 0x0f;
          messages.push({ ecu, data: b.slice(1, 1 + len), complete: b.length - 1 >= len });
          delete current[ecu];
        } else if (type === 1) {
          const len = ((b[0] & 0x0f) << 8) | b[1];
          const msg = { ecu, data: b.slice(2), len, complete: false, nextSeq: 1 };
          messages.push(msg);
          current[ecu] = msg;
        } else if (type === 2) {
          const msg = current[ecu];
          if (!msg) continue;
          msg.data.push(...b.slice(1));
          if (msg.data.length >= msg.len) {
            msg.data = msg.data.slice(0, msg.len);
            msg.complete = true;
            delete current[ecu];
          }
        }
        // type 3 = control de flujo: se ignora
      } else {
        const b = hexToBytes(hx);
        if (b.length < 4) continue;
        messages.push({ ecu: hex2(b[2]), data: b.slice(3, -1), complete: true });
      }
    }
    for (const m of messages) { delete m.len; delete m.nextSeq; }
    return messages;
  }

  class ELM327 {
    constructor(transport, opts = {}) {
      this.t = transport;
      this.log = opts.log || (() => {});
      this.buffer = '';
      this.pending = null;
      this.queue = Promise.resolve();
      this.protocol = null;
      this.version = '';
      this.closed = false;
      this.t.onData = s => this._onData(s);
    }

    get isCAN() { return isCANProtocol(this.protocol); }
    get is29bit() { return is29bit(this.protocol); }

    _onData(s) {
      this.buffer += s;
      if (!this.pending) return;
      const idx = this.buffer.indexOf('>');
      if (idx < 0) return;
      const resp = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.resolve(resp);
    }

    /** Envía un comando en bruto y devuelve el texto hasta el prompt '>'. Las peticiones van en cola. */
    send(cmd, timeout = 4000) {
      const run = () => new Promise((resolve, reject) => {
        if (this.closed) { reject(new ELMError('CLOSED', 'La conexión está cerrada.')); return; }
        this.buffer = '';
        const timer = setTimeout(() => {
          this.pending = null;
          reject(new ELMError('TIMEOUT', 'Sin respuesta del adaptador a "' + cmd + '".'));
        }, timeout);
        this.pending = { resolve, reject, timer };
        this.log('tx', cmd, cmd);
        Promise.resolve()
          .then(() => this.t.write(cmd + '\r'))
          .catch(err => {
            clearTimeout(timer);
            this.pending = null;
            reject(err);
          });
      }).then(raw => {
        this.log('rx', raw, cmd);
        return raw;
      });
      const p = this.queue.then(run, run);
      this.queue = p.catch(() => {});
      return p;
    }

    /** Comando AT: devuelve las líneas limpias unidas. */
    async at(cmd, timeout = 2500) {
      const raw = await this.send(cmd, timeout);
      return cleanLines(raw, cmd).join('\n');
    }

    /** Comprueba si al otro lado hay un ELM327 (se usa para detectar la velocidad del puerto). */
    async probe(timeout = 1200) {
      // Dos intentos: el primero puede recoger restos de basura del puerto.
      for (let i = 0; i < 2; i++) {
        try {
          const raw = await this.send('ATI', timeout);
          if (/ELM|STN|OBD/i.test(raw)) return cleanLines(raw, 'ATI').join(' ');
        } catch (_) {
          if (i === 1) return null;
        }
      }
      return null;
    }

    /** Petición OBD/UDS en hexadecimal. Devuelve mensajes por centralita. */
    async request(hex, timeout = 5000) {
      const raw = await this.send(hex, timeout);
      const lines = cleanLines(raw, hex);
      const err = findError(lines);
      if (err) throw err;
      return parseFrames(lines, this.protocol);
    }

    async setHeader(h) {
      const r = await this.at('ATSH' + h);
      if (!/OK/i.test(r)) throw new ELMError('HEADER', 'El adaptador no aceptó la cabecera ' + h);
    }

    /** Inicializa el adaptador y detecta el protocolo del coche. */
    async init(opts = {}) {
      const step = opts.onStep || (() => {});
      const protocol = String(opts.protocol || '0').toUpperCase();

      step('Reiniciando adaptador (ATZ)…');
      let z = '';
      try { z = await this.send('ATZ', 5000); } catch (_) { /* algunos clones no responden a ATZ */ }
      await sleep(250);
      const zl = cleanLines(z, 'ATZ').find(l => /ELM|STN|OBD/i.test(l));
      this.version = zl || (await this.at('ATI').catch(() => '')) || 'desconocido';
      step('Adaptador: ' + this.version);

      for (const c of ['ATE0', 'ATL0', 'ATS1', 'ATH1', 'ATAT1']) {
        const r = await this.at(c).catch(() => '');
        if (!/OK/i.test(r) && c !== 'ATAT1') step('Aviso: el adaptador no confirmó ' + c);
      }

      this.stn = '';
      try {
        const sti = await this.at('STI', 1200);
        if (sti && !/\?/.test(sti)) this.stn = sti;
      } catch (_) {}
      if (this.stn) step('Chip STN detectado: ' + this.stn);

      await this.at('ATSP' + protocol);
      try { this.voltage = await this.at('ATRV'); } catch (_) { this.voltage = ''; }
      if (this.voltage) step('Tensión de batería: ' + this.voltage);

      step(protocol === '0' ? 'Buscando el protocolo del vehículo (puede tardar unos segundos)…' : 'Probando ' + (PROTOCOLS[protocol] || protocol) + '…');
      const raw = await this.send('0100', 20000);
      const lines = cleanLines(raw, '0100');
      const err = findError(lines);
      if (err) throw err;

      const dpn = await this.at('ATDPN').catch(() => protocol);
      this.protocol = dpn.replace(/^A/i, '').trim().toUpperCase() || protocol;
      this.protocolName = PROTOCOLS[this.protocol] || dpn;
      const msgs = parseFrames(lines, this.protocol);
      this.ecus = [...new Set(msgs.map(m => m.ecu))];
      step('Protocolo: ' + this.protocolName);
      step('Centralitas que responden: ' + (this.ecus.join(', ') || 'ninguna'));
      return {
        version: this.version,
        stn: this.stn,
        voltage: this.voltage,
        protocol: this.protocol,
        protocolName: this.protocolName,
        ecus: this.ecus
      };
    }

    async close() {
      this.closed = true;
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        clearTimeout(p.timer);
        p.reject(new ELMError('CLOSED', 'La conexión se ha cerrado.'));
      }
      try { await this.t.close(); } catch (_) {}
    }
  }

  return { ELM327, ELMError, PROTOCOLS, cleanLines, parseFrames, findError, isCANProtocol };
});
