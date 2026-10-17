// Build: AOT compile the Kernel (and the Compiler) with the bootstrap
// compiler into TempleOS BINs carrying their wasm modules.
//   node tools/build.js [Kernel] [Compiler]     (default: both)
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Bootstrap } from '../compiler/aot.js';
import { AOTBackend } from '../compiler/backend.js';
import { BUILTINS } from '../runtime/builtins.js';
import { MEM_PAGES } from '../runtime/pc.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build');

export function buildModule(prj, { builtins = BUILTINS, requireAliases = false, lenient = false, trace = false } = {}) {
  const backend = new AOTBackend({ builtins, requireAliases, lenient, trace, blockTrace: process.env.HCC_BTRACE ? process.env.HCC_BTRACE.split(',') : null, memPages: MEM_PAGES, memMax: MEM_PAGES });
  const boot = new Bootstrap({ roots: [path.join(root, 'port'), path.join(root, 'vendor', 'TempleOS')], backend });
  boot.lenientAsm = lenient;
  boot.hostInit();
  const r = boot.Cmp(prj);
  r.traceNames = backend.traceNames;
  return r;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const which = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const targets = which.length ? which : ['Kernel'];
  fs.mkdirSync(out, { recursive: true });
  for (const t of targets) {
    const t0 = Date.now();
    const prj = t === 'Kernel' ? '/Kernel/Kernel' : '/Compiler/Compiler';
    const trace = process.argv.includes('-trace');
    const r = buildModule(prj, t === 'Kernel' ? { requireAliases: true, trace } : { lenient: process.argv.includes('-lenient'), trace });
    fs.writeFileSync(path.join(out, t + '.BIN'), r.bin);
    if (trace) fs.writeFileSync(path.join(out, t + '.trace.json'), JSON.stringify(r.traceNames));
    console.log(`${t}.BIN: ${r.bin.length} bytes (image ${r.aot.aot_U8s}, wasm ${r.aot.wasm.length}), ${Date.now() - t0} ms`);
  }
}
