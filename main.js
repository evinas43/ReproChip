'use strict';
/*
 * ReproChip — proceso principal de Electron.
 *  - Ventana y permisos de puerto serie (Web Serial dentro de Electron).
 *  - Puente TCP para adaptadores ELM327 WiFi.
 *  - Ajustes locales y clave de la API de Claude (cifrada con safeStorage si el sistema lo permite).
 *  - Llamadas a la API de Claude (la clave nunca llega a la interfaz).
 */
const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const DEFAULT_SETTINGS = {
  model: DEFAULT_MODEL,
  vehicle: {
    brand: 'Citroën',
    model: 'C4',
    engine: '1.6 HDi 92 cv',
    year: '',
    ecu: 'Bosch (EDC17C10 o EDC16C34, por confirmar)'
  },
  wifiHost: '192.168.0.10',
  wifiPort: 35000,
  baudRate: 'auto',
  protocol: '0',
  theme: 'dark'
};
const THEMES = ['dark', 'light', 'system'];

/** Aplica el tema a la parte nativa (barras de desplazamiento, diálogos) y devuelve el color de fondo. */
function applyNativeTheme(theme) {
  nativeTheme.themeSource = THEMES.includes(theme) ? theme : 'dark';
  return nativeTheme.shouldUseDarkColors ? '#0d0d0d' : '#f4f3f0';
}

let win = null;
let pendingSerialCallback = null;
let tcpSocket = null;

/* ---------------- Ajustes ---------------- */
function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }
function profilesPath() { return path.join(app.getPath('userData'), 'profiles.json'); }
function keyPath() { return path.join(app.getPath('userData'), 'apikey.bin'); }

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return { ...DEFAULT_SETTINGS, ...raw, vehicle: { ...DEFAULT_SETTINGS.vehicle, ...(raw.vehicle || {}) } };
  } catch (_) {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2), 'utf8');
}

function sanitizeSettings(partial) {
  const out = {};
  if (typeof partial.model === 'string') out.model = partial.model.trim().slice(0, 100) || DEFAULT_MODEL;
  if (typeof partial.wifiHost === 'string') out.wifiHost = partial.wifiHost.trim().slice(0, 255);
  if (partial.wifiPort !== undefined) {
    const p = parseInt(partial.wifiPort, 10);
    if (p > 0 && p < 65536) out.wifiPort = p;
  }
  if (typeof partial.baudRate === 'string') out.baudRate = partial.baudRate.slice(0, 10);
  if (typeof partial.protocol === 'string') out.protocol = partial.protocol.slice(0, 2);
  if (THEMES.includes(partial.theme)) out.theme = partial.theme;
  if (partial.dyno && typeof partial.dyno === 'object') {
    const num = (v, lo, hi) => { const n = Number(v); return isFinite(n) && n >= lo && n <= hi ? n : undefined; };
    const d = { mass: num(partial.dyno.mass, 300, 5000), cda: num(partial.dyno.cda, 0.2, 3), crr: num(partial.dyno.crr, 0.003, 0.05), loss: num(partial.dyno.loss, 0, 40) };
    out.dyno = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
  }
  if (partial.vehicle && typeof partial.vehicle === 'object') {
    out.vehicle = {};
    for (const k of ['brand', 'model', 'engine', 'year', 'ecu']) {
      if (typeof partial.vehicle[k] === 'string') out.vehicle[k] = partial.vehicle[k].slice(0, 120);
    }
  }
  return out;
}

function getApiKey() {
  try {
    const buf = fs.readFileSync(keyPath());
    if (buf.length === 0) return '';
    if (buf[0] === 0x00) return buf.slice(1).toString('utf8'); // guardada sin cifrar
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf.slice(1));
    return '';
  } catch (_) {
    return '';
  }
}

