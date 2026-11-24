'use strict';
/* Pruebas sin dependencias: node test/run-tests.js */
const assert = require('assert');
const path = require('path');
const lib = p => require(path.join(__dirname, '..', 'src', 'lib', p));
const { ELM327, parseFrames, cleanLines, findError } = lib('elm327.js');
const OBD = lib('obd.js');
const { SimTransport } = lib('transport.js');
const { ELMSimulator } = lib('simulator.js');
const BIN = lib('binanalyzer.js');
const AI = lib('ai.js');
const PROF = lib('profiles.js');
const EDIT = lib('mapedit.js');
const { buildDemo, buildMod } = require(path.join(__dirname, '..', 'scripts', 'make-samples.js'));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------- ELM327: análisis de respuestas ---------- */
test('cleanLines quita eco, SEARCHING y prompt', () => {
  const l = cleanLines('0100\rSEARCHING...\r7E8 06 41 00 BE 3F A8 13 00\r\r>', '0100');
  assert.deepStrictEqual(l, ['7E8 06 41 00 BE 3F A8 13 00']);
});

test('parseFrames: trama simple CAN 11 bit', () => {
  const m = parseFrames(['7E8 06 41 00 BE 3F A8 13 00'], '6');
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].ecu, '7E8');
  assert.deepStrictEqual(m[0].data, [0x41, 0x00, 0xbe, 0x3f, 0xa8, 0x13]);
});

test('parseFrames: multitrama ISO-TP (VIN)', () => {
  const lines = ['7E8 10 14 49 02 01 56 46 37', '7E8 21 53 49 4D 55 4C 41 44', '7E8 22 4F 52 30 30 30 30 31'];
  const m = parseFrames(lines, '6');
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].complete, true);
  assert.strictEqual(m[0].data.length, 0x14);
  assert.strictEqual(String.fromCharCode(...m[0].data.slice(3)), 'VF7SIMULADOR00001');
});

test('parseFrames: CAN 29 bit y sin espacios', () => {
  const m = parseFrames(['18DAF11003410C1AF8'], '7');
  assert.strictEqual(m[0].ecu, '18DAF110');
  assert.deepStrictEqual(m[0].data, [0x41, 0x0c, 0x1a]);
});

test('parseFrames: K-Line con cabecera y checksum', () => {
  const m = parseFrames(['48 6B 10 41 0C 1A F8 C2'], '5');
  assert.strictEqual(m[0].ecu, '10');
  assert.deepStrictEqual(m[0].data, [0x41, 0x0c, 0x1a, 0xf8]);
});

test('parseFrames: respuesta pendiente 0x78 y luego positiva', () => {
  const m = parseFrames(['7E8 03 7F 22 78 00 00 00 00', '7E8 06 62 F1 90 41 42 43 00'], '6');
  assert.strictEqual(m.length, 2);
  assert.strictEqual(m[1].data[0], 0x62);
});

test('findError reconoce NO DATA y UNABLE TO CONNECT', () => {
  assert.strictEqual(findError(['NO DATA']).code, 'NO_DATA');
  assert.strictEqual(findError(['SEARCHING...', 'UNABLE TO CONNECT']).code, 'UNABLE');
  assert.strictEqual(findError(['7E8 03 43 00 00']), null);
});

/* ---------- OBD ---------- */
test('decodeDTC', () => {
  assert.strictEqual(OBD.decodeDTC(0x02, 0x99), 'P0299');
  assert.strictEqual(OBD.decodeDTC(0x24, 0x63), 'P2463');
  assert.strictEqual(OBD.decodeDTC(0xc1, 0x00), 'U0100');
  assert.strictEqual(OBD.decodeDTC(0x11, 0x23), 'P1123');
});

test('describeDTC en español y categoría PSA', () => {
  assert.match(OBD.describeDTC('P0401').text, /EGR/);
  assert.match(OBD.describeDTC('P1351').category, /fabricante/);
});

test('bloqueo de solo lectura', () => {
  for (const c of ['2EF190AA', '3101FF00', '27 01', '1002', '3400', '3601', '11 01', '14FFFFFF', '04', 'ATPP0CSV23']) {
    assert.strictEqual(OBD.checkReadOnly(c).ok, false, c + ' debería bloquearse');
  }
  for (const c of ['ATRV', 'atdp', '010C', '0902', '22F190', '1003', '1901', '3E00', 'STI']) {
    assert.strictEqual(OBD.checkReadOnly(c).ok, true, c + ' debería permitirse');
  }
});

