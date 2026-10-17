// Backend tests: AOT compile test/hc/*.HC, run them in Node, compare output.
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Bootstrap } from '../compiler/aot.js';
import { AOTBackend } from '../compiler/backend.js';
import { Machine } from '../runtime/wasmload.js';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const files = fs.readdirSync(path.join(root, 'test', 'hc')).filter((f) => f.endsWith('.HC') && (!only.length || only.some((o) => f.includes(o))));
let fail = 0;
for (const f of files) {
  const out = [];
  const builtins = [
    { name: '__TPI', kind: 'js', nargs: 1, ret1: true },
    { name: '__TPF', kind: 'js', nargs: 1, ret1: true },
    { name: '__TPS', kind: 'js', nargs: 1, ret1: true },
  ];
  let m;
  const js = {
    __TPI: (i) => { out.push(String(BigInt.asIntN(64, i))); return 0n; },
    __TPF: (d) => { const v = new DataView(new ArrayBuffer(8)); v.setBigInt64(0, d, true); out.push(String(v.getFloat64(0, true))); return 0n; },
    __TPS: (p) => { const u8 = m.u8; let s = '', a = Number(p); while (u8[a]) s += String.fromCharCode(u8[a++]); out.push(s); return 0n; },
  };
  const backend = new AOTBackend({ builtins, memPages: 256, memMax: 256 });
  const boot = new Bootstrap({ roots: [path.join(root, 'test', 'hc'), path.join(root, 'port'), path.join(root, 'vendor', 'TempleOS')], backend });
  let r;
  try { r = boot.Cmp('C:/' + f); } catch (e) { console.log(`FAIL ${f}: compile: ${e.stack}`); fail++; continue; }
  m = new Machine({ memPages: 256, imports: { js } });
  m.sp.value = 256 * 65536 - 64;
  let lb;
  try {
    lb = m.loadBin(r.bin, 0x100000);
    for (const main of lb.mains) m.call(main);
  } catch (e) { console.log(`FAIL ${f}: run: ${e.stack}`); console.log(out.join('\n')); fail++; continue; }
  const want = fs.readFileSync(path.join(root, 'test', 'hc', f), 'latin1').split(/\r?\n/).filter((l) => l.startsWith('//> ')).map((l) => l.slice(4));
  const ok = want.length === out.length && want.every((w, i) => w === out[i]);
  if (ok) console.log(`ok ${f} (${out.length} lines)`);
  else {
    fail++;
    console.log(`FAIL ${f}:`);
    for (let i = 0; i < Math.max(want.length, out.length); i++)
      console.log(`  ${want[i] === out[i] ? ' ' : '!'} want ${JSON.stringify(want[i])} got ${JSON.stringify(out[i])}`);
  }
}
process.exit(fail ? 1 : 0);
