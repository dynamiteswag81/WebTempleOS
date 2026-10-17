# WebTempleOS: work in progress

TempleOS ported to WebAssembly without x86 emulation. **Start with
HANDOFF.md** (where things stand, how to run them, next steps). DESIGN.md
holds the architecture.

## Done
- Bootstrap compiler: a literal JS port of TempleOS's front-end (DolDoc
  lexing, PrsExp/PrsVar/PrsStmt with the AOT paths, OptPass012), a host env
  for `#exe{}`, the CmpJoin/Cmp BIN writer, and an IC interpreter for
  compile-time evaluation.
- IC→wasm backend: Kernel.PRJ and Compiler.PRJ compile to valid wasm
  (assembly is still stubbed by "lenient asm").
- Runtime loader (runtime/wasmload.js) and HolyC backend tests: 109 checks
  pass (`MSYS_NO_PATHCONV=1 node test/run.mjs`).

## Next
1. Port the kernel's asm to `port/` (builtins plus a data-only asm subset).
2. Boot the kernel in Node.
3. Device emulation, tasks with JSPI.
4. Runtime JIT through the real Compiler, then the browser UI.
