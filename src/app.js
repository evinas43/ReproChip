/* ReproChip — interfaz */
(function () {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const hx = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');
  const fmt = (v, dec = 0) => (v == null || !isFinite(v)) ? '—' : Number(v).toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec });

  const bridge = window.reprochip || null;
  const { ELM327 } = window.RCELM;
  const OBD = window.RCOBD;
  const BIN = window.RCBin;
  const PROF = window.RCProfiles;

  const DEFAULT_SETTINGS = {
    model: 'claude-sonnet-5-5',
    vehicle: { brand: 'Citroën', model: 'C4', engine: '1.6 HDi 92 cv', year: '', ecu: 'Bosch (EDC17C10 o EDC16C34, por confirmar)' },
    wifiHost: '192.168.0.10', wifiPort: 35000, baudRate: 'auto', protocol: '0', theme: 'dark', hasApiKey: false
  };

  // Paletas (modo oscuro): secuencial azul de menos a más; divergente azul ↔ rojo con gris neutro.
  const SEQ = ['#104281', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#b7d3f6', '#cde2fb'];
  const DIV = {
    dark: { up: ['#5c2b2a', '#8f3533', '#c24443', '#e66767'], down: ['#1e3a5f', '#1c5cab', '#2a78d6', '#5598e7'], zero: '#383835' },
    light: { up: ['#f6d4d3', '#eca4a3', '#d9605f', '#b83a39'], down: ['#d4e4f8', '#a6c8f0', '#5f9be3', '#2a6fc4'], zero: '#e2e1dc' }
  };
  /** Texto oscuro o claro según lo claro que sea el fondo. */
  function fgFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return L > 0.179 ? '#0b0b0b' : '#f0efec';
  }

  /* ---- Tema: colores leídos de las variables CSS (para los canvas) ---- */
  let themeCache = null;
  function tc() {
    if (themeCache) return themeCache;
    const cs = getComputedStyle(document.documentElement);
    const g = n => cs.getPropertyValue(n).trim();
    themeCache = {
      name: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
      grid: g('--grid'), axis: g('--axis'), muted: g('--muted'), text: g('--text'), text2: g('--text-2'),
      surface: g('--surface'), surface3: g('--surface-3'), accent: g('--accent'), accentText: g('--accent-text'),
      seriesB: g('--series-b'), drag: g('--drag'), pull: g('--pull-fill'), pullSel: g('--pull-fill-sel')
    };
    return themeCache;
  }

  const state = {
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    conn: { status: 'off', transport: null, elm: null, info: null, type: null },
    ident: null,
    uds: null,
    dtc: null,
    live: { supported: null, selected: new Set(OBD.DEFAULT_LIVE), running: false, recording: false, recStart: 0, rows: [], series: {}, cards: {}, hz: 0, errors: 0 },
    bin: { a: null, aName: '', b: null, bName: '', bIsWork: false, info: null, maps: [], endian: null, diff: null, sel: null, hexOffset: 0,
      edit: { on: false, sel: new Set(), anchor: null, drag: false, hist: new RCEdit.History(), dirty: false } },
    ai: { messages: [], busy: false },
    prof: { profiles: [], activeId: null, selectedId: null, draft: null },
    termHistory: [],
    termIdx: -1
  };

  /* ================= Utilidades de interfaz ================= */
  let toastTimer = null;
  function toast(msg, ms = 3200) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  let modalOnClose = null;
  function openModal({ title, body, actions, onClose }) {
    $('#modalTitle').textContent = title || '';
    const b = $('#modalBody');
    b.innerHTML = '';
    if (typeof body === 'string') b.innerHTML = body; else if (body) b.appendChild(body);
    const a = $('#modalActions');
    a.innerHTML = '';
    for (const act of actions || []) {
      const btn = document.createElement('button');
      btn.textContent = act.label;
      if (act.cls) btn.className = act.cls;
      btn.addEventListener('click', () => act.onClick && act.onClick());
      a.appendChild(btn);
    }
    modalOnClose = onClose || null;
    $('#modal').classList.remove('hidden');
  }
  function closeModal(silent) {
    $('#modal').classList.add('hidden');
    const cb = modalOnClose;
    modalOnClose = null;
    if (cb && !silent) cb();
  }
  function askConfirm(title, text, okLabel, danger) {
    return new Promise(resolve => {
      openModal({
        title,
        body: '<p>' + esc(text) + '</p>',
        actions: [
          { label: 'Cancelar', cls: 'ghost', onClick: () => { closeModal(true); resolve(false); } },
          { label: okLabel || 'Aceptar', cls: danger ? 'danger' : 'primary', onClick: () => { closeModal(true); resolve(true); } }
        ],
        onClose: () => resolve(false)
      });
    });
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal(); });

  function showTip(html, x, y) {
    const t = $('#tooltip');
    t.innerHTML = html;
    t.classList.remove('hidden');
    const r = t.getBoundingClientRect();
    let left = x + 14, top = y + 14;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
    t.style.left = left + 'px';
    t.style.top = top + 'px';
  }
  function hideTip() { $('#tooltip').classList.add('hidden'); }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    ta.remove();
    return ok;
  }

  async function saveTextFile(name, content, filterName, ext) {
    if (bridge && bridge.saveFile) {
      const p = await bridge.saveFile({ defaultName: name, content, filters: [{ name: filterName, extensions: [ext] }] });
      if (p) toast('Guardado en ' + p);
      return;
    }
    const blob = new Blob(['\ufeff' + content], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Leyendo…'; btn.disabled = true; }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; refreshButtons(); }
  }

  /* ================= Navegación ================= */
  function showSection(id) {
    $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.section === id));
    $$('.section').forEach(s => s.classList.toggle('active', s.id === 'sec-' + id));
    if (id === 'live') ensureSupported();
    if (id === 'logs') { renderLogPidPicker(); renderLogsAll(); if (isConnected() && !state.live.supported) ensureSupported().then(renderLogPidPicker); }
    if (id === 'vehicles') renderProfiles();
    if (id === 'ai') refreshAiNotice();
    if (id === 'term') { const el = $('#termLog'); el.scrollTop = el.scrollHeight; $('#termCmd').focus(); }
  }
  $$('#nav button').forEach(b => b.addEventListener('click', () => showSection(b.dataset.section)));

  /* ================= Ajustes ================= */
  const LS_KEY = 'reprochip.settings';
  async function loadSettings() {
    if (bridge) {
      try { state.settings = { ...DEFAULT_SETTINGS, ...(await bridge.settings.get()) }; } catch (_) {}
    } else {
      try {
        const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
        state.settings = { ...DEFAULT_SETTINGS, ...raw, vehicle: { ...DEFAULT_SETTINGS.vehicle, ...(raw.vehicle || {}) } };
      } catch (_) {}
    }
    applySettingsToUI();
  }
  async function saveSettings(partial) {
    if (bridge) {
      state.settings = { ...DEFAULT_SETTINGS, ...(await bridge.settings.set(partial)) };
    } else {
      const rest = { ...partial };
      delete rest.apiKey;
      state.settings = { ...state.settings, ...rest, vehicle: { ...state.settings.vehicle, ...(rest.vehicle || {}) } };
      try { localStorage.setItem(LS_KEY, JSON.stringify(state.settings)); } catch (_) {}
    }
    applySettingsToUI();
  }
  function vehicleText() {
    const p = activeProfile();
    if (p) return PROF.label(p);
    const v = state.settings.vehicle || {};
    return [v.brand, v.model, v.engine, v.year].filter(Boolean).join(' ');
  }
  function applySettingsToUI() {
    const s = state.settings;
    updateVehicleLabel();
    $('#model').value = s.model || '';
    $('#wifiHost').value = s.wifiHost || '192.168.0.10';
    $('#wifiPort').value = s.wifiPort || 35000;
    $('#baud').value = s.baudRate || 'auto';
    $('#protocol').value = s.protocol || '0';
    applyTheme(s.theme || 'dark');
    const ks = $('#keyStatus');
    if (!bridge) {
      ks.textContent = 'El asistente solo funciona dentro de la app de escritorio.';
      $('#apiKey').disabled = true;
      $('#btnSaveKey').disabled = true;
      $('#btnDeleteKey').disabled = true;
    } else {
      ks.textContent = s.hasApiKey ? 'Clave guardada' + (s.encrypted ? ' (cifrada)' : '') + '.' : 'No hay ninguna clave guardada.';
    }
    refreshAiNotice();
  }
  $('#btnSaveKey').addEventListener('click', async () => {
    const partial = { model: $('#model').value.trim() };
    const k = $('#apiKey').value.trim();
    if (k) partial.apiKey = k;
    await saveSettings(partial);
    $('#apiKey').value = '';
    toast('Ajustes de la API guardados');
  });
  $('#btnDeleteKey').addEventListener('click', async () => {
    if (!(await askConfirm('Borrar clave', '¿Quieres borrar la clave de API guardada en este ordenador?', 'Borrar', true))) return;
    await saveSettings({ apiKey: '' });
    toast('Clave borrada');
  });
  $('#goVehicles').addEventListener('click', e => { e.preventDefault(); showSection('vehicles'); });

  /* ================= Tema ================= */
  const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
  function effectiveTheme(t) { return t === 'light' ? 'light' : t === 'system' ? (darkMQ.matches ? 'dark' : 'light') : 'dark'; }
  function applyTheme(t) {
    const eff = effectiveTheme(t);
    const root = document.documentElement;
    const r = $('input[name="theme"][value="' + (t || 'dark') + '"]');
    if (r) r.checked = true;
    try { localStorage.setItem('reprochip.theme', JSON.stringify({ theme: t || 'dark', eff })); } catch (_) {}
    if (root.dataset.theme === eff && themeCache) return;
    root.dataset.theme = eff;
    themeCache = null;
    redrawCanvases();
  }
  function redrawCanvases() {
    Object.keys(state.live.cards).forEach(p => drawSpark(Number(p)));
    if (state.logs && logA()) drawLogChart();
    $$('#logCmpCharts canvas, #dynoCharts canvas').forEach(cv => cv._chart && drawCmpChart(cv._chart));
    if (state.bin.sel) renderMap();
  }
  $$('input[name="theme"]').forEach(r => r.addEventListener('change', () => {
    applyTheme(r.value);
    saveSettings({ theme: r.value }).catch(() => {});
  }));
  darkMQ.addEventListener('change', () => { if ((state.settings.theme || 'dark') === 'system') applyTheme('system'); });

  /* ================= Conexión ================= */
  const isConnected = () => state.conn.status === 'on' && !!state.conn.elm;

  function setConn(status, text) {
    state.conn.status = status;
    const pill = $('#connPill');
    pill.className = 'pill ' + status;
    pill.querySelector('.txt').textContent = text || ({ on: 'Conectado', off: 'Desconectado', busy: 'Conectando…', err: 'Error' })[status];
    const info = state.conn.info;
    $('#protoLabel').textContent = status === 'on' && info ? info.protocolName : '';
    $('#voltLabel').textContent = status === 'on' && info && info.voltage ? info.voltage : '';
    refreshButtons();
  }

  function refreshButtons() {
    const on = isConnected();
    $$('.needs-conn').forEach(b => { if (!b.dataset.label || b.textContent === b.dataset.label) b.disabled = !on; });
    $('#btnConnect').disabled = state.conn.status === 'on' || state.conn.status === 'busy';
    $('#btnDisconnect').disabled = state.conn.status !== 'on' && state.conn.status !== 'busy';
    $('#btnLiveStart').disabled = !on || state.live.running;
    $('#btnLiveStop').disabled = !state.live.running;
    $('#btnCsv').disabled = state.live.rows.length === 0;
    if (state.logs) {
      if (state.logs.rec.on) $('#btnLogRec').disabled = false;
      refreshLogButtons();
    }
  }

  function connType() { return ($('input[name="ctype"]:checked') || {}).value || 'serial'; }
  function updateConnFields() {
    const t = connType();
    $$('[data-for]').forEach(el => el.classList.toggle('hidden', el.dataset.for !== t));
  }
  $$('input[name="ctype"]').forEach(r => r.addEventListener('change', updateConnFields));

  function connLog(text, cls) {
    const ol = $('#connLog');
    const li = document.createElement('li');
    li.textContent = text;
    if (cls) li.className = cls;
    ol.appendChild(li);
    ol.scrollTop = ol.scrollHeight;
  }

  async function autoBaud(transport) {
    const rates = [38400, 115200, 9600, 57600, 230400, 500000];
    for (const rate of rates) {
      connLog('Probando ' + rate + ' baudios…');
      try {
        await transport.open(rate);
      } catch (e) {
        throw new Error('No se pudo abrir el puerto: ' + e.message);
      }
      const probe = new ELM327(transport, {});
      await transport.write('\r').catch(() => {});
      await sleep(150);
      const r = await probe.probe(1200);
      if (r) { connLog('Adaptador encontrado a ' + rate + ' baudios', 'ok'); return rate; }
      await transport.close();
      await sleep(150);
    }
    throw new Error('No se encontró ningún ELM327 en ese puerto. Prueba otra velocidad o revisa el adaptador.');
  }

  function elmLog(dir, data, cmd) {
    if ((state.live.looping || (state.logs && state.logs.rec.looping)) && !$('#termShowLive').checked && /^01([0-9A-F]{2})+$/i.test(cmd || '')) return;
    if (dir === 'tx') termAppend('tx', '> ' + data);
    else termAppend('rx', String(data).replace(/\r\n?/g, '\n').replace(/\n+$/, '').replace(/^\n+/, ''));
  }

  async function connect() {
    const type = connType();
    let transport = null;
    $('#connLog').innerHTML = '';
    $('#connSummary').classList.add('hidden');
    try {
      if (type === 'serial') {
        if (!RCTransport.WebSerialTransport.isAvailable()) throw new Error('Este entorno no permite puertos serie. Usa la app de escritorio (o Chrome/Edge).');
        transport = new RCTransport.WebSerialTransport();
        await transport.requestPort(); // primero, dentro del clic
        setConn('busy');
        const baud = $('#baud').value;
        if (baud === 'auto') await autoBaud(transport);
        else { connLog('Abriendo puerto a ' + baud + ' baudios…'); await transport.open(parseInt(baud, 10)); }
      } else if (type === 'wifi') {
        if (!bridge) throw new Error('La conexión WiFi solo funciona en la app de escritorio.');
        setConn('busy');
        const host = $('#wifiHost').value.trim();
        const port = parseInt($('#wifiPort').value, 10);
        connLog('Conectando con ' + host + ':' + port + '…');
        transport = new RCTransport.TcpTransport(bridge);
        await transport.open(host, port);
        saveSettings({ wifiHost: host, wifiPort: port }).catch(() => {});
      } else {
        setConn('busy');
        connLog('Arrancando el simulador…');
        transport = new RCTransport.SimTransport(new RCSim.ELMSimulator());
        await transport.open();
      }

      const elm = new ELM327(transport, { log: elmLog });
      transport.onClose = msg => handleDisconnect(msg || 'Conexión perdida');
      state.conn.transport = transport;
      state.conn.elm = elm;
      state.conn.type = type;
      const info = await elm.init({ protocol: $('#protocol').value, onStep: s => connLog(s) });
      state.conn.info = info;
      connLog('Conectado.', 'ok');
      saveSettings({ protocol: $('#protocol').value, baudRate: $('#baud').value }).catch(() => {});
      renderConnSummary();
      setConn('on', type === 'sim' ? 'Conectado (simulador)' : 'Conectado');
      state.live.supported = null;
      state.logs.rec.mode = null;
      if ($('#sec-logs').classList.contains('active')) ensureSupported().then(renderLogPidPicker);
      termAppend('sys', '— Conectado: ' + info.version + ' · ' + info.protocolName + ' —');
      if ($('#sec-live').classList.contains('active')) ensureSupported();
    } catch (e) {
      const msg = e && e.name === 'NotFoundError' ? 'No se eligió ningún puerto.' : (e && e.message) || String(e);
      connLog('Error: ' + msg, 'error');
      if (state.conn.elm) { try { await state.conn.elm.close(); } catch (_) {} }
      else if (transport) { try { await transport.close(); } catch (_) {} }
      state.conn = { status: 'off', transport: null, elm: null, info: null, type: null };
      setConn('off');
    }
  }

  function renderConnSummary() {
    const i = state.conn.info;
    const t = $('#connSummary');
    const rows = [
      ['Adaptador', i.version + (i.stn ? ' · ' + i.stn : '')],
      ['Conexión', state.conn.transport.label + (state.conn.transport.baudRate ? ' · ' + state.conn.transport.baudRate + ' baudios' : '')],
      ['Protocolo', i.protocolName],
      ['Tensión', i.voltage || '—'],
      ['Centralitas', (i.ecus || []).join(', ') || '—']
    ];
    t.innerHTML = rows.map(r => '<tr><td>' + esc(r[0]) + '</td><td class="val">' + esc(r[1]) + '</td></tr>').join('');
    t.classList.remove('hidden');
  }

  async function disconnect(reason) {
    stopLive();
    state.logs.rec.on = false;
    const elm = state.conn.elm;
    state.conn = { status: 'off', transport: null, elm: null, info: null, type: null };
    if (elm) { try { await elm.close(); } catch (_) {} }
    setConn('off');
    if (reason) { connLog(reason, 'error'); toast(reason); }
    termAppend('sys', '— Desconectado —');
  }
  function handleDisconnect(msg) {
    if (state.conn.status === 'off') return;
    disconnect(msg);
  }

  $('#btnConnect').addEventListener('click', connect);
  $('#btnDisconnect').addEventListener('click', () => disconnect());

  if (bridge && bridge.serial) {
    bridge.serial.onChoose(list => {
      if (!list || !list.length) {
        openModal({
          title: 'No se encontró ningún puerto',
          body: '<p>Conecta el adaptador por USB o empareja el Bluetooth en el sistema y vuelve a intentarlo.</p><p class="muted small">En Windows puede hacer falta el driver del chip del adaptador (CH340, FTDI o CP210x).</p>',
          actions: [{ label: 'Cerrar', cls: 'primary', onClick: () => closeModal() }],
          onClose: () => bridge.serial.choose('')
        });
        return;
      }
      const wrap = document.createElement('div');
      wrap.className = 'port-list';
      for (const p of list) {
        const b = document.createElement('button');
        b.innerHTML = '<span>' + esc(p.displayName || p.portName || 'Puerto') + '</span><span class="pn">' + esc(p.portName) + (p.vendorId ? ' · USB ' + esc(p.vendorId) + ':' + esc(p.productId) : '') + '</span>';
        b.addEventListener('click', () => { closeModal(true); bridge.serial.choose(p.portId); });
        wrap.appendChild(b);
      }
      openModal({
        title: 'Elige el puerto del adaptador',
        body: wrap,
        actions: [{ label: 'Cancelar', cls: 'ghost', onClick: () => closeModal() }],
        onClose: () => bridge.serial.choose('')
      });
    });
  }

  function requireConn() {
    if (!isConnected()) { toast('Primero conecta con el adaptador (pestaña Conexión).'); return false; }
    return true;
  }

  /* ================= Identificación ================= */
  $('#btnIdent').addEventListener('click', async e => {
    if (!requireConn()) return;
    const btn = e.currentTarget;
    busy(btn, true);
    const elm = state.conn.elm;
    const out = {};
    const tryRead = async (k, fn) => { try { out[k] = await fn(elm); } catch (err) { out[k] = { error: err.message }; } };
    try {
      try { out.supported09 = [...(await OBD.getSupportedPids(elm, 0x09))]; } catch (err) { out.supported09 = null; }
      await tryRead('vin', OBD.readVIN);
      await tryRead('calid', OBD.readCalibrationIds);
      await tryRead('cvn', OBD.readCVNs);
      await tryRead('ecuName', OBD.readEcuName);
      state.ident = out;
      renderIdent();
    } finally { busy(btn, false); }
  });

  function identValue(v) {
    if (v == null) return '<span class="muted">—</span>';
    if (v.error) return '<span class="muted">' + esc(v.error) + '</span>';
    if (Array.isArray(v)) return v.length ? v.map(esc).join('<br>') : '<span class="muted">vacío</span>';
    return esc(v) || '<span class="muted">vacío</span>';
  }

  function renderIdent() {
    const d = state.ident;
    const i = state.conn.info || {};
    const rows = [
      ['VIN (bastidor)', identValue(d.vin)],
      ['Calibration ID (software)', identValue(d.calid)],
      ['CVN (suma de verificación)', identValue(d.cvn)],
      ['Nombre de la centralita', identValue(d.ecuName)],
      ['PIDs del modo 09', d.supported09 ? esc(d.supported09.map(p => hx(p)).join(' ')) : '<span class="muted">—</span>'],
      ['Protocolo', esc(i.protocolName || '—')],
      ['Adaptador', esc(i.version || '—')]
    ];
    $('#identTable').innerHTML = rows.map(r => '<tr><td>' + r[0] + '</td><td class="val">' + r[1] + '</td></tr>').join('');
  }

  $('#btnUds').addEventListener('click', async e => {
    if (!requireConn()) return;
    const btn = e.currentTarget;
    busy(btn, true, 'Leyendo UDS…');
    try {
      state.uds = await OBD.readUdsIdentification(state.conn.elm, label => { btn.textContent = label + '…'; });
      renderUds();
    } catch (err) {
      $('#udsTable').innerHTML = '<tr><td class="muted">' + esc(err.message) + '</td></tr>';
    } finally { busy(btn, false); }
  });

  function renderUds() {
    $('#udsTable').innerHTML = '<thead><tr><th>DID</th><th>Dato</th><th>Valor</th></tr></thead><tbody>' +
      state.uds.map(r => '<tr><td class="mono">' + esc(r.did) + '</td><td>' + esc(r.label) + '</td><td class="mono">' + (r.value ? esc(r.value) : '<span class="muted">' + esc(r.error) + '</span>') + '</td></tr>').join('') + '</tbody>';
  }

  function identText() {
    const d = state.ident || {};
    const val = v => v == null ? '—' : v.error ? '(' + v.error + ')' : Array.isArray(v) ? v.join(', ') : v;
    const lines = [
      'Vehículo: ' + vehicleText(),
      'VIN: ' + val(d.vin),
      'Calibration ID: ' + val(d.calid),
      'CVN: ' + val(d.cvn),
      'Nombre ECU: ' + val(d.ecuName),
      'Protocolo: ' + ((state.conn.info || {}).protocolName || '—')
    ];
    if (state.uds) state.uds.forEach(r => lines.push('UDS ' + r.did + ' ' + r.label + ': ' + (r.value || '(' + r.error + ')')));
    return lines.join('\n');
  }

  $('#btnIdentCopy').addEventListener('click', async () => {
    if (!state.ident && !state.uds) { toast('Aún no hay datos leídos.'); return; }
    toast((await copyText(identText())) ? 'Identificación copiada' : 'No se pudo copiar');
  });
  $('#btnIdentProf').addEventListener('click', () => openProfileAI(null, { ident: true }));
  $('#btnIdentAI').addEventListener('click', () => askAI('Con la identificación leída (Calibration ID, CVN, VIN y datos UDS), ¿qué centralita y versión de software lleva el coche y qué debo tener en cuenta antes de preparar un archivo para este motor?'));

  /* ================= Averías ================= */
  $('#btnDtcRead').addEventListener('click', e => readDtcs(e.currentTarget));

  async function readDtcs(btn) {
    if (!requireConn()) return;
    busy(btn, true);
    const elm = state.conn.elm;
    const d = {};
    try {
      try { d.status = await OBD.readMonitorStatus(elm); } catch (_) { d.status = null; }
      for (const [k, mode] of [['stored', 0x03], ['pending', 0x07], ['permanent', 0x0a]]) {
        try { d[k] = await OBD.readDTCs(elm, mode); } catch (err) { d[k] = { error: err.message }; }
      }
      d.time = new Date();
      state.dtc = d;
      renderDtcs();
    } finally { if (btn) busy(btn, false); }
  }

  const ICON_ALERT = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l10 18H2z" fill="#d03b3b"/><path d="M12 10v5M12 18v.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>';
  const ICON_OK = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#0ca30c"/><path d="M7 12.5l3 3 7-7" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /** Descripción de una avería: la base local o, si no la conoce, la ficha del vehículo activo. */
  function dtcText(c) {
    const p = activeProfile();
    const fromProf = p && p.dtcs.find(d => d.code === c.code);
    if (fromProf && !c.known) return { text: fromProf.text, fromProfile: true };
    return { text: c.text, fromProfile: false };
  }

  function renderDtcs() {
    const d = state.dtc;
    const box = $('#milBox');
    const total = Array.isArray(d.stored) ? d.stored.length : 0;
    if (d.status) {
      box.className = 'banner ' + (d.status.mil ? 'crit' : 'good');
      box.innerHTML = (d.status.mil ? ICON_ALERT + '<strong>Testigo de avería encendido</strong>' : ICON_OK + '<strong>Testigo de avería apagado</strong>') +
        '<span class="muted">· ' + d.status.count + ' código(s) según la centralita · leído a las ' + d.time.toLocaleTimeString('es-ES') + '</span>';
    } else {
      box.className = 'banner';
      box.innerHTML = '<span class="muted">No se pudo leer el estado del testigo. ' + total + ' código(s) memorizado(s).</span>';
    }
    const list = (id, cntId, v, emptyText) => {
      const el = $(id);
      if (v && v.error) { el.innerHTML = '<p class="muted small">' + esc(v.error) + '</p>'; $(cntId).textContent = ''; return; }
      $(cntId).textContent = '(' + v.length + ')';
      el.innerHTML = v.length ? v.map(c => { const t = dtcText(c); return '<div class="dtc"><span class="code">' + esc(c.code) + '</span><span class="desc">' + esc(t.text) + '</span><span class="cat">' + esc(c.category) + (t.fromProfile ? ' · descripción de la ficha' : '') + (c.ecu ? ' · ECU ' + esc(c.ecu) : '') + '</span></div>'; }).join('') : '<p class="muted small">' + emptyText + '</p>';
    };
    list('#dtcStored', '#cntStored', d.stored, 'Sin averías memorizadas.');
    list('#dtcPending', '#cntPending', d.pending, 'Sin averías pendientes.');
    list('#dtcPermanent', '#cntPermanent', d.permanent, 'Sin averías permanentes.');
  }

  $('#btnDtcClear').addEventListener('click', async e => {
    if (!requireConn()) return;
    const ok = await askConfirm('Borrar averías',
      'Se borrarán los códigos memorizados y los datos de los monitores de emisiones (el coche tendrá que volver a hacer los ciclos de prueba). Hazlo con el contacto puesto y el motor parado. ¿Continuar?',
      'Borrar averías', true);
    if (!ok) return;
    const btn = e.currentTarget;
    busy(btn, true, 'Borrando…');
    try {
      await OBD.clearDTCs(state.conn.elm);
      toast('Averías borradas');
    } catch (err) {
      toast('No se pudieron borrar: ' + err.message, 5000);
    } finally { busy(btn, false); }
    await readDtcs($('#btnDtcRead'));
  });
  $('#btnDtcAI').addEventListener('click', () => askAI('Explícame las averías leídas: causa probable en este motor, cómo comprobarlas y qué revisar primero.'));

  /* ================= Datos en vivo ================= */
  async function ensureSupported() {
    renderPidPicker();
    if (!isConnected() || state.live.supported || state.live.loadingSupported) return;
    state.live.loadingSupported = true;
    try {
      state.live.supported = await OBD.getSupportedPids(state.conn.elm, 0x01);
      const ap = activeProfile();
      const fromProf = ap ? ap.livePids.filter(p => OBD.PIDS[p] && state.live.supported.has(p)) : [];
      if (fromProf.length) state.live.selected = new Set(fromProf);
      for (const p of [...state.live.selected]) if (!state.live.supported.has(p)) state.live.selected.delete(p);
    } catch (e) {
      toast('No se pudieron leer los PIDs admitidos: ' + e.message, 5000);
    } finally { state.live.loadingSupported = false; }
    renderPidPicker();
    buildCards();
  }

  function renderPidPicker() {
    const sup = state.live.supported;
    const pids = Object.keys(OBD.PIDS).map(Number).sort((a, b) => a - b);
    const list = $('#pidList');
    list.innerHTML = pids.map(p => {
      const def = OBD.PIDS[p];
      const ok = !sup || sup.has(p);
      return '<label class="chk' + (ok ? '' : ' unsupported') + '" title="PID ' + hx(p) + (ok ? '' : ' · no admitido') + '"><input type="checkbox" data-pid="' + p + '"' +
        (state.live.selected.has(p) ? ' checked' : '') + (ok ? '' : ' disabled') + '><span>' + esc(def.name) + (def.unit ? ' <span class="muted">(' + esc(def.unit) + ')</span>' : '') + '</span></label>';
    }).join('');
    $('#pidCount').textContent = state.live.selected.size;
    $$('input[data-pid]', list).forEach(cb => cb.addEventListener('change', () => {
      const p = Number(cb.dataset.pid);
      if (cb.checked) state.live.selected.add(p); else state.live.selected.delete(p);
      $('#pidCount').textContent = state.live.selected.size;
      buildCards();
    }));
  }

  function buildCards() {
    const wrap = $('#liveCards');
    wrap.innerHTML = '';
    state.live.cards = {};
    for (const pid of [...state.live.selected].sort((a, b) => a - b)) {
      const def = OBD.PIDS[pid];
      const el = document.createElement('div');
      el.className = 'gauge stale';
      el.innerHTML = '<div class="name"><span>' + esc(def.short) + '</span><span class="range"></span></div>' +
        '<div class="value">—<span class="unit">' + esc(def.unit) + '</span></div><canvas></canvas>';
      el.title = def.name + ' (PID ' + hx(pid) + ')';
      wrap.appendChild(el);
      const card = { el, valueEl: $('.value', el), rangeEl: $('.range', el), canvas: $('canvas', el), hover: null };
      state.live.cards[pid] = card;
      card.canvas.addEventListener('mousemove', ev => sparkHover(pid, ev));
      card.canvas.addEventListener('mouseleave', () => { card.hover = null; hideTip(); drawSpark(pid); });
      updateCard(pid);
    }
  }

  function pushSeries(pid, v) {
    const s = state.live.series[pid] || (state.live.series[pid] = []);
    s.push({ t: Date.now(), v });
    if (s.length > 300) s.shift();
  }

  function seriesStats(pid) {
    const s = state.live.series[pid] || [];
    if (!s.length) return null;
    let mn = Infinity, mx = -Infinity, sum = 0;
    for (const p of s) { if (p.v < mn) mn = p.v; if (p.v > mx) mx = p.v; sum += p.v; }
    return { last: s[s.length - 1].v, min: mn, max: mx, avg: sum / s.length, n: s.length, span: (s[s.length - 1].t - s[0].t) / 1000 };
  }

  function updateCard(pid) {
    const card = state.live.cards[pid];
    if (!card) return;
    const def = OBD.PIDS[pid];
    const st = seriesStats(pid);
    if (st) {
      card.el.classList.remove('stale');
      card.valueEl.innerHTML = fmt(st.last, def.dec) + '<span class="unit">' + esc(def.unit) + '</span>';
      card.rangeEl.textContent = fmt(st.min, def.dec) + ' – ' + fmt(st.max, def.dec);
    }
    drawSpark(pid);
  }

  function drawSpark(pid) {
    const card = state.live.cards[pid];
    if (!card) return;
    const cv = card.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = tc().grid;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h - 0.5); ctx.lineTo(w, h - 0.5); ctx.stroke();
    const s = (state.live.series[pid] || []).slice(-120);
    if (s.length < 2) return;
    let mn = Infinity, mx = -Infinity;
    for (const p of s) { if (p.v < mn) mn = p.v; if (p.v > mx) mx = p.v; }
    if (mx - mn < 1e-9) { mx += 1; mn -= 1; }
    const pad = 4;
    const X = i => (i / (s.length - 1)) * (w - 2) + 1;
    const Y = v => h - pad - ((v - mn) / (mx - mn)) * (h - pad * 2);
    ctx.strokeStyle = tc().accent;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    s.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p.v)) : ctx.moveTo(X(i), Y(p.v))));
    ctx.stroke();
    card.layout = { s, X, Y };
    if (card.hover != null && card.hover < s.length) {
      const i = card.hover;
      ctx.strokeStyle = tc().muted;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(X(i) + 0.5, 0); ctx.lineTo(X(i) + 0.5, h); ctx.stroke();
      ctx.fillStyle = tc().accent;
      ctx.strokeStyle = tc().surface;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(X(i), Y(s[i].v), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }

  function sparkHover(pid, ev) {
    const card = state.live.cards[pid];
    const s = (state.live.series[pid] || []).slice(-120);
    if (s.length < 2) return;
    const rect = card.canvas.getBoundingClientRect();
    const i = Math.max(0, Math.min(s.length - 1, Math.round(((ev.clientX - rect.left - 1) / (rect.width - 2)) * (s.length - 1))));
    card.hover = i;
    drawSpark(pid);
    const def = OBD.PIDS[pid];
    const ago = (Date.now() - s[i].t) / 1000;
    showTip('<strong>' + fmt(s[i].v, def.dec) + ' ' + esc(def.unit) + '</strong> <span class="tk">· hace ' + fmt(ago, 1) + ' s</span>', ev.clientX, ev.clientY);
  }

  async function liveLoop() {
    const L = state.live;
    if (L.looping) return;
    L.running = true;
    L.looping = true;
    L.errors = 0;
    refreshButtons();
    while (L.running && isConnected()) {
      const pids = [...L.selected].sort((a, b) => a - b);
      if (!pids.length) { await sleep(300); continue; }
      const t0 = performance.now();
      const row = { t: Date.now() };
      let ok = 0;
      for (const pid of pids) {
        if (!L.running || !isConnected()) break;
        try {
          const v = await OBD.readPid(state.conn.elm, pid);
          row[pid] = v;
          pushSeries(pid, v);
          updateCard(pid);
          ok++;
        } catch (e) {
          row[pid] = null;
          if (e.code === 'CLOSED') break;
        }
      }
      L.errors = ok ? 0 : L.errors + 1;
      if (L.errors >= 5) { toast('La centralita ha dejado de responder. Datos en vivo detenidos.', 5000); break; }
      L.hz = 1000 / Math.max(1, performance.now() - t0);
      $('#liveHz').textContent = fmt(L.hz, 1) + ' lecturas completas/s';
      if (L.recording) {
        L.rows.push(row);
        $('#recInfo').textContent = 'Grabando: ' + L.rows.length + ' muestras · ' + fmt((Date.now() - L.recStart) / 1000, 0) + ' s';
      }
    }
    L.running = false;
    L.looping = false;
    refreshButtons();
  }

  function stopLive() {
    state.live.running = false;
    refreshButtons();
  }

  $('#btnLiveStart').addEventListener('click', async () => {
    if (!requireConn()) return;
    if (state.logs.rec.on) { toast('Se está grabando un log (pestaña Logs). Los valores se ven aquí igualmente.'); return; }
    await ensureSupported();
    if (!Object.keys(state.live.cards).length) buildCards();
    liveLoop();
  });
  $('#btnLiveStop').addEventListener('click', stopLive);
  $('#btnRec').addEventListener('click', () => {
    const L = state.live;
    L.recording = !L.recording;
    $('#btnRec').classList.toggle('recording', L.recording);
    $('#btnRec').lastChild.textContent = L.recording ? 'Detener grabación' : 'Grabar';
    if (L.recording) {
      L.rows = [];
      L.recStart = Date.now();
      $('#recInfo').textContent = 'Grabando…';
      if (!L.running && isConnected()) $('#btnLiveStart').click();
    } else {
      $('#recInfo').textContent = L.rows.length ? L.rows.length + ' muestras grabadas' : '';
      if (L.rows.length > 1) {
        const log = LOG.fromRows(L.rows, { name: 'Datos en vivo ' + new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }), source: 'live', PIDS: OBD.PIDS });
        state.logs.list.push(log);
        $('#recInfo').textContent += ' · también en la pestaña Logs';
      }
    }
    refreshButtons();
  });
  $('#btnCsv').addEventListener('click', () => {
    const L = state.live;
    if (!L.rows.length) return;
    const pids = [...new Set(L.rows.flatMap(r => Object.keys(r).filter(k => k !== 't').map(Number)))].sort((a, b) => a - b);
    const head = ['tiempo_s'].concat(pids.map(p => OBD.PIDS[p].short + (OBD.PIDS[p].unit ? ' (' + OBD.PIDS[p].unit + ')' : '')));
    const t0 = L.rows[0].t;
    const lines = [head.join(';')].concat(L.rows.map(r => [((r.t - t0) / 1000).toFixed(2).replace('.', ',')].concat(pids.map(p => r[p] == null ? '' : Number(r[p]).toFixed(OBD.PIDS[p].dec + 1).replace('.', ','))).join(';')));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    saveTextFile('reprochip_log_' + stamp + '.csv', lines.join('\r\n'), 'CSV', 'csv');
  });
  $('#btnProfPids').addEventListener('click', () => {
    const ap = activeProfile();
    const pids = ap ? ap.livePids.filter(p => OBD.PIDS[p] && (!state.live.supported || state.live.supported.has(p))) : [];
    if (!pids.length) { toast(ap ? 'La ficha activa no tiene PIDs recomendados que admita esta centralita.' : 'No hay ningún vehículo activo.'); return; }
    state.live.selected = new Set(pids);
    renderPidPicker();
    buildCards();
    toast('Parámetros de la ficha: ' + pids.length);
  });
  $('#btnLiveAI').addEventListener('click', () => askAI('Analiza los datos en vivo: ¿hay algo fuera de lo normal en turbo, caudalímetro, presión de rail o EGR para este motor? Ten en cuenta régimen y carga.'));
  window.addEventListener('resize', () => Object.keys(state.live.cards).forEach(p => drawSpark(Number(p))));

  /* ================= Logs ================= */
  const LOG = window.RCLog;
  const LOG_PRESETS = {
    pull: [0x0C, 0x49, 0x0B, 0x23, 0x10, 0x62, 0x0D, 0x0F],
    diag: [0x0C, 0x49, 0x05, 0x0F, 0x0B, 0x10, 0x23, 0x2C, 0x2D, 0x04, 0x0D, 0x42]
  };
  // Orden de las franjas de la gráfica: primero lo que manda (régimen, pedal) y luego la respuesta del motor.
  const LANE_ORDER = [0x0C, 0x49, 0x4A, 0x11, 0x4C, 0x0B, 0x23, 0x22, 0x10, 0x62, 0x61, 0x04, 0x43, 0x0D, 0x0F, 0x05, 0x5C, 0x2C, 0x2D, 0x5E, 0x42];
  const laneRank = key => { const p = LOG.pidOf(key); const i = p == null ? -1 : LANE_ORDER.indexOf(p); return i >= 0 ? i : 100 + (p == null ? 200 : p); };
  const COL = { get A() { return tc().accent; }, get B() { return tc().seriesB; } };

  state.logs = { list: [], aId: null, bId: null, pulls: {}, selPull: null, cmpA: null, cmpB: null, preset: 'pull',
    pids: new Set(LOG_PRESETS.pull), view: null, hover: null, drag: null, rec: { on: false, looping: false, log: null, mode: null } };

  const logById = id => state.logs.list.find(l => l.id === id) || null;
  const logA = () => logById(state.logs.aId);
  const logB = () => logById(state.logs.bId);
  const isRecLog = log => state.logs.rec.on && state.logs.rec.log === log;
  function pullsOf(log) {
    if (!log) return [];
    if (isRecLog(log)) return LOG.detectPulls(log);
    return state.logs.pulls[log.id] || (state.logs.pulls[log.id] = LOG.detectPulls(log));
  }
  const fmtDur = s => s >= 60 ? Math.floor(s / 60) + ' min ' + String(Math.round(s % 60)).padStart(2, '0') + ' s' : fmt(s, 1) + ' s';
  const pullLabel = (log, p) => { const s = LOG.pullStats(log, p); return 'T' + p.n + ' · ' + fmt(s.rpmStart) + '→' + fmt(s.rpmEnd) + ' rpm · ' + fmt(s.duration, 1) + ' s'; };

  /* ---- Qué grabar ---- */
  function renderLogPidPicker() {
    const sup = state.live.supported;
    const L = state.logs;
    const pids = Object.keys(OBD.PIDS).map(Number).sort((a, b) => a - b);
    $('#logPidList').innerHTML = pids.map(p => {
      const def = OBD.PIDS[p];
      const ok = !sup || sup.has(p);
      return '<label class="chk' + (ok ? '' : ' unsupported') + '" title="PID ' + hx(p) + (ok ? '' : ' · no admitido') + '"><input type="checkbox" data-lpid="' + p + '"' +
        (L.pids.has(p) && ok ? ' checked' : '') + (ok && !L.rec.on ? '' : ' disabled') + '><span>' + esc(def.name) + (def.unit ? ' <span class="muted">(' + esc(def.unit) + ')</span>' : '') + '</span></label>';
    }).join('');
    $$('#logPidList input[data-lpid]').forEach(cb => cb.addEventListener('change', () => {
      const p = Number(cb.dataset.lpid);
      if (cb.checked) L.pids.add(p); else L.pids.delete(p);
      L.preset = 'custom';
      const r = $('input[name="logPreset"][value="custom"]');
      if (r) r.checked = true;
      renderLogPidHint();
    }));
    renderLogPidHint();
  }
  function logRecPids() {
    const sup = state.live.supported;
    return [...state.logs.pids].filter(p => OBD.PIDS[p] && (!sup || sup.has(p))).sort((a, b) => laneRank(LOG.keyOf(a)) - laneRank(LOG.keyOf(b)));
  }
  function renderLogPidHint() {
    const list = logRecPids();
    const n = list.length;
    $('#logPidSummary').innerHTML = n ? list.map(p => '<span class="badge">' + esc(OBD.PIDS[p].short) + '</span>').join('') : '<span class="muted">Ningún parámetro elegido.</span>';
    let txt = n + ' parámetros. Cuantos menos, más muestras por segundo: para un tirón conviene no pasar de 8.';
    if (!state.live.supported) txt += ' Al conectar se desactivan los que no admita la centralita.';
    if (state.logs.rec.mode === 'multi') txt += ' Esta centralita admite varias PIDs por petición: se piden de 6 en 6.';
    $('#logPidHint').textContent = txt;
  }
  $$('input[name="logPreset"]').forEach(r => r.addEventListener('change', () => {
    const L = state.logs;
    L.preset = r.value;
    if (r.value !== 'custom') L.pids = new Set(LOG_PRESETS[r.value]);
    renderLogPidPicker();
  }));

  /* ---- Grabación ---- */
  function updateLogRecUI() {
    const R = state.logs.rec;
    const btn = $('#btnLogRec');
    btn.classList.toggle('recording', R.on);
    btn.lastChild.textContent = R.on ? 'Detener grabación' : 'Grabar log';
    if (R.on) btn.disabled = false;
    const log = R.log;
    if (R.on && log) {
      const d = LOG.duration(log);
      $('#logRecInfo').textContent = 'Grabando: ' + fmtDur(d) + ' · ' + log.rows.length + ' muestras · ' + fmt(LOG.rate(log), 1) + ' muestras/s' +
        (R.mode === 'multi' ? ' (varias PIDs por petición)' : '');
    }
    $$('#logPidList input').forEach(cb => { if (R.on) cb.disabled = true; });
    $$('input[name="logPreset"]').forEach(r => { r.disabled = R.on; });
    refreshLogButtons();
  }
  function refreshLogButtons() {
    const a = logA();
    $('#btnLogSave').disabled = !a || isRecLog(a) || !a.rows.length;
    $('#btnLogAI').disabled = !a || !a.rows.length;
  }

  async function startLogRec() {
    if (!requireConn()) return;
    const R = state.logs.rec;
    if (R.on) return;
    if (state.live.running) { stopLive(); while (state.live.looping) await sleep(30); }
    await ensureSupported();
    renderLogPidPicker();
    const pids = logRecPids();
    if (!pids.length) { toast('Elige al menos un parámetro que admita la centralita.'); return; }
    const now = new Date();
    const log = LOG.newLog({
      name: 'Log ' + now.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + (state.conn.type === 'sim' ? ' (simulador)' : ''),
      source: 'rec', keys: pids.map(LOG.keyOf), PIDS: OBD.PIDS
    });
    state.logs.list.push(log);
    state.logs.aId = log.id;
    state.logs.view = null;
    state.logs.selPull = null;
    R.on = true;
    R.log = log;
    updateLogRecUI();
    renderLogsAll();
    logLoop(log, pids);
  }

  async function logLoop(log, pids) {
    const R = state.logs.rec;
    R.looping = true;
    const elm = state.conn.elm;
    const useMulti = elm.isCAN && pids.length > 1;
    const t0 = performance.now();
    let errors = 0, lastDraw = 0;
    try {
      while (R.on && isConnected()) {
        const a = performance.now();
        const vals = {};
        if (useMulti && R.mode !== 'single') {
          try { Object.assign(vals, await OBD.readPids(elm, pids)); }
          catch (e) { if (e.code === 'CLOSED') break; }
          // La primera vez se decide: si la centralita no devuelve todas las PIDs juntas, se piden de una en una.
          if (R.mode == null) { R.mode = pids.every(p => vals[p] != null) ? 'multi' : 'single'; renderLogPidHint(); }
        }
        if (!(useMulti && R.mode === 'multi')) {
          for (const p of pids) {
            if (vals[p] != null) continue;
            if (!R.on || !isConnected()) break;
            try { vals[p] = await OBD.readPid(elm, p); }
            catch (e) { if (e.code === 'CLOSED') throw e; }
          }
        }
        const b = performance.now();
        const got = pids.filter(p => vals[p] != null);
        errors = got.length ? 0 : errors + 1;
        if (errors >= 5) { toast('La centralita ha dejado de responder. Grabación detenida.', 5000); break; }
        if (got.length) {
          const row = { t: ((a + b) / 2 - t0) / 1000 };
          for (const p of pids) {
            const v = vals[p] != null ? vals[p] : null;
            row[LOG.keyOf(p)] = v;
            if (v != null) { pushSeries(p, v); updateCard(p); }
          }
          log.rows.push(row);
        }
        if (b - lastDraw > 350) {
          lastDraw = b;
          updateLogRecUI();
          if ($('#sec-logs').classList.contains('active') && state.logs.aId === log.id) { drawLogChart(); renderLogPulls(); }
        }
      }
    } catch (_) { /* conexión cerrada */ }
    R.on = false;
    R.looping = false;
    finishLogRec(log);
  }

  function finishLogRec(log) {
    const L = state.logs;
    L.rec.log = null;
    if (log.rows.length < 2) {
      L.list = L.list.filter(l => l !== log);
      if (L.aId === log.id) L.aId = L.list.length ? L.list[L.list.length - 1].id : null;
      $('#logRecInfo').textContent = 'No se grabó ningún dato.';
    } else {
      delete L.pulls[log.id];
      const n = pullsOf(log).length;
      $('#logRecInfo').textContent = 'Log grabado: ' + fmtDur(LOG.duration(log)) + ', ' + log.rows.length + ' muestras (' + fmt(LOG.rate(log), 1) + '/s), ' + n + (n === 1 ? ' tirón.' : ' tirones.');
    }
    updateLogRecUI();
    renderLogPidPicker();
    renderLogsAll();
    refreshButtons();
  }

  $('#btnLogRec').addEventListener('click', () => {
    if (state.logs.rec.on) { state.logs.rec.on = false; $('#logRecInfo').textContent = 'Deteniendo…'; }
    else startLogRec();
  });

  /* ---- Lista de logs ---- */
  const SOURCE_LABEL = { rec: 'Grabado', file: 'Archivo', live: 'Datos en vivo' };
  function renderLogList() {
    const L = state.logs;
    $('#logCount').textContent = L.list.length ? L.list.length : '';
    const el = $('#logList');
    if (!L.list.length) {
      el.innerHTML = '<div class="empty">Aún no hay logs. Conecta y pulsa «Grabar log», o abre un CSV.<br><span class="small">Sin coche: conecta el simulador; hace un tirón a fondo cada 24 segundos.</span></div>';
      return;
    }
    el.innerHTML = '<table class="data log-table"><thead><tr><th>Nombre</th><th>Origen</th><th class="num">Duración</th><th class="num">Muestras/s</th><th class="num">Parámetros</th><th class="num">Tirones</th><th></th></tr></thead><tbody>' +
      L.list.slice().reverse().map(l => {
        const rec = isRecLog(l);
        const np = rec ? '…' : pullsOf(l).length;
        return '<tr data-id="' + l.id + '" class="' + (l.id === L.aId ? 'sel' : '') + '"><td>' + esc(l.name) +
          (l.id === L.aId ? '<span class="badge a">A</span>' : '') + (l.id === L.bId ? '<span class="badge b">B</span>' : '') + (rec ? '<span class="badge rec">grabando</span>' : '') +
          '</td><td>' + esc(SOURCE_LABEL[l.source] || l.source) + '</td><td class="num">' + fmtDur(LOG.duration(l)) + '</td><td class="num">' + fmt(LOG.rate(l), 1) +
          '</td><td class="num">' + l.keys.length + '</td><td class="num">' + np + '</td><td><div class="log-actions">' +
          '<button data-act="a" title="Ver en la gráfica">Ver</button>' +
          '<button data-act="b"' + (rec ? ' disabled' : '') + ' title="Usar como B en la comparación">' + (l.id === L.bId ? 'Quitar de B' : 'Comparar') + '</button>' +
          '<button data-act="ren" class="ghost">Renombrar</button>' +
          '<button data-act="save" class="ghost"' + (rec ? ' disabled' : '') + '>Guardar</button>' +
          '<button data-act="del" class="ghost"' + (rec ? ' disabled' : '') + '>Quitar</button></div></td></tr>';
      }).join('') + '</tbody></table>';
    $$('#logList tbody tr').forEach(tr => tr.addEventListener('click', e => {
      const id = tr.dataset.id;
      const act = e.target.closest('button') ? e.target.closest('button').dataset.act : 'a';
      logAction(id, act);
    }));
  }

  function selectLogA(id) {
    const L = state.logs;
    if (L.aId !== id) { L.aId = id; L.view = null; L.selPull = null; L.cmpA = null; }
  }

  async function logAction(id, act) {
    const L = state.logs;
    const log = logById(id);
    if (!log) return;
    if (act === 'a') selectLogA(id);
    else if (act === 'b') { L.bId = L.bId === id ? null : id; L.cmpB = null; }
    else if (act === 'save') return saveLog(log);
    else if (act === 'ren') return renameLog(log);
    else if (act === 'del') {
      if (!(await askConfirm('Quitar log', 'Se quita «' + log.name + '» de la lista. Si no lo has guardado, se pierde.', 'Quitar', true))) return;
      L.list = L.list.filter(l => l !== log);
      delete L.pulls[log.id];
      if (L.bId === id) L.bId = null;
      if (L.aId === id) { L.aId = L.list.length ? L.list[L.list.length - 1].id : null; L.view = null; L.selPull = null; }
    }
    renderLogsAll();
  }

  function renameLog(log) {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<div class="field"><label for="logNewName">Nombre</label><input id="logNewName"></div>';
    const input = $('input', wrap);
    input.value = log.name;
    const done = () => { const v = input.value.trim(); if (v) log.name = v.slice(0, 80); closeModal(true); renderLogsAll(); };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') done(); });
    openModal({ title: 'Renombrar log', body: wrap, actions: [{ label: 'Cancelar', cls: 'ghost', onClick: () => closeModal(true) }, { label: 'Guardar', cls: 'primary', onClick: done }] });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  }

  function saveLog(log) {
    if (!log || !log.rows.length) return;
    const safe = log.name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '_').slice(0, 80) || 'log';
    saveTextFile('reprochip_' + safe + '.csv', LOG.toCSV(log), 'CSV', 'csv');
  }
  $('#btnLogSave').addEventListener('click', () => saveLog(logA()));

  $('#logOpen').addEventListener('change', async e => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    const opened = [];
    for (const f of files) {
      try {
        const text = await f.text();
        const log = LOG.parseCSV(text, { name: f.name.replace(/\.[^.]+$/, ''), PIDS: OBD.PIDS });
        state.logs.list.push(log);
        opened.push(log);
      } catch (err) {
        toast('No se pudo leer «' + f.name + '»: ' + err.message, 6000);
      }
    }
    if (!opened.length) return;
    selectLogA(opened[0].id);
    if (opened.length > 1) { state.logs.bId = opened[1].id; state.logs.cmpB = null; }
    toast(opened.length === 1 ? 'Abierto «' + opened[0].name + '»' : 'Abiertos ' + opened.length + ' logs: el primero como A y el segundo como B');
    renderLogsAll();
  });

  /* ---- Gráfica de tiempo ---- */
  const LC = { laneH: 58, gap: 6, top: 4, axisH: 24, padL: 8, padR: 8, labelH: 16 };

  function laneKeys(log) {
    return log.keys.filter(k => LOG.has(log, k)).sort((a, b) => laneRank(a) - laneRank(b));
  }
  function logView(log) {
    const dur = LOG.duration(log);
    if (state.logs.view) return state.logs.view;
    if (isRecLog(log)) return { t0: Math.max(0, dur - 60), t1: Math.max(dur, 10) };
    return { t0: 0, t1: Math.max(dur, 1) };
  }
  function niceStep(range, target) {
    const raw = range / Math.max(1, target);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  }
  const fmtT = s => s >= 60 ? Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0') : fmt(s, s < 10 && s % 1 ? 1 : 0) + ' s';

  function chartGeom(cv) {
    const w = cv.clientWidth;
    const log = logA();
    const v = log ? logView(log) : { t0: 0, t1: 1 };
    const X = t => LC.padL + ((t - v.t0) / (v.t1 - v.t0)) * (w - LC.padL - LC.padR);
    const T = x => v.t0 + ((x - LC.padL) / (w - LC.padL - LC.padR)) * (v.t1 - v.t0);
    return { w, v, X, T };
  }

  function drawLogChart() {
    const cv = $('#logChart');
    const log = logA();
    if (!log) return;
    const keys = laneKeys(log);
    const H = LC.top + Math.max(1, keys.length) * (LC.laneH + LC.gap) + LC.axisH;
    if (cv.style.height !== H + 'px') cv.style.height = H + 'px';
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    if (!w) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(H * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, H);
    const { v, X, T } = chartGeom(cv);
    const plotBottom = H - LC.axisH;
    ctx.font = '12px ' + getComputedStyle(document.body).fontFamily;
    ctx.textBaseline = 'middle';

    if (!keys.length) {
      ctx.fillStyle = tc().muted;
      ctx.fillText(isRecLog(log) ? 'Esperando datos…' : 'Este log no tiene datos.', 12, 30);
      return;
    }

    // Tirones sombreados
    for (const p of pullsOf(log)) {
      if (p.t1 < v.t0 || p.t0 > v.t1) continue;
      const x0 = Math.max(LC.padL, X(p.t0)), x1 = Math.min(w - LC.padR, X(p.t1));
      ctx.fillStyle = p.n === state.logs.selPull ? tc().pullSel : tc().pull;
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), plotBottom);
      ctx.fillStyle = tc().accentText;
      ctx.textAlign = 'left';
      if (x1 - x0 > 22) ctx.fillText('T' + p.n, x0 + 4, plotBottom - 9);
    }

    const rows = log.rows;
    const i0 = Math.max(0, LOG.lowerBound(rows, v.t0) - 1);
    const i1 = Math.min(rows.length, LOG.lowerBound(rows, v.t1) + 1);
    const hoverT = state.logs.hover;

    keys.forEach((k, li) => {
      const def = log.defs[k];
      const y0 = LC.top + li * (LC.laneH + LC.gap);
      const py0 = y0 + LC.labelH, py1 = y0 + LC.laneH - 3;
      let mn = Infinity, mx = -Infinity;
      for (let i = i0; i < i1; i++) { const val = rows[i][k]; if (val == null) continue; if (val < mn) mn = val; if (val > mx) mx = val; }
      // Línea base de la franja
      ctx.strokeStyle = tc().grid;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(LC.padL, y0 + LC.laneH + 0.5); ctx.lineTo(w - LC.padR, y0 + LC.laneH + 0.5); ctx.stroke();
      // Nombre y valor
      ctx.textAlign = 'left';
      ctx.fillStyle = tc().text2;
      const name = def.short + (def.unit ? ' (' + def.unit + ')' : '');
      ctx.fillText(name, LC.padL + 2, y0 + LC.labelH / 2 + 1);
      const hv = hoverT != null ? LOG.valueAt(log, k, hoverT) : null;
      ctx.textAlign = 'right';
      if (hv != null) {
        ctx.fillStyle = tc().text;
        ctx.font = '600 12px ' + getComputedStyle(document.body).fontFamily;
        ctx.fillText(fmt(hv, def.dec), w - LC.padR, y0 + LC.labelH / 2 + 1);
        ctx.font = '12px ' + getComputedStyle(document.body).fontFamily;
      } else if (mn <= mx) {
        ctx.fillStyle = tc().muted;
        ctx.fillText(fmt(mn, def.dec) + ' – ' + fmt(mx, def.dec), w - LC.padR, y0 + LC.labelH / 2 + 1);
      }
      if (!(mn <= mx)) return;
      if (mx - mn < 1e-9) { mx += 1; mn -= 1; }
      const Y = val => py1 - ((val - mn) / (mx - mn)) * (py1 - py0);
      ctx.save();
      ctx.beginPath(); ctx.rect(LC.padL, y0, w - LC.padL - LC.padR, LC.laneH); ctx.clip();
      ctx.strokeStyle = COL.A;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let prevT = null;
      for (let i = i0; i < i1; i++) {
        const r = rows[i];
        if (r[k] == null) continue;
        const x = X(r.t), y = Y(r[k]);
        if (prevT == null || r.t - prevT > 3) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        prevT = r.t;
      }
      ctx.stroke();
      if (hv != null) {
        ctx.fillStyle = COL.A;
        ctx.strokeStyle = tc().surface;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(X(hoverT), Y(hv), 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    });

    // Eje de tiempo
    ctx.strokeStyle = tc().axis;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(LC.padL, plotBottom + 0.5); ctx.lineTo(w - LC.padR, plotBottom + 0.5); ctx.stroke();
    const step = niceStep(v.t1 - v.t0, Math.max(2, Math.floor(w / 110)));
    ctx.fillStyle = tc().muted;
    ctx.textAlign = 'center';
    for (let t = Math.ceil(v.t0 / step) * step; t <= v.t1 + 1e-9; t += step) {
      const x = X(t);
      ctx.beginPath(); ctx.moveTo(x + 0.5, plotBottom); ctx.lineTo(x + 0.5, plotBottom + 4); ctx.stroke();
      if (x > 20 && x < w - 20) ctx.fillText(fmtT(t), x, plotBottom + 14);
    }

    // Cursor
    if (hoverT != null && hoverT >= v.t0 && hoverT <= v.t1) {
      const x = Math.round(X(hoverT)) + 0.5;
      ctx.strokeStyle = tc().muted;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotBottom); ctx.stroke();
      const label = fmt(hoverT, 2) + ' s';
      ctx.font = '600 12px ' + getComputedStyle(document.body).fontFamily;
      const tw = ctx.measureText(label).width + 12;
      const lx = Math.min(w - tw - 2, Math.max(2, x - tw / 2));
      ctx.fillStyle = tc().surface3;
      ctx.fillRect(lx, plotBottom + 3, tw, 18);
      ctx.fillStyle = tc().text;
      ctx.textAlign = 'center';
      ctx.fillText(label, lx + tw / 2, plotBottom + 12);
    }
    // Selección para ampliar
    const d = state.logs.drag;
    if (d && Math.abs(d.x1 - d.x0) > 2) {
      ctx.fillStyle = tc().drag;
      ctx.fillRect(Math.min(d.x0, d.x1), 0, Math.abs(d.x1 - d.x0), plotBottom);
    }
  }

  (function wireLogChart() {
    const cv = $('#logChart');
    const xOf = e => e.clientX - cv.getBoundingClientRect().left;
    cv.addEventListener('mousemove', e => {
      const log = logA();
      if (!log) return;
      const g = chartGeom(cv);
      const x = xOf(e);
      state.logs.hover = Math.max(g.v.t0, Math.min(g.v.t1, g.T(x)));
      if (state.logs.drag) state.logs.drag.x1 = x;
      drawLogChart();
    });
    cv.addEventListener('mouseleave', () => { state.logs.hover = null; drawLogChart(); });
    cv.addEventListener('mousedown', e => { if (e.button === 0 && logA()) { const x = xOf(e); state.logs.drag = { x0: x, x1: x }; } });
    window.addEventListener('mouseup', () => {
      const d = state.logs.drag;
      if (!d) return;
      state.logs.drag = null;
      const log = logA();
      if (!log) return;
      const g = chartGeom(cv);
      if (Math.abs(d.x1 - d.x0) > 6) {
        let t0 = g.T(Math.min(d.x0, d.x1)), t1 = g.T(Math.max(d.x0, d.x1));
        if (t1 - t0 < 0.5) { const c = (t0 + t1) / 2; t0 = c - 0.25; t1 = c + 0.25; }
        state.logs.view = { t0: Math.max(0, t0), t1 };
      } else {
        const t = g.T(d.x0);
        const p = pullsOf(log).find(q => t >= q.t0 && t <= q.t1);
        if (p) { state.logs.selPull = p.n; renderLogPulls(); }
      }
      drawLogChart();
    });
    cv.addEventListener('dblclick', () => { state.logs.view = null; drawLogChart(); });
    cv.addEventListener('wheel', e => {
      const log = logA();
      if (!log) return;
      e.preventDefault();
      const g = chartGeom(cv);
      const dur = Math.max(LOG.duration(log), 1);
      const f = e.deltaY > 0 ? 1.25 : 0.8;
      const tc = g.T(xOf(e));
      const span = Math.max(0.5, (g.v.t1 - g.v.t0) * f);
      if (span >= dur && !isRecLog(log)) { state.logs.view = null; drawLogChart(); return; }
      let t0 = tc - (tc - g.v.t0) * f;
      t0 = Math.max(0, Math.min(t0, dur - span));
      state.logs.view = { t0, t1: t0 + span };
      drawLogChart();
    }, { passive: false });
    $('#btnLogZoomReset').addEventListener('click', () => { state.logs.view = null; drawLogChart(); });
  })();

  /* ---- Tabla de tirones ---- */
  function renderLogPulls() {
    const log = logA();
    const el = $('#logPulls');
    const pulls = pullsOf(log);
    $('#logPullCount').textContent = pulls.length ? pulls.length : '';
    if (!log) { el.innerHTML = ''; return; }
    if (!pulls.length) {
      const why = !LOG.driverKey(log) ? 'Este log no tiene la posición del pedal ni de la mariposa: añádela a lo que se graba para detectar tirones.'
        : !LOG.has(log, LOG.K.rpm) ? 'Este log no tiene el régimen del motor (RPM).'
        : 'No hay ningún tramo a fondo con el régimen subiendo.';
      el.innerHTML = '<p class="muted small">' + esc(why) + '</p>';
      return;
    }
    const cell = (v, d) => '<td class="num">' + fmt(v, d) + '</td>';
    el.innerHTML = '<table class="data log-table"><thead><tr><th>Tirón</th><th class="num">Inicio</th><th class="num">Duración</th><th class="num">Régimen (rpm)</th><th class="num">Sobrepresión máx (bar)</th>' +
      '<th class="num">Rail máx (bar)</th><th class="num">MAF máx (g/s)</th><th class="num">Par real máx (%)</th><th class="num">Aire admisión (°C)</th><th class="num">Velocidad (km/h)</th></tr></thead><tbody>' +
      pulls.map(p => {
        const s = LOG.pullStats(log, p);
        return '<tr data-n="' + p.n + '" class="' + (p.n === state.logs.selPull ? 'sel' : '') + '"><td>T' + p.n + '</td>' + '<td class="num">' + fmtT(p.t0) + '</td>' + cell(s.duration, 1) +
          '<td class="num">' + fmt(s.rpmStart) + ' → ' + fmt(s.rpmEnd) + '</td>' +
          '<td class="num">' + fmt(s.boostMax, 2) + (s.boostRpm != null ? ' <span class="muted">a ' + fmt(s.boostRpm) + '</span>' : '') + '</td>' +
          '<td class="num">' + fmt(s.railMax) + (s.railRpm != null ? ' <span class="muted">a ' + fmt(s.railRpm) + '</span>' : '') + '</td>' +
          cell(s.mafMax, 1) + cell(s.torqueMax) +
          '<td class="num">' + (s.iatMax != null ? fmt(s.iatStart) + ' → ' + fmt(s.iatMax) : '—') + '</td>' +
          '<td class="num">' + (s.speedStart != null ? fmt(s.speedStart) + ' → ' + fmt(s.speedEnd) : '—') + '</td></tr>';
      }).join('') + '</tbody></table>';
    $$('#logPulls tbody tr').forEach(tr => tr.addEventListener('click', () => {
      const p = pulls.find(q => q.n === Number(tr.dataset.n));
      if (!p) return;
      state.logs.selPull = p.n;
      state.logs.cmpA = p.n;
      const pad = Math.max(1, (p.t1 - p.t0) * 0.25);
      state.logs.view = { t0: Math.max(0, p.t0 - pad), t1: p.t1 + pad };
      renderLogPulls();
      drawLogChart();
      renderLogCompare();
      $('#logViewCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  }

  /* ---- Comparación por régimen ---- */
  const CMP_CHANNELS = [
    { key: '0B', title: 'Sobrepresión (bar)', dec: 2, map: (log, v) => (v - LOG.baroOf(log)) / 100 },
    { key: '23', title: 'Presión de rail (bar)', dec: 0 },
    { key: '10', title: 'Caudal de aire MAF (g/s)', dec: 1 },
    { key: '62', title: 'Par real (%)', dec: 0 },
    { key: '04', title: 'Carga calculada (%)', dec: 0 },
    { key: '0F', title: 'Aire de admisión (°C)', dec: 0 }
  ];

  function cmpPulls() {
    const L = state.logs, a = logA(), b = logB();
    if (!a || !b) return null;
    const pa = pullsOf(a), pb = pullsOf(b);
    if (!pa.length || !pb.length) return { a, b, pa, pb, A: null, B: null };
    let A = pa.find(p => p.n === L.cmpA) || pa.find(p => p.n === L.selPull) || LOG.bestPull(a, pa);
    let B = pb.find(p => p.n === L.cmpB);
    if (!B) B = a === b ? (pb.find(p => p.n !== A.n) || pb[0]) : LOG.bestPull(b, pb);
    return { a, b, pa, pb, A, B };
  }

  function renderLogCompare() {
    renderLogCompareCard();
    renderDyno();
  }
  function renderLogCompareCard() {
    const card = $('#logCmpCard');
    const c = cmpPulls();
    if (!c || isRecLog(c.a) || isRecLog(c.b)) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    const opts = (log, pulls, sel) => pulls.map(p => '<option value="' + p.n + '"' + (sel && p.n === sel.n ? ' selected' : '') + '>' + esc(pullLabel(log, p)) + '</option>').join('');
    $('#logCmpPullA').innerHTML = opts(c.a, c.pa, c.A);
    $('#logCmpPullB').innerHTML = opts(c.b, c.pb, c.B);
    if (!c.A || !c.B) {
      $('#logCmpLegend').innerHTML = '';
      $('#logCmpTable').innerHTML = '<p class="muted small">' + esc(!c.pa.length ? 'El log A' : 'El log B') + ' no tiene tirones a fondo para comparar.</p>';
      $('#logCmpCharts').innerHTML = '';
      return;
    }
    $('#logCmpLegend').innerHTML = '<span><span class="sw a"></span>A: ' + esc(c.a.name) + ' · T' + c.A.n + '</span><span><span class="sw b"></span>B: ' + esc(c.b.name) + ' · T' + c.B.n + '</span>';
    const sa = LOG.pullStats(c.a, c.A), sb = LOG.pullStats(c.b, c.B);
    const rows = [
      ['Sobrepresión máx', sa.boostMax, sb.boostMax, 2, 'bar'],
      ['Presión de rail máx', sa.railMax, sb.railMax, 0, 'bar'],
      ['MAF máx', sa.mafMax, sb.mafMax, 1, 'g/s'],
      ['Par real máx', sa.torqueMax, sb.torqueMax, 0, '%'],
      ['Aire de admisión máx', sa.iatMax, sb.iatMax, 0, '°C']
    ];
    const span = LOG.commonRpmSpan(c.a, c.A, c.b, c.B);
    if (span) rows.push(['Tiempo de ' + fmt(span[0]) + ' a ' + fmt(span[1]) + ' rpm', LOG.timeBetweenRpm(c.a, c.A, span[0], span[1]), LOG.timeBetweenRpm(c.b, c.B, span[0], span[1]), 2, 's', true]);
    const shown = rows.filter(r => r[1] != null || r[2] != null);
    $('#logCmpTable').innerHTML = '<table class="data log-table cmp-table"><thead><tr><th>Medida</th><th class="num">A</th><th class="num">B</th><th class="num">A frente a B</th></tr></thead><tbody>' +
      shown.map(r => {
        let diff = '—';
        if (r[1] != null && r[2] != null && r[2] !== 0) {
          const pct = ((r[1] - r[2]) / Math.abs(r[2])) * 100;
          diff = (pct >= 0 ? '+' : '') + fmt(pct, 1) + ' %' + (r[5] ? ' <span class="muted">(' + (pct < 0 ? 'A más rápido' : pct > 0 ? 'A más lento' : 'igual') + ')</span>' : '');
        }
        return '<tr><td>' + esc(r[0]) + '</td><td class="num">' + fmt(r[1], r[3]) + ' ' + esc(r[4]) + '</td><td class="num">' + fmt(r[2], r[3]) + ' ' + esc(r[4]) + '</td><td class="num">' + diff + '</td></tr>';
      }).join('') + '</tbody></table>';

    const wrap = $('#logCmpCharts');
    wrap.innerHTML = '';
    for (const ch of CMP_CHANNELS) {
      if (!LOG.has(c.a, ch.key) || !LOG.has(c.b, ch.key)) continue;
      const conv = (log, pts) => pts.map(p => ({ rpm: p.rpm, v: ch.map ? ch.map(log, p.v) : p.v }));
      const ca = conv(c.a, LOG.byRpm(c.a, c.A, ch.key, 100)), cb = conv(c.b, LOG.byRpm(c.b, c.B, ch.key, 100));
      if (ca.length < 2 && cb.length < 2) continue;
      const box = document.createElement('div');
      box.className = 'cmp-chart';
      box.innerHTML = '<h3>' + esc(ch.title) + '</h3><canvas></canvas>';
      wrap.appendChild(box);
      const cv = $('canvas', box);
      const chart = { cv, ca, cb, dec: ch.dec, hover: null };
      cv._chart = chart;
      cv.addEventListener('mousemove', e => cmpHover(chart, e));
      cv.addEventListener('mouseleave', () => { chart.hover = null; hideTip(); drawCmpChart(chart); });
      drawCmpChart(chart);
    }
    if (!wrap.children.length) wrap.innerHTML = '<p class="muted small">Los dos logs no tienen parámetros en común para dibujar curvas (MAP, rail, MAF, par…).</p>';
  }

  function curveAt(curve, rpm) {
    if (!curve.length || rpm < curve[0].rpm || rpm > curve[curve.length - 1].rpm) return null;
    for (let i = 1; i < curve.length; i++) {
      if (curve[i].rpm >= rpm) { const p = curve[i - 1], q = curve[i]; return p.v + ((q.v - p.v) * (rpm - p.rpm)) / (q.rpm - p.rpm || 1); }
    }
    return curve[curve.length - 1].v;
  }

  function drawCmpChart(chart) {
    const { cv, ca, cb } = chart;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const all = ca.concat(cb);
    let rx0 = Math.min(...all.map(p => p.rpm)), rx1 = Math.max(...all.map(p => p.rpm));
    let mn = Math.min(...all.map(p => p.v)), mx = Math.max(...all.map(p => p.v));
    if (rx1 - rx0 < 1) rx1 = rx0 + 100;
    if (mx - mn < 1e-9) { mx += 1; mn -= 1; }
    const ys = niceStep(mx - mn, 4);
    mn = Math.floor(mn / ys) * ys; mx = Math.ceil(mx / ys) * ys;
    const padL = 46, padR = 10, padT = 8, padB = 22;
    const X = r => padL + ((r - rx0) / (rx1 - rx0)) * (w - padL - padR);
    const Y = v => h - padB - ((v - mn) / (mx - mn)) * (h - padT - padB);
    chart.geom = { X, rx0, rx1, padL, padR, w };
    ctx.font = '11.5px ' + getComputedStyle(document.body).fontFamily;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    let ydec = 0;
    while (ydec < 4 && Math.abs(ys * 10 ** ydec - Math.round(ys * 10 ** ydec)) > 1e-6) ydec++;
    for (let v = mn; v <= mx + ys / 2; v += ys) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = tc().grid;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillStyle = tc().muted;
      ctx.textAlign = 'right';
      ctx.fillText(fmt(v, ydec), padL - 6, y);
    }
    const xs = niceStep(rx1 - rx0, Math.max(2, Math.floor(w / 90)));
    ctx.textAlign = 'center';
    for (let r = Math.ceil(rx0 / xs) * xs; r <= rx1; r += xs) ctx.fillText(fmt(r), X(r), h - padB + 12);
    const line = (pts, col, dash) => {
      if (pts.length < 1) return;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(X(p.rpm), Y(p.v)) : ctx.moveTo(X(p.rpm), Y(p.v))));
      ctx.stroke();
      ctx.setLineDash([]);
    };
    line(cb, COL.B, [5, 4]);
    line(ca, COL.A);
    if (chart.hover != null) {
      const x = Math.round(X(chart.hover)) + 0.5;
      ctx.strokeStyle = tc().muted;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke();
      for (const [curve, col] of [[cb, COL.B], [ca, COL.A]]) {
        const v = curveAt(curve, chart.hover);
        if (v == null) continue;
        ctx.fillStyle = col;
        ctx.strokeStyle = tc().surface;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(X(chart.hover), Y(v), 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
  }

  function cmpHover(chart, e) {
    const g = chart.geom;
    if (!g) return;
    const rect = chart.cv.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const rpm = g.rx0 + ((x - g.padL) / (g.w - g.padL - g.padR)) * (g.rx1 - g.rx0);
    chart.hover = Math.max(g.rx0, Math.min(g.rx1, rpm));
    drawCmpChart(chart);
    const va = curveAt(chart.ca, chart.hover), vb = curveAt(chart.cb, chart.hover);
    const u = chart.unit ? ' ' + esc(chart.unit) : '';
    let html = '<strong>' + fmt(chart.hover) + ' rpm</strong><br><span style="color:' + COL.A + '">A</span> ' + fmt(va, chart.dec) + u +
      (chart.cb.length ? ' · <span style="color:' + COL.B + '">B</span> ' + fmt(vb, chart.dec) + u : '');
    if (va != null && vb != null && Math.abs(vb) > 1e-9) { const pct = ((va - vb) / Math.abs(vb)) * 100; html += ' <span class="tk">(' + (pct >= 0 ? '+' : '') + fmt(pct, 1) + ' %)</span>'; }
    showTip(html, e.clientX, e.clientY);
  }

  $('#logCmpPullA').addEventListener('change', e => { state.logs.cmpA = Number(e.target.value); renderLogCompare(); });
  $('#logCmpPullB').addEventListener('change', e => { state.logs.cmpB = Number(e.target.value); renderLogCompare(); });

  /* ---- Dinamómetro virtual ---- */
  const DYNO_FIELDS = [['mass', '#dynoMass', 0], ['cda', '#dynoCda', 2], ['crr', '#dynoCrr', 3], ['loss', '#dynoLoss', 0]];
  function dynoOpts() { return { ...LOG.DYNO_DEFAULTS, ...(state.settings.dyno || {}) }; }
  function fillDynoInputs() {
    const o = dynoOpts();
    for (const [k, sel, d] of DYNO_FIELDS) if (document.activeElement !== $(sel)) $(sel).value = fmt(o[k], d).replace(/\./g, '');
  }
  let dynoSaveTimer = null;
  function onDynoInput() {
    const d = {};
    for (const [k, sel] of DYNO_FIELDS) {
      const v = Number($(sel).value.replace(/\./g, '').replace(',', '.'));
      const ok = isFinite(v) && v > 0 && (k !== 'loss' || v < 40);
      $(sel).classList.toggle('invalid', !ok);
      if (ok) d[k] = v;
    }
    state.settings.dyno = { ...(state.settings.dyno || {}), ...d };
    renderDyno(true);
    clearTimeout(dynoSaveTimer);
    dynoSaveTimer = setTimeout(() => saveSettings({ dyno: state.settings.dyno }).catch(() => {}), 600);
  }
  DYNO_FIELDS.forEach(([, sel]) => $(sel).addEventListener('input', onDynoInput));
  $('#btnDynoReset').addEventListener('click', () => {
    const { mass, cda, crr, loss } = LOG.DYNO_DEFAULTS;
    state.settings.dyno = { mass, cda, crr, loss };
    DYNO_FIELDS.forEach(([, sel]) => $(sel).classList.remove('invalid'));
    fillDynoInputs();
    renderDyno(true);
    saveSettings({ dyno: state.settings.dyno }).catch(() => {});
  });

  /** Tirones que mide el dinamómetro: el de A (el de la comparación, el seleccionado o el mejor) y el de B si se compara. */
  function dynoRuns() {
    const a = logA();
    if (!a || isRecLog(a)) return null;
    const pa = pullsOf(a);
    if (!pa.length) return { runs: [] };
    const c = cmpPulls();
    const o = dynoOpts();
    const A = c && c.A ? c.A : pa.find(p => p.n === state.logs.selPull) || LOG.bestPull(a, pa);
    const runs = [{ key: 'A', log: a, pull: A, d: LOG.dyno(a, A, o) }];
    if (c && c.B && !isRecLog(c.b)) runs.push({ key: 'B', log: c.b, pull: c.B, d: LOG.dyno(c.b, c.B, o) });
    return { runs, opts: o };
  }

  function renderDyno(fromInput) {
    const card = $('#logDynoCard');
    const r = dynoRuns();
    if (!r) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    if (!fromInput) fillDynoInputs();
    const tbl = $('#dynoTable'), charts = $('#dynoCharts'), warn = $('#dynoWarn');
    if (!r.runs.length) {
      $('#dynoLegend').innerHTML = '';
      warn.innerHTML = '';
      tbl.innerHTML = '<p class="muted small">Hace falta un tirón a fondo en una sola marcha, con régimen, pedal y velocidad grabados (el conjunto «Tirón (potencia)» ya los incluye).</p>';
      charts.innerHTML = '';
      return;
    }
    $('#dynoLegend').innerHTML = r.runs.map(x => '<span><span class="sw ' + x.key.toLowerCase() + '"></span>' + x.key + ': ' + esc(x.log.name) + ' · T' + x.pull.n + '</span>').join('');
    const msgs = [];
    for (const x of r.runs) {
      if (x.d.error) msgs.push(x.key + ': ' + x.d.error);
      else for (const w of x.d.warnings) msgs.push(x.key + ': ' + w);
    }
    warn.innerHTML = msgs.length ? '<div class="banner warn"><div>' + msgs.map(esc).join('<br>') + '</div></div>' : '';
    const ok = r.runs.filter(x => !x.d.error);
    const ap = activeProfile();
    const fab = ap && ap.vehicle && (ap.vehicle.powerCv || ap.vehicle.torqueNm) ? ap.vehicle : null;
    let rows = ok.map(x => '<tr><td><span class="badge ' + x.key.toLowerCase() + '">' + x.key + '</span> ' + esc(x.log.name) + '</td>' +
      '<td class="num big">' + fmt(x.d.peakCv, 1) + ' cv <span class="muted">a ' + fmt(x.d.peakCvRpm) + '</span></td>' +
      '<td class="num big">' + fmt(x.d.peakNm) + ' Nm <span class="muted">a ' + fmt(x.d.peakNmRpm) + '</span></td>' +
      '<td class="num">' + fmt(x.d.peakWheelCv, 1) + ' cv</td><td class="num">' + fmt(x.d.kmhPer1000, 1) + ' km/h</td></tr>').join('');
    if (ok.length === 2) {
      const [a, b] = ok;
      const dcv = a.d.peakCv - b.d.peakCv, dnm = a.d.peakNm - b.d.peakNm;
      const sg = v => (v >= 0 ? '+' : '−') + fmt(Math.abs(v), 1);
      rows += '<tr class="diff"><td>A frente a B</td><td class="num">' + sg(dcv) + ' cv (' + sg((dcv / b.d.peakCv) * 100) + ' %)</td><td class="num">' + sg(dnm) + ' Nm (' + sg((dnm / b.d.peakNm) * 100) + ' %)</td><td></td><td></td></tr>';
      if (Math.abs(a.d.kmhPer1000 - b.d.kmhPer1000) / b.d.kmhPer1000 > 0.05) {
        warn.innerHTML += '<div class="banner warn"><div>Los dos tirones parecen de marchas distintas (' + fmt(a.d.kmhPer1000, 1) + ' y ' + fmt(b.d.kmhPer1000, 1) + ' km/h a 1000 rpm): la comparación es menos fiable.</div></div>';
      }
    }
    if (fab) rows += '<tr class="ref"><td>De fábrica (ficha «' + esc(PROF.label(ap)) + '»)</td><td class="num">' + (fab.powerCv ? fmt(fab.powerCv) + ' cv' : '—') + '</td><td class="num">' + (fab.torqueNm ? fmt(fab.torqueNm) + ' Nm' : '—') + '</td><td></td><td></td></tr>';
    tbl.innerHTML = ok.length ? '<table class="data log-table cmp-table dyno-table"><thead><tr><th>Medición</th><th class="num">Potencia máx</th><th class="num">Par máx</th><th class="num">Potencia en rueda</th><th class="num">Marcha (a 1000 rpm)</th></tr></thead><tbody>' + rows + '</tbody></table>' : '';

    charts.innerHTML = '';
    if (!ok.length) return;
    const A = ok.find(x => x.key === 'A'), B = ok.find(x => x.key === 'B');
    for (const ch of [{ title: 'Potencia (cv)', f: 'cv', dec: 1, unit: 'cv' }, { title: 'Par (Nm)', f: 'nm', dec: 0, unit: 'Nm' }]) {
      const conv = x => (x ? x.d.curve.map(p => ({ rpm: p.rpm, v: p[ch.f] })) : []);
      const box = document.createElement('div');
      box.className = 'cmp-chart';
      box.innerHTML = '<h3>' + esc(ch.title) + '</h3><canvas></canvas>';
      charts.appendChild(box);
      const cv = $('canvas', box);
      // Si solo hay B (A con error), se dibuja B como serie principal para no dejar la gráfica vacía.
      const chart = { cv, ca: conv(A || B), cb: A ? conv(B) : [], dec: ch.dec, unit: ch.unit, hover: null };
      cv._chart = chart;
      cv.addEventListener('mousemove', e => cmpHover(chart, e));
      cv.addEventListener('mouseleave', () => { chart.hover = null; hideTip(); drawCmpChart(chart); });
      drawCmpChart(chart);
    }
  }

  function dynoText() {
    const r = dynoRuns();
    if (!r || !r.runs.length) return '';
    const o = r.opts;
    const lines = ['DINAMÓMETRO VIRTUAL (estimación por aceleración; peso ' + fmt(o.mass) + ' kg, CdA ' + fmt(o.cda, 2) + ' m², Crr ' + fmt(o.crr, 3) + ', pérdidas de transmisión ' + fmt(o.loss) + ' %):'];
    for (const x of r.runs) {
      if (x.d.error) { lines.push('- ' + x.key + ' «' + x.log.name + '» T' + x.pull.n + ': ' + x.d.error); continue; }
      lines.push('- ' + x.key + ' «' + x.log.name + '» T' + x.pull.n + ': ' + fmt(x.d.peakCv, 1) + ' cv a ' + fmt(x.d.peakCvRpm) + ' rpm, ' + fmt(x.d.peakNm) + ' Nm a ' + fmt(x.d.peakNmRpm) +
        ' rpm (en rueda ' + fmt(x.d.peakWheelCv, 1) + ' cv; ' + fmt(x.d.kmhPer1000, 1) + ' km/h a 1000 rpm)' + (x.d.warnings.length ? '. Avisos: ' + x.d.warnings.join(' ') : ''));
      lines.push('  Curva (rpm: cv / Nm): ' + x.d.curve.filter(p => p.rpm % 500 === 0).map(p => p.rpm + ': ' + fmt(p.cv, 0) + ' / ' + fmt(p.nm, 0)).join('; '));
    }
    return lines.join('\n');
  }

  /* ---- Conjunto ---- */
  function renderLogsAll() {
    renderLogList();
    const log = logA();
    $('#logViewCard').classList.toggle('hidden', !log);
    $('#logPullsCard').classList.toggle('hidden', !log);
    if (log) {
      $('#logViewTitle').innerHTML = 'Gráfica: ' + esc(log.name) + ' <span class="count">' + fmtDur(LOG.duration(log)) + ' · ' + log.rows.length + ' muestras</span>';
      drawLogChart();
      renderLogPulls();
    }
    renderLogCompare();
    refreshLogButtons();
  }

  $('#btnLogAI').addEventListener('click', () => {
    const c = cmpPulls();
    const prompt = c && c.A && c.B
      ? 'Compara los dos tirones del log (A y B): ¿qué ha cambiado en sobrepresión, presión de rail, caudal de aire y en la potencia y el par del dinamómetro virtual? ¿La ganancia es coherente con lo que ha cambiado y los valores son seguros para este motor (embrague, turbo, temperaturas)? Dime qué vigilar.'
      : 'Analiza el log grabado: ¿cómo responde el motor en los tirones? Revisa sobrepresión del turbo, presión de rail, caudal de aire y temperaturas para este motor y dime si hay algo fuera de lo normal.';
    $('#ctxLog').checked = true;
    askAI(prompt);
  });

  function logContextText() {
    const a = logA();
    if (!a || !a.rows.length) return '';
    const pulls = pullsOf(a);
    const sel = pulls.find(p => p.n === state.logs.selPull);
    let txt = LOG.summaryText(a, { pulls, pull: sel });
    const c = cmpPulls();
    if (c && c.A && c.B) txt += '\n\n' + LOG.compareText(c.a, c.A, c.b, c.B);
    const dt = dynoText();
    if (dt) txt += '\n\n' + dt;
    return txt;
  }

  window.addEventListener('resize', () => {
    if (!$('#sec-logs').classList.contains('active')) return;
    drawLogChart();
    $$('#logCmpCharts canvas, #dynoCharts canvas').forEach(cv => cv._chart && drawCmpChart(cv._chart));
  });

  /* ================= Archivo .bin ================= */
  function readFile(input) {
    return new Promise((resolve, reject) => {
      const f = input.files && input.files[0];
      if (!f) { resolve(null); return; }
      if (f.size > 64 * 1024 * 1024) { reject(new Error('El archivo es demasiado grande (más de 64 MB).')); return; }
      const r = new FileReader();
      r.onload = () => resolve({ name: f.name, bytes: new Uint8Array(r.result) });
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(f);
    });
  }

  async function confirmDiscardEdits() {
    if (!state.bin.edit.dirty) return true;
    return askConfirm('Cambios sin guardar', 'Tienes cambios en la copia de trabajo que no has guardado. ¿Descartarlos?', 'Descartar', true);
  }
  function resetEdit() {
    const E = state.bin.edit;
    E.on = false;
    E.sel = new Set();
    E.anchor = null;
    E.hist.clear();
    E.dirty = false;
  }

  $('#fileA').addEventListener('change', async e => {
    try {
      const f = await readFile(e.target);
      if (!f) return;
      if (!(await confirmDiscardEdits())) return;
      resetEdit();
      if (state.bin.bIsWork) { state.bin.b = null; state.bin.bName = ''; state.bin.bIsWork = false; }
      state.bin.a = f.bytes;
      state.bin.aName = f.name;
      analyzeBin();
    } catch (err) { toast(err.message, 5000); }
    e.target.value = '';
  });
  $('#fileB').addEventListener('change', async e => {
    try {
      const f = await readFile(e.target);
      if (!f) return;
      if (!(await confirmDiscardEdits())) return;
      resetEdit();
      state.bin.b = f.bytes;
      state.bin.bName = f.name;
      state.bin.bIsWork = false;
      if (state.bin.a) { computeDiff(); renderBinAll(); } else toast('Abre primero el archivo original.');
    } catch (err) { toast(err.message, 5000); }
    e.target.value = '';
  });
  $('#endian').addEventListener('change', () => { if (state.bin.a) analyzeBin(); });
  $('#onlyChanged').addEventListener('change', renderMapList);

  function analyzeBin() {
    const B = state.bin;
    B.info = BIN.identify(B.a);
    const choice = $('#endian').value;
    const ap = activeProfile();
    B.swKey = PROF.swKey(B.info);
    if (choice === 'auto') {
      if (B.info.endianGuess) { B.endian = B.info.endianGuess; B.endianSrc = 'según la familia del archivo'; B.maps = BIN.findMaps(B.a, { endian: B.endian }); }
      else if (ap && ap.ecu.endian) { B.endian = ap.ecu.endian; B.endianSrc = 'según la ficha activa'; B.maps = BIN.findMaps(B.a, { endian: B.endian }); }
      else { const r = BIN.findMapsAuto(B.a); B.endian = r.endian; B.endianSrc = 'detectado por los mapas'; B.maps = r.maps; }
    } else {
      B.endian = choice;
      B.endianSrc = 'elegido a mano';
      B.maps = BIN.findMaps(B.a, { endian: choice });
    }
    computeDiff();
    B.sel = B.maps.find(m => m.changed) || B.maps[0] || null;
    B.hexOffset = B.sel ? B.sel.offset & ~0xf : 0;
    applyMapLabel(B.sel);
    renderBinAll();
  }

  function computeDiff() {
    const B = state.bin;
    B.diff = B.b ? BIN.diffFiles(B.a, B.b) : null;
    BIN.annotateChanges(B.maps, B.a, B.b);
  }

  function renderBinAll() {
    $('#binEmpty').classList.add('hidden');
    $('#binContent').classList.remove('hidden');
    $('#btnBinAI').disabled = false;
    renderBinInfo();
    renderDiffInfo();
    renderMapList();
    renderMap();
    renderHex();
  }

  function renderBinInfo() {
    const B = state.bin, i = B.info;
    const rows = [
      ['Archivo', esc(B.aName)],
      ['Tamaño', fmt(i.size) + ' bytes (' + fmt(i.sizeKB) + ' KB)'],
      ['Familia detectada', i.family ? esc(i.family) + (i.familyOffset != null ? ' <span class="muted">en ' + BIN.hex(i.familyOffset) + '</span>' : '') : '<span class="muted">no encontrada en las cadenas de texto</span>'],
      ['Orden de bytes', (B.endian === 'big' ? 'Big-endian (tipo EDC16)' : 'Little-endian (tipo EDC17)') + ' <span class="muted">' + esc(B.endianSrc || '') + '</span>'],
      ['Clave de software', esc(B.swKey) + ' <span class="muted">(para las etiquetas)</span>'],
      ['Hardware Bosch', i.boschHW.length ? esc(i.boschHW.join(', ')) : '<span class="muted">—</span>'],
      ['Software Bosch', i.boschSW.length ? esc(i.boschSW.join(', ')) : '<span class="muted">—</span>'],
      ['Referencias PSA', i.psa.length ? esc(i.psa.join(', ')) : '<span class="muted">—</span>'],
      ['Mapas encontrados', fmt(B.maps.length)]
    ];
    let html = '<h2>Original</h2><table class="kv">' + rows.map(r => '<tr><td>' + r[0] + '</td><td class="val">' + r[1] + '</td></tr>').join('') + '</table>';
    if (i.interesting.length) {
      html += '<details style="margin-top:10px"><summary class="small">Cadenas relevantes (' + i.interesting.length + ')</summary><table class="data">' +
        i.interesting.slice(0, 30).map(s => '<tr><td class="mono">' + BIN.hex(s.offset) + '</td><td class="mono">' + esc(s.text) + '</td></tr>').join('') + '</table></details>';
    }
    $('#binInfo').innerHTML = html;
  }

  function renderDiffInfo() {
    const B = state.bin, d = B.diff;
    const el = $('#diffInfo');
    if (!d) {
      el.innerHTML = '<h2>Comparación</h2><p class="muted">Abre un archivo modificado con «Comparar con modificado…» para ver qué ha cambiado respecto al original.</p>';
      return;
    }
    const changedMaps = B.maps.filter(m => m.changed).length;
    const rows = [
      ['Modificado', esc(B.bName) + (B.bIsWork ? ' <span class="muted">(copia de trabajo)</span>' : '') + (B.edit.dirty ? ' <span style="color:var(--warn-text)">· cambios sin guardar</span>' : '')],
      ['Tamaños', d.sameSize ? 'Iguales' : '<span style="color:var(--serious-text)">Distintos: ' + fmt(d.sizeA) + ' / ' + fmt(d.sizeB) + ' bytes</span>'],
      ['Bytes distintos', fmt(d.changed) + ' (' + fmt(d.percent, 2) + ' %)'],
      ['Zonas con cambios', fmt(d.ranges.length) + (d.truncated ? '+' : '')],
      ['Mapas con cambios', fmt(changedMaps) + ' de ' + fmt(B.maps.length)]
    ];
    const outside = d.ranges.filter(r => !B.maps.some(m => r.start < m.end && r.end > m.offset));
    let html = '<h2>Comparación</h2><table class="kv">' + rows.map(r => '<tr><td>' + r[0] + '</td><td class="val">' + r[1] + '</td></tr>').join('') + '</table>';
    if (d.ranges.length) {
      html += '<details style="margin-top:10px"' + (outside.length ? ' open' : '') + '><summary class="small">Zonas cambiadas fuera de los mapas detectados (' + outside.length + ')</summary><table class="data">' +
        outside.slice(0, 40).map(r => '<tr><td class="mono"><a href="#" data-jump="' + r.start + '">' + BIN.hex(r.start) + '</a></td><td>' + fmt(r.end - r.start) + ' bytes</td></tr>').join('') +
        '</table><p class="muted small">Pueden ser mapas que el buscador no reconoce, checksums o datos de la herramienta.</p></details>';
    }
    el.innerHTML = html;
    $$('a[data-jump]', el).forEach(a => a.addEventListener('click', ev => { ev.preventDefault(); state.bin.hexOffset = Number(a.dataset.jump) & ~0xf; renderHex(); $('#hexView').scrollIntoView({ behavior: 'smooth', block: 'center' }); }));
  }

  const axisRange = a => fmt(a[0]) + '–' + fmt(a[a.length - 1]);

  function renderMapList() {
    const B = state.bin;
    const only = $('#onlyChanged').checked;
    const list = B.maps.filter(m => !only || m.changed);
    $('#mapCount').textContent = '(' + list.length + ')';
    const el = $('#mapList');
    if (!list.length) {
      el.innerHTML = '<p class="muted small" style="padding:8px">' + (only ? 'Ningún mapa detectado tiene cambios.' : 'No se encontraron mapas con el orden de bytes actual. Prueba a cambiarlo.') + '</p>';
      return;
    }
    el.innerHTML = list.map(m => { const lb = mapLabel(m); return '<div class="map-item' + (B.sel && B.sel.id === m.id ? ' sel' : '') + '" data-id="' + m.id + '">' +
      (lb ? '<span class="mname' + (lb.exact ? '' : ' sugg') + '">' + esc(lb.exact ? lb.def.name : '¿' + lb.def.name + '?') + '</span>' : '') +
      '<span class="addr">' + m.offsetHex + (m.changed ? '<span class="badge chg">' + m.changed + ' cambios</span>' : '') + '</span>' +
      '<span class="dims">' + m.nx + ' × ' + m.ny + '</span>' +
      '<span class="meta">X ' + axisRange(m.xAxis) + ' · Y ' + axisRange(m.yAxis) + ' · fiabilidad ' + m.confidence + ' %' + (m.hints.length ? ' · ' + esc(m.hints.join(', ')) : '') + '</span></div>'; }).join('');
    $$('.map-item', el).forEach(it => it.addEventListener('click', () => {
      B.sel = B.maps.find(m => m.id === Number(it.dataset.id));
      B.edit.sel = new Set();
      B.edit.anchor = null;
      $$('.map-item', el).forEach(x => x.classList.toggle('sel', x === it));
      B.hexOffset = B.sel.offset & ~0xf;
      applyMapLabel(B.sel);
      renderMap();
      renderHex();
    }));
  }

  /* ---- Etiquetas de mapas (se guardan en la ficha activa, por software) ---- */
  function mapLabel(m) {
    const ap = activeProfile();
    return m && ap && state.bin.swKey ? PROF.findDef(ap, state.bin.swKey, m) : null;
  }

  function applyMapLabel(m) {
    const hit = mapLabel(m);
    $('#mFactor').value = hit ? hit.def.factor : 1;
    $('#mOffset').value = hit ? hit.def.add : 0;
    $('#mDec').value = hit ? hit.def.dec : 0;
    $('#lblName').value = hit ? hit.def.name : '';
    $('#lblUnit').value = hit ? hit.def.unit : '';
    renderLabelRow();
  }

  function renderLabelRow() {
    const m = state.bin.sel, ap = activeProfile();
    const hit = mapLabel(m);
    $('#btnLblSave').disabled = !m || !ap;
    $('#btnLblDel').classList.toggle('hidden', !(hit && hit.exact));
    $('#lblHint').textContent = !ap ? 'Activa un vehículo en la pestaña Vehículos para guardar etiquetas.'
      : !hit ? (ap.maps.length ? 'Elige un nombre de la lista de la ficha o escribe uno.' : '')
      : hit.exact ? 'Guardada en la ficha «' + PROF.label(ap) + '».'
      : 'Sugerencia: hay un mapa igual etiquetado en otro software (' + hit.def.swKey + '). Guárdala si es correcta.';
    $('#lblNames').innerHTML = ap ? ap.maps.map(x => '<option value="' + esc(x.name) + '">' + esc([x.unit, x.factor != null ? '×' + x.factor : ''].filter(Boolean).join(' ')) + '</option>').join('') : '';
  }

  $('#lblName').addEventListener('change', () => {
    const ap = activeProfile();
    const t = ap && ap.maps.find(x => x.name.toLowerCase() === $('#lblName').value.trim().toLowerCase());
    if (!t) return;
    if (t.unit) $('#lblUnit').value = t.unit;
    if (t.factor != null) $('#mFactor').value = t.factor;
    $('#mOffset').value = t.add || 0;
    if (t.factor != null && t.factor < 1) $('#mDec').value = Math.min(4, Math.max(0, Math.round(-Math.log10(t.factor))));
    renderMap();
  });

  $('#btnLblSave').addEventListener('click', async () => {
    const ap = activeProfile(), m = state.bin.sel;
    if (!ap || !m) return;
    const name = $('#lblName').value.trim();
    if (!name) { toast('Escribe un nombre para el mapa.'); $('#lblName').focus(); return; }
    const o = viewOpts();
    PROF.upsertDef(ap, state.bin.swKey, m, { name, unit: $('#lblUnit').value.trim(), factor: o.factor, add: o.offset, dec: o.dec });
    await persistProfiles();
    renderMapList();
    renderLabelRow();
    renderMap();
    toast('Etiqueta guardada en la ficha «' + PROF.label(ap) + '»');
  });

  $('#btnLblDel').addEventListener('click', async () => {
    const ap = activeProfile(), m = state.bin.sel;
    if (!ap || !m) return;
    PROF.removeDef(ap, state.bin.swKey, m.offset);
    await persistProfiles();
    applyMapLabel(m);
    renderMapList();
    renderMap();
    toast('Etiqueta quitada');
  });

  /* ---- Editor de mapas: trabaja sobre la copia de trabajo (state.bin.b) ---- */
  function statsText(m, o) {
    const B = state.bin;
    if (!B.b) return '';
    const st = RCEdit.mapStats(B.a, B.b, m, o.signed);
    if (!st.changed) return '';
    const parts = [];
    if (st.maxPct > 0) parts.push('máx. +' + fmt(st.maxPct, 1) + ' %');
    if (st.minPct < 0) parts.push('mín. ' + fmt(st.minPct, 1) + ' %');
    return parts.length ? ' (' + parts.join(', ') + ')' : '';
  }

  function updateEditUI() {
    const B = state.bin, E = B.edit;
    $('#btnEditStart').classList.toggle('hidden', E.on);
    $('#editIntro').classList.toggle('hidden', E.on);
    $('#btnEditStart').disabled = !B.a || !B.sel;
    $('#editTools').classList.toggle('hidden', !E.on);
    $('#editKeys').classList.toggle('hidden', !E.on);
    $('#btnUndo').disabled = !E.hist.canUndo;
    $('#btnRedo').disabled = !E.hist.canRedo;
    $('#btnSaveBin').disabled = !B.b;
    $('#btnSaveBin').innerHTML = (E.dirty ? '<span class="dirty-dot" aria-hidden="true"></span>' : '') + 'Guardar copia .bin…';
    const n = E.sel.size;
    $('#selInfo').textContent = n ? n + (n > 1 ? ' celdas seleccionadas' : ' celda seleccionada') : 'Clic y arrastra para seleccionar celdas';
    $('#editIntro').textContent = B.b && !B.bIsWork
      ? 'Los cambios se harán sobre el modificado abierto (' + B.bName + '). El original no se toca.'
      : 'Crea una copia de trabajo del archivo y modifica sus celdas. El original no se toca.';
  }

  function startEdit() {
    const B = state.bin;
    if (!B.a || !B.sel) return;
    if (!B.b) {
      B.b = new Uint8Array(B.a);
      B.bName = B.aName.replace(/(\.[^.]*)?$/, ext => '_mod' + (ext || '.bin'));
      B.bIsWork = true;
      computeDiff();
    }
    if (B.b.length < B.sel.end) { toast('El archivo modificado es más corto que el original: no se puede editar este mapa.', 5000); return; }
    B.edit.on = true;
    B.edit.sel = new Set();
    if ($('input[name="vmode"]:checked').value === 'ori') $('input[name="vmode"][value="mod"]').checked = true;
    renderDiffInfo();
    renderMap();
  }

  function endEdit() {
    state.bin.edit.on = false;
    state.bin.edit.sel = new Set();
    renderMap();
  }

  function selCells() {
    return [...state.bin.edit.sel].map(k => { const [r, c] = k.split(',').map(Number); return { r, c }; });
  }

  function doEdit(op) {
    const B = state.bin, E = B.edit;
    if (!E.on || !B.sel || !B.b) return;
    if (!E.sel.size) { toast('Selecciona primero una o varias celdas (clic y arrastra).'); return; }
    const o = viewOpts();
    const m = effectiveMap(B.sel, o);
    let res;
    try { res = RCEdit.apply(B.b, m, selCells(), op, { factor: o.factor, add: o.offset, signed: o.signed }); }
    catch (e) { toast(e.message); return; }
    if (!res.changes.length) {
      toast(op.type === 'interp' ? 'Para interpolar, selecciona al menos tres celdas seguidas en una fila o columna.' : 'Ningún valor ha cambiado (el cambio es menor que un paso del valor bruto).');
      return;
    }
    E.hist.push(res.changes, { mapId: B.sel.id });
    E.dirty = true;
    if (res.clamped) toast(res.clamped + ' celda(s) han llegado al límite del valor de 16 bit.', 4500);
    if ($('input[name="vmode"]:checked').value === 'ori') $('input[name="vmode"][value="mod"]').checked = true;
    afterEdit();
  }

  function afterEdit() {
    computeDiff();
    renderDiffInfo();
    renderMapList();
    renderMap();
    renderHex();
  }

  function undoRedo(redo) {
    const B = state.bin, E = B.edit;
    if (!B.b) return;
    const e = redo ? E.hist.redo(B.b) : E.hist.undo(B.b);
    if (!e) return;
    E.dirty = true;
    if (e.info && B.sel && e.info.mapId !== B.sel.id) {
      const m = B.maps.find(x => x.id === e.info.mapId);
      if (m) { B.sel = m; B.hexOffset = m.offset & ~0xf; E.sel = new Set(); applyMapLabel(m); }
    }
    afterEdit();
  }

  async function saveWorkingBin() {
    const B = state.bin;
    if (!B.b) return;
    const ok = await askConfirm('Guardar copia modificada',
      'Se guardará como un archivo nuevo; el original no se modifica. Importante: ReproChip NO corrige el checksum. Antes de escribir este archivo en un coche, corrígelo con tu herramienta (KESS, KTAG…) y guarda siempre la lectura original.',
      'Guardar copia');
    if (!ok) return;
    const name = B.bName || 'reprochip_mod.bin';
    try {
      if (bridge && bridge.saveBinary) {
        const p = await bridge.saveBinary({ defaultName: name, data: B.b });
        if (!p) return;
        B.bName = p.split(/[\\/]/).pop();
        toast('Copia guardada en ' + p, 4500);
      } else {
        const blob = new Blob([B.b], { type: 'application/octet-stream' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }
      B.edit.dirty = false;
      B.bIsWork = false;
      renderDiffInfo();
      updateEditUI();
    } catch (e) { toast('No se pudo guardar: ' + errMsg(e), 5000); }
  }

  const mapWrap = $('#mapTableWrap');
  const tdPos = td => ({ r: Number(td.dataset.r), c: Number(td.dataset.c) });
  function paintSel() {
    const E = state.bin.edit;
    $$('td[data-g]', mapWrap).forEach(td => td.classList.toggle('sel', E.sel.has(td.dataset.g)));
    updateEditUI();
  }
  function selectRect(a, b) {
    const E = state.bin.edit;
    const r0 = Math.min(a.r, b.r), r1 = Math.max(a.r, b.r), c0 = Math.min(a.c, b.c), c1 = Math.max(a.c, b.c);
    E.sel = new Set();
    $$('td[data-g]', mapWrap).forEach(td => {
      const p = tdPos(td);
      if (p.r >= r0 && p.r <= r1 && p.c >= c0 && p.c <= c1) E.sel.add(td.dataset.g);
    });
    paintSel();
  }
  function selectAllCells() {
    const rows = $$('tbody tr', mapWrap).length, cols = $$('thead th[data-col]', mapWrap).length;
    if (rows && cols) { state.bin.edit.anchor = { r: 0, c: 0 }; selectRect({ r: 0, c: 0 }, { r: rows - 1, c: cols - 1 }); }
  }

  mapWrap.addEventListener('mousedown', ev => {
    const E = state.bin.edit;
    if (!E.on || ev.button !== 0) return;
    const td = ev.target.closest('td[data-g]');
    const th = ev.target.closest('th');
    if (td) {
      ev.preventDefault();
      const p = tdPos(td);
      if (ev.shiftKey && E.anchor) { selectRect(E.anchor, p); E.drag = true; }
      else if (ev.ctrlKey || ev.metaKey) {
        if (E.sel.has(td.dataset.g)) E.sel.delete(td.dataset.g); else E.sel.add(td.dataset.g);
        E.anchor = p;
        paintSel();
      } else { E.anchor = p; selectRect(p, p); E.drag = true; }
    } else if (th) {
      ev.preventDefault();
      const rows = $$('tbody tr', mapWrap).length, cols = $$('thead th[data-col]', mapWrap).length;
      if (th.classList.contains('corner')) selectAllCells();
      else if (th.dataset.col != null) { const c = Number(th.dataset.col); E.anchor = { r: 0, c }; selectRect({ r: 0, c }, { r: rows - 1, c }); }
      else if (th.dataset.row != null) { const r = Number(th.dataset.row); E.anchor = { r, c: 0 }; selectRect({ r, c: 0 }, { r, c: cols - 1 }); }
    }
  });
  mapWrap.addEventListener('mouseover', ev => {
    const E = state.bin.edit;
    if (!E.on || !E.drag || !E.anchor) return;
    const td = ev.target.closest('td[data-g]');
    if (td) selectRect(E.anchor, tdPos(td));
  });
  document.addEventListener('mouseup', () => { state.bin.edit.drag = false; });

  // Doble clic en una celda: escribir el valor (se aplica a toda la selección si la celda está dentro).
  mapWrap.addEventListener('dblclick', ev => {
    const E = state.bin.edit;
    const td = ev.target.closest('td[data-g]');
    if (!E.on || !td) return;
    if (!E.sel.has(td.dataset.g)) { E.anchor = tdPos(td); selectRect(E.anchor, E.anchor); }
    const o = viewOpts();
    const m = effectiveMap(state.bin.sel, o);
    const [gr, gc] = td.dataset.g.split(',').map(Number);
    const raw = RCEdit.getRaw(state.bin.b, m, gr, gc, o.signed);
    const cur = raw == null ? '' : +(raw * o.factor + o.offset).toFixed(Math.max(o.dec, 4));
    const body = document.createElement('div');
    body.innerHTML = '<p class="small">Valor nuevo para ' + (E.sel.size > 1 ? E.sel.size + ' celdas' : 'la celda') + ' (en unidades de pantalla: bruto × factor + offset).</p>' +
      '<input id="cellVal" type="number" step="any" style="width:100%" value="' + esc(cur) + '">';
    const go = () => {
      const v = parseFloat(String($('#cellVal').value).replace(',', '.'));
      if (!isFinite(v)) { toast('Escribe un número.'); return; }
      closeModal(true);
      doEdit({ type: 'set', value: v });
    };
    body.querySelector('#cellVal').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    openModal({ title: 'Escribir valor', body, actions: [{ label: 'Cancelar', cls: 'ghost', onClick: () => closeModal(true) }, { label: 'Aplicar', cls: 'primary', onClick: go }] });
    setTimeout(() => { const i = $('#cellVal'); if (i) { i.focus(); i.select(); } }, 30);
  });

  document.addEventListener('keydown', ev => {
    const E = state.bin.edit;
    if (!E.on || !$('#sec-bin').classList.contains('active') || !$('#modal').classList.contains('hidden')) return;
    const tag = (ev.target && ev.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag)) return;
    const k = ev.key.toLowerCase();
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && k === 'z' && !ev.shiftKey) { ev.preventDefault(); undoRedo(false); }
    else if (mod && (k === 'y' || (k === 'z' && ev.shiftKey))) { ev.preventDefault(); undoRedo(true); }
    else if (mod && k === 'a') { ev.preventDefault(); selectAllCells(); }
    else if (!mod && (ev.key === '+' || ev.key === '=')) { ev.preventDefault(); doEdit({ type: 'pct', value: 1 }); }
    else if (!mod && (ev.key === '-' || ev.key === '_')) { ev.preventDefault(); doEdit({ type: 'pct', value: -1 }); }
    else if (ev.key === 'Escape') { E.sel = new Set(); paintSel(); }
  });

  $('#btnEditStart').addEventListener('click', startEdit);
  $('#btnEditEnd').addEventListener('click', endEdit);
  $$('#editTools [data-step]').forEach(b => b.addEventListener('click', () => doEdit({ type: 'pct', value: Number(b.dataset.step) })));
  $('#btnEditApply').addEventListener('click', () => doEdit({ type: $('#editOp').value, value: parseFloat(String($('#editVal').value).replace(',', '.')) }));
  $('#editVal').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnEditApply').click(); });
  $('#btnInterp').addEventListener('click', () => doEdit({ type: 'interp' }));
  $('#btnSmooth').addEventListener('click', () => doEdit({ type: 'smooth' }));
  $('#btnUndo').addEventListener('click', () => undoRedo(false));
  $('#btnRedo').addEventListener('click', () => undoRedo(true));
  $('#btnSaveBin').addEventListener('click', saveWorkingBin);
  $('#btnEditAI').addEventListener('click', () => askAI('Revisa los cambios que he hecho en el mapa seleccionado (original frente a modificado): ¿son coherentes y suaves, hay saltos raros entre celdas y son razonables para este motor y su embrague y turbo de serie?'));

  function viewOpts() {
    return {
      mode: ($('input[name="vmode"]:checked') || {}).value || 'ori',
      factor: parseFloat($('#mFactor').value) || 1,
      offset: parseFloat($('#mOffset').value) || 0,
      dec: Math.max(0, Math.min(4, parseInt($('#mDec').value, 10) || 0)),
      signed: $('#mSigned').checked,
      transpose: $('#mTranspose').checked,
      flip: $('#mOrder').checked
    };
  }
  ['#mFactor', '#mOffset', '#mDec', '#mSigned', '#mTranspose', '#mOrder'].forEach(id => $(id).addEventListener('input', renderMap));
  $$('input[name="vmode"]').forEach(r => r.addEventListener('change', renderMap));

  function effectiveMap(m, o) {
    return o.flip ? { ...m, order: m.order === 'x' ? 'y' : 'x' } : m;
  }

  function seqColor(t) {
    const i = Math.max(0, Math.min(SEQ.length - 1, Math.round(t * (SEQ.length - 1))));
    return { bg: SEQ[i], fg: fgFor(SEQ[i]) };
  }
  function divColor(pct) {
    const a = Math.abs(pct);
    const D = DIV[tc().name];
    if (!isFinite(pct) || a < 0.05) return { bg: D.zero, fg: fgFor(D.zero) };
    const i = a < 3 ? 0 : a < 8 ? 1 : a < 15 ? 2 : 3;
    const arr = pct > 0 ? D.up : D.down;
    return { bg: arr[i], fg: fgFor(arr[i]) };
  }

  function renderMap() {
    const B = state.bin, m0 = B.sel;
    const wrap = $('#mapTableWrap');
    $('#btnMapAI').disabled = !m0;
    if (!m0) { $('#mapHead').innerHTML = '<h2>Selecciona un mapa</h2>'; wrap.innerHTML = ''; $('#mapLegend').innerHTML = ''; updateEditUI(); return; }
    const o = viewOpts();
    const m = effectiveMap(m0, o);
    if (o.mode !== 'ori' && !B.b) { $('input[name="vmode"][value="ori"]').checked = true; o.mode = 'ori'; }
    const ori = BIN.mapGrid(B.a, m, o.signed);
    const mod = B.b ? BIN.mapGrid(B.b, m, o.signed) : null;
    const phys = v => v == null ? null : v * o.factor + o.offset;

    const lb = mapLabel(m0);
    $('#mapHead').innerHTML = '<h2>' + (lb && lb.exact ? esc(lb.def.name) + (lb.def.unit ? ' <span class="muted">(' + esc(lb.def.unit) + ')</span>' : '') + ' · ' : '') + 'Mapa en ' + m.offsetHex + ' · ' + m.nx + ' × ' + m.ny + '</h2><span class="muted small">Datos desde ' + BIN.hex(m.zOff) + ' · disposición ' + m.layout + ' · ' + (m.order === 'x' ? 'X primero' : 'Y primero') + (m.changed ? ' · <span style="color:var(--serious-text)">' + m.changed + ' celdas cambiadas' + statsText(m, o) + '</span>' : '') + '</span>';

    // Rejilla mostrada
    let rowsAxis = m.yAxis, colsAxis = m.xAxis, rowName = 'Y', colName = 'X';
    const cell = (r, c) => o.transpose ? [c, r] : [r, c];
    if (o.transpose) { rowsAxis = m.xAxis; colsAxis = m.yAxis; rowName = 'X'; colName = 'Y'; }

    const shown = [];
    let mn = Infinity, mx = -Infinity;
    for (let r = 0; r < rowsAxis.length; r++) {
      const row = [];
      for (let c = 0; c < colsAxis.length; c++) {
        const [gr, gc] = cell(r, c);
        const a = ori[gr][gc];
        const b = mod ? mod[gr][gc] : null;
        let v;
        if (o.mode === 'diff') v = a === b ? 0 : (a ? ((b - a) / Math.abs(a)) * 100 : (b ? 100 : 0));
        else v = phys(o.mode === 'mod' ? b : a);
        row.push({ v, a, b, changed: mod ? a !== b : false });
        if (o.mode !== 'diff' && v != null) { if (v < mn) mn = v; if (v > mx) mx = v; }
      }
      shown.push(row);
    }

    const E = B.edit;
    let html = '<table class="map' + (E.on ? ' editing' : '') + '"><thead><tr><th class="corner" title="' + (E.on ? 'Seleccionar todo' : '') + '">' + rowName + ' \\ ' + colName + '</th>' +
      colsAxis.map((x, c) => '<th data-col="' + c + '">' + fmt(x) + '</th>').join('') + '</tr></thead><tbody>';
    shown.forEach((row, r) => {
      html += '<tr><th data-row="' + r + '">' + fmt(rowsAxis[r]) + '</th>';
      row.forEach((cl, c) => {
        const g = cell(r, c).join(',');
        let col, text;
        if (o.mode === 'diff') { col = divColor(cl.v); text = cl.v === 0 ? '0' : (cl.v > 0 ? '+' : '') + fmt(cl.v, 1); }
        else { col = seqColor(mx > mn ? (cl.v - mn) / (mx - mn) : 0); text = fmt(cl.v, o.dec); }
        const cls = [cl.changed && o.mode !== 'diff' ? 'chg' : '', E.on && E.sel.has(g) ? 'sel' : ''].filter(Boolean).join(' ');
        html += '<td data-r="' + r + '" data-c="' + c + '" data-g="' + g + '"' + (cls ? ' class="' + cls + '"' : '') + ' style="background:' + col.bg + ';color:' + col.fg + '">' + text + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;

    const tbody = $('tbody', wrap);
    tbody.addEventListener('mousemove', ev => {
      const td = ev.target.closest('td');
      if (!td) { hideTip(); return; }
      const r = Number(td.dataset.r), c = Number(td.dataset.c);
      const cl = shown[r][c];
      const xv = o.transpose ? rowsAxis[r] : colsAxis[c];
      const yv = o.transpose ? colsAxis[c] : rowsAxis[r];
      let tip = '<span class="tk">X</span> ' + fmt(xv) + ' <span class="tk">· Y</span> ' + fmt(yv) + '<br><span class="tk">Original</span> ' + fmt(phys(cl.a), o.dec) + ' <span class="tk">(bruto ' + cl.a + ')</span>';
      if (mod) {
        const pct = cl.a ? ((cl.b - cl.a) / Math.abs(cl.a)) * 100 : 0;
        tip += '<br><span class="tk">Modificado</span> ' + fmt(phys(cl.b), o.dec) + ' <span class="tk">(bruto ' + cl.b + ')</span>' + (cl.changed ? ' <strong>' + (pct > 0 ? '+' : '') + fmt(pct, 1) + ' %</strong>' : '');
      }
      showTip(tip, ev.clientX, ev.clientY);
    });
    tbody.addEventListener('mouseleave', hideTip);

    const lg = $('#mapLegend');
    if (o.mode === 'diff') {
      lg.innerHTML = '<span>−15 %</span><span class="ramp">' + DIV_DOWN.slice().reverse().map(c => '<span style="background:' + c + '"></span>').join('') +
        '<span style="background:' + DIV_ZERO + '"></span>' + DIV_UP.map(c => '<span style="background:' + c + '"></span>').join('') + '</span><span>+15 %</span><span>· cambio del modificado respecto al original</span>';
    } else {
      lg.innerHTML = '<span>' + fmt(mn, o.dec) + '</span><span class="ramp">' + SEQ.map(c => '<span style="background:' + c + '"></span>').join('') + '</span><span>' + fmt(mx, o.dec) + '</span>' +
        (B.b ? '<span>· marca en la esquina: celda cambiada</span>' : '') + '<span>· valor = bruto × factor + offset</span>';
    }
    updateEditUI();
  }

  function renderHex() {
    const B = state.bin;
    if (!B.a) return;
    const ROWS = 24;
    const start = Math.max(0, Math.min(B.hexOffset, Math.max(0, B.a.length - 16)));
    B.hexOffset = start;
    const m = B.sel;
    let out = '';
    for (let r = 0; r < ROWS; r++) {
      const base = start + r * 16;
      if (base >= B.a.length) break;
      let hexPart = '', asc = '';
      for (let i = 0; i < 16; i++) {
        const off = base + i;
        if (off >= B.a.length) { hexPart += '   '; continue; }
        const v = B.a[off];
        let cls = '';
        if (B.b && off < B.b.length && B.b[off] !== v) cls = 'b-diff';
        else if (m && off >= m.zOff && off < m.end) cls = 'b-map';
        else if (m && off >= m.offset && off < m.zOff) cls = 'b-axis';
        const t = hx(v);
        hexPart += (cls ? '<span class="' + cls + '">' + t + '</span>' : t) + (i === 7 ? '  ' : ' ');
        asc += v >= 0x20 && v < 0x7f ? esc(String.fromCharCode(v)) : '.';
      }
      out += '<span class="addr">' + hx(base, 8) + '</span>  ' + hexPart + ' <span class="asc">' + asc + '</span>\n';
    }
    $('#hexView').innerHTML = out;
    $('#hexGoto').value = '0x' + hx(start, 6);
  }

  function parseAddr(s) {
    const t = String(s).trim();
    if (!t) return null;
    const v = /^0x/i.test(t) || /[a-f]/i.test(t) ? parseInt(t.replace(/^0x/i, ''), 16) : parseInt(t, 10);
    return isFinite(v) ? v : null;
  }
  $('#hexGo').addEventListener('click', () => { const v = parseAddr($('#hexGoto').value); if (v != null) { state.bin.hexOffset = v & ~0xf; renderHex(); } });
  $('#hexGoto').addEventListener('keydown', e => { if (e.key === 'Enter') $('#hexGo').click(); });
  $('#hexPrev').addEventListener('click', () => { state.bin.hexOffset = Math.max(0, state.bin.hexOffset - 384); renderHex(); });
  $('#hexNext').addEventListener('click', () => { state.bin.hexOffset += 384; renderHex(); });
  $('#hexNextDiff').addEventListener('click', () => {
    const d = state.bin.diff;
    if (!d || !d.ranges.length) { toast('No hay archivo modificado o no hay cambios.'); return; }
    const cur = state.bin.hexOffset + 16;
    const next = d.ranges.find(r => r.start >= cur) || d.ranges[0];
    state.bin.hexOffset = next.start & ~0xf;
    renderHex();
  });

  $('#btnBinAI').addEventListener('click', () => askAI(state.bin.b
    ? 'Resume las diferencias entre el original y el modificado: qué mapas se han tocado, cuánto y si los cambios parecen coherentes y seguros para este motor.'
    : 'Analiza el archivo: qué centralita y software parece, y qué mapas de los encontrados serían los principales para una reprogramación de este motor.'));
  $('#btnMapAI').addEventListener('click', () => askAI('Según los ejes y valores, ¿qué mapa crees que es el seleccionado, qué unidades y factor de conversión tendría y qué papel juega en una reprogramación?'));

  /* ================= Vehículos y centralitas ================= */
  const LS_PROF = 'reprochip.profiles';
  const errMsg = e => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  function activeProfile() {
    return state.prof.profiles.find(p => p.id === state.prof.activeId) || null;
  }

  function updateVehicleLabel() {
    const ap = activeProfile();
    const el = $('#vehicleLabel');
    if (!el) return;
    el.textContent = ap ? PROF.label(ap) + (PROF.ecuLabel(ap) ? ' · ' + PROF.ecuLabel(ap) : '') : 'Sin vehículo activo';
  }

  async function loadProfiles() {
    let data = null;
    if (bridge && bridge.profiles) { try { data = await bridge.profiles.get(); } catch (_) {} }
    else { try { data = JSON.parse(localStorage.getItem(LS_PROF) || 'null'); } catch (_) {} }
    const list = data && Array.isArray(data.profiles) ? data.profiles.map(p => PROF.sanitize(p)) : [];
    state.prof.profiles = list;
    state.prof.activeId = data && list.some(p => p.id === data.activeId) ? data.activeId : (list[0] ? list[0].id : null);
    if (!list.length) {
      // Primera vez: la ficha sale del vehículo que había en Ajustes (versión 0.1).
      const first = PROF.fromLegacy(state.settings.vehicle || DEFAULT_SETTINGS.vehicle);
      state.prof.profiles = [first];
      state.prof.activeId = first.id;
      await persistProfiles();
    }
    state.prof.selectedId = state.prof.activeId;
    onActiveProfileChanged(false);
  }

  async function persistProfiles() {
    const data = { profiles: state.prof.profiles, activeId: state.prof.activeId };
    try {
      if (bridge && bridge.profiles) await bridge.profiles.put(data);
      else localStorage.setItem(LS_PROF, JSON.stringify(data));
    } catch (e) { toast('No se pudo guardar la biblioteca: ' + errMsg(e), 5000); }
  }

  function onActiveProfileChanged(byUser) {
    const ap = activeProfile();
    updateVehicleLabel();
    if (ap && ap.ecu.protocol && state.conn.status === 'off') $('#protocol').value = ap.ecu.protocol;
    if (state.dtc) renderDtcs();
    if (state.bin.a) { applyMapLabel(state.bin.sel); renderMapList(); renderMap(); }
    else renderLabelRow();
    if (byUser && ap) toast('Vehículo activo: ' + PROF.label(ap));
  }

  function currentEditProfile() {
    const P = state.prof;
    if (P.draft && P.selectedId === P.draft.id) return P.draft;
    return P.profiles.find(p => p.id === P.selectedId) || null;
  }

  function profItemHtml(p, draft) {
    const P = state.prof;
    return '<div class="prof-item' + (P.selectedId === p.id ? ' sel' : '') + '" data-id="' + esc(p.id) + '">' +
      '<div class="pname">' + esc(PROF.label(p) || 'Ficha sin nombre') +
      (p.id === P.activeId ? '<span class="badge active">Activa</span>' : '') +
      (draft ? '<span class="badge draft">Sin guardar</span>' : '') +
      (p.source === 'ia' ? '<span class="badge ia">IA</span>' : '') + '</div>' +
      '<div class="pecu">' + esc(PROF.ecuLabel(p) || 'Centralita sin indicar') + (p.mapDefs.length ? ' · ' + p.mapDefs.length + ' etiqueta(s) de mapas' : '') + '</div></div>';
  }

  function renderProfiles() {
    const P = state.prof;
    const items = P.profiles.slice().sort((a, b) => PROF.label(a).localeCompare(PROF.label(b), 'es'));
    $('#profCount').textContent = '(' + P.profiles.length + ')';
    const html = (P.draft ? profItemHtml(P.draft, true) : '') + items.map(p => profItemHtml(p, false)).join('');
    $('#profList').innerHTML = html || '<p class="muted small" style="padding:8px">No hay fichas todavía.</p>';
    $$('.prof-item', $('#profList')).forEach(it => it.addEventListener('click', async () => {
      const id = it.dataset.id;
      if (P.draft && id !== P.draft.id) {
        if (!(await askConfirm('Ficha sin guardar', 'Tienes una ficha nueva sin guardar. ¿Quieres descartarla?', 'Descartar', true))) return;
        P.draft = null;
      }
      P.selectedId = id;
      renderProfiles();
    }));
    renderProfileEditor();
  }

  const PROTO_OPTS = [['', 'Sin indicar'], ['0', 'Automático'], ['6', 'CAN 11 bit 500k'], ['7', 'CAN 29 bit 500k'], ['8', 'CAN 11 bit 250k'], ['9', 'CAN 29 bit 250k'], ['5', 'KWP rápido'], ['4', 'KWP 5 baudios'], ['3', 'ISO 9141-2']];
  const ENDIAN_OPTS = [['', 'Según la familia'], ['little', 'Little-endian (EDC17)'], ['big', 'Big-endian (EDC16)']];

  function mapRowHtml(m) {
    const inp = (c, v, ph) => '<td><input data-col="' + c + '" value="' + esc(v == null ? '' : v) + '"' + (ph ? ' placeholder="' + ph + '"' : '') + '></td>';
    return '<tr data-add="' + esc(m.add || 0) + '">' + inp('name', m.name, 'Nombre') + inp('unit', m.unit, 'mg/emb') + inp('factor', m.factor, '0.01') + inp('x', m.xAxis, 'rpm') + inp('y', m.yAxis, 'pedal %') + inp('notes', m.notes, '') +
      '<td class="del"><button class="ghost" data-del title="Quitar">✕</button></td></tr>';
  }
  function dtcRowHtml(d) {
    return '<tr><td style="width:110px"><input data-col="code" value="' + esc(d.code) + '" placeholder="P1351"></td><td><input data-col="text" value="' + esc(d.text) + '" placeholder="Descripción"></td>' +
      '<td class="del"><button class="ghost" data-del title="Quitar">✕</button></td></tr>';
  }

  function renderProfileEditor() {
    const el = $('#profEditor');
    const p = currentEditProfile();
    if (!p) { el.innerHTML = '<p class="muted">Elige una ficha de la lista o crea una nueva.</p>'; return; }
    const P = state.prof;
    const isDraft = !!(P.draft && p.id === P.draft.id);
    const isActive = p.id === P.activeId;
    const v = p.vehicle, e = p.ecu;
    const field = (k, label, val, cls, type) => '<div class="field ' + (cls || '') + '"><label>' + label + '</label><input data-k="' + k + '"' + (type ? ' type="' + type + '"' : '') + ' value="' + esc(val == null ? '' : val) + '"></div>';
    const select = (k, label, opts, val) => '<div class="field"><label>' + label + '</label><select data-k="' + k + '">' + opts.map(o => '<option value="' + o[0] + '"' + ((val || '') === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select></div>';
    const origin = p.source === 'ia' ? 'Generada con IA' + (p.confidence ? ' · fiabilidad ' + p.confidence : '') : p.source === 'importado' ? 'Importada' : 'Creada a mano';

    let h = '<div class="prof-head"><div><h2>' + esc(PROF.label(p) || 'Ficha nueva') + '</h2><div class="muted small">' + (isActive ? 'Vehículo activo · ' : '') + origin + (isDraft ? ' · sin guardar' : '') + '</div></div>' +
      '<div class="actions" style="margin:0">' + (!isActive && !isDraft ? '<button id="pfActivate">Usar este vehículo</button>' : '') +
      '<button id="pfAI" class="ghost">Completar con IA</button><button id="pfSave" class="primary">' + (isDraft ? 'Guardar ficha' : 'Guardar cambios') + '</button></div></div>';
    if (p.source === 'ia' && (isDraft || p.doubts.length)) {
      h += '<div class="banner warn" style="display:block"><strong>Revisa la ficha antes de fiarte de ella.</strong> La ha preparado la IA y puede equivocarse' +
        (p.doubts.length ? '. Comprueba sobre todo:<ul class="doubts">' + p.doubts.map(d => '<li>' + esc(d) + '</li>').join('') + '</ul>' : '.') + '</div>';
    }
    h += '<div class="sub">Vehículo</div><div class="form-grid">' +
      field('vehicle.brand', 'Marca', v.brand) + field('vehicle.model', 'Modelo', v.model) + field('vehicle.engine', 'Motor', v.engine, 'span2') +
      field('vehicle.engineCode', 'Código de motor', v.engineCode) + field('vehicle.years', 'Años', v.years) + field('vehicle.fuel', 'Combustible', v.fuel) +
      field('vehicle.powerCv', 'Potencia (cv)', v.powerCv, '', 'number') + field('vehicle.torqueNm', 'Par (Nm)', v.torqueNm, '', 'number') + '</div>';
    h += '<div class="sub">Centralita</div><div class="form-grid">' +
      field('ecu.supplier', 'Fabricante', e.supplier) + field('ecu.family', 'Familia', e.family) + field('ecu.alternatives', 'Alternativas (separadas por comas)', e.alternatives.join(', '), 'span2') +
      select('ecu.endian', 'Orden de bytes', ENDIAN_OPTS, e.endian) + select('ecu.protocol', 'Protocolo OBD', PROTO_OPTS, e.protocol) +
      field('ecu.hardware', 'Nº de hardware', e.hardware) + field('ecu.software', 'Nº de software / Calibration ID', e.software) + '</div>';
    h += '<div class="field"><label>Notas</label><textarea class="notes" data-k="notes">' + esc(p.notes) + '</textarea></div>';

    h += '<div class="sub">Mapas típicos para reprogramar</div><p class="muted small">Sirven de lista al etiquetar mapas en «Archivo .bin»: al elegir un nombre se aplican su unidad y su factor.</p>' +
      '<table class="edit" id="pfMaps"><thead><tr><th>Nombre</th><th>Unidad</th><th>Factor</th><th>Eje X</th><th>Eje Y</th><th>Notas</th><th></th></tr></thead><tbody>' + p.maps.map(mapRowHtml).join('') + '</tbody></table>' +
      '<button id="pfAddMap" class="ghost" style="margin-top:6px">+ Añadir mapa</button>';
    h += '<div class="sub">Averías propias del fabricante</div><p class="muted small">Se usan cuando la base de averías de la app no conoce el código.</p>' +
      '<table class="edit" id="pfDtcs"><tbody>' + p.dtcs.map(dtcRowHtml).join('') + '</tbody></table><button id="pfAddDtc" class="ghost" style="margin-top:6px">+ Añadir avería</button>';
    const pids = Object.keys(OBD.PIDS).map(Number).sort((a, b) => a - b);
    h += '<div class="sub">Parámetros en vivo recomendados</div><div class="pid-list">' + pids.map(pid =>
      '<label class="chk"><input type="checkbox" data-lpid="' + pid + '"' + (p.livePids.includes(pid) ? ' checked' : '') + '><span>' + esc(OBD.PIDS[pid].name) + '</span></label>').join('') + '</div>';

    const groups = {};
    p.mapDefs.forEach(d => (groups[d.swKey] = groups[d.swKey] || []).push(d));
    h += '<div class="sub">Etiquetas de mapas guardadas</div>';
    h += Object.keys(groups).length ? Object.keys(groups).map(k => '<div class="defs-group"><div class="gk">' + esc(k) + '</div><table class="data">' +
      groups[k].sort((a, b) => a.offset - b.offset).map(d => '<tr><td class="mono">' + BIN.hex(d.offset) + '</td><td>' + d.nx + ' × ' + d.ny + '</td><td>' + esc(d.name) + '</td><td>' + esc(d.unit) + '</td><td class="mono">×' + d.factor + (d.add ? ' + ' + d.add : '') + '</td>' +
        '<td class="del"><button class="ghost" data-deldef="' + d.offset + '" data-sw="' + esc(k) + '" title="Quitar">✕</button></td></tr>').join('') + '</table></div>').join('')
      : '<p class="muted small">Todavía no hay etiquetas. Se añaden desde «Archivo .bin» al seleccionar un mapa.</p>';

    h += '<div class="actions">' + (isDraft ? '<button id="pfDiscard" class="danger">Descartar</button>' : '<button id="pfExport" class="ghost">Exportar ficha</button><button id="pfDelete" class="danger">Borrar ficha</button>') + '</div>';
    el.innerHTML = h;

    const on = (id, fn) => { const b = $('#' + id, el); if (b) b.addEventListener('click', fn); };
    on('pfSave', saveCurrentProfile);
    on('pfActivate', () => activateProfile(p.id));
    on('pfAI', () => openProfileAI(collectProfileForm(p)));
    on('pfAddMap', () => { $('#pfMaps tbody', el).insertAdjacentHTML('beforeend', mapRowHtml({ name: '', unit: '', factor: null, xAxis: '', yAxis: '', notes: '' })); });
    on('pfAddDtc', () => { $('#pfDtcs tbody', el).insertAdjacentHTML('beforeend', dtcRowHtml({ code: '', text: '' })); });
    on('pfDiscard', () => { P.draft = null; P.selectedId = P.activeId; renderProfiles(); });
    on('pfExport', () => saveTextFile(slug(PROF.label(p)) + '.json', JSON.stringify({ format: 'reprochip-ficha', version: 1, profile: p }, null, 2), 'JSON', 'json'));
    on('pfDelete', async () => {
      if (!(await askConfirm('Borrar ficha', '¿Borrar la ficha «' + PROF.label(p) + '»' + (p.mapDefs.length ? ' y sus ' + p.mapDefs.length + ' etiquetas de mapas' : '') + '? No se puede deshacer.', 'Borrar', true))) return;
      P.profiles = P.profiles.filter(x => x.id !== p.id);
      if (P.activeId === p.id) P.activeId = P.profiles[0] ? P.profiles[0].id : null;
      P.selectedId = P.activeId;
      await persistProfiles();
      renderProfiles();
      onActiveProfileChanged(false);
    });
  }

  // Un único manejador para quitar filas y etiquetas del editor de fichas.
  $('#profEditor').addEventListener('click', ev => {
    const del = ev.target.closest('button[data-del]');
    if (del) { del.closest('tr').remove(); return; }
    const dd = ev.target.closest('button[data-deldef]');
    if (!dd) return;
    const p = currentEditProfile();
    if (!p || (state.prof.draft && p.id === state.prof.draft.id)) return;
    PROF.removeDef(p, dd.dataset.sw, Number(dd.dataset.deldef));
    persistProfiles().then(() => {
      renderProfileEditor();
      renderProfilesListOnly();
      if (state.bin.a) { applyMapLabel(state.bin.sel); renderMapList(); renderMap(); }
    });
  });

  function renderProfilesListOnly() {
    const sel = state.prof.selectedId;
    const keepScroll = $('#profList').scrollTop;
    const P = state.prof;
    const items = P.profiles.slice().sort((a, b) => PROF.label(a).localeCompare(PROF.label(b), 'es'));
    $('#profList').innerHTML = (P.draft ? profItemHtml(P.draft, true) : '') + items.map(p => profItemHtml(p, false)).join('');
    $('#profList').scrollTop = keepScroll;
    state.prof.selectedId = sel;
    $$('.prof-item', $('#profList')).forEach(it => it.addEventListener('click', () => { if (!P.draft || it.dataset.id === P.draft.id) { P.selectedId = it.dataset.id; renderProfiles(); } }));
  }

  const slug = s => (String(s || 'ficha').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase() || 'ficha');

  function collectProfileForm(base) {
    const el = $('#profEditor');
    const o = JSON.parse(JSON.stringify(base));
    $$('[data-k]', el).forEach(inp => {
      const [a, b] = inp.dataset.k.split('.');
      if (b) o[a][b] = inp.value; else o[a] = inp.value;
    });
    o.ecu.alternatives = String(o.ecu.alternatives || '').split(/[,;/]+/).map(x => x.trim()).filter(Boolean);
    o.maps = $$('#pfMaps tbody tr', el).map(tr => {
      const g = c => $('[data-col="' + c + '"]', tr).value;
      return { name: g('name'), unit: g('unit'), factor: g('factor'), add: tr.dataset.add, xAxis: g('x'), yAxis: g('y'), notes: g('notes') };
    });
    o.dtcs = $$('#pfDtcs tbody tr', el).map(tr => ({ code: $('[data-col="code"]', tr).value, text: $('[data-col="text"]', tr).value }));
    o.livePids = $$('input[data-lpid]:checked', el).map(cb => Number(cb.dataset.lpid));
    const replaces = base._replaces;
    const clean = PROF.sanitize(o);
    if (replaces) clean._replaces = replaces;
    return clean;
  }

  async function saveCurrentProfile() {
    const P = state.prof;
    const cur = currentEditProfile();
    if (!cur) return;
    const upd = collectProfileForm(cur);
    if (!PROF.label(upd).trim()) { toast('Pon al menos la marca y el modelo.'); return; }
    upd.updatedAt = new Date().toISOString();
    const isDraft = !!(P.draft && cur.id === P.draft.id);
    if (isDraft && upd._replaces && P.profiles.some(p => p.id === upd._replaces)) {
      const old = P.profiles.find(p => p.id === upd._replaces);
      upd.id = old.id;
      upd.mapDefs = old.mapDefs;
      upd.createdAt = old.createdAt;
      delete upd._replaces;
      P.profiles = P.profiles.map(p => (p.id === old.id ? upd : p));
      P.draft = null;
    } else if (isDraft) {
      delete upd._replaces;
      P.profiles.push(upd);
      P.draft = null;
      if (!P.activeId) P.activeId = upd.id;
    } else {
      P.profiles = P.profiles.map(p => (p.id === upd.id ? upd : p));
    }
    P.selectedId = upd.id;
    await persistProfiles();
    renderProfiles();
    if (upd.id === P.activeId) onActiveProfileChanged(false);
    toast('Ficha guardada' + (upd.id === P.activeId ? '' : '. Pulsa «Usar este vehículo» para activarla.'));
  }

  async function activateProfile(id) {
    state.prof.activeId = id;
    await persistProfiles();
    renderProfiles();
    onActiveProfileChanged(true);
  }

  async function generateProfile({ desc, useIdent, useBin, base }) {
    const parts = [base ? 'Revisa y completa la ficha de este vehículo y su centralita.' : 'Crea la ficha de este vehículo y su centralita.'];
    if (desc) parts.push('Descripción del usuario: ' + desc);
    if (base) parts.push('Ficha actual. Rellena lo que falte y, si algo te parece incorrecto, no lo cambies: explícalo en "doubts":\n' + PROF.forAI(base));
    if (useIdent && (state.ident || state.uds)) parts.push('Lectura del coche por OBD:\n' + identText());
    if (useBin && state.bin.info) {
      const i = state.bin.info;
      parts.push('Archivo de centralita abierto: ' + state.bin.aName + ', ' + i.size + ' bytes; familia detectada: ' + (i.family || 'no detectada') +
        '; HW Bosch: ' + (i.boschHW.join(', ') || '—') + '; SW Bosch: ' + (i.boschSW.join(', ') || '—') + '; referencias PSA: ' + (i.psa.join(', ') || '—') +
        '; cadenas: ' + i.interesting.slice(0, 12).map(s => s.text).join(' | '));
    }
    const system = PROF.profilePrompt(Object.keys(OBD.PIDS).map(p => hx(Number(p))));
    let messages = [{ role: 'user', content: parts.join('\n\n') }];
    let text = await bridge.ai.ask({ system, messages, maxTokens: 4096 });
    try {
      return PROF.parseAIProfile(text);
    } catch (_) {
      messages = messages.concat([{ role: 'assistant', content: text }, { role: 'user', content: 'Tu respuesta no era un objeto JSON válido con la forma pedida. Devuelve solo el JSON, sin texto alrededor.' }]);
      text = await bridge.ai.ask({ system, messages, maxTokens: 4096 });
      return PROF.parseAIProfile(text);
    }
  }

  function openProfileAI(base, opts) {
    if (!bridge) { toast('La IA solo funciona dentro de la app de escritorio.'); return; }
    if (!state.settings.hasApiKey) { toast('Primero añade la clave de la API de Claude en Ajustes.'); showSection('settings'); return; }
    const o = opts || {};
    const hasIdent = !!(state.ident || state.uds);
    const hasBin = !!state.bin.info;
    const body = document.createElement('div');
    body.innerHTML = '<p class="small">' + (base ? 'Claude revisará la ficha «' + esc(PROF.label(base)) + '» y completará lo que falte. Puedes añadir detalles:' : 'Describe el coche: marca, modelo, motor, potencia, año y lo que sepas de la centralita. También puedes pegar el VIN.') + '</p>' +
      '<textarea id="aiProfDesc" placeholder="Ej.: Peugeot 308 1.6 HDi 112 cv de 2012, centralita Bosch"></textarea>' +
      '<label class="chk"><input type="checkbox" id="aiProfIdent"' + (hasIdent ? (o.ident !== false ? ' checked' : '') : ' disabled') + '> Incluir la identificación leída del coche' + (hasIdent ? '' : ' (aún no hay lectura)') + '</label>' +
      '<label class="chk"><input type="checkbox" id="aiProfBin"' + (hasBin ? (o.bin ? ' checked' : '') : ' disabled') + '> Incluir los datos del archivo abierto' + (hasBin ? ' (' + esc(state.bin.aName) + ')' : ' (no hay archivo)') + '</label>' +
      '<p class="muted small">Se envía a Claude con tu clave de API. Revisa la ficha antes de guardarla: la IA puede equivocarse.</p><p id="aiProfStatus" class="small"></p>';
    let working = false;
    const setWorking = w => { working = w; $$('#modalActions button').forEach(b => { b.disabled = w; }); };
    openModal({
      title: base ? 'Completar ficha con IA' : 'Añadir vehículo con IA',
      body,
      actions: [
        { label: 'Cancelar', cls: 'ghost', onClick: () => { if (!working) closeModal(true); } },
        { label: 'Generar ficha', cls: 'primary', onClick: async () => {
          if (working) return;
          const desc = $('#aiProfDesc').value.trim();
          const useIdent = $('#aiProfIdent').checked, useBin = $('#aiProfBin').checked;
          if (!desc && !base && !useIdent && !useBin) { $('#aiProfStatus').textContent = 'Escribe una descripción o incluye la lectura del coche o el archivo.'; return; }
          setWorking(true);
          $('#aiProfStatus').textContent = 'Preparando la ficha con Claude… puede tardar unos segundos.';
          try {
            const gen = await generateProfile({ desc, useIdent, useBin, base });
            const P = state.prof;
            if (base) {
              const merged = PROF.mergeProfiles(base, gen);
              merged.source = 'ia';
              const draft = { ...merged, id: PROF.newId(), _replaces: P.draft && base.id === P.draft.id ? base._replaces : base.id };
              P.draft = draft;
            } else {
              P.draft = gen;
            }
            P.selectedId = P.draft.id;
            closeModal(true);
            showSection('vehicles');
            toast('Ficha preparada. Revísala y pulsa «Guardar ficha».', 4500);
          } catch (e) {
            setWorking(false);
            $('#aiProfStatus').textContent = 'No se pudo generar: ' + errMsg(e);
          }
        } }
      ]
    });
    setTimeout(() => { const t = $('#aiProfDesc'); if (t) t.focus(); }, 50);
  }

  $('#btnProfAI').addEventListener('click', () => openProfileAI(null));
  $('#btnProfManual').addEventListener('click', () => {
    state.prof.draft = PROF.sanitize({ source: 'manual' });
    state.prof.selectedId = state.prof.draft.id;
    renderProfiles();
    const b = $('#profEditor input[data-k="vehicle.brand"]');
    if (b) b.focus();
  });
  $('#btnProfExportAll').addEventListener('click', () => {
    saveTextFile('reprochip_biblioteca.json', JSON.stringify({ format: 'reprochip-biblioteca', version: 1, profiles: state.prof.profiles }, null, 2), 'JSON', 'json');
  });
  $('#profImport').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      if (f.size > 8 * 1024 * 1024) throw new Error('El archivo es demasiado grande.');
      const obj = JSON.parse((await f.text()).replace(/^﻿/, ''));
      const list = Array.isArray(obj.profiles) ? obj.profiles : obj.profile ? [obj.profile] : obj.vehicle ? [obj] : [];
      if (!list.length) throw new Error('No contiene ninguna ficha de ReproChip.');
      let n = 0;
      for (const raw of list) {
        const p = PROF.sanitize(raw);
        if (state.prof.profiles.some(x => x.id === p.id)) p.id = PROF.newId();
        p.source = 'importado';
        state.prof.profiles.push(p);
        n++;
      }
      if (!state.prof.activeId) state.prof.activeId = state.prof.profiles[0].id;
      await persistProfiles();
      renderProfiles();
      toast(n + ' ficha(s) importada(s)');
    } catch (err) { toast('No se pudo importar: ' + errMsg(err), 5000); }
  });

  /* ================= Asistente IA ================= */
  function refreshAiNotice() {
    const n = $('#aiNotice');
    if (!bridge) {
      n.innerHTML = 'El asistente solo funciona dentro de la app de escritorio, que es donde se guarda la clave de la API.';
      n.classList.remove('hidden');
    } else if (!state.settings.hasApiKey) {
      n.innerHTML = 'Falta la clave de la API de Claude. Añádela en <a href="#" id="goSettings">Ajustes</a>.';
      n.classList.remove('hidden');
      const a = $('#goSettings');
      if (a) a.addEventListener('click', e => { e.preventDefault(); showSection('settings'); });
    } else n.classList.add('hidden');
  }

  function buildContext() {
    const parts = [];
    const v = state.settings.vehicle || {};
    if ($('#ctxVehicle').checked) {
      const ap = activeProfile();
      if (ap) parts.push(PROF.contextText(ap));
      else parts.push('VEHÍCULO: ' + [v.brand, v.model, v.engine, v.year ? 'año ' + v.year : 'año sin indicar', 'centralita: ' + (v.ecu || 'sin indicar')].filter(Boolean).join(', '));
    }
    if (isConnected()) {
      const i = state.conn.info;
      parts.push('CONEXIÓN: ' + (state.conn.type === 'sim' ? 'SIMULADOR de ReproChip (datos ficticios, no es un coche real)' : 'adaptador ' + i.version) + '; protocolo ' + i.protocolName + '; tensión ' + (i.voltage || '?'));
    }
    if ($('#ctxIdent').checked && (state.ident || state.uds)) {
      parts.push('IDENTIFICACIÓN:\n' + identText());
    }
    if ($('#ctxDtc').checked && state.dtc) {
      const d = state.dtc;
      const fmtList = l => !l ? '—' : l.error ? '(' + l.error + ')' : l.length ? l.map(c => c.code + ' ' + dtcText(c).text).join('; ') : 'ninguna';
      parts.push('AVERÍAS (leídas ' + d.time.toLocaleTimeString('es-ES') + '):\nTestigo MIL: ' + (d.status ? (d.status.mil ? 'encendido' : 'apagado') + ', ' + d.status.count + ' códigos' : 'desconocido') +
        '\nMemorizadas: ' + fmtList(d.stored) + '\nPendientes: ' + fmtList(d.pending) + '\nPermanentes: ' + fmtList(d.permanent));
    }
    if ($('#ctxLive').checked) {
      const lines = [];
      for (const pid of Object.keys(state.live.series).map(Number).sort((a, b) => a - b)) {
        const st = seriesStats(pid);
        if (!st) continue;
        const def = OBD.PIDS[pid];
        lines.push(def.name + ': actual ' + fmt(st.last, def.dec) + ' ' + def.unit + ', mín ' + fmt(st.min, def.dec) + ', máx ' + fmt(st.max, def.dec) + ', media ' + fmt(st.avg, def.dec) + ' (' + st.n + ' muestras, ' + fmt(st.span, 0) + ' s)');
      }
      if (lines.length) {
        let txt = 'DATOS EN VIVO (últimas muestras):\n' + lines.join('\n');
        const rpm = state.live.series[0x0c], map = state.live.series[0x0b];
        if (rpm && map && rpm.length > 5) {
          const pairs = rpm.slice(-40).map((p, i) => { const m = map[map.length - Math.min(map.length, 40) + i]; return m ? fmt(p.v) + ' rpm → ' + fmt(m.v) + ' kPa' : null; }).filter(Boolean);
          txt += '\nMuestras recientes RPM → MAP: ' + pairs.filter((_, i) => i % 4 === 0).join(', ');
        }
        parts.push(txt);
      }
    }
    if ($('#ctxLog').checked) {
      const t = logContextText();
      if (t) parts.push(t);
    }
    if ($('#ctxBin').checked && state.bin.a) {
      const B = state.bin, i = B.info;
      let txt = 'ARCHIVO ORIGINAL: ' + B.aName + ', ' + fmt(i.size) + ' bytes; familia: ' + (i.family || 'no detectada') + '; orden de bytes: ' + B.endian +
        '; HW Bosch: ' + (i.boschHW.join(', ') || '—') + '; SW Bosch: ' + (i.boschSW.join(', ') || '—') + '; ref. PSA: ' + (i.psa.join(', ') || '—') +
        '\nMapas 2D encontrados por el buscador heurístico: ' + B.maps.length;
      if (B.diff) txt += '\nARCHIVO MODIFICADO: ' + B.bName + '; bytes distintos ' + fmt(B.diff.changed) + ' (' + fmt(B.diff.percent, 2) + ' %), ' + B.diff.ranges.length + ' zonas, ' + B.maps.filter(m => m.changed).length + ' mapas con cambios';
      const list = (B.diff ? B.maps.filter(m => m.changed).concat(B.maps.filter(m => !m.changed)) : B.maps).slice(0, 40);
      txt += '\nLista (offset, tamaño X×Y, eje X, eje Y, rango de datos en bruto, celdas cambiadas):\n' +
        list.map(m => { const lb = mapLabel(m); return m.offsetHex + (lb ? ' «' + lb.def.name + '»' + (lb.exact ? '' : ' (sugerida)') : '') + ' ' + m.nx + '×' + m.ny + ' X[' + m.xAxis[0] + '..' + m.xAxis[m.nx - 1] + '] Y[' + m.yAxis[0] + '..' + m.yAxis[m.ny - 1] + '] datos ' + m.min + '..' + m.max + (B.diff ? ' cambios ' + m.changed : ''); }).join('\n');
      if (B.sel) {
        const o = viewOpts();
        const m = effectiveMap(B.sel, o);
        const g = BIN.mapGrid(B.a, m, o.signed);
        txt += '\n\nMAPA SELECCIONADO ' + m.offsetHex + ' (' + m.nx + '×' + m.ny + ', valores en bruto de 16 bit; factor en pantalla ' + o.factor + ', offset ' + o.offset + '):\nEje X: ' + m.xAxis.join(' ') + '\nEje Y: ' + m.yAxis.join(' ') +
          '\nOriginal (una fila por valor de Y):\n' + g.map((r, k) => 'Y=' + m.yAxis[k] + ': ' + r.join(' ')).join('\n');
        if (B.b) {
          const g2 = BIN.mapGrid(B.b, m, o.signed);
          txt += '\nModificado:\n' + g2.map((r, k) => 'Y=' + m.yAxis[k] + ': ' + r.join(' ')).join('\n');
        }
      }
      parts.push(txt);
    }
    return parts.join('\n\n');
  }

  function addMsg(role, html, cls) {
    const log = $('#chatLog');
    const d = document.createElement('div');
    d.className = 'msg ' + role;
    d.innerHTML = '<div class="bubble' + (cls ? ' ' + cls : '') + '">' + html + '</div>';
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  async function sendChat(text) {
    const q = String(text || '').trim();
    if (!q || state.ai.busy) return;
    if (!bridge) { refreshAiNotice(); toast('El asistente necesita la app de escritorio.'); return; }
    if (!state.settings.hasApiKey) { refreshAiNotice(); toast('Añade la clave de la API en Ajustes.'); return; }
    state.ai.busy = true;
    $('#btnSend').disabled = true;
    addMsg('user', RCAI.renderMarkdown(q));
    state.ai.messages.push({ role: 'user', content: q });
    const thinking = addMsg('assistant', 'Pensando…', 'thinking');
    try {
      const answer = await bridge.ai.ask({ system: RCAI.buildSystemPrompt(buildContext()), messages: state.ai.messages.slice(-16) });
      state.ai.messages.push({ role: 'assistant', content: answer || '(respuesta vacía)' });
      thinking.remove();
      addMsg('assistant', RCAI.renderMarkdown(answer || '(respuesta vacía)'));
    } catch (e) {
      state.ai.messages.pop();
      thinking.remove();
      addMsg('assistant', esc(errMsg(e)), 'error');
    } finally {
      state.ai.busy = false;
      $('#btnSend').disabled = false;
    }
  }

  function askAI(prompt) {
    showSection('ai');
    $('#chatInput').value = '';
    sendChat(prompt);
  }

  $('#btnSend').addEventListener('click', () => { const v = $('#chatInput').value; $('#chatInput').value = ''; sendChat(v); });
  $('#chatInput').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#btnSend').click(); } });
  $$('.quick').forEach(b => b.addEventListener('click', () => sendChat(b.dataset.q)));
  $('#btnChatClear').addEventListener('click', () => {
    state.ai.messages = [];
    $('#chatLog').innerHTML = '';
    addMsg('assistant', '<p>Conversación nueva. ¿En qué te ayudo?</p>');
  });

  /* ================= Terminal ================= */
  const termLines = [];
  function termAppend(kind, text) {
    const time = new Date().toLocaleTimeString('es-ES', { hour12: false });
    termLines.push({ kind, text: time + '  ' + String(text).replace(/\n/g, '\n          ') });
    if (termLines.length > 2500) termLines.splice(0, termLines.length - 2500);
    scheduleTermRender();
  }
  let termPending = false;
  function scheduleTermRender() {
    if (termPending) return;
    termPending = true;
    requestAnimationFrame(() => {
      termPending = false;
      const el = $('#termLog');
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
      el.innerHTML = termLines.map(l => '<span class="' + l.kind + '">' + esc(l.text) + '</span>').join('\n');
      if (atBottom) el.scrollTop = el.scrollHeight;
    });
  }

  async function termSend() {
    const inp = $('#termCmd');
    const cmd = inp.value.trim();
    if (!cmd) return;
    if (!requireConn()) return;
    state.termHistory.push(cmd);
    state.termIdx = state.termHistory.length;
    inp.value = '';
    const check = OBD.checkReadOnly(cmd);
    if (!check.ok) { termAppend('err', '✕ ' + cmd + ' — ' + check.reason); return; }
    try {
      await state.conn.elm.send(cmd.toUpperCase(), 10000);
      if (/^AT\s*(H|S|E|L|CAF)\s*[01]$/i.test(cmd) || /^ATSP/i.test(cmd) || /^AT\s*(Z|D|WS)$/i.test(cmd)) {
        termAppend('sys', 'Aviso: has cambiado la configuración del adaptador. Si las demás pestañas fallan, desconecta y vuelve a conectar.');
      }
    } catch (e) { termAppend('err', e.message); }
  }
  $('#btnTermSend').addEventListener('click', termSend);
  $('#termCmd').addEventListener('keydown', e => {
    if (e.key === 'Enter') termSend();
    else if (e.key === 'ArrowUp' && state.termHistory.length) { state.termIdx = Math.max(0, state.termIdx - 1); e.target.value = state.termHistory[state.termIdx] || ''; e.preventDefault(); }
    else if (e.key === 'ArrowDown' && state.termHistory.length) { state.termIdx = Math.min(state.termHistory.length, state.termIdx + 1); e.target.value = state.termHistory[state.termIdx] || ''; e.preventDefault(); }
  });
  $('#btnTermClear').addEventListener('click', () => { termLines.length = 0; scheduleTermRender(); });

  // Casilla para ver u ocultar el tráfico de los datos en vivo
  (function addTermToggle() {
    const lab = document.createElement('label');
    lab.className = 'chk';
    lab.innerHTML = '<input type="checkbox" id="termShowLive"> Mostrar tráfico de datos en vivo';
    $('.term-input').appendChild(lab);
  })();

  /* ================= Arranque ================= */
  updateConnFields();
  setConn('off');
  loadSettings().then(loadProfiles).then(() => { buildCards(); renderPidPicker(); });
  termAppend('sys', 'ReproChip listo. Modo solo lectura activo.' + (bridge ? '' : ' (Modo navegador: sin WiFi ni asistente IA.)'));

  // Exponer para pruebas
  window.__reprochip = { state, showSection, buildContext, activeProfile };
})();
