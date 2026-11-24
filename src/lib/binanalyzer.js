/*
 * ReproChip — análisis de volcados de centralita (.bin / .ori).
 *  - identify(): familia de ECU, números Bosch y PSA a partir de las cadenas de texto.
 *  - findMaps(): busca mapas 2D de 16 bit con cabecera de dimensiones y ejes crecientes,
 *    en el estilo Bosch (EDC16 big-endian, EDC17 little-endian). Es una heurística:
 *    puede dejarse mapas y dar algún falso positivo.
 *  - diffFiles(): compara original y modificado.
 * Solo lee: nunca modifica el archivo ni recalcula checksums.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RCBin = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const hex = (n, w = 6) => '0x' + n.toString(16).toUpperCase().padStart(w, '0');

  function extractStrings(bytes, minLen = 5, maxCount = 20000) {
    const out = [];
    let start = -1;
    for (let i = 0; i <= bytes.length; i++) {
      const b = i < bytes.length ? bytes[i] : 0;
      const printable = b >= 0x20 && b < 0x7f;
      if (printable) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        if (i - start >= minLen) {
          let text = '';
          for (let j = start; j < i && j - start < 200; j++) text += String.fromCharCode(bytes[j]);
          out.push({ offset: start, text });
          if (out.length >= maxCount) break;
        }
        start = -1;
      }
    }
    return out;
  }

  const FAMILIES = [
    [/EDC17[A-Z]{1,2}\d{1,3}/, 'little'],
    [/EDC16[A-Z]{1,2}\d{1,3}/, 'big'],
    [/EDC15[A-Z]{0,2}\d{0,3}/, 'little'],
    [/MED17\.?\d(\.\d)?/, 'little'],
    [/MD1C[A-Z]\d{3}/, 'little'],
    [/MG1C[A-Z]\d{3}/, 'little'],
    [/ME7\.\d(\.\d)?/, 'little'],
    [/MED9\.\d/, 'big'],
    [/SID\s?80\d\w*/, null],
    [/DCM\d\.\d\w*/, null],
    [/EDC17/, 'little'],
    [/EDC16/, 'big']
  ];

  function uniq(arr) { return [...new Set(arr)]; }

  function identify(bytes) {
    const strings = extractStrings(bytes, 5);
    const all = strings.map(s => s.text).join('\n');
    let family = null;
    let endian = null;
    let familyOffset = null;
    for (const [re, e] of FAMILIES) {
      const m = all.match(re);
      if (m) {
        family = m[0];
        endian = e;
        const s = strings.find(x => re.test(x.text));
        familyOffset = s ? s.offset : null;
        break;
      }
    }
    const boschHW = uniq(all.match(/0281\d{6}/g) || []).slice(0, 10);
    const boschSW = uniq(all.match(/1037\d{6,7}/g) || []).slice(0, 10);
    const psa = uniq(all.match(/9[68]\d{8}/g) || []).filter(x => !boschHW.includes(x)).slice(0, 10);
    const brands = uniq((all.match(/BOSCH|Bosch|PSA|PEUGEOT|CITROEN|Citroen|DELPHI|SIEMENS|CONTINENTAL/g) || []).map(s => s.toUpperCase()));
    const interesting = strings
      .filter(s => s.text.length >= 6 && /EDC1\d|MED1\d|BOSCH|Bosch|0281\d{6}|1037\d{6}|9[68]\d{8}|PSA|CITRO|Citro|PEUGEOT|Peugeot|DV6|HDI|HDi/.test(s.text))
      .slice(0, 60);
    return {
      size: bytes.length,
      sizeKB: Math.round(bytes.length / 1024),
      family,
      familyOffset,
      endianGuess: endian,
      boschHW,
      boschSW,
      psa,
      brands,
      interesting,
      stringCount: strings.length
    };
  }

  /* ---------------- Buscador de mapas ---------------- */
  function readAxis(dv, off, n, little) {
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = dv.getUint16(off + 2 * i, little);
    return a;
  }

  function strictlyIncreasing(a) {
    for (let i = 1; i < a.length; i++) if (a[i] <= a[i - 1]) return false;
    return true;
  }

  function normalizeAxis(a) {
    if (strictlyIncreasing(a)) return { values: a, signed: false };
    const s = a.map(v => (v > 32767 ? v - 65536 : v));
    if (strictlyIncreasing(s)) return { values: s, signed: true };
    return null;
  }

  function trivialAxis(a) {
    // 0,1,2,3… o 1,2,3,4… (índices, no ejes reales)
    for (let i = 1; i < a.length; i++) if (a[i] - a[i - 1] !== 1) return false;
    return a[0] <= 1;
  }

  function axisPlausible(a) {
    let mn = Infinity, mx = 0;
    for (let i = 1; i < a.length; i++) {
      const d = a[i] - a[i - 1];
      if (d < mn) mn = d;
      if (d > mx) mx = d;
    }
    return mx / mn <= 120;
  }

  function cellIndex(order, nx, ny, r, c) {
    return order === 'x' ? r * nx + c : c * ny + r;
  }

  function roughness(raw, nx, ny, order, mn, mx) {
    const range = mx - mn || 1;
    let sum = 0, n = 0;
    for (let r = 0; r < ny; r++) {
      for (let c = 0; c < nx; c++) {
        const v = raw[cellIndex(order, nx, ny, r, c)];
        if (c + 1 < nx) { sum += Math.abs(v - raw[cellIndex(order, nx, ny, r, c + 1)]); n++; }
        if (r + 1 < ny) { sum += Math.abs(v - raw[cellIndex(order, nx, ny, r + 1, c)]); n++; }
      }
    }
    return n ? sum / n / range : 1;
  }

  function looksLikeRpm(a) {
    const first = a[0], last = a[a.length - 1];
    return a.length >= 5 && first >= 300 && first <= 1500 && last >= 2500 && last <= 7000;
  }

  function tryAt(dv, off, len, little, cfg, layout) {
    const nx = dv.getUint16(off, little);
    if (nx < cfg.minDim || nx > cfg.maxDim) return null;
    let ny, xOff, yOff, zOff;
    if (layout === 'A') {
      ny = dv.getUint16(off + 2, little);
      if (ny < cfg.minDim || ny > cfg.maxDim) return null;
      xOff = off + 4;
      yOff = xOff + 2 * nx;
      zOff = yOff + 2 * ny;
    } else {
      xOff = off + 2;
      const nyOff = xOff + 2 * nx;
      if (nyOff + 2 > len) return null;
      ny = dv.getUint16(nyOff, little);
      if (ny < cfg.minDim || ny > cfg.maxDim) return null;
      yOff = nyOff + 2;
      zOff = yOff + 2 * ny;
    }
    if (nx * ny < cfg.minCells || Math.max(nx, ny) < 4) return null;
    const end = zOff + 2 * nx * ny;
    if (end > len) return null;

    const xa = normalizeAxis(readAxis(dv, xOff, nx, little));
    if (!xa) return null;
    const ya = normalizeAxis(readAxis(dv, yOff, ny, little));
    if (!ya) return null;
    if (trivialAxis(xa.values) && trivialAxis(ya.values)) return null;
    if (!axisPlausible(xa.values) || !axisPlausible(ya.values)) return null;

    const raw = new Array(nx * ny);
    let mn = Infinity, mx = -Infinity, blank = 0;
    for (let i = 0; i < raw.length; i++) {
      const v = dv.getUint16(zOff + 2 * i, little);
      raw[i] = v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      if (v === 0xffff) blank++;
    }
    if (mx === mn) return null;
    if (blank > raw.length * 0.3) return null;

    const rx = roughness(raw, nx, ny, 'x', mn, mx);
    const ry = roughness(raw, nx, ny, 'y', mn, mx);
    // Por defecto X primero; solo se cambia si la otra lectura es claramente más suave.
    const order = ry < rx * 0.8 ? 'y' : 'x';
    const rough = Math.min(rx, ry);
    const limit = nx * ny >= 36 ? cfg.maxRough : cfg.maxRough * 0.75;
    if (rough > limit) return null;

    const confidence = Math.round(Math.max(0, Math.min(100,
      100 - rough * 260 + Math.min(20, nx * ny / 12) - (xa.signed || ya.signed ? 8 : 0))));
    const hints = [];
    if (looksLikeRpm(xa.values)) hints.push('Eje X: posible RPM');
    if (looksLikeRpm(ya.values)) hints.push('Eje Y: posible RPM');
    return {
      id: off,
      offset: off,
      offsetHex: hex(off),
      layout,
      nx, ny,
      xOff, yOff, zOff, end,
      xAxis: xa.values,
      yAxis: ya.values,
      xSigned: xa.signed,
      ySigned: ya.signed,
      order,
      rough: Math.round(rough * 1000) / 1000,
      min: mn,
      max: mx,
      little,
      confidence,
      hints
    };
  }

  function findMaps(bytes, opts = {}) {
    const little = opts.endian !== 'big';
    const cfg = {
      minDim: opts.minDim || 2,
      maxDim: opts.maxDim || 32,
      minCells: opts.minCells || 12,
      maxRough: opts.maxRough || 0.2
    };
    const limit = opts.maxResults || 1000;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = bytes.length;
    const maps = [];
    let off = 0;
    while (off + 12 <= len && maps.length < limit) {
      const m = tryAt(dv, off, len, little, cfg, 'A') || tryAt(dv, off, len, little, cfg, 'B');
      if (m) {
        maps.push(m);
        off = m.end + (m.end % 2);
      } else {
        off += 2;
      }
    }
    return maps;
  }

  /** Busca en los dos órdenes de bytes y se queda con el que encuentra mapas más fiables. */
  function findMapsAuto(bytes, opts = {}) {
    const little = findMaps(bytes, { ...opts, endian: 'little' });
    const big = findMaps(bytes, { ...opts, endian: 'big' });
    const score = list => list.reduce((s, m) => s + m.confidence, 0);
    return score(little) >= score(big)
      ? { endian: 'little', maps: little }
      : { endian: 'big', maps: big };
  }

  /** Valores del mapa como rejilla [fila = eje Y][columna = eje X]. */
  function mapGrid(bytes, map, signed) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const grid = [];
    for (let r = 0; r < map.ny; r++) {
      const row = [];
      for (let c = 0; c < map.nx; c++) {
        const off = map.zOff + 2 * cellIndex(map.order, map.nx, map.ny, r, c);
        if (off + 2 > bytes.length) { row.push(null); continue; }
        row.push(signed ? dv.getInt16(off, map.little) : dv.getUint16(off, map.little));
      }
      grid.push(row);
    }
    return grid;
  }

  function cellOffset(map, r, c) {
    return map.zOff + 2 * cellIndex(map.order, map.nx, map.ny, r, c);
  }

  /* ---------------- Comparación ---------------- */
  function diffFiles(a, b, maxRanges = 5000) {
    const n = Math.min(a.length, b.length);
    const ranges = [];
    let cur = null;
    let changed = 0;
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) {
        changed++;
        if (cur && i - cur.end <= 8) cur.end = i + 1;
        else if (ranges.length < maxRanges) {
          cur = { start: i, end: i + 1 };
          ranges.push(cur);
        } else cur = null;
      }
    }
    return {
      sizeA: a.length,
      sizeB: b.length,
      sameSize: a.length === b.length,
      changed,
      percent: n ? Math.round((changed / n) * 10000) / 100 : 0,
      ranges,
      truncated: ranges.length >= maxRanges
    };
  }

  function mapChanges(map, a, b) {
    if (!b) return 0;
    let n = 0;
    for (let i = 0; i < map.nx * map.ny; i++) {
      const off = map.zOff + 2 * i;
      if (off + 1 >= b.length) break;
      if (a[off] !== b[off] || a[off + 1] !== b[off + 1]) n++;
    }
    return n;
  }

  function annotateChanges(maps, a, b) {
    for (const m of maps) m.changed = b ? mapChanges(m, a, b) : 0;
    return maps;
  }

  return {
    extractStrings, identify, findMaps, findMapsAuto, mapGrid, cellOffset,
    diffFiles, mapChanges, annotateChanges, hex
  };
});
