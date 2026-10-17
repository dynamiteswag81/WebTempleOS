// Runs the TempleOS machine (runtime/pc.js) in a worker: fetches the kernel
// and the C: drive, keeps written sectors in IndexedDB, draws the screen.
import { PC } from '../runtime/pc.js';
import { DiskStore } from '../runtime/diskstore.js';

const status = (text) => postMessage({ type: 'status', text });
const log = (text) => postMessage({ type: 'log', text });
let pc = null, store = null;

async function fetchBytes(url, what) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} (build it: see HANDOFF.md)`);
  const len = +r.headers.get('Content-Length') || 0;
  const out = new Uint8Array(len);
  const rd = r.body.getReader();
  let n = 0, last = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    out.set(value, n); n += value.length;
    if (len && Date.now() - last > 200) { last = Date.now(); status(`Loading ${what}: ${Math.round(100 * n / len)}%`); }
  }
  return { bytes: out, id: `${len}-${r.headers.get('Last-Modified')}` };
}

async function start(canvas) {
  const ctx = canvas.getContext('2d');
  const layout = await (await fetch('../build/layout.json')).json();
  const kernel = (await fetchBytes('../build/Kernel.BIN', 'kernel')).bytes;
  const { bytes: disk, id } = await fetchBytes('../build/C.img', 'C: drive');
  try {
    store = await DiskStore.open();
    const n = await store.load(disk, id);
    log(n ? `C: drive: ${n} saved chunks restored from this browser` : 'C: drive: fresh image');
  } catch (e) { store = null; log('IndexedDB unavailable, files will not be kept: ' + e); }
  pc = new PC({ vga: true, disk, layout, log, onDiskWrite: store ? (lba, n) => store.written(lba, n) : null });
  pc.onHalt = (e) => { status('Halted: ' + (e && e.message)); log(String(e && e.stack)); };
  status('Booting TempleOS... (click the screen to use the mouse)');
  pc.boot(kernel);
  const img = ctx.createImageData(640, 480), px = new Uint32Array(img.data.buffer);
  setInterval(() => { pc.vgaDev.render(pc.u8, px); ctx.putImageData(img, 0, 0); }, 33);
  if (store) setInterval(() => store.flush().catch((e) => log('save failed: ' + e)), 1000);
  let shown = false;
  setInterval(() => {
    if (!shown && pc.jit && pc.jit.units > 3000) { shown = true; status('TempleOS (click the screen to capture the mouse; Esc releases it)'); }
  }, 500);
}

onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'start') await start(m.canvas);
    else if (!pc) return;
    else if (m.type === 'key') pc.key(m.code, m.up);
    else if (m.type === 'mouse') pc.mouse(m.dx * 2, m.dy * 2, m.buttons, m.dz || 0);
    else if (m.type === 'reset') { if (store) await store.reset(); status('C: drive reset: reload the page'); }
  } catch (err) { status('Error: ' + err.message); log(err.stack); }
};
