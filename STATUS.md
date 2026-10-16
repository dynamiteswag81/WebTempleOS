# WebTempleOS: work in progress

Goal: a faithful port of TempleOS to WebAssembly (no x86 emulation). No networking (per the user).

## Architecture (decided)
- **Bootstrap compiler** (`compiler/`): a JS port of TempleOS's own front-end
  (Lex.HC, PrsExp/PrsStmt/PrsVar/PrsLib, OptLib/OptPass012). It produces TempleOS
  intermediate code (ICs) identical to what the real compiler produces.
- **Shared IC->wasm backend** (`public/js/backend.js`, NOT WRITTEN YET): translates the
  post-OptPass012 IC postfix stream directly onto the wasm operand stack, splits it into
  basic blocks, and structures control flow with a dominator-based stackifier (dispatch
  loop if irreducible). Locals that are never address-taken get promoted to wasm locals.
  try/catch: outline the try and catch regions into helper functions and use wasm EH.
  Switch start/end porches (IC_SUB_CALL) use a return-address local plus br_table.
- **ABI**: every function is `() -> i64`. Args go on a linear-memory shadow stack
  (`$sp` global) in TempleOS order (arg i at fp+16+8i), and the caller restores `$sp`.
  Function pointers point to 8-byte descriptors that hold a table index, so `Call()`,
  `Free()` on machine code, and the IDT all keep working. Globals hold `$sp`, `Fs`, `Gs`
  and the interrupt flag.
- **Kernel + Compiler** are AOT-compiled by the bootstrap into `kernel.wasm` plus a data
  image (at 0x7C00), with a TempleOS-format export patch table so the original
  `LoadKernel()` works. Kernel `#exe{}` config blocks are replaced by port files.
- **Runtime JIT**: TempleOS's real compiler (in wasm) runs OptPass012, then calls the JS
  backend through an import that replaces COCCompile/OptPass789A. Adam, the shell, and
  demos are JIT-compiled from C: at boot, as in real TempleOS.
- **Tasks**: JSPI (Chrome 152 in the pane supports it). Each task is a suspendable wasm
  stack, Yield is a ported `_YIELD` in HolyC plus a JS switch, and the idle path returns
  to the event loop.
- **Hardware**: a JS port-I/O bus (PIT, PIC, PS/2 kbd/mouse, CMOS RTC, VGA DAC, speaker,
  ATA PIO disk so the original DskATA/RedSea code runs). Shared memory carries the
  framebuffer and IRQ flags. The final VGA blit is replaced by a present call. The disk
  image persists to IndexedDB (dirty chunks, periodic plus pagehide/visibilitychange).

## Done
- server.cjs (zero-dep, port 8090, COOP/COEP), .claude/launch.json
- tools/gen-consts.js -> compiler/consts.js (constants taken from the TempleOS headers)
- compiler/util.js, core.js (hash tables, classes with pointer levels, members)
- compiler/lex.js (port of Lex/LexLib, raw-text path)
- compiler/parse.js (port of PrsLib/PrsExp/PrsVar/PrsStmt)
- compiler/opt.js (port of OptLib/OptPass012 + intermediate_code_table)
None of this has been run or tested yet.

## Next
1. compiler/aot.js: env hooks (includeFile, #exe Cd/Option, LexExpression const-eval of
   IC trees, globals/static/data image, descriptors, PrsVarInit/PrsGlblInit, _extern
   binding with builtins `__W_*`, import binding across Kernel/Compiler units).
   Parse-test it on Kernel.PRJ and Compiler.PRJ.
2. Backend (see above), then run small HolyC tests in Node (`--experimental-wasm-jspi`).
3. port/ overlay: replacements for KStart*, Sched (_YIELD), KInts, KExcept (throw via
   wasm EH), KUtils/StrA/KMathA/KHashA/MAllocFree/Compress asm, MultiProc, PCI, HPET,
   KMain (#exe baked), DskAddDev, a COCCompile hook in Compiler, and the GrUpdateVGA blit.
4. JS runtime (worker, devices, scheduler), disk image builder (MBR + RedSea C:),
   UI, start.bat, README, end-to-end test in the browser pane.