/* ---------- Punta a punta contra el simulador ---------- */
test('sesión completa con el simulador', async () => {
  const t = new SimTransport(new ELMSimulator());
  await t.open();
  const elm = new ELM327(t);
  const info = await elm.init();
  assert.strictEqual(info.protocol, '6');
  assert.deepStrictEqual(info.ecus, ['7E8']);

  const sup = await OBD.getSupportedPids(elm, 1);
  for (const p of [0x0c, 0x0b, 0x10, 0x23, 0x49, 0x42]) assert.ok(sup.has(p), 'PID ' + p.toString(16));
  assert.ok(!sup.has(0x5c));

  const rpm = await OBD.readPid(elm, 0x0c);
  assert.ok(rpm > 600 && rpm < 5000, 'rpm ' + rpm);
  const rail = await OBD.readPid(elm, 0x23);
  assert.ok(rail > 200 && rail < 1800, 'rail ' + rail);

  const st = await OBD.readMonitorStatus(elm);
  assert.deepStrictEqual(st, { mil: true, count: 2, diesel: true });
  assert.deepStrictEqual((await OBD.readDTCs(elm, 0x03)).map(c => c.code), ['P0299', 'P0101']);
  assert.deepStrictEqual((await OBD.readDTCs(elm, 0x07)).map(c => c.code), ['P0401']);

  assert.strictEqual(await OBD.readVIN(elm), 'VF7SIMULADOR00001');
  assert.deepStrictEqual(await OBD.readCalibrationIds(elm), ['SIM_EDC17C10_P01']);
  assert.deepStrictEqual(await OBD.readCVNs(elm), ['1A2B3C4D']);
  assert.strictEqual(await OBD.readEcuName(elm), 'ECM-EngineControl');

  const uds = await OBD.readUdsIdentification(elm);
  assert.strictEqual(uds.find(r => r.did === 'F190').value, 'VF7SIMULADOR00001');
  assert.ok(uds.find(r => r.did === 'F18B').error);
  // Tras UDS se vuelve a la cabecera funcional y el OBD sigue funcionando
  assert.ok((await OBD.readPid(elm, 0x05)) >= 40);

  await OBD.clearDTCs(elm);
  assert.deepStrictEqual(await OBD.readDTCs(elm, 0x03), []);
  assert.strictEqual((await OBD.readMonitorStatus(elm)).mil, false);
  assert.deepStrictEqual((await OBD.readDTCs(elm, 0x0a)).map(c => c.code), ['P0299']);

  await elm.close();
});

test('el driver serializa peticiones concurrentes', async () => {
  const t = new SimTransport(new ELMSimulator());
  await t.open();
  const elm = new ELM327(t);
  await elm.init();
  const r = await Promise.all([OBD.readPid(elm, 0x0c), OBD.readVIN(elm), OBD.readPid(elm, 0x05), OBD.readDTCs(elm, 3)]);
  assert.strictEqual(r[1], 'VF7SIMULADOR00001');
  assert.strictEqual(r[3].length, 2);
  await elm.close();
});

test('protocolo forzado incorrecto da error claro', async () => {
  const t = new SimTransport(new ELMSimulator());
  await t.open();
  const elm = new ELM327(t);
  await assert.rejects(() => elm.init({ protocol: '8' }), e => e.code === 'CAN_ERROR');
  await elm.close();
});

test('cerrar con una petición en curso la rechaza', async () => {
  const t = new SimTransport(new ELMSimulator());
  await t.open();
  const elm = new ELM327(t);
  await elm.init();
  const p = elm.request('0902');
  await elm.close();
  await assert.rejects(p, e => e.code === 'CLOSED');
});

