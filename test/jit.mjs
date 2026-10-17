// Runtime JIT tests: boot TempleOS with a C: whose StartOS.HC compiles and
// runs test/hc/*.HC through the real Compiler (Compiler.BIN as wasm, its
// COCCompile feeding runtime/jit.js), and compare with the //> lines.
//   node test/jit.mjs [names...]
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { PC } from '../runtime/pc.js';
import { intermediate_code_table } from '../compiler/opt.js';
import { buildImage, standardTree, treePut } from '../tools/mkdisk.js';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const files = fs.readdirSync(path.join(root, 'test', 'hc')).filter((f) => f.endsWith('.HC') && (!only.length || only.some((o) => f.includes(o))));
const enc = (s) => new Uint8Array(Buffer.from(s, 'latin1'));

const prelude = `_extern _DBG_PUTC U0 DbgPutC(U8 ch);
U0 TPS(U8 *s) { while (*s) DbgPutC(*s++); DbgPutC('\\n'); }
U0 TPI(I64 i) { U8 buf[32]; StrPrint(buf,"%d",i); TPS(buf); }
U0 TPF(F64 d) { U8 buf[32]; StrPrint(buf,"F:%X",d(I64)); TPS(buf); }
`;
const tree = standardTree(root);
let start = `#include "/Kernel/KernelA.HH"
#include "/Compiler/CompilerA.HH"
#include "/Kernel/KernelB.HH"
#include "/Kernel/KernelC.HH"
#include "/Compiler/CompilerB.HH"
#include "/Test/Prelude.HC"
`;
treePut(tree, 'Test/Prelude.HC', enc(prelude));
for (const f of files) {
  const src = fs.readFileSync(path.join(root, 'test', 'hc', f), 'latin1')
    .split('\n').filter((l) => !/^(#include|_extern __TP|_intern )/.test(l)).join('\n');
  treePut(tree, 'Test/' + f, enc(src));
  start += `TPS("@@BEGIN ${f}");\n#include "/Test/${f}"\n`;
}
start += 'TPS("@@END");\n';
treePut(tree, 'StartOS.HC', enc(start));
const { img } = buildImage(tree, { mb: 64 });
const layout = JSON.parse(fs.readFileSync(path.join(root, 'build', 'layout.json'), 'utf8'));
const lines = [];
const pc = new PC({ disk: img, layout, log: (s) => { if (s.startsWith('dbg: ')) lines.push(s.slice(5)); else if (!s.startsWith('io:')) console.log(s); } });
if (process.env.JIT_DUMP) pc.jit.dump = (u) => u.ics.some((t) => (intermediate_code_table[t.code] || {}).name === process.env.JIT_DUMP);
let done;
const fin = new Promise((r) => { done = r; });
pc.onHalt = (e) => done(e);
const iv = setInterval(() => { if (lines.includes('@@END')) done(null); }, 100);
const t0 = Date.now();
pc.boot(new Uint8Array(fs.readFileSync(path.join(root, 'build', 'Kernel.BIN'))));
const to = setTimeout(() => done(new Error('timeout')), +(process.argv.find((a) => a.startsWith('-secs=')) || '-secs=120').slice(6) * 1000);
const e = await fin;
clearInterval(iv); clearTimeout(to);
if (process.argv.includes("-v")) console.log(lines.join("\n"));
const f2s = (h) => { const dv = new DataView(new ArrayBuffer(8)); dv.setBigUint64(0, BigInt('0x' + h)); return String(dv.getFloat64(0)); };
let fail = 0;
for (const f of files) {
  const want = fs.readFileSync(path.join(root, 'test', 'hc', f), 'latin1').split(/\r?\n/).filter((l) => l.startsWith('//> ')).map((l) => l.slice(4));
  const b = lines.indexOf('@@BEGIN ' + f);
  let k = b + 1; const got = [];
  while (b >= 0 && k < lines.length && !lines[k].startsWith('@@BEGIN') && lines[k] !== '@@END') got.push(lines[k++]);
  const out = got.map((l) => (l.startsWith('F:') ? f2s(l.slice(2)) : l));
  const ok = want.length === out.length && want.every((w, i) => w === out[i]);
  if (ok) console.log(`ok ${f} (${out.length} lines)`);
  else {
    fail++;
    console.log(`FAIL ${f}:`);
    for (let i = 0; i < Math.max(want.length, out.length); i++) if (want[i] !== out[i]) console.log(`  line ${i}: want ${JSON.stringify(want[i])} got ${JSON.stringify(out[i])}`);
  }
}
console.log(`--- ${((Date.now() - t0) / 1000).toFixed(1)} s, jit ${pc.jit.units} units ${(pc.jit.ms / 1000).toFixed(1)} s` + (e ? ', halted: ' + (e.stack || e) : ''));
if (e && e.message !== 'timeout') console.log(pc.textScreen());
process.exit(fail || e ? 1 : 0);
