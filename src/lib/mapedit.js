/*
 * ReproChip — motor de edición de mapas.
 * Trabaja SIEMPRE sobre la copia de trabajo (nunca sobre el original) y guarda cada cambio
 * byte a byte para poder deshacerlo. Las operaciones se hacen sobre el valor físico
 * (bruto × factor + offset) y se vuelven a convertir a 16 bit con redondeo y límites.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RCEdit = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Dirección de la celda [fila = eje Y][columna = eje X], según el orden de datos del mapa. */
  function cellOff(m, r, c) {
    return m.zOff + 2 * (m.order === 'x' ? r * m.nx + c : c * m.ny + r);
  }

  const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength);

  function getRaw(bytes, m, r, c, signed) {
    const off = cellOff(m, r, c);
    if (off + 2 > bytes.length) return null;
    const d = view(bytes);
    return signed ? d.getInt16(off, m.little) : d.getUint16(off, m.little);
  }

  function setRaw(bytes, m, r, c, v, signed) {
    const off = cellOff(m, r, c);
    const d = view(bytes);
    if (signed) d.setInt16(off, v, m.little); else d.setUint16(off, v, m.little);
    return off;
  }

  function normConv(conv) {
    const c = conv || {};
    const factor = typeof c.factor === 'number' && isFinite(c.factor) && c.factor !== 0 ? c.factor : 1;
    const add = typeof c.add === 'number' && isFinite(c.add) ? c.add : 0;
    return { factor, add, signed: !!c.signed };
  }

  /**
   * Aplica una operación a las celdas indicadas ({r, c} en coordenadas del mapa).
   * op.type: 'pct' (sumar %), 'add' (sumar valor físico), 'set' (fijar valor físico),
   *          'interp' (interpolar entre los extremos de la selección), 'smooth' (suavizar).
   * Devuelve { changes: [{off, prev:[b0,b1], next:[b0,b1]}], clamped }.
   */
  function apply(bytes, m, cells, op, conv) {
    const cv = normConv(conv);
    const lo = cv.signed ? -32768 : 0;
    const hi = cv.signed ? 32767 : 65535;
    const inside = cells.filter(({ r, c }) => r >= 0 && c >= 0 && r < m.ny && c < m.nx && cellOff(m, r, c) + 2 <= bytes.length);
    if (!inside.length) return { changes: [], clamped: 0 };

    const raw = (r, c) => getRaw(bytes, m, r, c, cv.signed);
    const phys = v => v * cv.factor + cv.add;
    const toRaw = p => (p - cv.add) / cv.factor;
    const key = (r, c) => r + ',' + c;
    const selected = new Set(inside.map(x => key(x.r, x.c)));
    const target = new Map();
    const v = Number(op && op.value);

    switch (op && op.type) {
      case 'pct':
        if (!isFinite(v)) throw new Error('Valor no válido');
        inside.forEach(({ r, c }) => target.set(key(r, c), toRaw(phys(raw(r, c)) * (1 + v / 100))));
        break;
      case 'add':
        if (!isFinite(v)) throw new Error('Valor no válido');
        inside.forEach(({ r, c }) => target.set(key(r, c), toRaw(phys(raw(r, c)) + v)));
        break;
      case 'set':
        if (!isFinite(v)) throw new Error('Valor no válido');
        inside.forEach(({ r, c }) => target.set(key(r, c), toRaw(v)));
        break;
      case 'interp': {
        const rs = inside.map(x => x.r), cs = inside.map(x => x.c);
        const r0 = Math.min(...rs), r1 = Math.max(...rs), c0 = Math.min(...cs), c1 = Math.max(...cs);
        if (c1 > c0) {
          // Por filas, a lo largo del eje X
          for (let r = r0; r <= r1; r++) {
            const a = raw(r, c0), b = raw(r, c1);
            for (let c = c0 + 1; c < c1; c++) if (selected.has(key(r, c))) target.set(key(r, c), a + ((b - a) * (c - c0)) / (c1 - c0));
          }
        } else if (r1 > r0) {
          for (let r = r0 + 1; r < r1; r++) {
            const a = raw(r0, c0), b = raw(r1, c0);
            if (selected.has(key(r, c0))) target.set(key(r, c0), a + ((b - a) * (r - r0)) / (r1 - r0));
          }
        }
        break;
      }
      case 'smooth':
        inside.forEach(({ r, c }) => {
          let sum = 2 * raw(r, c), w = 2;
          for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]) {
            const rr = r + dr, cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= m.ny || cc >= m.nx) continue;
            const x = raw(rr, cc);
            if (x == null) continue;
            sum += x;
            w++;
          }
          target.set(key(r, c), sum / w);
        });
        break;
      default:
        throw new Error('Operación desconocida');
    }

    const changes = [];
    let clamped = 0;
    for (const [k, val] of target) {
      if (!isFinite(val)) continue;
      let n = Math.round(val);
      if (n < lo) { n = lo; clamped++; }
      if (n > hi) { n = hi; clamped++; }
      const [r, c] = k.split(',').map(Number);
      const off = cellOff(m, r, c);
      const prev = [bytes[off], bytes[off + 1]];
      setRaw(bytes, m, r, c, n, cv.signed);
      const next = [bytes[off], bytes[off + 1]];
      if (prev[0] !== next[0] || prev[1] !== next[1]) changes.push({ off, prev, next });
    }
    return { changes, clamped };
  }

  function revert(bytes, changes) {
    for (let i = changes.length - 1; i >= 0; i--) {
      const ch = changes[i];
      bytes[ch.off] = ch.prev[0];
      bytes[ch.off + 1] = ch.prev[1];
    }
  }

  function reapply(bytes, changes) {
    for (const ch of changes) {
      bytes[ch.off] = ch.next[0];
      bytes[ch.off + 1] = ch.next[1];
    }
  }

  class History {
    constructor(limit = 300) { this.undoStack = []; this.redoStack = []; this.limit = limit; }
    push(changes, info) {
      if (!changes.length) return;
      this.undoStack.push({ changes, info });
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.redoStack = [];
    }
    undo(bytes) {
      const e = this.undoStack.pop();
      if (!e) return null;
      revert(bytes, e.changes);
      this.redoStack.push(e);
      return e;
    }
    redo(bytes) {
      const e = this.redoStack.pop();
      if (!e) return null;
      reapply(bytes, e.changes);
      this.undoStack.push(e);
      return e;
    }
    get canUndo() { return this.undoStack.length > 0; }
    get canRedo() { return this.redoStack.length > 0; }
    clear() { this.undoStack = []; this.redoStack = []; }
  }

  /** Cambio del modificado respecto al original en un mapa: celdas, % máximo y mínimo. */
  function mapStats(a, b, m, signed) {
    let changed = 0, maxPct = 0, minPct = 0;
    if (!b) return { changed, maxPct, minPct };
    for (let r = 0; r < m.ny; r++) {
      for (let c = 0; c < m.nx; c++) {
        const x = getRaw(a, m, r, c, signed), y = getRaw(b, m, r, c, signed);
        if (x == null || y == null || x === y) continue;
        changed++;
        const p = x ? ((y - x) / Math.abs(x)) * 100 : 100;
        if (p > maxPct) maxPct = p;
        if (p < minPct) minPct = p;
      }
    }
    return { changed, maxPct, minPct };
  }

  return { cellOff, getRaw, apply, revert, reapply, History, mapStats };
});