/* ---------- Analizador de archivos ---------- */
test('identify y buscador de mapas en el demo EDC17', () => {
  const { buf, maps } = buildDemo();
  const info = BIN.identify(buf);
  assert.strictEqual(info.family, 'EDC17C10');
  assert.strictEqual(info.endianGuess, 'little');
  assert.deepStrictEqual(info.boschHW, ['0281000000']);
  const found = BIN.findMaps(buf, { endian: 'little' });
  for (const m of maps) {
    const f = found.find(x => x.offset === m.offset);
    assert.ok(f, 'mapa en 0x' + m.offset.toString(16) + ' (' + m.name + ')');
    assert.strictEqual(f.nx, m.x.length);
    assert.strictEqual(f.ny, m.y.length);
    assert.strictEqual(f.order, 'x');
    const g = BIN.mapGrid(buf, f, false);
    assert.strictEqual(g[2][3], m.z(m.x[3], m.y[2]));
  }
  assert.ok(found.length <= maps.length + 2, 'demasiados falsos positivos: ' + found.length);
});

test('buscador automático elige little-endian y compara ORI/MOD', () => {
  const { buf, maps } = buildDemo();
  const mod = buildMod(buf, maps);
  const r = BIN.findMapsAuto(buf);
  assert.strictEqual(r.endian, 'little');
  BIN.annotateChanges(r.maps, buf, mod);
  const changed = r.maps.filter(m => m.changed).map(m => m.offset);
  assert.deepStrictEqual(changed, maps.slice(0, 4).map(m => m.offset));
  const d = BIN.diffFiles(buf, mod);
  assert.ok(d.changed > 0 && d.sameSize);
  assert.ok(d.ranges.some(x => x.start <= 0x7fff0 && x.end > 0x7fff0), 'cambio fuera de mapas detectado');
});

test('buscador en big-endian (estilo EDC16)', () => {
  const size = 128 * 1024;
  const buf = new Uint8Array(size);
  let s = 7;
  for (let i = 0; i < size; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; buf[i] = s >>> 24; }
  const dv = new DataView(buf.buffer);
  const x = [800, 1200, 1600, 2000, 2400, 2800, 3200, 3600, 4000, 4400];
  const y = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000];
  let p = 0x8000;
  const w = v => { dv.setUint16(p, v, false); p += 2; };
  w(x.length); w(y.length); x.forEach(w); y.forEach(w);
  for (const yy of y) for (const xx of x) w(Math.round(900 + xx * 0.2 + yy * 0.1));
  const found = BIN.findMaps(buf, { endian: 'big' });
  assert.ok(found.find(m => m.offset === 0x8000 && m.nx === 10 && m.ny === 8));
  assert.strictEqual(BIN.findMapsAuto(buf).endian, 'big');
});

/* ---------- Asistente ---------- */
test('el Markdown escapa HTML', () => {
  const html = AI.renderMarkdown('**hola** <img src=x onerror=alert(1)>\n- a\n- b');
  assert.ok(!/<img/.test(html));
  assert.ok(/<strong>hola<\/strong>/.test(html));
  assert.ok(/<ul><li>a<\/li><li>b<\/li><\/ul>/.test(html));
});

test('tabla Markdown', () => {
  const html = AI.renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |');
  assert.ok(/<table>/.test(html) && /<td>2<\/td>/.test(html));
});

test('el prompt de sistema incluye el contexto', () => {
  const p = AI.buildSystemPrompt('VEHÍCULO: Citroën C4');
  assert.ok(p.includes('VEHÍCULO: Citroën C4'));
  assert.ok(/español/.test(p));
});

/* ---------- Fichas de vehículos ---------- */
test('migración del vehículo de la versión 0.1', () => {
  const p = PROF.fromLegacy({ brand: 'Citroën', model: 'C4', engine: '1.6 HDi 92 cv', year: '', ecu: 'Bosch (EDC17C10 o EDC16C34, por confirmar)' });
  assert.strictEqual(PROF.label(p), 'Citroën C4 1.6 HDi 92 cv');
  assert.strictEqual(p.ecu.supplier, 'Bosch');
  assert.strictEqual(p.ecu.family, 'EDC17C10');
  assert.deepStrictEqual(p.ecu.alternatives, ['EDC16C34']);
});

