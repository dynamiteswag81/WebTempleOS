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

const pc = new PC({ ramMB: +arg('ram', 1024) });
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
if (e) { console.log('--- halted:', e.stack || e); process.exit(1); }
process.exit(0);
