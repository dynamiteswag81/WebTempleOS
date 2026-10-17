// Print member offsets of TempleOS classes (from KernelA.HH), for JS-side
// debugging and runtime code:  node tools/offsets.mjs CTask CCPU ...
import path from 'path';
import { fileURLToPath } from 'url';
import { Bootstrap } from '../compiler/aot.js';
import { members, HashFind } from '../compiler/core.js';
import * as K from '../compiler/consts.js';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The classes the runtime (runtime/jit.js, runtime/pc.js) reads.
export const RUNTIME_CLASSES = ['CTask', 'CCPU', 'CCmpCtrl', 'CLexHashTableContext', 'CCodeCtrl', 'CIntermediateCode',
  'CICTreeLinks', 'CCodeMisc', 'CHash', 'CHashClass', 'CHashFun', 'CAOT', 'CBinFile', 'CHashExport', 'CHashGlblVar'];
export function classOffsets(names) {
  const boot = new Bootstrap({ roots: [path.join(root, 'port'), path.join(root, 'vendor', 'TempleOS')] });
  boot.hostExeFile('/Kernel/KernelA.HH');
  const out = {};
  for (const n of names) {
    const c = HashFind(n, boot.hostTable, K.HTT_CLASS);
    if (!c) throw new Error('no class ' + n);
    out[n] = { sizeof: c.size };
    const chain = [];
    for (let b = c; b; b = b.base_class) chain.unshift(b);
    for (const b of chain) for (const m of members(b)) out[n][m.str] = m.offset;
  }
  return out;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(classOffsets(process.argv.slice(2)), null, 1));