test('ficha de la IA: limpia código, valida averías y PIDs', () => {
  const txt = 'Aquí tienes:\n```json\n' + JSON.stringify({
    vehicle: { brand: 'Peugeot', model: '308', engine: '1.6 HDi 112 cv', powerCv: '112', torqueNm: 270 },
    ecu: { supplier: 'Bosch', family: 'EDC17C10', endian: null, protocol: 6, hardware: null },
    maps: [{ name: 'Presión de turbo objetivo', unit: 'mbar', factor: 1 }, { unit: 'sin nombre' }],
    dtcs: [{ code: 'p1351', text: 'Precalentamiento' }, { code: 'XYZ', text: 'mal' }, { code: 'P1351', text: 'duplicado' }],
    livePids: ['0C', '010B', 16, 'zz'],
    confidence: 'media', doubts: ['Confirmar centralita']
  }) + '\n```';
  const p = PROF.parseAIProfile(txt);
  assert.strictEqual(p.vehicle.powerCv, 112);
  assert.strictEqual(p.ecu.endian, 'little');
  assert.strictEqual(p.ecu.protocol, '6');
  assert.strictEqual(p.ecu.hardware, '');
  assert.strictEqual(p.maps.length, 1);
  assert.deepStrictEqual(p.dtcs, [{ code: 'P1351', text: 'Precalentamiento' }]);
  assert.deepStrictEqual(p.livePids, [0x0c, 0x0b, 0x10]);
  assert.strictEqual(p.source, 'ia');
  assert.throws(() => PROF.parseAIProfile('No sé qué coche es.'), /JSON/);
});

test('orden de bytes por familia', () => {
  assert.strictEqual(PROF.endianForFamily('EDC16C34'), 'big');
  assert.strictEqual(PROF.endianForFamily('EDC17C10'), 'little');
  assert.strictEqual(PROF.endianForFamily('EDC15C2'), 'little');
  assert.strictEqual(PROF.endianForFamily('SID807'), null);
});

test('etiquetas de mapas: exacta por software y sugerida en otro', () => {
  const { buf, maps } = buildDemo();
  const info = BIN.identify(buf);
  const key = PROF.swKey(info);
  assert.strictEqual(key, 'SW 1037000000');
  const found = BIN.findMaps(buf, { endian: 'little' });
  const p = PROF.sanitize({ vehicle: { brand: 'Citroën', model: 'C4' } });
  PROF.upsertDef(p, key, found[1], { name: 'Presión de turbo objetivo', unit: 'mbar', factor: 1, add: 0, dec: 0 });
  PROF.upsertDef(p, key, found[1], { name: 'Turbo (renombrado)', unit: 'mbar', factor: 1, add: 0, dec: 0 });
  assert.strictEqual(p.mapDefs.length, 1);
  const hit = PROF.findDef(p, key, found[1]);
  assert.ok(hit.exact && hit.def.name === 'Turbo (renombrado)');
  const other = PROF.findDef(p, 'SW 1037999999', { ...found[1], offset: 0x50000 });
  assert.ok(other && !other.exact);
  assert.strictEqual(PROF.findDef(p, key, found[0]), null);
  PROF.removeDef(p, key, found[1].offset);
  assert.strictEqual(p.mapDefs.length, 0);
  assert.ok(maps.length);
});

test('completar con IA conserva id, fechas y etiquetas', () => {
  const base = PROF.sanitize({ vehicle: { brand: 'Citroën', model: 'C4', engine: '1.6 HDi 92 cv' }, ecu: { family: 'EDC17C10' },
    mapDefs: [{ swKey: 'SW 1', offset: 100, nx: 4, ny: 4, name: 'X' }], dtcs: [{ code: 'P1351', text: 'a' }] });
  const gen = PROF.sanitize({ vehicle: { brand: 'Citroën', model: 'C4', engineCode: 'DV6DTED', powerCv: 92 }, ecu: { family: 'EDC17C10', protocol: '6' },
    dtcs: [{ code: 'P1351', text: 'b' }, { code: 'P1160', text: 'c' }], maps: [{ name: 'Turbo', unit: 'mbar' }], livePids: [12], confidence: 'alta', source: 'ia' });
  const m = PROF.mergeProfiles(base, gen);
  assert.strictEqual(m.id, base.id);
  assert.strictEqual(m.mapDefs.length, 1);
  assert.strictEqual(m.vehicle.engine, '1.6 HDi 92 cv');
  assert.strictEqual(m.vehicle.engineCode, 'DV6DTED');
  assert.strictEqual(m.ecu.protocol, '6');
  assert.deepStrictEqual(m.dtcs.map(d => d.text), ['b', 'c']);
  assert.ok(!PROF.forAI(m).includes('mapDefs'));
});

