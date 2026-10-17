// Front-end test: AOT compile a project (default the kernel) with lenient asm.
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Bootstrap } from '../compiler/aot.js';
import { AOTBackend } from '../compiler/backend.js';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = process.argv.includes('-nobackend') ? null : new AOTBackend({ lenient: !process.argv.includes('-strict') });
const boot = new Bootstrap({ roots: [path.join(root, 'port'), path.join(root, 'vendor', 'TempleOS')], warnings: process.argv.includes('-w'), backend });
boot.lenientAsm = !process.argv.includes('-strict');
boot.hostInit();
const prj = process.argv.slice(2).find((a) => !a.startsWith('-')) || '/Kernel/Kernel';
const t0 = Date.now();
try {
  const r = boot.Cmp(prj);
  if (r.aot.wasm) {
    fs.mkdirSync(path.join(root, 'build'), { recursive: true });
    fs.writeFileSync(path.join(root, 'build', path.basename(prj) + '.wasm'), r.aot.wasm);
    try { new WebAssembly.Module(r.aot.wasm); console.log('wasm module valid,', r.aot.wasm.length, 'bytes'); }
    catch (e) { console.log('wasm INVALID:', e.message); }
  }
  console.log(`ok ${prj}: image ${r.aot.aot_U8s} bytes, bin ${r.bin.length} bytes, ie ${r.aot.ie.length}, ${Date.now() - t0} ms, lines ${boot.cmp.compiled_lines}`);
} catch (e) {
  console.log('FAIL', e.stack);
  process.exit(1);
}
