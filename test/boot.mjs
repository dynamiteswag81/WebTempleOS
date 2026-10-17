// Boot the kernel in Node and print what it shows.
//   node test/boot.mjs [-secs=N] [-trace]
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { PC } from '../runtime/pc.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`-${n}=`)); return a ? a.slice(n.length + 2) : d; };
const secs = +arg('secs', 5);
const bin = fs.readFileSync(path.join(root, 'build', 'Kernel.BIN'));

// With a -trace build (node tools/build.js -trace): record function entries,
// and break out of a synchronous loop after -secs.
const tracePath = path.join(root, 'build', 'Kernel.trace.json');
const names = process.argv.includes('-trace') && fs.existsSync(tracePath) ? JSON.parse(fs.readFileSync(tracePath, 'utf8')) : null;
const ring = [], counts = new Map();
let ncalls = 0, deadline = performance.now() + secs * 1000;
const trace = names && ((id, sp) => {
  ring.push([id, Number(sp)]); if (ring.length > 80) ring.shift();
  counts.set(id, (counts.get(id) || 0) + 1);
  if (++ncalls % 1000000 === 0 && performance.now() > deadline) throw new Error('trace: deadline in a synchronous run');
});
const pc = new PC({ ramMB: +arg('ram', 1024), trace });
let done;
const finished = new Promise((r) => { done = r; });
pc.onHalt = (e) => done(e);
const t0 = performance.now();
pc.boot(new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength));
const timer = setTimeout(() => done(null), secs * 1000);
const e = await finished;
clearTimeout(timer);
console.log(`--- ${((performance.now() - t0) / 1000).toFixed(2)} s, ${pc.sched.switches} task switches`);
console.log(pc.textScreen());
if (names) {
  console.log('--- last calls (fn sp):');
  for (const [id, sp] of ring) console.log(names[id] + ' ' + sp.toString(16));
  console.log('--- most called:');
  for (const [id, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(names[id] + ' ' + n);
}
if (e) { console.log('--- halted:', e.stack || e); process.exit(1); }
process.exit(0);