test('el prompt de fichas limita los PIDs y prohíbe anular anticontaminación', () => {
  const t = PROF.profilePrompt(['0C', '0B']);
  assert.ok(t.includes('0C, 0B'));
  assert.ok(/anticontaminación/.test(t));
});

/* ---------- Editor de mapas ---------- */
test('editor: +% sobre el valor físico, deshacer y rehacer', () => {
  const { buf, maps } = buildDemo();
  const work = new Uint8Array(buf);
  const m = BIN.findMaps(buf, { endian: 'little' }).find(x => x.offset === maps[1].offset); // turbo, valores 1000…2250
  const h = new EDIT.History();
  const cells = [{ r: 5, c: 6 }, { r: 5, c: 7 }];
  const before = cells.map(({ r, c }) => EDIT.getRaw(work, m, r, c));
  const res = EDIT.apply(work, m, cells, { type: 'pct', value: 10 }, { factor: 1 });
  h.push(res.changes, {});
  cells.forEach(({ r, c }, i) => assert.strictEqual(EDIT.getRaw(work, m, r, c), Math.round(before[i] * 1.1)));
  // El original no se toca
  assert.strictEqual(EDIT.getRaw(buf, m, 5, 6), before[0]);
  const st = EDIT.mapStats(buf, work, m);
  assert.strictEqual(st.changed, 2);
  assert.ok(Math.abs(st.maxPct - 10) < 0.2);
  h.undo(work);
  assert.deepStrictEqual(Array.from(work), Array.from(buf));
  h.redo(work);
  assert.strictEqual(EDIT.getRaw(work, m, 5, 6), Math.round(before[0] * 1.1));
});

test('editor: sumar y fijar con factor, límites de 16 bit', () => {
  const { buf, maps } = buildDemo();
  const work = new Uint8Array(buf);
  const m = BIN.findMaps(buf, { endian: 'little' }).find(x => x.offset === maps[0].offset); // inyección ×0,01
  EDIT.apply(work, m, [{ r: 9, c: 5 }], { type: 'set', value: 40.5 }, { factor: 0.01 });
  assert.strictEqual(EDIT.getRaw(work, m, 9, 5), 4050);
  EDIT.apply(work, m, [{ r: 9, c: 5 }], { type: 'add', value: -0.5 }, { factor: 0.01 });
  assert.strictEqual(EDIT.getRaw(work, m, 9, 5), 4000);
  const r = EDIT.apply(work, m, [{ r: 9, c: 5 }], { type: 'set', value: 99999 }, { factor: 0.01 });
  assert.strictEqual(r.clamped, 1);
  assert.strictEqual(EDIT.getRaw(work, m, 9, 5), 65535);
  const r2 = EDIT.apply(work, m, [{ r: 0, c: 0 }], { type: 'add', value: -5 }, { factor: 1 });
  assert.strictEqual(r2.clamped, 1);
  assert.strictEqual(EDIT.getRaw(work, m, 0, 0), 0);
});

test('editor: interpolar y suavizar', () => {
  const { buf, maps } = buildDemo();
  const work = new Uint8Array(buf);
  const m = BIN.findMaps(buf, { endian: 'little' }).find(x => x.offset === maps[4].offset);
  EDIT.apply(work, m, [{ r: 3, c: 2 }], { type: 'set', value: 100 }, {});
  EDIT.apply(work, m, [{ r: 3, c: 6 }], { type: 'set', value: 500 }, {});
  const row = [2, 3, 4, 5, 6].map(c => ({ r: 3, c }));
  EDIT.apply(work, m, row, { type: 'interp' }, {});
  assert.deepStrictEqual(row.map(({ r, c }) => EDIT.getRaw(work, m, r, c)), [100, 200, 300, 400, 500]);
  const spike = new Uint8Array(buf);
  const base = EDIT.getRaw(spike, m, 5, 5);
  EDIT.apply(spike, m, [{ r: 5, c: 5 }], { type: 'add', value: 5000 }, {});
  EDIT.apply(spike, m, [{ r: 5, c: 5 }], { type: 'smooth' }, {});
  const after = EDIT.getRaw(spike, m, 5, 5);
  assert.ok(after < base + 5000 && after > base, 'suavizado ' + after);
});

