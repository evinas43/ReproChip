/*
 * ReproChip — capa OBD-II / EOBD y lecturas UDS de solo lectura.
 * Modo 01 (datos en vivo), 03/07/0A (averías), 04 (borrado), 09 (VIN, Calibration ID, CVN),
 * UDS 0x22 (identificación de la centralita). Incluye el bloqueo de solo lectura del terminal.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RCOBD = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const hx = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');
  const u16 = b => (b[0] << 8) | b[1];
  const pct = a => (a * 100) / 255;

  /* ---------------- PIDs del modo 01 ---------------- */
  const PIDS = {
    0x04: { name: 'Carga calculada del motor', short: 'Carga', unit: '%', dec: 0, decode: b => pct(b[0]) },
    0x05: { name: 'Temperatura del refrigerante', short: 'Refrigerante', unit: '°C', dec: 0, decode: b => b[0] - 40 },
    0x0B: { name: 'Presión absoluta del colector (MAP)', short: 'MAP', unit: 'kPa', dec: 0, decode: b => b[0] },
    0x0C: { name: 'Régimen del motor', short: 'RPM', unit: 'rpm', dec: 0, decode: b => u16(b) / 4 },
    0x0D: { name: 'Velocidad del vehículo', short: 'Velocidad', unit: 'km/h', dec: 0, decode: b => b[0] },
    0x0F: { name: 'Temperatura del aire de admisión', short: 'Aire admisión', unit: '°C', dec: 0, decode: b => b[0] - 40 },
    0x10: { name: 'Caudal de aire (MAF)', short: 'MAF', unit: 'g/s', dec: 1, decode: b => u16(b) / 100 },
    0x11: { name: 'Posición de la mariposa', short: 'Mariposa', unit: '%', dec: 0, decode: b => pct(b[0]) },
    0x1F: { name: 'Tiempo desde el arranque', short: 'Tiempo arranque', unit: 's', dec: 0, decode: b => u16(b) },
    0x21: { name: 'Distancia con testigo de avería encendido', short: 'Km con MIL', unit: 'km', dec: 0, decode: b => u16(b) },
    0x22: { name: 'Presión del rail (relativa a vacío)', short: 'Rail (rel.)', unit: 'kPa', dec: 0, decode: b => u16(b) * 0.079 },
    0x23: { name: 'Presión del rail de combustible', short: 'Presión rail', unit: 'bar', dec: 0, decode: b => u16(b) / 10 },
    0x2C: { name: 'EGR comandada', short: 'EGR', unit: '%', dec: 0, decode: b => pct(b[0]) },
    0x2D: { name: 'Error de la EGR', short: 'Error EGR', unit: '%', dec: 0, decode: b => (b[0] * 100) / 128 - 100 },
    0x2F: { name: 'Nivel de combustible', short: 'Combustible', unit: '%', dec: 0, decode: b => pct(b[0]) },
    0x30: { name: 'Calentamientos desde el borrado', short: 'Calentamientos', unit: '', dec: 0, decode: b => b[0] },
    0x31: { name: 'Distancia desde el borrado de averías', short: 'Km desde borrado', unit: 'km', dec: 0, decode: b => u16(b) },
    0x33: { name: 'Presión barométrica', short: 'Barométrica', unit: 'kPa', dec: 0, decode: b => b[0] },
    0x42: { name: 'Tensión del módulo de control', short: 'Tensión ECU', unit: 'V', dec: 2, decode: b => u16(b) / 1000 },
    0x43: { name: 'Carga absoluta', short: 'Carga abs.', unit: '%', dec: 0, decode: b => (u16(b) * 100) / 255 },
    0x46: { name: 'Temperatura ambiente', short: 'Ambiente', unit: '°C', dec: 0, decode: b => b[0] - 40 },
    0x49: { name: 'Posición del pedal del acelerador D', short: 'Pedal', unit: '%', dec: 0, decode: b => pct(b[0]) },
    0x4A: { name: 'Posición del pedal del acelerador E', short: 'Pedal E', unit: '%', dec: 0, decode: b => pct(b[0]) },
    0x4C: { name: 'Mariposa comandada', short: 'Mariposa cmd.', unit: '%', dec: 0, decode: b => pct(b[0]) },
    0x5C: { name: 'Temperatura del aceite', short: 'Aceite', unit: '°C', dec: 0, decode: b => b[0] - 40 },
    0x5E: { name: 'Consumo de combustible', short: 'Consumo', unit: 'L/h', dec: 1, decode: b => u16(b) / 20 },
    0x61: { name: 'Par solicitado por el conductor', short: 'Par pedido', unit: '%', dec: 0, decode: b => b[0] - 125 },
    0x62: { name: 'Par real del motor', short: 'Par real', unit: '%', dec: 0, decode: b => b[0] - 125 },
    0x63: { name: 'Par de referencia del motor', short: 'Par ref.', unit: 'Nm', dec: 0, decode: b => u16(b) }
  };

  /** Valores por defecto para un diésel common-rail como el 1.6 HDi. */
  const DEFAULT_LIVE = [0x0C, 0x0B, 0x10, 0x23, 0x49, 0x04, 0x05, 0x0F, 0x2C, 0x0D, 0x42];

  /* ---------------- Averías ---------------- */
  function decodeDTC(hi, lo) {
    const letter = 'PCBU'[hi >> 6];
    const d1 = (hi >> 4) & 0x03;
    return letter + d1 + hx(hi & 0x0f, 1) + hx(lo);
  }

  const DTC_ES = {
    P0001: 'Regulador de caudal de combustible: circuito abierto',
    P0002: 'Regulador de caudal de combustible: rango/funcionamiento',
    P0003: 'Regulador de caudal de combustible: señal baja',
    P0004: 'Regulador de caudal de combustible: señal alta',
    P0087: 'Presión del rail demasiado baja',
    P0088: 'Presión del rail demasiado alta',
    P0089: 'Regulador de presión de combustible: funcionamiento',
    P0090: 'Regulador de presión de combustible: circuito',
    P0093: 'Fuga de combustible importante detectada',
    P0100: 'Caudalímetro (MAF): circuito',
    P0101: 'Caudalímetro (MAF): rango/funcionamiento',
    P0102: 'Caudalímetro (MAF): señal baja',
    P0103: 'Caudalímetro (MAF): señal alta',
    P0105: 'Sensor de presión del colector (MAP): circuito',
    P0106: 'Sensor MAP/barométrico: rango/funcionamiento',
    P0107: 'Sensor MAP/barométrico: señal baja',
    P0108: 'Sensor MAP/barométrico: señal alta',
    P0110: 'Sensor de temperatura del aire de admisión: circuito',
    P0112: 'Sensor de temperatura del aire de admisión: señal baja',
    P0113: 'Sensor de temperatura del aire de admisión: señal alta',
    P0115: 'Sensor de temperatura del refrigerante: circuito',
    P0116: 'Sensor de temperatura del refrigerante: rango/funcionamiento',
    P0117: 'Sensor de temperatura del refrigerante: señal baja',
    P0118: 'Sensor de temperatura del refrigerante: señal alta',
    P0120: 'Sensor de posición del pedal/mariposa A: circuito',
    P0180: 'Sensor de temperatura del combustible: circuito',
    P0190: 'Sensor de presión del rail: circuito',
    P0191: 'Sensor de presión del rail: rango/funcionamiento',
    P0192: 'Sensor de presión del rail: señal baja',
    P0193: 'Sensor de presión del rail: señal alta',
    P0200: 'Inyectores: circuito',
    P0201: 'Inyector cilindro 1: circuito',
    P0202: 'Inyector cilindro 2: circuito',
    P0203: 'Inyector cilindro 3: circuito',
    P0204: 'Inyector cilindro 4: circuito',
    P0219: 'Sobrerrégimen del motor',
    P0225: 'Sensor de posición del pedal C: circuito',
    P0234: 'Sobrealimentación excesiva del turbo',
    P0235: 'Sensor de presión de sobrealimentación: circuito',
    P0236: 'Sensor de presión de sobrealimentación: rango/funcionamiento',
    P0237: 'Sensor de presión de sobrealimentación: señal baja',
    P0238: 'Sensor de presión de sobrealimentación: señal alta',
    P0243: 'Electroválvula de regulación del turbo: circuito',
    P0245: 'Electroválvula de regulación del turbo: señal baja',
    P0246: 'Electroválvula de regulación del turbo: señal alta',
    P0263: 'Cilindro 1: contribución/equilibrado',
    P0266: 'Cilindro 2: contribución/equilibrado',
    P0269: 'Cilindro 3: contribución/equilibrado',
    P0272: 'Cilindro 4: contribución/equilibrado',
    P0299: 'Sobrealimentación insuficiente del turbo',
    P0335: 'Sensor de posición del cigüeñal: circuito',
    P0336: 'Sensor de posición del cigüeñal: rango/funcionamiento',
    P0340: 'Sensor de posición del árbol de levas: circuito',
    P0341: 'Sensor de posición del árbol de levas: rango/funcionamiento',
    P0380: 'Bujías de precalentamiento: circuito A',
    P0382: 'Bujías de precalentamiento: circuito B',
    P0400: 'Recirculación de gases (EGR): caudal',
    P0401: 'EGR: caudal insuficiente',
    P0402: 'EGR: caudal excesivo',
    P0403: 'EGR: circuito de control',
    P0404: 'EGR: rango/funcionamiento',
    P0405: 'Sensor de posición de la EGR: señal baja',
    P0406: 'Sensor de posición de la EGR: señal alta',
    P0420: 'Catalizador: eficiencia por debajo del umbral',
    P0470: 'Sensor de presión de escape: circuito',
    P0471: 'Sensor de presión de escape: rango/funcionamiento',
    P0472: 'Sensor de presión de escape: señal baja',
    P0473: 'Sensor de presión de escape: señal alta',
    P0480: 'Ventilador de refrigeración 1: circuito',
    P0500: 'Sensor de velocidad del vehículo',
    P0504: 'Interruptor del pedal de freno: correlación A/B',
    P0560: 'Tensión del sistema',
    P0562: 'Tensión del sistema baja',
    P0563: 'Tensión del sistema alta',
    P0571: 'Interruptor de freno A: circuito',
    P0600: 'Enlace de comunicación serie',
    P0601: 'Memoria de la centralita: error de checksum',
    P0602: 'Centralita: error de programación',
    P0603: 'Memoria KAM de la centralita',
    P0604: 'Memoria RAM de la centralita',
    P0605: 'Memoria ROM de la centralita',
    P0606: 'Procesador de la centralita',
    P0607: 'Funcionamiento del módulo de control',
    P0627: 'Bomba de combustible: circuito de control',
    P0641: 'Tensión de referencia de sensores A',
    P0651: 'Tensión de referencia de sensores B',
    P0670: 'Módulo de precalentamiento: circuito',
    P0671: 'Bujía de precalentamiento cilindro 1',
    P0672: 'Bujía de precalentamiento cilindro 2',
    P0673: 'Bujía de precalentamiento cilindro 3',
    P0674: 'Bujía de precalentamiento cilindro 4',
    P0683: 'Comunicación módulo de precalentamiento – centralita',
    P0700: 'Sistema de control de la transmisión',
    P2002: 'Filtro de partículas (FAP/DPF): eficiencia por debajo del umbral',
    P2031: 'Sensor de temperatura de escape 2: circuito',
    P2032: 'Sensor de temperatura de escape 2: señal baja',
    P2033: 'Sensor de temperatura de escape 2: señal alta',
    P2135: 'Correlación sensores de posición del pedal/mariposa A/B',
    P2138: 'Correlación sensores de posición del pedal D/E',
    P2146: 'Inyectores grupo A: circuito de alimentación',
    P2149: 'Inyectores grupo B: circuito de alimentación',
    P2263: 'Sistema de sobrealimentación: funcionamiento',
    P242F: 'Filtro de partículas: restricción por acumulación de ceniza',
    P2452: 'Sensor de presión diferencial del FAP: circuito',
    P2453: 'Sensor de presión diferencial del FAP: rango/funcionamiento',
    P2454: 'Sensor de presión diferencial del FAP: señal baja',
    P2455: 'Sensor de presión diferencial del FAP: señal alta',
    P2458: 'Filtro de partículas: duración de la regeneración',
    P2463: 'Filtro de partículas: acumulación de hollín',
    P2563: 'Sensor de posición del turbo: rango/funcionamiento',
    U0001: 'Bus CAN de alta velocidad',
    U0100: 'Pérdida de comunicación con la centralita del motor',
    U0101: 'Pérdida de comunicación con la caja de cambios',
    U0121: 'Pérdida de comunicación con el ABS',
    U0140: 'Pérdida de comunicación con la BSI (caja de servicio inteligente)',
    U0155: 'Pérdida de comunicación con el cuadro de instrumentos'
  };

  function dtcCategory(code) {
    const L = code[0];
    const d = code[1];
    if (L === 'P') {
      if (d === '1' || d === '3') return 'Específico del fabricante (PSA)';
      const g = code[2];
      return ({
        '0': 'Medición de aire y combustible / emisiones',
        '1': 'Medición de aire y combustible',
        '2': 'Medición de aire y combustible (inyectores y turbo)',
        '3': 'Encendido / fallos de combustión',
        '4': 'Control de emisiones auxiliar',
        '5': 'Velocidad, ralentí y entradas',
        '6': 'Centralita y salidas',
        '7': 'Transmisión',
        '8': 'Transmisión',
        'A': 'Propulsión híbrida'
      })[g] || 'Motor y transmisión';
    }
    if (L === 'C') return 'Chasis';
    if (L === 'B') return 'Carrocería';
    if (L === 'U') return 'Red de comunicaciones';
    return '';
  }

  function describeDTC(code) {
    return {
      code,
      text: DTC_ES[code] || (code[1] === '1' || code[1] === '3' ? 'Código propio del fabricante (consultar documentación PSA)' : 'Descripción no disponible en la base local'),
      category: dtcCategory(code),
      known: !!DTC_ES[code]
    };
  }

  /* ---------------- Ayudas de respuesta ---------------- */
  const NRC = {
    0x10: 'rechazo general',
    0x11: 'servicio no soportado',
    0x12: 'subfunción no soportada',
    0x13: 'longitud o formato incorrecto',
    0x14: 'respuesta demasiado larga',
    0x21: 'ocupada, repetir petición',
    0x22: 'condiciones no correctas',
    0x24: 'secuencia de petición incorrecta',
    0x31: 'dato no disponible en esta centralita',
    0x33: 'acceso de seguridad denegado',
    0x35: 'clave no válida',
    0x72: 'error general de programación',
    0x78: 'respuesta pendiente',
    0x7E: 'subfunción no soportada en esta sesión',
    0x7F: 'servicio no soportado en esta sesión'
  };

  function nrcError(sid, code) {
    const e = new Error('Respuesta negativa (0x' + hx(code) + '): ' + (NRC[code] || 'desconocida'));
    e.code = 'NRC';
    e.nrc = code;
    e.sid = sid;
    return e;
  }

  function ecuRank(ecu) {
    const e = String(ecu).toUpperCase();
    if (e === '7E8' || e === '18DAF110' || e === '10') return 0;
    return 1;
  }

  /** Filtra respuestas positivas (sid + 0x40). Ignora 'respuesta pendiente' (NRC 0x78). */
  function positive(msgs, sid, pid) {
    const ok = msgs.filter(m => m.data[0] === sid + 0x40 && (pid === undefined || m.data[1] === pid));
    if (!ok.length) {
      const neg = msgs.find(m => m.data[0] === 0x7f && m.data[2] !== 0x78);
      if (neg) throw nrcError(neg.data[1], neg.data[2]);
      const e = new Error('Respuesta inesperada de la centralita');
      e.code = 'UNEXPECTED';
      throw e;
    }
    return ok.sort((a, b) => ecuRank(a.ecu) - ecuRank(b.ecu));
  }

  function sameEcu(list) {
    const first = list[0].ecu;
    return list.filter(m => m.ecu === first);
  }

  function ascii(bytes) {
    return bytes.filter(b => b >= 0x20 && b < 0x7f).map(b => String.fromCharCode(b)).join('').trim();
  }

  function isNoData(e) { return e && (e.code === 'NO_DATA'); }

  /* ---------------- Lecturas ---------------- */
  async function getSupportedPids(elm, mode = 0x01) {
    const supported = new Set();
    for (let base = 0; base <= 0xe0; base += 0x20) {
      let msgs;
      try {
        msgs = await elm.request(hx(mode) + hx(base), base === 0 ? 6000 : 4000);
      } catch (e) {
        if (base === 0) throw e;
        break;
      }
      const r = positive(msgs, mode, base)[0];
      const bits = r.data.slice(2, 6);
      for (let i = 0; i < 32; i++) {
        if (bits[i >> 3] & (0x80 >> (i & 7))) supported.add(base + i + 1);
      }
      if (!supported.has(base + 0x20)) break;
    }
    return supported;
  }

  async function readPid(elm, pid) {
    const def = PIDS[pid];
    if (!def) throw new Error('PID no soportado por ReproChip: ' + hx(pid));
    const msgs = await elm.request('01' + hx(pid), 3000);
    const r = positive(msgs, 0x01, pid)[0];
    return def.decode(r.data.slice(2));
  }

  // Bytes de datos de cada PID (para separar las respuestas de varias PIDs en una sola trama).
  const PID_LEN = {
    0x04: 1, 0x05: 1, 0x0B: 1, 0x0C: 2, 0x0D: 1, 0x0F: 1, 0x10: 2, 0x11: 1, 0x1F: 2, 0x21: 2, 0x22: 2, 0x23: 2,
    0x2C: 1, 0x2D: 1, 0x2F: 1, 0x30: 1, 0x31: 2, 0x33: 1, 0x42: 2, 0x43: 2, 0x46: 1, 0x49: 1, 0x4A: 1, 0x4C: 1,
    0x5C: 1, 0x5E: 2, 0x61: 1, 0x62: 1, 0x63: 2
  };

  /** Separa una respuesta 41 PID datos PID datos… en { pid: valor decodificado }. */
  function splitMulti(data, out) {
    let i = 1;
    while (i < data.length) {
      const pid = data[i], len = PID_LEN[pid];
      if (!len || !PIDS[pid] || i + 1 + len > data.length) break;
      out[pid] = PIDS[pid].decode(data.slice(i + 1, i + 1 + len));
      i += 1 + len;
    }
    return out;
  }

  /**
   * Lee varias PIDs pidiendo hasta 6 en cada petición (solo CAN, ISO 15765-4).
   * Devuelve { pid: valor }; las PIDs que la centralita no devuelva no aparecen.
   */
  async function readPids(elm, pids) {
    const out = {};
    for (let i = 0; i < pids.length; i += 6) {
      const chunk = pids.slice(i, i + 6);
      const msgs = await elm.request('01' + chunk.map(p => hx(p)).join(''), 3000);
      const ok = positive(msgs, 0x01);
      const first = ok[0].ecu;
      for (const m of ok) if (m.ecu === first) splitMulti(m.data, out);
    }
    return out;
  }

  async function readMonitorStatus(elm) {
    const msgs = await elm.request('0101');
    const r = positive(msgs, 0x01, 0x01)[0];
    const a = r.data[2] || 0;
    const b = r.data[3] || 0;
    return { mil: !!(a & 0x80), count: a & 0x7f, diesel: !!(b & 0x08) };
  }

  async function readDTCs(elm, mode) {
    let msgs;
    try {
      msgs = await elm.request(hx(mode), 6000);
    } catch (e) {
      if (isNoData(e)) return [];
      throw e;
    }
    const ok = msgs.filter(m => m.data[0] === mode + 0x40);
    if (!ok.length) {
      const neg = msgs.find(m => m.data[0] === 0x7f);
      if (neg) throw nrcError(neg.data[1], neg.data[2]);
      return [];
    }
    const codes = [];
    for (const m of ok) {
      const d = m.data;
      let start = 1;
      if (elm.isCAN) {
        const n = d[1];
        if (d.length >= 2 + 2 * n) start = 2;
      }
      for (let i = start; i + 1 < d.length; i += 2) {
        if (d[i] === 0 && d[i + 1] === 0) continue;
        const code = decodeDTC(d[i], d[i + 1]);
        if (!codes.find(c => c.code === code)) codes.push({ ...describeDTC(code), ecu: m.ecu });
      }
    }
    return codes;
  }

  async function clearDTCs(elm) {
    const msgs = await elm.request('04', 8000);
    positive(msgs, 0x04);
    return true;
  }

  /** Datos del modo 09 en CAN: [49, PID, nº de elementos, datos…]. En K-Line: varios mensajes [49, PID, nº, 4 bytes]. */
  async function mode09Data(elm, pid) {
    const msgs = await elm.request('09' + hx(pid), 6000);
    const list = sameEcu(positive(msgs, 0x09, pid));
    if (elm.isCAN) {
      const d = list[0].data;
      return { count: d[2] || 1, bytes: d.slice(3), ecu: list[0].ecu };
    }
    return { count: list.length, bytes: [].concat(...list.map(m => m.data.slice(3))), ecu: list[0].ecu };
  }

  async function readVIN(elm) {
    const r = await mode09Data(elm, 0x02);
    return ascii(r.bytes);
  }

  async function readCalibrationIds(elm) {
    const r = await mode09Data(elm, 0x04);
    const out = [];
    for (let i = 0; i < r.bytes.length; i += 16) {
      const s = ascii(r.bytes.slice(i, i + 16));
      if (s) out.push(s);
    }
    return out;
  }

  async function readCVNs(elm) {
    const r = await mode09Data(elm, 0x06);
    const out = [];
    for (let i = 0; i + 3 < r.bytes.length; i += 4) out.push(r.bytes.slice(i, i + 4).map(b => hx(b)).join(''));
    return out;
  }

  async function readEcuName(elm) {
    const r = await mode09Data(elm, 0x0a);
    return ascii(r.bytes);
  }

  /* ---------------- UDS 0x22 (solo lectura) ---------------- */
  const UDS_DIDS = [
    [0xf190, 'VIN'],
    [0xf187, 'Referencia de recambio del fabricante'],
    [0xf188, 'Número de software de la ECU'],
    [0xf189, 'Versión de software de la ECU'],
    [0xf18a, 'Proveedor del sistema'],
    [0xf18b, 'Fecha de fabricación'],
    [0xf18c, 'Número de serie de la ECU'],
    [0xf191, 'Número de hardware de la ECU'],
    [0xf192, 'Hardware del proveedor'],
    [0xf193, 'Versión de hardware del proveedor'],
    [0xf194, 'Software del proveedor'],
    [0xf195, 'Versión de software del proveedor'],
    [0xf197, 'Nombre del sistema']
  ];

  function formatDidValue(bytes) {
    const printable = bytes.every(b => (b >= 0x20 && b < 0x7f) || b === 0x00 || b === 0xff);
    const text = ascii(bytes);
    if (printable && text.length >= 2) return text;
    return bytes.map(b => hx(b)).join(' ');
  }

  async function readUdsIdentification(elm, onProgress) {
    if (!elm.isCAN) throw new Error('La identificación UDS solo está disponible en CAN.');
    const physical = elm.is29bit ? 'DA10F1' : '7E0';
    const functional = elm.is29bit ? 'DB33F1' : '7DF';
    const results = [];
    await elm.setHeader(physical);
    try {
      for (const [did, label] of UDS_DIDS) {
        if (onProgress) onProgress(label);
        const row = { did: hx(did, 4), label };
        try {
          const msgs = await elm.request('22' + hx(did, 4), 3000);
          const ok = msgs.filter(m => m.data[0] === 0x62 && ((m.data[1] << 8) | m.data[2]) === did);
          if (ok.length) row.value = formatDidValue(ok[0].data.slice(3));
          else {
            const neg = msgs.find(m => m.data[0] === 0x7f && m.data[2] !== 0x78);
            row.error = neg ? 'No disponible: ' + (NRC[neg.data[2]] || 'código 0x' + hx(neg.data[2])) : 'Respuesta inesperada';
          }
        } catch (e) {
          row.error = isNoData(e) ? 'Sin respuesta' : e.message;
        }
        results.push(row);
      }
    } finally {
      await elm.setHeader(functional).catch(() => {});
    }
    return results;
  }

  /* ---------------- Bloqueo de solo lectura ---------------- */
  // Servicios que solo leen. Todo lo demás (escritura, programación, seguridad, rutinas, reset…) se bloquea.
  const READ_SERVICES = new Set([0x01, 0x02, 0x03, 0x05, 0x06, 0x07, 0x09, 0x0a, 0x17, 0x18, 0x19, 0x1a, 0x21, 0x22, 0x23, 0x3e]);
  const BLOCKED_NAMES = {
    0x04: 'borrado de averías (usa el botón de la pestaña Averías)',
    0x10: 'cambio de sesión',
    0x11: 'reinicio de la centralita',
    0x14: 'borrado de averías UDS',
    0x27: 'acceso de seguridad',
    0x28: 'control de comunicación',
    0x2e: 'escritura de datos',
    0x2f: 'control de entradas/salidas',
    0x31: 'rutinas',
    0x34: 'descarga a la centralita (programación)',
    0x35: 'subida de memoria',
    0x36: 'transferencia de datos (programación)',
    0x37: 'fin de transferencia',
    0x3b: 'escritura de datos KWP',
    0x3d: 'escritura en memoria',
    0x85: 'control de memorización de averías'
  };

  function checkReadOnly(cmd) {
    const c = String(cmd || '').replace(/\s+/g, '').toUpperCase();
    if (!c) return { ok: false, reason: 'Comando vacío' };
    if (c.startsWith('AT') || c.startsWith('ST')) {
      if (/^ATPP/.test(c)) return { ok: false, reason: 'Los parámetros programables del adaptador (ATPP) están bloqueados.' };
      return { ok: true };
    }
    if (!/^[0-9A-F]+$/.test(c) || c.length % 2) return { ok: false, reason: 'Formato no válido: usa hexadecimal (p. ej. 010C) o un comando AT.' };
    const sid = parseInt(c.slice(0, 2), 16);
    if (sid === 0x10) {
      const sub = parseInt(c.slice(2, 4) || '01', 16);
      if (sub === 0x01 || sub === 0x03) return { ok: true };
      return { ok: false, reason: 'Bloqueado en modo solo lectura: sesión de programación.' };
    }
    if (READ_SERVICES.has(sid)) return { ok: true };
    return { ok: false, reason: 'Bloqueado en modo solo lectura: servicio 0x' + hx(sid) + (BLOCKED_NAMES[sid] ? ' (' + BLOCKED_NAMES[sid] + ')' : '') + '.' };
  }

  return {
    PIDS, DEFAULT_LIVE, DTC_ES, NRC, UDS_DIDS,
    decodeDTC, describeDTC, dtcCategory,
    getSupportedPids, readPid, readPids, splitMulti, PID_LEN, readMonitorStatus, readDTCs, clearDTCs,
    readVIN, readCalibrationIds, readCVNs, readEcuName, readUdsIdentification,
    checkReadOnly, hx
  };
});
