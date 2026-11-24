/*
 * ReproChip — biblioteca de vehículos y centralitas (fichas).
 * Cada ficha guarda el vehículo, la centralita, mapas típicos, averías propias del fabricante,
 * PIDs recomendados y las etiquetas de mapas que el usuario va poniendo en sus archivos.
 * Incluye el prompt para que Claude genere fichas y la validación de lo que devuelve.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RCProfiles = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITS = { str: 300, notes: 3000, maps: 60, dtcs: 80, defs: 3000, doubts: 15, alts: 8 };

  const str = (v, max = LIMITS.str) => (v == null ? '' : String(v)).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  const strOrNull = (v, max) => { const s = str(v, max); return s && !/^(null|desconocido|n\/a)$/i.test(s) ? s : ''; };
  const num = v => {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return isFinite(n) ? n : null;
  };
  const int = (v, min, max) => {
    const n = num(v);
    if (n == null) return null;
    const i = Math.round(n);
    return i >= min && i <= max ? i : null;
  };

  function newId() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function endianForFamily(f) {
    const s = String(f || '').toUpperCase();
    if (/EDC17|MED17|MD1|MG1|EDC15|ME7|MS4/.test(s)) return 'little';
    if (/EDC16|MED9|EDC7|ME9/.test(s)) return 'big';
    return null;
  }

  function cleanPid(v) {
    if (typeof v === 'number') return int(v, 1, 255);
    const s = String(v || '').trim().replace(/^0x/i, '').replace(/^01(?=[0-9a-f]{2}$)/i, '');
    if (!/^[0-9a-f]{1,2}$/i.test(s)) return null;
    return int(parseInt(s, 16), 1, 255);
  }

  function sanitize(p) {
    const src = p && typeof p === 'object' ? p : {};
    const v = src.vehicle || {};
    const e = src.ecu || {};
    const family = strOrNull(e.family, 60);
    let endian = e.endian === 'little' || e.endian === 'big' ? e.endian : null;
    if (!endian) endian = endianForFamily(family);
    const protocol = /^[0-9]$/.test(String(e.protocol || '')) ? String(e.protocol) : null;

    const maps = (Array.isArray(src.maps) ? src.maps : []).slice(0, LIMITS.maps).map(m => ({
      name: str(m && m.name, 120),
      unit: str(m && m.unit, 30),
      factor: num(m && m.factor),
      add: num(m && m.add) || 0,
      xAxis: str(m && m.xAxis, 60),
      yAxis: str(m && m.yAxis, 60),
      notes: str(m && m.notes, 400)
    })).filter(m => m.name);

    const seen = new Set();
    const dtcs = [];
    for (const d of Array.isArray(src.dtcs) ? src.dtcs : []) {
      const code = str(d && d.code, 8).toUpperCase();
      const text = str(d && d.text, 200);
      if (!/^[PCBU][0-3][0-9A-F]{3}$/.test(code) || !text || seen.has(code)) continue;
      seen.add(code);
      dtcs.push({ code, text });
      if (dtcs.length >= LIMITS.dtcs) break;
    }

    const livePids = [...new Set((Array.isArray(src.livePids) ? src.livePids : []).map(cleanPid).filter(x => x != null))].slice(0, 40);

    const mapDefs = [];
    for (const d of Array.isArray(src.mapDefs) ? src.mapDefs : []) {
      const offset = int(d && d.offset, 0, 0x7fffffff);
      const nx = int(d && d.nx, 1, 255), ny = int(d && d.ny, 1, 255);
      const name = str(d && d.name, 120);
      if (offset == null || !nx || !ny || !name) continue;
      mapDefs.push({
        swKey: str(d.swKey, 80) || 'desconocido',
        offset, nx, ny,
        x0: num(d.x0), x1: num(d.x1), y0: num(d.y0), y1: num(d.y1),
        name,
        unit: str(d.unit, 30),
        factor: num(d.factor) == null ? 1 : num(d.factor),
        add: num(d.add) || 0,
        dec: int(d.dec, 0, 4) || 0
      });
      if (mapDefs.length >= LIMITS.defs) break;
    }

    const conf = ['alta', 'media', 'baja'].includes(src.confidence) ? src.confidence : null;
    const now = new Date().toISOString();
    return {
      id: str(src.id, 40) || newId(),
      vehicle: {
        brand: str(v.brand, 60),
        model: str(v.model, 80),
        engine: str(v.engine, 80),
        engineCode: strOrNull(v.engineCode, 60),
        years: strOrNull(v.years, 40),
        fuel: strOrNull(v.fuel, 30),
        powerCv: int(v.powerCv, 1, 2000),
        torqueNm: int(v.torqueNm, 1, 5000)
      },
      ecu: {
        supplier: strOrNull(e.supplier, 60),
        family,
        alternatives: (Array.isArray(e.alternatives) ? e.alternatives : []).map(a => strOrNull(a, 60)).filter(Boolean).slice(0, LIMITS.alts),
        endian,
        protocol,
        hardware: strOrNull(e.hardware, 80),
        software: strOrNull(e.software, 80)
      },
      notes: str(src.notes, LIMITS.notes),
      doubts: (Array.isArray(src.doubts) ? src.doubts : []).map(d => str(d, 300)).filter(Boolean).slice(0, LIMITS.doubts),
      confidence: conf,
      maps,
      dtcs,
      livePids,
      mapDefs,
      source: ['ia', 'manual', 'importado'].includes(src.source) ? src.source : 'manual',
      createdAt: str(src.createdAt, 40) || now,
      updatedAt: str(src.updatedAt, 40) || now
    };
  }

  /** Convierte el antiguo «vehículo» de Ajustes (versión 0.1) en una ficha. */
  function fromLegacy(v) {
    const ecuText = str(v && v.ecu, 120);
    const fams = ecuText.match(/EDC1[5-7][A-Z]{0,2}\d{0,3}|MED1\d[.\d]*|SID\d{3}/gi) || [];
    return sanitize({
      vehicle: { brand: v && v.brand, model: v && v.model, engine: v && v.engine, years: v && v.year },
      ecu: { supplier: /bosch/i.test(ecuText) ? 'Bosch' : '', family: fams[0] || '', alternatives: fams.slice(1) },
      notes: ecuText && /confirmar/i.test(ecuText) ? 'Centralita por confirmar: ' + ecuText : '',
      source: 'manual'
    });
  }

  function label(p) {
    if (!p) return '';
    const v = p.vehicle || {};
    return [v.brand, v.model, v.engine].filter(Boolean).join(' ') + (v.years ? ' (' + v.years + ')' : '');
  }

  function ecuLabel(p) {
    if (!p) return '';
    const e = p.ecu || {};
    return [e.supplier, e.family].filter(Boolean).join(' ') + (e.alternatives && e.alternatives.length ? ' / ' + e.alternatives.join(' / ') : '');
  }

  /* ---------------- Etiquetas de mapas ---------------- */
  function swKey(info) {
    if (!info) return 'desconocido';
    if (info.boschSW && info.boschSW.length) return 'SW ' + info.boschSW[0];
    return (info.family || 'ECU') + ' · ' + info.sizeKB + ' KB';
  }

  function findDef(profile, key, map) {
    if (!profile || !map) return null;
    const defs = profile.mapDefs || [];
    const exact = defs.find(d => d.swKey === key && d.offset === map.offset && d.nx === map.nx && d.ny === map.ny);
    if (exact) return { def: exact, exact: true };
    const x0 = map.xAxis[0], x1 = map.xAxis[map.xAxis.length - 1], y0 = map.yAxis[0], y1 = map.yAxis[map.yAxis.length - 1];
    const similar = defs.find(d => d.nx === map.nx && d.ny === map.ny && d.x0 === x0 && d.x1 === x1 && d.y0 === y0 && d.y1 === y1);
    return similar ? { def: similar, exact: false } : null;
  }

  function upsertDef(profile, key, map, label) {
    const def = sanitize({ mapDefs: [{
      swKey: key, offset: map.offset, nx: map.nx, ny: map.ny,
      x0: map.xAxis[0], x1: map.xAxis[map.xAxis.length - 1], y0: map.yAxis[0], y1: map.yAxis[map.yAxis.length - 1],
      name: label.name, unit: label.unit, factor: label.factor, add: label.add, dec: label.dec
    }] }).mapDefs[0];
    if (!def) throw new Error('La etiqueta necesita un nombre.');
    profile.mapDefs = (profile.mapDefs || []).filter(d => !(d.swKey === key && d.offset === map.offset));
    profile.mapDefs.push(def);
    profile.updatedAt = new Date().toISOString();
    return def;
  }

  function removeDef(profile, key, offset) {
    profile.mapDefs = (profile.mapDefs || []).filter(d => !(d.swKey === key && d.offset === offset));
    profile.updatedAt = new Date().toISOString();
  }

  /* ---------------- IA ---------------- */
  function profilePrompt(pidList) {
    return [
      'Eres un experto en diagnosis y calibración de motores (centralitas Bosch, Delphi, Siemens/Continental, Marelli) y ayudas a rellenar la ficha técnica de un vehículo en ReproChip, una app de lectura de centralitas.',
      'Devuelve SOLO un objeto JSON válido, sin texto antes ni después y sin bloques de código.',
      '',
      'Forma exacta del JSON:',
      '{',
      '  "vehicle": {"brand": "Citroën", "model": "C4", "engine": "1.6 HDi 92 cv", "engineCode": "…", "years": "2010-2015", "fuel": "diésel", "powerCv": 92, "torqueNm": 230},',
      '  "ecu": {"supplier": "Bosch", "family": "EDC17C10", "alternatives": ["EDC16C34"], "endian": "little", "protocol": "6", "hardware": null, "software": null},',
      '  "maps": [{"name": "Cantidad de inyección por pedal", "unit": "mg/emb", "factor": 0.01, "add": 0, "xAxis": "rpm", "yAxis": "pedal %", "notes": "…"}],',
      '  "dtcs": [{"code": "P1351", "text": "descripción en español"}],',
      '  "livePids": ["0C", "0B"],',
      '  "notes": "notas útiles para diagnóstico y reprogramación: puntos débiles, límites de embrague y turbo, cuidados…",',
      '  "doubts": ["datos que hay que confirmar en el coche"],',
      '  "confidence": "alta"',
      '}',
      '',
      'Reglas:',
      '- Todo el texto en español de España.',
      '- Si no conoces un dato con seguridad, pon null (o una lista vacía) y añádelo a "doubts". Nunca inventes referencias de pieza, números de hardware o software ni códigos de motor.',
      '- "ecu.hardware" y "ecu.software" solo se rellenan con números que aparezcan en los datos que te paso.',
      '- "ecu.endian": "little" para TriCore y C167 (EDC17, MED17, MD1, MG1, EDC15, ME7); "big" para PowerPC (EDC16, MED9). null si no lo sabes.',
      '- "ecu.protocol": número de protocolo del ELM327 en la toma OBD: "6" CAN 11 bit 500k, "7" CAN 29 bit 500k, "8" CAN 11 bit 250k, "9" CAN 29 bit 250k, "5" KWP rápido, "4" KWP 5 baudios, "3" ISO 9141-2. null si no lo sabes.',
      '- "maps": de 5 a 15 mapas habituales en la reprogramación de esta centralita y motor, con la unidad y el factor típico para convertir el valor bruto de 16 bit (null si no lo sabes).',
      '- "dtcs": hasta 25 códigos frecuentes en este motor o propios del fabricante, con descripción en español. No repitas los genéricos obvios.',
      '- "livePids": PIDs OBD-II del modo 01 recomendados para este motor, solo de esta lista: ' + pidList.join(', ') + '.',
      '- "confidence": "alta", "media" o "baja" según lo seguro que estés de la ficha en conjunto.',
      '- No incluyas mapas, notas ni pasos para anular sistemas anticontaminación (FAP/DPF, EGR, AdBlue/SCR) ni el inmovilizador.'
    ].join('\n');
  }

  function extractJSON(text) {
    let t = String(text || '').trim();
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('La IA no devolvió una ficha en formato JSON.');
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch (e) {
      throw new Error('La ficha que devolvió la IA no es JSON válido (' + e.message + ').');
    }
  }

  function parseAIProfile(text) {
    const obj = extractJSON(text);
    const p = sanitize({ ...obj, source: 'ia' });
    if (!p.vehicle.brand && !p.vehicle.model && !p.ecu.family) throw new Error('La ficha de la IA llegó vacía.');
    return p;
  }

  /**
   * Une una ficha existente con la que devuelve la IA al «completar»: conserva id, etiquetas, fechas
   * y todo lo que ya estaba escrito; la IA solo rellena huecos (sus correcciones van en «doubts»).
   */
  function mergeProfiles(base, gen) {
    const pick = (a, b) => (a != null && a !== '' ? a : b);
    const out = sanitize(base);
    for (const k of Object.keys(out.vehicle)) out.vehicle[k] = pick(out.vehicle[k], gen.vehicle[k]);
    for (const k of ['supplier', 'family', 'endian', 'protocol', 'hardware', 'software']) out.ecu[k] = pick(out.ecu[k], gen.ecu[k]);
    out.ecu.alternatives = [...new Set(out.ecu.alternatives.concat(gen.ecu.alternatives))].filter(a => a !== out.ecu.family).slice(0, LIMITS.alts);
    const byCode = new Map(out.dtcs.map(d => [d.code, d]));
    gen.dtcs.forEach(d => byCode.set(d.code, d));
    out.dtcs = [...byCode.values()].slice(0, LIMITS.dtcs);
    const byName = new Map(out.maps.map(m => [m.name.toLowerCase(), m]));
    gen.maps.forEach(m => byName.set(m.name.toLowerCase(), m));
    out.maps = [...byName.values()].slice(0, LIMITS.maps);
    out.livePids = gen.livePids.length ? gen.livePids : out.livePids;
    out.notes = !gen.notes || out.notes.includes(gen.notes) ? out.notes : (out.notes ? out.notes + '\n\n' : '') + gen.notes;
    out.doubts = gen.doubts;
    out.confidence = gen.confidence || out.confidence;
    out.updatedAt = new Date().toISOString();
    return out;
  }

  /** Texto de la ficha para el contexto del asistente. */
  function contextText(p) {
    if (!p) return '';
    const v = p.vehicle, e = p.ecu;
    const lines = [
      'VEHÍCULO ACTIVO: ' + label(p),
      'Motor: ' + [v.engineCode && 'código ' + v.engineCode, v.fuel, v.powerCv && v.powerCv + ' cv', v.torqueNm && v.torqueNm + ' Nm'].filter(Boolean).join(', '),
      'Centralita: ' + (ecuLabel(p) || 'sin indicar') + (e.endian ? '; orden de bytes ' + e.endian : '') + (e.protocol ? '; protocolo ELM ' + e.protocol : '') +
        (e.hardware ? '; HW ' + e.hardware : '') + (e.software ? '; SW ' + e.software : '')
    ];
    if (p.notes) lines.push('Notas de la ficha: ' + p.notes);
    if (p.maps.length) lines.push('Mapas típicos de la ficha: ' + p.maps.map(m => m.name + (m.unit ? ' (' + m.unit + (m.factor != null ? ', factor ' + m.factor : '') + ')' : '')).join('; '));
    if (p.doubts.length) lines.push('Por confirmar: ' + p.doubts.join('; '));
    if (p.confidence) lines.push('Fiabilidad de la ficha: ' + p.confidence + (p.source === 'ia' ? ' (generada con IA)' : ''));
    return lines.join('\n');
  }

  /** Ficha resumida (sin etiquetas) para enviarla a la IA al completar. */
  function forAI(p) {
    const s = sanitize(p);
    delete s.mapDefs;
    delete s.id;
    delete s.createdAt;
    delete s.updatedAt;
    delete s.source;
    return JSON.stringify(s);
  }

  return {
    newId, sanitize, fromLegacy, label, ecuLabel, endianForFamily,
    swKey, findDef, upsertDef, removeDef,
    profilePrompt, extractJSON, parseAIProfile, mergeProfiles, contextText, forAI
  };
});