test('editor: orden de datos invertido y mapa big-endian', () => {
  const m = { zOff: 0, nx: 3, ny: 2, order: 'y', little: false };
  const b = new Uint8Array(12);
  EDIT.apply(b, m, [{ r: 1, c: 2 }], { type: 'set', value: 0x1234 }, {});
  // orden 'y': índice c*ny + r = 2*2+1 = 5 → bytes 10-11, big-endian
  assert.deepStrictEqual(Array.from(b.slice(10, 12)), [0x12, 0x34]);
});

/* ---------- Varias PIDs por petición ---------- */
test('PID_LEN cubre todas las PIDs y splitMulti separa la respuesta', () => {
  for (const p of Object.keys(OBD.PIDS)) assert.ok(OBD.PID_LEN[p], 'falta longitud de ' + Number(p).toString(16));
  const out = OBD.splitMulti([0x41, 0x0c, 0x0c, 0xf8, 0x0b, 0x64, 0x23, 0x03, 0xe8], {});
  assert.deepStrictEqual(out, { 0x0c: 830, 0x0b: 100, 0x23: 100 });
});

test('readPids pide varias PIDs a la vez contra el simulador', async () => {
  const t = new SimTransport(new ELMSimulator());
  await t.open();
  const elm = new ELM327(t);
  await elm.init();
  const pids = [0x0c, 0x0b, 0x10, 0x23, 0x49, 0x0d, 0x0f, 0x62];
  let sent = 0;
  const orig = elm.request.bind(elm);
  elm.request = (h, to) => { sent++; return orig(h, to); };
  const v = await OBD.readPids(elm, pids);
  assert.strictEqual(sent, 2, '8 PIDs en 2 peticiones');
  for (const p of pids) assert.ok(v[p] != null, 'PID ' + p.toString(16));
  assert.ok(v[0x0c] > 600 && v[0x0c] < 5000);
  assert.ok(v[0x62] >= 0 && v[0x62] <= 100, 'par real ' + v[0x62]);
  await elm.close();
});

/* ---------- Logs ---------- */
const LOG = lib('datalog.js');
// Log sintético: 4 s de ralentí, tirón de 6 s a fondo de 1500 a 4200 rpm, 3 s soltando.
function synthLog(boostScale = 1, rpmRate = 450) {
  const log = LOG.newLog({ name: 'prueba', keys: ['0C', '49', '0B', '23', '10', '33'], PIDS: OBD.PIDS, startedAt: 0 });
  let rpm = 830;
  for (let t = 0; t <= 13; t += 0.25) {
    const pull = t >= 4 && t < 10;
    if (pull) rpm = Math.min(4200, (t === 4 ? 1500 : rpm) + rpmRate * 0.25);
    else rpm = t < 4 ? 830 : 1200;
    const boost = pull ? Math.min(1, (rpm - 1300) / 900) * 110 * boostScale : 0;
    log.rows.push({ t, '0C': rpm, '49': pull ? 100 : 0, '0B': 100 + boost, '23': pull ? 300 + rpm * 0.3 : 280, '10': 10 + rpm / 100, '33': 100 });
  }
  return log;
}

test('logs: detecta el tirón y calcula sobrepresión y rail', () => {
  const log = synthLog();
  const pulls = LOG.detectPulls(log);
  assert.strictEqual(pulls.length, 1);
  assert.ok(Math.abs(pulls[0].t0 - 4) < 0.01);
  const st = LOG.pullStats(log, pulls[0]);
  assert.ok(Math.abs(st.boostMax - 1.1) < 0.01, 'boost ' + st.boostMax);
  assert.ok(st.rpmStart < 2000 && st.rpmEnd === 4200, st.rpmStart + '→' + st.rpmEnd);
  assert.ok(st.railMax > 1500);
  // Sin pedal no hay tirones
  const noPedal = LOG.newLog({ name: 'x', keys: ['0C'], PIDS: OBD.PIDS });
  noPedal.rows = log.rows.map(r => ({ t: r.t, '0C': r['0C'] }));
  assert.deepStrictEqual(LOG.detectPulls(noPedal), []);
});

