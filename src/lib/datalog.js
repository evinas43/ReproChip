/*
 * ReproChip — logs de datos (datalogging).
 * Formato del log, CSV de ida y vuelta, detección de tirones a fondo, estadísticas,
 * curvas por régimen y resúmenes de texto para el asistente. Sin dependencias de la interfaz.
 *
 * Un log es:
 *   { id, name, source: 'rec'|'file'|'live', startedAt (ms, o null),
 *     keys: ['0C', '0B', …],            // canales en orden; PIDs en hexadecimal, otros como 'x:Nombre'
 *     defs: { '0C': { name, short, unit, dec } },
 *     rows: [{ t: segundos desde el inicio, '0C': 830, '0B': null, … }] }
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RCLog = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const hx = n => n.toString(16).toUpperCase().padStart(2, '0');
  const keyOf = pid => hx(pid);
  const pidOf = key => (/^[0-9A-F]{2}$/.test(key) ? parseInt(key, 16) : null);
  const num = v => (v == null || v === '' || !isFinite(v) ? null : Number(v));

  // Canales con significado especial para el análisis.
  const K = { rpm: '0C', map: '0B', baro: '33', maf: '10', rail: '23', iat: '0F', speed: '0D', load: '04', torque: '62', egr: '2C', coolant: '05' };
  const DRIVER_KEYS = ['49', '4A', '11', '4C']; // pedal D, pedal E, mariposa, mariposa comandada

  let idSeq = 0;
  const newId = () => 'log' + Date.now().toString(36) + (idSeq++).toString(36);

  function defFor(key, PIDS) {
    const pid = pidOf(key);
    const d = pid != null && PIDS && PIDS[pid];
    if (d) return { name: d.name, short: d.short, unit: d.unit || '', dec: d.dec || 0 };
    const name = key.replace(/^x:/, '');
    return { name, short: name, unit: '', dec: 2 };
  }

  function newLog({ name, source, keys, PIDS, startedAt }) {
    const defs = {};
    for (const k of keys) defs[k] = defFor(k, PIDS);
    return { id: newId(), name: name || 'Log', source: source || 'rec', startedAt: startedAt == null ? Date.now() : startedAt, keys: keys.slice(), defs, rows: [] };
  }

  /** Convierte las filas de «Datos en vivo» ({ t: ms, [pid]: valor }) en un log. */
  function fromRows(rows, { name, source, PIDS }) {
    const pids = [...new Set(rows.flatMap(r => Object.keys(r).filter(k => k !== 't').map(Number)))].sort((a, b) => a - b);
    const log = newLog({ name, source: source || 'live', keys: pids.map(keyOf), PIDS, startedAt: rows.length ? rows[0].t : null });
    const t0 = rows.length ? rows[0].t : 0;
    for (const r of rows) {
      const row = { t: (r.t - t0) / 1000 };
      for (const p of pids) row[keyOf(p)] = num(r[p]);
      log.rows.push(row);
    }
    return log;
  }

  /* ---------------- CSV ---------------- */
  // Mismo formato que la exportación de «Datos en vivo»: separador «;» y coma decimal (Excel en español).
  function colTitle(def) { return def.short + (def.unit ? ' (' + def.unit + ')' : ''); }

  function toCSV(log) {
    const head = ['tiempo_s'].concat(log.keys.map(k => colTitle(log.defs[k])));
    const lines = [head.join(';')];
    for (const r of log.rows) {
      const cells = [r.t.toFixed(3).replace('.', ',')];
      for (const k of log.keys) {
        const v = r[k];
        cells.push(v == null ? '' : Number(v).toFixed(Math.min(6, (log.defs[k].dec || 0) + 1)).replace('.', ','));
      }
      lines.push(cells.join(';'));
    }
    return lines.join('\r\n');
  }

  function splitLine(line, sep) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === sep) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map(s => s.trim());
  }

  /** Lee un CSV de ReproChip (o uno parecido: «;», «,» o tabulador; coma o punto decimal). */
  function parseCSV(text, { name, PIDS } = {}) {
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).filter(l => l.trim() !== '');
    if (lines.length < 2) throw new Error('El archivo está vacío o no tiene datos.');
    const first = lines[0];
    const sep = first.includes(';') ? ';' : first.includes('\t') ? '\t' : ',';
    const commaDecimal = sep !== ',';
    const head = splitLine(first, sep);
    const tcol = head.findIndex(h => /^(tiempo|time|t|seg|sec|segundos|seconds)\b/i.test(h) || /tiempo|time/i.test(h));
    if (tcol < 0) throw new Error('No encuentro la columna de tiempo (por ejemplo «tiempo_s»).');
    const tScale = /\bms\b|_ms|milis/i.test(head[tcol]) ? 0.001 : 1;

    const byTitle = {};
    if (PIDS) for (const p of Object.keys(PIDS)) {
      const d = PIDS[p];
      byTitle[colTitle(d).toLowerCase()] = keyOf(Number(p));
      if (!byTitle[d.short.toLowerCase()]) byTitle[d.short.toLowerCase()] = keyOf(Number(p));
    }
    const cols = [];
    const used = new Set();
    head.forEach((h, i) => {
      if (i === tcol || !h) return;
      let key = byTitle[h.toLowerCase()] || byTitle[h.replace(/\s*\([^)]*\)\s*$/, '').toLowerCase()];
      if (!key || used.has(key)) key = 'x:' + h;
      if (used.has(key)) return;
      used.add(key);
      cols.push({ i, key, title: h });
    });
    if (!cols.length) throw new Error('El archivo no tiene columnas de datos.');

    const log = newLog({ name: name || 'Log', source: 'file', keys: cols.map(c => c.key), PIDS, startedAt: null });
    for (const c of cols) if (c.key.startsWith('x:')) {
      const m = c.title.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
      log.defs[c.key] = { name: m ? m[1] : c.title, short: m ? m[1] : c.title, unit: m ? m[2] : '', dec: 2 };
    }
    const parse = s => {
      if (s == null || s === '') return null;
      const v = Number(commaDecimal ? s.replace(/\./g, s.includes(',') ? '' : '.').replace(',', '.') : s);
      return isFinite(v) ? v : null;
    };
    for (let li = 1; li < lines.length; li++) {
      const cells = splitLine(lines[li], sep);
      const t = parse(cells[tcol]);
      if (t == null) continue;
      const row = { t: t * tScale };
      for (const c of cols) row[c.key] = parse(cells[c.i]);
      log.rows.push(row);
    }
    if (!log.rows.length) throw new Error('No hay filas con tiempo válido.');
    log.rows.sort((a, b) => a.t - b.t);
    const t0 = log.rows[0].t;
    if (t0) for (const r of log.rows) r.t -= t0;
    return log;
  }

  /* ---------------- Consultas ---------------- */
  const duration = log => (log.rows.length ? log.rows[log.rows.length - 1].t - log.rows[0].t : 0);
  const rate = log => { const d = duration(log); return d > 0 ? (log.rows.length - 1) / d : 0; };
  const has = (log, key) => log.keys.includes(key) && log.rows.some(r => r[key] != null);

  /** Primer índice con t >= x. */
  function lowerBound(rows, x) {
    let lo = 0, hi = rows.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m].t < x) lo = m + 1; else hi = m; }
    return lo;
  }

  /** Valor interpolado de un canal en el instante t (null si no hay datos cerca). */
  function valueAt(log, key, t, maxGap = 3) {
    const rows = log.rows;
    if (!rows.length) return null;
    const i = lowerBound(rows, t);
    let a = i - 1, b = i;
    while (a >= 0 && rows[a][key] == null) a--;
    while (b < rows.length && rows[b][key] == null) b++;
    const A = a >= 0 ? rows[a] : null, B = b < rows.length ? rows[b] : null;
    if (A && B) {
      if (B.t - A.t > maxGap) return Math.abs(t - A.t) < Math.abs(B.t - t) ? A[key] : B[key];
      if (B.t === A.t) return A[key];
      return A[key] + ((B[key] - A[key]) * (t - A.t)) / (B.t - A.t);
    }
    const P = A || B;
    return P && Math.abs(P.t - t) <= maxGap ? P[key] : null;
  }

  function stats(log, key, t0 = -Infinity, t1 = Infinity) {
    let mn = Infinity, mx = -Infinity, sum = 0, n = 0, tMax = null, tMin = null;
    for (const r of log.rows) {
      if (r.t < t0 || r.t > t1) continue;
      const v = r[key];
      if (v == null) continue;
      if (v > mx) { mx = v; tMax = r.t; }
      if (v < mn) { mn = v; tMin = r.t; }
      sum += v; n++;
    }
    return n ? { min: mn, max: mx, avg: sum / n, n, tMax, tMin } : null;
  }

  function driverKey(log) { return DRIVER_KEYS.find(k => has(log, k)) || null; }

  /**
   * Tirones a fondo: tramos con el pedal (o la mariposa) por encima de minPedal durante al menos minDur
   * segundos y en los que el régimen sube al menos minRise rpm.
   */
  function detectPulls(log, opts = {}) {
    const minPedal = opts.minPedal != null ? opts.minPedal : 80;
    const minDur = opts.minDur != null ? opts.minDur : 1.5;
    const minRise = opts.minRise != null ? opts.minRise : 600;
    const maxGap = opts.maxGap != null ? opts.maxGap : 0.6;
    const dk = driverKey(log);
    if (!dk || !has(log, K.rpm)) return [];
    const segs = [];
    let cur = null;
    for (const r of log.rows) {
      const v = r[dk];
      if (v == null) continue;
      if (v >= minPedal) {
        if (cur && r.t - cur.t1 <= maxGap) cur.t1 = r.t;
        else { if (cur) segs.push(cur); cur = { t0: r.t, t1: r.t }; }
      } else if (cur && r.t - cur.t1 > maxGap) { segs.push(cur); cur = null; }
    }
    if (cur) segs.push(cur);
    const out = [];
    for (const s of segs) {
      if (s.t1 - s.t0 < minDur) continue;
      const st = stats(log, K.rpm, s.t0, s.t1);
      const r0 = valueAt(log, K.rpm, s.t0);
      if (!st || r0 == null || st.max - r0 < minRise) continue;
      // El tirón acaba donde el régimen deja de subir (pico de rpm).
      out.push({ n: out.length + 1, t0: s.t0, t1: Math.max(s.t0 + minDur, Math.min(s.t1, st.tMax)) });
    }
    return out;
  }

  function baroOf(log) {
    const st = stats(log, K.baro);
    return st ? st.avg : 101.3;
  }

  /** Tiempo (s) que tarda el régimen en pasar de rpmA a rpmB dentro del tirón (null si no los cruza). */
  function timeBetweenRpm(log, pull, rpmA, rpmB) {
    let ta = null, tb = null, prev = null;
    for (const r of log.rows) {
      if (r.t < pull.t0 || r.t > pull.t1 || r[K.rpm] == null) continue;
      if (prev) {
        const cross = x => prev.v < x && r[K.rpm] >= x ? prev.t + ((x - prev.v) * (r.t - prev.t)) / (r[K.rpm] - prev.v) : null;
        if (ta == null) ta = cross(rpmA);
        if (ta != null && tb == null) tb = cross(rpmB);
      }
      prev = { t: r.t, v: r[K.rpm] };
    }
    return ta != null && tb != null ? tb - ta : null;
  }

  function pullStats(log, pull) {
    const baro = baroOf(log);
    const s = k => (has(log, k) ? stats(log, k, pull.t0, pull.t1) : null);
    const at = (k, t) => (has(log, k) && t != null ? valueAt(log, k, t) : null);
    const rpm = s(K.rpm), map = s(K.map), rail = s(K.rail), maf = s(K.maf), iat = s(K.iat), torque = s(K.torque), load = s(K.load);
    return {
      duration: pull.t1 - pull.t0,
      rpmStart: at(K.rpm, pull.t0),
      rpmEnd: rpm ? rpm.max : null,
      boostMax: map ? (map.max - baro) / 100 : null, // bar sobre la atmosférica
      boostRpm: map ? at(K.rpm, map.tMax) : null,
      mapMax: map ? map.max : null,
      railMax: rail ? rail.max : null,
      railRpm: rail ? at(K.rpm, rail.tMax) : null,
      mafMax: maf ? maf.max : null,
      iatStart: at(K.iat, pull.t0),
      iatMax: iat ? iat.max : null,
      torqueMax: torque ? torque.max : null,
      loadMax: load ? load.max : null,
      speedStart: at(K.speed, pull.t0),
      speedEnd: at(K.speed, pull.t1),
      baro
    };
  }

  /** Curva de un canal frente al régimen dentro de un tirón, agrupada en tramos de `step` rpm. */
  function byRpm(log, pull, key, step = 250) {
    const bins = new Map();
    for (const r of log.rows) {
      if (r.t < pull.t0 || r.t > pull.t1 || r[key] == null) continue;
      const rpm = r[K.rpm] != null ? r[K.rpm] : valueAt(log, K.rpm, r.t);
      if (rpm == null) continue;
      const b = Math.round(rpm / step) * step;
      const e = bins.get(b) || { sum: 0, n: 0 };
      e.sum += r[key]; e.n++;
      bins.set(b, e);
    }
    return [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([rpm, e]) => ({ rpm, v: e.sum / e.n }));
  }

  /** Tirón «principal»: el que más régimen barre (a igualdad, el más largo). */
  function bestPull(log, pulls) {
    if (!pulls.length) return null;
    let best = pulls[0], bestScore = -Infinity;
    for (const p of pulls) {
      const st = pullStats(log, p);
      const score = (st.rpmEnd || 0) - (st.rpmStart || 0) + (p.t1 - p.t0);
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  /* ---------------- Dinamómetro virtual ---------------- */
  const DYNO_DEFAULTS = { mass: 1400, cda: 0.68, crr: 0.012, loss: 15, rho: 1.2, window: 0.7, step: 100, smooth: 200 };
  const CV = 735.49875; // W por cv (DIN)

  /**
   * Estima potencia y par a partir de un tirón en una marcha fija.
   *  - La velocidad en marcha es proporcional al régimen: se ajusta v = k·rpm con la velocidad OBD y luego
   *    se usa el régimen (mucho más fino que los km/h enteros del OBD).
   *  - La aceleración sale de una regresión lineal local del régimen (ventana de `window` s).
   *  - F = m·a + ½·ρ·CdA·v² + Crr·m·g; P rueda = F·v; P motor = P rueda / (1 − pérdidas); par = P motor / ω motor.
   * opts: mass (kg, coche + ocupantes + combustible), cda (m²), crr, loss (% de pérdidas de la transmisión).
   */
  function dyno(log, pull, opts = {}) {
    const o = { ...DYNO_DEFAULTS, ...opts };
    const warnings = [];
    if (!has(log, K.rpm)) return { error: 'El log no tiene el régimen del motor (RPM).' };
    if (!has(log, K.speed)) return { error: 'El log no tiene la velocidad del vehículo: hace falta para calcular la potencia.' };
    const pts = log.rows.filter(r => r.t >= pull.t0 && r.t <= pull.t1 && r[K.rpm] != null).map(r => ({ t: r.t, rpm: r[K.rpm], kmh: r[K.speed] }));
    if (pts.length < 8 || pull.t1 - pull.t0 < 2) return { error: 'El tirón es demasiado corto o tiene muy pocas muestras para calcular la potencia.' };

    // 1) Relación de marcha: km/h por rpm (mínimos cuadrados por el origen).
    let sxy = 0, sxx = 0, n = 0;
    for (const p of pts) if (p.kmh != null && p.kmh > 8) { sxy += p.kmh * p.rpm; sxx += p.rpm * p.rpm; n++; }
    if (n < 5) return { error: 'No hay suficientes lecturas de velocidad durante el tirón.' };
    const k = sxy / sxx; // km/h por rpm
    let se = 0;
    for (const p of pts) if (p.kmh != null && p.kmh > 8) se += Math.pow((p.kmh - k * p.rpm) / (k * p.rpm), 2);
    const fitErr = Math.sqrt(se / n) * 100; // % de dispersión
    if (fitErr > 6) warnings.push('La velocidad no sigue al régimen de forma constante (' + fmtN(fitErr, 1) + ' % de dispersión): ¿cambio de marcha, embrague que patina o ruedas que patinan?');
    if (pull.t1 - pull.t0 < 3) warnings.push('El tirón dura menos de 3 s: la curva será poco fiable.');
    const rate0 = pts.length / (pull.t1 - pull.t0);
    if (rate0 < 3) warnings.push('Pocas muestras por segundo (' + fmtN(rate0, 1) + '): graba menos parámetros para que la curva salga más fina.');

    // 2) Régimen suavizado y su derivada por regresión lineal local.
    const half = o.window / 2;
    const kms = k / 3.6; // m/s por rpm
    const raw = [];
    for (let i = 0; i < pts.length; i++) {
      const t = pts[i].t;
      let st = 0, sr = 0, stt = 0, str = 0, m = 0;
      for (let j = i; j >= 0 && t - pts[j].t <= half; j--) { st += pts[j].t; sr += pts[j].rpm; stt += pts[j].t * pts[j].t; str += pts[j].t * pts[j].rpm; m++; }
      for (let j = i + 1; j < pts.length && pts[j].t - t <= half; j++) { st += pts[j].t; sr += pts[j].rpm; stt += pts[j].t * pts[j].t; str += pts[j].t * pts[j].rpm; m++; }
      if (m < 3) continue;
      const den = m * stt - st * st;
      if (Math.abs(den) < 1e-9) continue;
      const slope = (m * str - st * sr) / den; // rpm/s
      const rpm = (sr - slope * st) / m + slope * t;
      const v = kms * rpm, a = kms * slope;
      const F = o.mass * a + 0.5 * o.rho * o.cda * v * v + o.crr * o.mass * 9.81;
      const pw = F * v;
      const pc = pw / (1 - o.loss / 100);
      const nm = pc / (rpm * 2 * Math.PI / 60);
      if (pw > 0 && rpm > 0) raw.push({ rpm, wheelCv: pw / CV, cv: pc / CV, nm });
    }
    if (raw.length < 5) return { error: 'No se pudo calcular la curva: el régimen no sube lo suficiente durante el tirón.' };

    // 3) Curva por tramos de régimen.
    const bins = new Map();
    for (const p of raw) {
      const b = Math.round(p.rpm / o.step) * o.step;
      const e = bins.get(b) || { cv: 0, nm: 0, w: 0, n: 0 };
      e.cv += p.cv; e.nm += p.nm; e.w += p.wheelCv; e.n++;
      bins.set(b, e);
    }
    const binned = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([rpm, e]) => ({ rpm, cv: e.cv / e.n, nm: e.nm / e.n, wheelCv: e.w / e.n }));
    // Suavizado: media móvil de ±o.smooth rpm, como hacen los bancos de potencia, para que el ruido no marque el máximo.
    const curve = binned.map(p => {
      const near = binned.filter(q => Math.abs(q.rpm - p.rpm) <= o.smooth);
      const avg = f => near.reduce((s, q) => s + q[f], 0) / near.length;
      return { rpm: p.rpm, cv: avg('cv'), nm: avg('nm'), wheelCv: avg('wheelCv') };
    });
    let pk = curve[0], tk = curve[0];
    for (const c of curve) { if (c.cv > pk.cv) pk = c; if (c.nm > tk.nm) tk = c; }
    return {
      curve, peakCv: pk.cv, peakCvRpm: pk.rpm, peakWheelCv: pk.wheelCv, peakNm: tk.nm, peakNmRpm: tk.rpm,
      kmhPer1000: k * 1000, fitErr, warnings, opts: o
    };
  }
  const fmtN = (v, d) => Number(v).toFixed(d).replace('.', ',');

  /* ---------------- Texto para el asistente ---------------- */
  const f = (v, d = 0) => (v == null || !isFinite(v) ? '—' : Number(v).toFixed(d).replace('.', ','));

  function pullLine(log, p) {
    const s = pullStats(log, p);
    const parts = ['Tirón ' + p.n + ': de ' + f(p.t0, 1) + ' s a ' + f(p.t1, 1) + ' s (' + f(s.duration, 1) + ' s), ' + f(s.rpmStart) + ' → ' + f(s.rpmEnd) + ' rpm'];
    if (s.boostMax != null) parts.push('sobrepresión máx ' + f(s.boostMax, 2) + ' bar a ' + f(s.boostRpm) + ' rpm (MAP ' + f(s.mapMax) + ' kPa, barométrica ' + f(s.baro) + ' kPa)');
    if (s.railMax != null) parts.push('rail máx ' + f(s.railMax) + ' bar a ' + f(s.railRpm) + ' rpm');
    if (s.mafMax != null) parts.push('MAF máx ' + f(s.mafMax, 1) + ' g/s');
    if (s.torqueMax != null) parts.push('par real máx ' + f(s.torqueMax) + ' %');
    if (s.iatMax != null) parts.push('aire admisión ' + f(s.iatStart) + ' → ' + f(s.iatMax) + ' °C');
    if (s.speedStart != null) parts.push('velocidad ' + f(s.speedStart) + ' → ' + f(s.speedEnd) + ' km/h');
    return parts.join('; ');
  }

  function curveTable(log, pull, step = 500) {
    const keys = [K.map, K.maf, K.rail, K.torque, K.load, K.iat, '49'].filter(k => k !== K.rpm && has(log, k));
    if (!keys.length) return '';
    const curves = keys.map(k => new Map(byRpm(log, pull, k, step).map(p => [p.rpm, p.v])));
    const rpms = [...new Set(curves.flatMap(c => [...c.keys()]))].sort((a, b) => a - b);
    const head = 'rpm; ' + keys.map(k => colTitle(log.defs[k])).join('; ');
    const rows = rpms.map(r => r + '; ' + curves.map((c, i) => f(c.get(r), log.defs[keys[i]].dec)).join('; '));
    return head + '\n' + rows.join('\n');
  }

  function summaryText(log, opts = {}) {
    const pulls = opts.pulls || detectPulls(log);
    const lines = ['LOG «' + log.name + '»: ' + f(duration(log), 1) + ' s, ' + log.rows.length + ' muestras (' + f(rate(log), 1) + ' muestras/s por canal).'];
    lines.push('Canales (mín / media / máx):');
    for (const k of log.keys) {
      const st = stats(log, k);
      if (!st) continue;
      const d = log.defs[k];
      lines.push('- ' + d.name + ': ' + f(st.min, d.dec) + ' / ' + f(st.avg, d.dec) + ' / ' + f(st.max, d.dec) + (d.unit ? ' ' + d.unit : ''));
    }
    if (pulls.length) {
      lines.push('Tirones a fondo detectados: ' + pulls.length);
      for (const p of pulls.slice(0, 6)) lines.push('- ' + pullLine(log, p));
      const main = opts.pull || bestPull(log, pulls);
      const tbl = curveTable(log, main);
      if (tbl) lines.push('Curva del tirón ' + main.n + ' por régimen (media por tramo de 500 rpm):\n' + tbl);
    } else {
      lines.push('No hay tirones a fondo (pedal ≥ 80 % con subida de régimen) en este log.');
    }
    return lines.join('\n');
  }

  function compareText(a, pa, b, pb) {
    const sa = pullStats(a, pa), sb = pullStats(b, pb);
    const lines = ['COMPARACIÓN de tirones: A = «' + a.name + '» tirón ' + pa.n + ', B = «' + b.name + '» tirón ' + pb.n + '.'];
    const row = (label, va, vb, d, unit) => {
      const diff = va != null && vb != null && vb !== 0 ? ' (' + (va >= vb ? '+' : '') + f(((va - vb) / Math.abs(vb)) * 100, 1) + ' %)' : '';
      lines.push('- ' + label + ': A ' + f(va, d) + ' / B ' + f(vb, d) + ' ' + unit + diff);
    };
    row('Sobrepresión máx', sa.boostMax, sb.boostMax, 2, 'bar');
    row('Presión de rail máx', sa.railMax, sb.railMax, 0, 'bar');
    row('MAF máx', sa.mafMax, sb.mafMax, 1, 'g/s');
    row('Par real máx', sa.torqueMax, sb.torqueMax, 0, '%');
    row('Aire de admisión máx', sa.iatMax, sb.iatMax, 0, '°C');
    const span = commonRpmSpan(a, pa, b, pb);
    if (span) row('Tiempo ' + span[0] + '→' + span[1] + ' rpm', timeBetweenRpm(a, pa, span[0], span[1]), timeBetweenRpm(b, pb, span[0], span[1]), 2, 's');
    lines.push('Curvas A:\n' + curveTable(a, pa));
    lines.push('Curvas B:\n' + curveTable(b, pb));
    return lines.join('\n');
  }

  /** Tramo de régimen que cubren los dos tirones, redondeado a 500 rpm (null si es menor de 1000 rpm). */
  function commonRpmSpan(a, pa, b, pb) {
    const sa = pullStats(a, pa), sb = pullStats(b, pb);
    if ([sa.rpmStart, sa.rpmEnd, sb.rpmStart, sb.rpmEnd].some(v => v == null)) return null;
    const lo = Math.ceil(Math.max(sa.rpmStart, sb.rpmStart) / 500) * 500;
    const hi = Math.floor(Math.min(sa.rpmEnd, sb.rpmEnd) / 500) * 500;
    return hi - lo >= 1000 ? [lo, hi] : null;
  }

  return {
    K, keyOf, pidOf, newLog, fromRows, toCSV, parseCSV, colTitle,
    duration, rate, has, valueAt, stats, lowerBound, driverKey,
    detectPulls, pullStats, byRpm, bestPull, timeBetweenRpm, commonRpmSpan, baroOf,
    summaryText, compareText, dyno, DYNO_DEFAULTS
  };
});
