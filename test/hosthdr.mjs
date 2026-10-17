// Smoke test: JIT-compile TempleOS headers into the bootstrap host env.
import path from 'path';
import { fileURLToPath } from 'url';
import { Bootstrap } from '../compiler/aot.js';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const boot = new Bootstrap({ roots: [path.join(root, 'port'), path.join(root, 'vendor', 'TempleOS')], warnings: process.argv.includes('-w') });
const t0 = Date.now();
for (const f of process.argv.slice(2).filter((a) => !a.startsWith('-'))) {
  try {
    boot.hostExeFile(f);
    console.log('ok', f, Date.now() - t0, 'ms');
  } catch (e) {
    console.log('FAIL', f, e.stack);
    process.exit(1);
  }
}
let n = 0; for (const _ of boot.hostTable.entries()) n++;
console.log('host symbols:', n);