test('logs: CSV de ida y vuelta y CSV ajeno con punto decimal', () => {
  const log = synthLog();
  const back = LOG.parseCSV(LOG.toCSV(log), { name: 'vuelta', PIDS: OBD.PIDS });
  assert.deepStrictEqual(back.keys, log.keys);
  assert.strictEqual(back.rows.length, log.rows.length);
  assert.ok(Math.abs(back.rows[30]['0C'] - log.rows[30]['0C']) < 0.01);
  assert.strictEqual(LOG.detectPulls(back).length, 1);

  const other = LOG.parseCSV('time_ms,RPM (rpm),Boost (bar)\n1000,850.5,0.01\n1500,,0.02\n2000,900,\n', { PIDS: OBD.PIDS });
  assert.deepStrictEqual(other.keys, ['0C', 'x:Boost (bar)']);
  assert.strictEqual(other.defs['x:Boost (bar)'].unit, 'bar');
  assert.deepStrictEqual(other.rows.map(r => r.t), [0, 0.5, 1]);
  assert.strictEqual(other.rows[0]['0C'], 850.5);
  assert.strictEqual(other.rows[1]['0C'], null);
  assert.ok(Math.abs(LOG.valueAt(other, '0C', 0.5) - 875.25) < 1e-9, 'interpola');
  assert.throws(() => LOG.parseCSV('a;b\n1;2'), /tiempo/);
});

test('logs: curva por rpm, tiempo entre regímenes y comparación', () => {
  const a = synthLog(1.15, 520), b = synthLog(1, 450);
  const pa = LOG.detectPulls(a)[0], pb = LOG.detectPulls(b)[0];
  const curve = LOG.byRpm(a, pa, '0B', 500);
  assert.ok(curve.length >= 4 && curve.every((p, i) => !i || p.rpm > curve[i - 1].rpm));
  const span = LOG.commonRpmSpan(a, pa, b, pb);
  assert.deepStrictEqual(span, [2000, 4000]);
  const ta = LOG.timeBetweenRpm(a, pa, 2000, 4000), tb = LOG.timeBetweenRpm(b, pb, 2000, 4000);
  assert.ok(Math.abs(tb - 2000 / 450) < 0.3 && ta < tb, ta + ' / ' + tb);
  const txt = LOG.compareText(a, pa, b, pb);
  assert.ok(/Sobrepresión máx: A 1,2[67] \/ B 1,10 bar \(\+15,0 %\)/.test(txt), txt.split('\n')[1]);
  assert.ok(/Tirones a fondo detectados: 1/.test(LOG.summaryText(a)));
});

/* ---------- Dinamómetro virtual ---------- */
// Tirón simulado con física: par motor conocido, 4.ª marcha (≈ 36 km/h a 1000 rpm), 1400 kg.
function physicsPull({ torqueScale = 1, hz = 10, mass = 1400, loss = 15 } = {}) {
  const T = rpm => torqueScale * (rpm < 1750 ? 150 + (rpm - 1250) * 0.16 : rpm < 2750 ? 230 : 230 - (rpm - 2750) * 0.045); // Nm
  const kms = 36 / 3.6 / 1000; // m/s por rpm
  const log = LOG.newLog({ name: 'fisica', keys: ['0C', '49', '0D'], PIDS: OBD.PIDS, startedAt: 0 });
  let v = 1400 * kms, t = 0, next = 0;
  for (let i = 0; i < 20000 && v / kms < 4400; i++) {
    const rpm = v / kms;
    const pw = T(rpm) * rpm * 2 * Math.PI / 60 * (1 - loss / 100);
    const a = (pw / v - 0.5 * 1.2 * 0.68 * v * v - 0.012 * mass * 9.81) / mass;
    if (t >= next) {
      log.rows.push({ t, '0C': Math.round(rpm * 4) / 4, '49': 100, '0D': Math.round(v * 3.6) });
      next += 1 / hz;
    }
    v += a * 0.005; t += 0.005;
  }
  // 1 s al ralentí delante para que el detector vea el inicio del tirón
  log.rows = [{ t: -1, '0C': 900, '49': 0, '0D': 50 }].concat(log.rows).map(r => ({ ...r, t: r.t + 1 }));
  return { log, maxCv: Math.max(...[...Array(300)].map((_, i) => { const r = 1400 + i * 10; return T(r) * r * 2 * Math.PI / 60 / 735.5; })), maxNm: 230 * torqueScale };
}

