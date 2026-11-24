/*
 * ReproChip — asistente de IA (Claude).
 * Construye el contexto técnico que se envía con cada pregunta y convierte la respuesta
 * (Markdown sencillo) en HTML seguro.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RCAI = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BASE_PROMPT = [
    'Eres el asistente técnico de ReproChip, una aplicación de escritorio para leer centralitas de coche por OBD',
    'y analizar archivos de centralita (.bin). Hablas con un técnico de reprogramación en España.',
    '',
    'Cómo respondes:',
    '- En español de España, claro y directo, como un compañero de taller con experiencia en diagnosis y calibración de motores diésel common-rail (Bosch EDC16/EDC17, motores PSA DV6/HDi).',
    '- Empieza por la conclusión práctica; luego el porqué y los pasos para comprobarlo.',
    '- Usa los datos del contexto. Si un dato no está, dilo y explica cómo obtenerlo con la app.',
    '- Distingue lo seguro de lo probable. Los códigos P1xxx/P3xxx son propios de PSA: indica que la descripción puede variar.',
    '- Sobre mapas: identifica qué podría ser cada mapa por sus ejes y valores (cantidad de inyección, presión de turbo, limitador de humos, limitador de par, presión de rail, avance), con la cautela de que es una estimación.',
    '- Si se habla de aumentar valores, recuerda los límites mecánicos (embrague, turbo, temperatura de gases de escape, inyectores) y que tras modificar un archivo hay que recalcular el checksum con una herramienta profesional antes de escribirlo.',
    '- No des instrucciones para anular o eliminar sistemas anticontaminación (FAP/DPF, EGR, AdBlue/SCR, sondas) ni el inmovilizador: no es legal en vías públicas en España. Ofrece diagnosticar y reparar la causa de la avería.',
    '- Respuestas breves por defecto (máx. ~250 palabras) salvo que te pidan detalle. Puedes usar listas y tablas Markdown.'
  ].join('\n');

  function buildSystemPrompt(contextText) {
    return BASE_PROMPT + '\n\n=== CONTEXTO ACTUAL DE REPROCHIP ===\n' + (contextText || '(sin datos todavía)');
  }

  /* ---------------- Markdown mínimo y seguro ---------------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function inline(s) {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    return t;
  }

  function renderMarkdown(md) {
    const lines = String(md || '').replace(/\r/g, '').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push('<table><thead><tr>' + head.map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>' +
          rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
        continue;
      }
      let m;
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
        const lvl = Math.min(4, m[1].length + 2);
        out.push('<h' + lvl + '>' + inline(m[2]) + '</h' + lvl + '>');
        i++;
        continue;
      }
      if (/^\s*[-*•]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*•]\s+/, ''));
        out.push('<ul>' + items.map(t => '<li>' + inline(t) + '</li>').join('') + '</ul>');
        continue;
      }
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
        out.push('<ol>' + items.map(t => '<li>' + inline(t) + '</li>').join('') + '</ol>');
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*[-*•]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i])) para.push(lines[i++]);
      if (!para.length) { para.push(lines[i++]); }
      out.push('<p>' + para.map(inline).join('<br>') + '</p>');
    }
    return out.join('\n');
  }

  return { buildSystemPrompt, renderMarkdown, BASE_PROMPT };
});