function setApiKey(key) {
  const k = String(key || '').trim();
  if (!k) { try { fs.unlinkSync(keyPath()); } catch (_) {} return; }
  fs.mkdirSync(path.dirname(keyPath()), { recursive: true });
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(keyPath(), Buffer.concat([Buffer.from([0x01]), safeStorage.encryptString(k)]));
  } else {
    fs.writeFileSync(keyPath(), Buffer.concat([Buffer.from([0x00]), Buffer.from(k, 'utf8')]));
  }
}

function publicSettings() {
  return { ...loadSettings(), hasApiKey: !!getApiKey(), encrypted: safeStorage.isEncryptionAvailable() };
}

/* ---------------- Ventana ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: applyNativeTheme(loadSettings().theme),
    title: 'ReproChip',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const ses = win.webContents.session;

  // Web Serial: Electron no muestra selector propio, así que enviamos la lista a la interfaz.
  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    if (pendingSerialCallback) { try { pendingSerialCallback(''); } catch (_) {} }
    pendingSerialCallback = callback;
    const list = (portList || []).map(p => ({
      portId: p.portId,
      portName: p.portName || '',
      displayName: p.displayName || '',
      vendorId: p.vendorId || '',
      productId: p.productId || ''
    }));
    if (win) win.webContents.send('serial:choose', list);
  });
  ses.on('serial-port-added', (event, port) => {
    if (win) win.webContents.send('serial:changed', { added: port && (port.displayName || port.portName) });
  });
  ses.on('serial-port-removed', (event, port) => {
    if (win) win.webContents.send('serial:changed', { removed: port && (port.displayName || port.portName) });
  });
  ses.setPermissionCheckHandler((webContents, permission) => permission === 'serial' || permission === 'clipboard-sanitized-write');
  ses.setPermissionRequestHandler((webContents, permission, callback) => callback(permission === 'serial' || permission === 'clipboard-sanitized-write'));
  ses.setDevicePermissionHandler(details => details.deviceType === 'serial');

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.on('closed', () => { win = null; });
}

ipcMain.on('serial:chosen', (event, portId) => {
  if (pendingSerialCallback) {
    const cb = pendingSerialCallback;
    pendingSerialCallback = null;
    cb(typeof portId === 'string' ? portId : '');
  }
});

/* ---------------- Puente TCP (ELM327 WiFi) ---------------- */
ipcMain.handle('tcp:connect', (event, args) => new Promise((resolve, reject) => {
  const host = String((args && args.host) || '').trim();
  const port = parseInt(args && args.port, 10);
  if (!host || !(port > 0 && port < 65536)) { reject(new Error('Dirección o puerto no válidos')); return; }
  if (tcpSocket) { tcpSocket.destroy(); tcpSocket = null; }
  let settled = false;
  const sock = net.createConnection({ host, port });
  sock.setNoDelay(true);
  sock.setTimeout(6000);
  sock.once('connect', () => {
    settled = true;
    sock.setTimeout(0);
    tcpSocket = sock;
    resolve(true);
  });
  sock.once('timeout', () => {
    if (!settled) { settled = true; sock.destroy(); reject(new Error('Tiempo agotado al conectar con ' + host + ':' + port + '. ¿Estás conectado a la WiFi del adaptador?')); }
  });
  sock.on('error', err => {
    if (!settled) { settled = true; reject(new Error('No se pudo conectar con ' + host + ':' + port + ' (' + err.message + ')')); }
  });
  sock.on('data', d => { if (win && tcpSocket === sock) win.webContents.send('tcp:data', d.toString('latin1')); });
  sock.on('close', () => {
    if (tcpSocket === sock) {
      tcpSocket = null;
      if (win) win.webContents.send('tcp:closed', 'Conexión WiFi cerrada');
    }
  });
}));

ipcMain.handle('tcp:write', (event, data) => {
  if (!tcpSocket) throw new Error('No hay conexión WiFi abierta');
  tcpSocket.write(String(data), 'latin1');
  return true;
});

ipcMain.handle('tcp:close', () => {
  if (tcpSocket) { const s = tcpSocket; tcpSocket = null; s.destroy(); }
  return true;
});

/* ---------------- Ajustes ---------------- */
ipcMain.handle('settings:get', () => publicSettings());