test('dinamómetro: recupera potencia y par de un tirón simulado', () => {
  const { log, maxCv, maxNm } = physicsPull();
  const pull = LOG.detectPulls(log)[0];
  assert.ok(pull, 'detecta el tirón');
  const d = LOG.dyno(log, pull, { mass: 1400, cda: 0.68, crr: 0.012, loss: 15 });
  assert.ok(!d.error, d.error);
  assert.ok(Math.abs(d.peakCv - maxCv) / maxCv < 0.04, 'cv ' + d.peakCv.toFixed(1) + ' frente a ' + maxCv.toFixed(1));
  assert.ok(Math.abs(d.peakNm - maxNm) / maxNm < 0.05, 'Nm ' + d.peakNm.toFixed(1) + ' frente a ' + maxNm);
  assert.ok(d.peakNmRpm >= 1700 && d.peakNmRpm <= 2900, 'par máx a ' + d.peakNmRpm);
  assert.ok(Math.abs(d.kmhPer1000 - 36) < 0.5, 'relación ' + d.kmhPer1000);
  assert.strictEqual(d.warnings.length, 0, d.warnings.join(' | '));
  assert.ok(d.peakWheelCv < d.peakCv);
});

test('dinamómetro: Stage 1 da más que serie y avisa de los problemas', () => {
  const serie = physicsPull(), st1 = physicsPull({ torqueScale: 1.2 });
  const ds = LOG.dyno(serie.log, LOG.detectPulls(serie.log)[0]);
  const d1 = LOG.dyno(st1.log, LOG.detectPulls(st1.log)[0]);
  const gain = d1.peakCv / ds.peakCv;
  assert.ok(gain > 1.15 && gain < 1.25, 'ganancia ' + gain.toFixed(3));
  // Más peso declarado → más potencia estimada
  const heavy = LOG.dyno(serie.log, LOG.detectPulls(serie.log)[0], { mass: 1600 });
  assert.ok(heavy.peakCv > ds.peakCv);
  // Sin velocidad no se puede
  const noSpeed = LOG.newLog({ name: 'x', keys: ['0C', '49'], PIDS: OBD.PIDS });
  noSpeed.rows = serie.log.rows.map(r => ({ t: r.t, '0C': r['0C'], '49': r['49'] }));
  assert.ok(/velocidad/.test(LOG.dyno(noSpeed, LOG.detectPulls(noSpeed)[0]).error));
  // Cambio de marcha a mitad: la velocidad deja de seguir al régimen
  const mixed = physicsPull();
  mixed.log.rows.forEach((r, i) => { if (i > mixed.log.rows.length / 2) r['0D'] = Math.round(r['0D'] * 1.3); });
  assert.ok(LOG.dyno(mixed.log, LOG.detectPulls(mixed.log)[0]).warnings.some(w => /marcha/.test(w)));
});

test('logs: filas de Datos en vivo a log', () => {
  const log = LOG.fromRows([{ t: 1000, 12: 800, 11: 100 }, { t: 1500, 12: 900, 11: null }], { name: 'vivo', PIDS: OBD.PIDS });
  assert.deepStrictEqual(log.keys, ['0B', '0C']);
  assert.deepStrictEqual(log.rows, [{ t: 0, '0B': 100, '0C': 800 }, { t: 0.5, '0B': null, '0C': 900 }]);
});

(async () => {
  let ok = 0, fail = 0;
  for (const t of tests) {
    try {
      await t.fn();
      ok++;
      console.log('  ✓ ' + t.name);
    } catch (e) {
      fail++;
      console.log('  ✗ ' + t.name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e));
    }
  }
  console.log('\n' + ok + ' correctas, ' + fail + ' fallidas');
  process.exit(fail ? 1 : 0);
})();
