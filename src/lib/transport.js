/*
 * ReproChip — transportes hacia el adaptador.
 *  - WebSerialTransport: USB y Bluetooth clásico (puerto COM / /dev/cu.*) vía Web Serial.
 *  - TcpTransport: adaptadores WiFi, a través del proceso principal de Electron.
 *  - SimTransport: simulador integrado, para probar sin coche.
 * Interfaz común: open(), write(str), close(), onData = fn(str), onClose = fn(motivo).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RCTransport = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const bytesToStr = u8 => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return s; };
  const strToBytes = s => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff; return u; };

  class WebSerialTransport {
    constructor() {
      this.port = null;
      this.reader = null;
      this.writer = null;
      this.loop = null;
      this.onData = null;
      this.onClose = null;
      this.baudRate = null;
      this.label = 'Puerto serie';
    }

    static isAvailable() {
      return typeof navigator !== 'undefined' && !!navigator.serial;
    }

    /** Debe llamarse directamente desde un clic del usuario. */
    async requestPort() {
      this.port = await navigator.serial.requestPort();
      const info = this.port.getInfo ? this.port.getInfo() : {};
      if (info.usbVendorId) this.label = 'USB ' + info.usbVendorId.toString(16).padStart(4, '0') + ':' + (info.usbProductId || 0).toString(16).padStart(4, '0');
      else if (info.bluetoothServiceClassId) this.label = 'Bluetooth';
    }

    async open(baudRate) {
      if (!this.port) throw new Error('No se ha elegido ningún puerto.');
      this.closing = false;
      this.baudRate = baudRate;
      await this.port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 8192 });
      this.writer = this.port.writable.getWriter();
      this.reader = this.port.readable.getReader();
      this.loop = this._readLoop();
    }

    async _readLoop() {
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value && value.length && this.onData) this.onData(bytesToStr(value));
        }
      } catch (e) {
        if (!this.closing && this.onClose) this.onClose('Se perdió la conexión con el adaptador (' + e.message + ')');
      } finally {
        try { this.reader.releaseLock(); } catch (_) {}
      }
    }

    async write(str) {
      if (!this.writer) throw new Error('Puerto cerrado');
      await this.writer.write(strToBytes(str));
    }

    async close() {
      this.closing = true;
      try { if (this.reader) await this.reader.cancel(); } catch (_) {}
      try { if (this.loop) await this.loop; } catch (_) {}
      try { if (this.writer) { this.writer.releaseLock(); } } catch (_) {}
      try { await this.port.close(); } catch (_) {}
      this.reader = null;
      this.writer = null;
      this.loop = null;
    }
  }

  /** WiFi: el socket vive en el proceso principal (los navegadores no abren TCP). */
  class TcpTransport {
    constructor(bridge) {
      if (!bridge || !bridge.tcp) throw new Error('La conexión WiFi solo funciona en la app de escritorio.');
      this.bridge = bridge;
      this.onData = null;
      this.onClose = null;
      this.label = 'WiFi';
      if (!TcpTransport._wired) {
        TcpTransport._wired = true;
        bridge.tcp.onData(d => { if (TcpTransport.active && TcpTransport.active.onData) TcpTransport.active.onData(d); });
        bridge.tcp.onClosed(m => {
          const a = TcpTransport.active;
          if (a && !a.closing && a.onClose) a.onClose(m || 'Conexión WiFi cerrada');
        });
      }
    }

    async open(host, port) {
      this.closing = false;
      TcpTransport.active = this;
      this.label = 'WiFi ' + host + ':' + port;
      await this.bridge.tcp.connect(host, port);
    }

    write(str) { return this.bridge.tcp.write(str); }

    async close() {
      this.closing = true;
      await this.bridge.tcp.close();
      if (TcpTransport.active === this) TcpTransport.active = null;
    }
  }

  class SimTransport {
    constructor(simulator) {
      this.sim = simulator;
      this.onData = null;
      this.onClose = null;
      this.label = 'Simulador';
      this.buf = '';
      this.opened = false;
    }

    async open() { this.opened = true; }

    write(str) {
      if (!this.opened) throw new Error('Simulador cerrado');
      this.buf += str;
      let idx;
      while ((idx = this.buf.indexOf('\r')) >= 0) {
        const cmd = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        const resp = this.sim.handle(cmd);
        const delay = this.sim.delayFor(cmd);
        setTimeout(() => {
          if (!this.opened || !this.onData) return;
          // Se entrega en dos trozos, como haría un puerto real.
          const cut = Math.floor(resp.length / 2);
          this.onData(resp.slice(0, cut));
          this.onData(resp.slice(cut));
        }, delay);
      }
    }

    async close() { this.opened = false; }
  }

  return { WebSerialTransport, TcpTransport, SimTransport, bytesToStr, strToBytes };
});