ipcMain.handle('settings:set', (event, partial) => {
  const p = partial && typeof partial === 'object' ? partial : {};
  const clean = sanitizeSettings(p);
  const current = loadSettings();
  const next = { ...current, ...clean, vehicle: { ...current.vehicle, ...(clean.vehicle || {}) } };
  saveSettings(next);
  if (clean.theme && win) win.setBackgroundColor(applyNativeTheme(clean.theme));
  if (Object.prototype.hasOwnProperty.call(p, 'apiKey')) setApiKey(p.apiKey);
  return publicSettings();
});

/* ---------------- Biblioteca de vehículos y centralitas ---------------- */
ipcMain.handle('profiles:get', () => {
  try {
    const raw = JSON.parse(fs.readFileSync(profilesPath(), 'utf8'));
    return { profiles: Array.isArray(raw.profiles) ? raw.profiles : [], activeId: typeof raw.activeId === 'string' ? raw.activeId : null };
  } catch (_) {
    return { profiles: [], activeId: null, empty: true };
  }
});

ipcMain.handle('profiles:put', (event, data) => {
  const d = data && typeof data === 'object' ? data : {};
  const body = JSON.stringify({ profiles: Array.isArray(d.profiles) ? d.profiles : [], activeId: typeof d.activeId === 'string' ? d.activeId : null }, null, 1);
  if (body.length > 8 * 1024 * 1024) throw new Error('La biblioteca supera los 8 MB.');
  fs.mkdirSync(path.dirname(profilesPath()), { recursive: true });
  const tmp = profilesPath() + '.tmp';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, profilesPath());
  return true;
});

/* ---------------- API de Claude ---------------- */
ipcMain.handle('ai:ask', async (event, payload) => {
  const key = getApiKey();
  if (!key) throw new Error('Falta la clave de la API de Claude. Añádela en Ajustes.');
  const s = loadSettings();
  const system = String((payload && payload.system) || '').slice(0, 120000);
  const messages = Array.isArray(payload && payload.messages) ? payload.messages : [];
  const clean = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content.slice(0, 60000) }));
  if (!clean.length || clean[0].role !== 'user') throw new Error('Mensaje vacío');
  const mt = parseInt(payload && payload.maxTokens, 10);
  const maxTokens = mt >= 256 && mt <= 8000 ? mt : 2048;

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: s.model || DEFAULT_MODEL, max_tokens: maxTokens, system, messages: clean })
    });
  } catch (err) {
    throw new Error('No se pudo contactar con la API de Claude (' + err.message + '). ¿Hay conexión a internet?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || ('Error HTTP ' + res.status);
    throw new Error('La API de Claude respondió con un error: ' + msg);
  }
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
});

/* ---------------- Guardar archivos ---------------- */
ipcMain.handle('file:save', async (event, opts) => {
  const o = opts || {};
  const r = await dialog.showSaveDialog(win, {
    defaultPath: String(o.defaultName || 'reprochip.txt'),
    filters: Array.isArray(o.filters) ? o.filters : undefined
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, String(o.content || ''), 'utf8');
  return r.filePath;
});

ipcMain.handle('file:saveBinary', async (event, opts) => {
  const o = opts || {};
  const data = o.data;
  if (!(data instanceof Uint8Array) || data.length === 0) throw new Error('No hay datos que guardar');
  if (data.length > 64 * 1024 * 1024) throw new Error('El archivo es demasiado grande');
  const r = await dialog.showSaveDialog(win, {
    title: 'Guardar copia modificada',
    defaultPath: String(o.defaultName || 'reprochip_mod.bin'),
    filters: [{ name: 'Archivo de centralita', extensions: ['bin', 'ori', 'mod'] }, { name: 'Todos los archivos', extensions: ['*'] }]
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  return r.filePath;
});

/* ---------------- Ciclo de vida ---------------- */
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (tcpSocket) { tcpSocket.destroy(); tcpSocket = null; }
  if (process.platform !== 'darwin') app.quit();
});
