'use strict';
/*
 * Genera archivos de DEMOSTRACIÓN sintéticos (no son de ninguna centralita real):
 *   samples/demo_edc17_ori.bin  y  samples/demo_edc17_mod.bin
 * Sirven para probar el buscador de mapas y el comparador sin tener un volcado real.
 * Uso: node scripts/make-samples.js
 */
const fs = require('fs');
const path = require('path');

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; };
}

function linspace(a, b, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.round(a + ((b - a) * i) / (n - 1)));
  return out;
}

/** Mapas de ejemplo con forma realista (valores en bruto de 16 bit). */
function demoMaps() {
  const rpm16 = [750, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750, 3000, 3250, 3500, 3750, 4000, 4250, 4500];
  const rpm12 = [750, 1000, 1250, 1500, 1750, 2000, 2500, 3000, 3500, 4000, 4500, 5000];
  const pedal10 = [0, 500, 1000, 2000, 3000, 4000, 5000, 6500, 8000, 10000];
  const iq10 = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500];
  const maps = [];
  maps.push({
    name: 'Cantidad de inyección (pedal x rpm)', layout: 'A', x: rpm16, y: pedal10,
    z: (x, y) => Math.max(0, Math.round((y / 10000) * 4300 * (1 - Math.abs(x - 2250) / 6000)))
  });
  maps.push({
    name: 'Presión de turbo objetivo (IQ x rpm)', layout: 'A', x: rpm12, y: iq10,
    z: (x, y) => Math.round(1000 + Math.min(1250, Math.max(0, (x - 1000) / 2200) * (y / 4500) * 1250))
  });
  maps.push({
    name: 'Limitador de humos (masa de aire x rpm)', layout: 'A', x: rpm16.slice(0, 14), y: linspace(100, 1200, 12),
    z: (x, y) => Math.round(y * 3.6 * (0.9 + x / 20000))
  });
  maps.push({
    name: 'Limitador de par (presión atm. x rpm)', layout: 'A', x: rpm16, y: [600, 800, 950, 1050],
    z: (x, y) => Math.round((x < 1750 ? 2400 + (x - 750) * 1.6 : 4000 - (x - 1750) * 0.35) * (0.8 + y / 5000))
  });
  maps.push({
    name: 'Presión de rail objetivo (IQ x rpm)', layout: 'A', x: rpm16, y: linspace(0, 5000, 12),
    z: (x, y) => Math.round(2500 + (x / 4500) * 6000 + (y / 5000) * 7000)
  });
  maps.push({
    name: 'Avance de inyección (IQ x rpm)', layout: 'B', x: rpm12.slice(0, 10), y: iq10,
    z: (x, y) => Math.round(200 + (x / 4500) * 1500 - (y / 4500) * 300)
  });
  return maps;
}

function writeMap(dv, off, m) {
  const nx = m.x.length, ny = m.y.length;
  let p = off;
  const w = v => { dv.setUint16(p, v & 0xffff, true); p += 2; };
  if (m.layout === 'A') { w(nx); w(ny); m.x.forEach(w); m.y.forEach(w); }
  else { w(nx); m.x.forEach(w); w(ny); m.y.forEach(w); }
  m.zOff = p;
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) w(m.z(m.x[c], m.y[r]));
  return p;
}

function buildDemo(size = 512 * 1024) {
  const buf = new Uint8Array(size);
  const rnd = lcg(0xc4c4);
  // "Código": bytes pseudoaleatorios con zonas vacías (0xFF), como un volcado real.
  for (let i = 0; i < size; i++) buf[i] = rnd() >>> 24;
  buf.fill(0xff, 0x70000, 0x7c000);
  const dv = new DataView(buf.buffer);

  const text = (off, s) => { for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i); buf[off + s.length] = 0; };
  text(0x00200, 'ReproChip DEMO - archivo sintetico, no es de una centralita real');
  text(0x00300, 'EDC17C10 DEMO');
  text(0x00320, '0281000000');
  text(0x00330, '1037000000');
  text(0x00340, '9800000080');
  text(0x00360, 'PSA DV6 HDI 92 DEMO');

  const maps = demoMaps();
  let off = 0x40000;
  for (const m of maps) {
    m.offset = off;
    const end = writeMap(dv, off, m);
    off = end + 0x200; // hueco de "código" entre mapas
  }
  return { buf, maps };
}

function buildMod(ori, maps) {
  const mod = new Uint8Array(ori);
  const dv = new DataView(mod.buffer);
  const tweak = (m, fn) => {
    const nx = m.x.length, ny = m.y.length;
    for (let r = 0; r < ny; r++) {
      for (let c = 0; c < nx; c++) {
        const o = m.zOff + 2 * (r * nx + c);
        const v = dv.getUint16(o, true);
        dv.setUint16(o, Math.min(0xffff, Math.round(fn(v, m.x[c], m.y[r]))), true);
      }
    }
  };
  tweak(maps[0], (v, x, y) => (x >= 2000 && y >= 5000 ? v * 1.12 : v));
  tweak(maps[1], (v, x) => (x >= 1750 && x <= 3500 ? v + 120 : v));
  tweak(maps[2], v => v * 1.1);
  tweak(maps[3], v => v * 1.1);
  // Cambio de "checksum" ficticio, como haría una herramienta al guardar.
  dv.setUint32(0x7fff0, 0xdeadbeef, true);
  return mod;
}

if (require.main === module) {
  const { buf, maps } = buildDemo();
  const mod = buildMod(buf, maps);
  const dir = path.join(__dirname, '..', 'samples');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'demo_edc17_ori.bin'), buf);
  fs.writeFileSync(path.join(dir, 'demo_edc17_mod.bin'), mod);
  console.log('Generados en', dir);
  maps.forEach(m => console.log('  0x' + m.offset.toString(16).toUpperCase(), m.x.length + 'x' + m.y.length, m.name));
}

module.exports = { buildDemo, buildMod, demoMaps, lcg };
