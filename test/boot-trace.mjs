// Debug aid: boot a -trace kernel build in a worker; after -secs, print the
// last function entries (works even when wasm spins without yielding).
//   node tools/build.js Kernel -trace && node test/boot-trace.mjs -secs=3
import { Worker, isMainThread, workerData } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 4096;
if (isMainThread) {
  const secs = +((process.argv.find((a) => a.startsWith('-secs=')) || '-secs=3').slice(6));
  const sab = new SharedArrayBuffer(4 * (2 * N + 2));
  const names = JSON.parse(fs.readFileSync(path.join(root, 'build', 'Kernel.trace.json'), 'utf8'));
  const w = new Worker(fileURLToPath(import.meta.url), { workerData: { sab } });
  let mem = null, ex = null;
  w.on('message', (m) => { if (m && m.mem) { mem = m.mem; ex = m.ex; } else console.log(m); });
  w.on('error', (e) => console.log('worker error', e));
  setTimeout(() => {
    const a = new Int32Array(sab);
    const n = Atomics.load(a, 0);
    console.log(`--- ${n} calls; last ones (fn sp):`);
    for (let i = Math.max(0, n - 60); i < n; i++) { const k = i % N; console.log(names[a[2 + 2 * k]], (a[3 + 2 * k] >>> 0).toString(16)); }
    if (mem && process.argv.includes('-dump')) {
      const dv = new DataView(mem.buffer);
      const q = (a) => Number(dv.getBigUint64(a, true));
      const bp = q(Number(ex.SYS_CODE_BP));
      console.log('sys_code_bp', bp.toString(16), 'locked', q(bp), 'alloced', q(bp + 8).toString(16), 'used', q(bp + 16).toString(16));
      let m = q(bp + 24), k = 0;
      while (m && k++ < 8) { console.log('  free blk', m.toString(16), 'next', q(m).toString(16), 'sig', dv.getUint32(m + 16, true).toString(16), 'pags', dv.getUint32(m + 20, true)); m = q(m); }
      const hc = 0x100000 + 4488; // CSysFixedArea.adam_hc
      console.log('adam_hc', hc.toString(16), 'sig', dv.getUint32(hc + 8, true).toString(16), 'locked', q(hc + 16), 'alloced', q(hc + 24).toString(16), 'used', q(hc + 32).toString(16), 'last_mergable', q(hc + 64).toString(16));
      let u = q(hc + 72); k = 0;
      while (u && k++ < 8) { console.log('  malloc_free', u.toString(16), 'next', q(u).toString(16), 'size', q(u + 8).toString(16)); u = q(u); }
      for (let i = 0; i < 128; i++) { const h = q(hc + 96 + 8 * i); if (h) console.log('  heap_hash[' + i + ']', h.toString(16), 'next', q(h).toString(16)); }
    }
    w.terminate();
    process.exit(0);
  }, secs * 1000);
} else {
  const { PC } = await import('../runtime/pc.js');
  const a = new Int32Array(workerData.sab);
  const { parentPort } = await import('worker_threads');
  const pc = new PC({ log: (s) => parentPort.postMessage(s), trace: (id, sp) => {
    const n = a[0]; const k = n % N; a[2 + 2 * k] = id; a[3 + 2 * k] = Number(sp); Atomics.store(a, 0, n + 1);
  } });
  pc.onHalt = (e) => parentPort.postMessage('halt: ' + (e.stack || e));
  pc.load(new Uint8Array(fs.readFileSync(path.join(root, 'build', 'Kernel.BIN'))));
  parentPort.postMessage({ mem: pc.m.memory, ex: Object.fromEntries(pc.kernel.exports) });
  setTimeout(() => pc.start(), 50);
  setInterval(() => parentPort.postMessage('screen:\n' + pc.textScreen()), 2000);
}
