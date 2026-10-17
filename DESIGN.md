# WebTempleOS design notes

TempleOS ported to WebAssembly without emulating x86. TempleOS's own compiler
front-end produces intermediate code (ICs); a shared IC->wasm backend replaces
the x86 back-end (OptPass3..OptPass789A). Everything above the back-end is
TempleOS's own HolyC.

## Bootstrap compiler (`compiler/`)
A literal JS port of the TempleOS front-end: Lex/LexLib, PrsLib/PrsExp/PrsVar/
PrsStmt, OptLib/OptPass012, plus the AOT machinery (CAOTCtrl rip/bin,
CAOTImportExport lists, AOTGlblsResolve, the Cmp() patch-table writer).
It keeps the CCF_AOT_COMPILE code paths exactly (IC_ABS_ADDR, IC_CALL_EXTERN,
IC_CALL_IMPORT, IC_ADDR_IMPORT, IET_MAIN init code, ...), because the
relocatable Compiler module and TempleOS's own `Load()` depend on them.

* Source files are lexed as DolDoc documents (`doldoc.js`), as `LexAttachDoc`
  does, so `$LK,...$` etc. behave exactly as in TempleOS (skipped in code,
  kept as text inside string literals).
* `COCCompile` is the hook point. In AOT mode it runs the backend and returns
  the "code blob" the caller stores at `aotc->rip` (see below). In JIT mode
  (only used at bootstrap time for constant expressions and `#exe{}` blocks)
  it returns an IC program run by a small IC interpreter.

## Code addresses = function descriptors
`exe_addr` of a function is the address of an 8-byte *descriptor* in linear
memory: `U32 table_index, U32 module_func_index`. A function pointer is a
descriptor address, so `&Fun`, `Call()`, `fp_*` callbacks, `Spawn()`, `Free()`
of JIT code, export tables and `Load()` all keep working unchanged.

A *code blob* (what COCCompile returns) is laid out as
`[descriptor 8][string constants][import slots]`, aligned to 8. String
constants live right after the descriptor just like TempleOS places them after
the machine code. In AOT mode the blob is stored at `aotc->rip`; in JIT mode it
is `MAlloc`ed on `Fs->code_heap`.

## ABI (x86-exact shadow stack)
* Linear memory is wasm32 (shared, fixed size). HolyC values are i64/f64;
  addresses are `i32.wrap_i64`'d at each access.
* Every wasm function has type `() -> i64` (the i64 is RAX).
* The shadow stack mirrors x86 TempleOS exactly: the caller pushes args in IC
  order (arg0 ends up at fp+16), then a "return address" marker (the caller's
  descriptor address); IC_ENTER pushes the old fp. Locals are at negative
  offsets from fp. `Ff_RET1` callees pop their own args (`RET n`), others are
  popped by the caller's IC_ADD_RSP, exactly like the original.
* Globals: `$sp` (i32), `$fp` (frame chain, for GetRBP/Caller()), `$fs`
  (current CTask, read as FS:[0]), `$gs` (current CCPU).
* IC_RET pops the top of the shadow stack: values below LABEL_LIMIT are local
  continuation ids (switch `start:` sub-calls, catch-block ends), anything else
  returns from the wasm function.

## try/catch
TempleOS runs a catch block *before* unwinding (throw() -> TestExcept jumps to
the catch code, which RETs back into throw()). We keep that observable
behaviour with wasm exceptions:
* IC_GET_LABEL yields a label id. SysTry stores label ids in CExcept.
* TestExcept/TakeExcept throw a wasm exception `$resume(fp, label, sp)`.
* A function containing resumable labels wraps its body in
  `loop { try { dispatch($resume_label) ...body... } catch $resume { if fp
  matches: set sp, label; br loop; else rethrow } }`; resumable labels are
  extra successors of the entry block in the CFG.
* The catch block runs with sp = the throw-time sp (so the thrower's stack
  memory survives, as on x86) and a CATCH_END marker pushed; its terminating
  IC_RET calls the port's `_CatchEnd()` which does the rest of throw()'s loop.

## Control flow
The backend splits the IC stream into basic blocks and structures them with a
dominator-based algorithm (Ramsey, "Beyond Relooper"). Irreducible functions
fall back to a loop+br_table state machine. Locals that are never
address-taken may be promoted to wasm locals (not in functions with try,
matching TempleOS's CCF_NO_REG_OPT).

## Modules
* Kernel: AOT-compiled to `kernel.wasm` + a TempleOS BIN image. Assembly
  files (KStart*, KUtils, StrA, KMathA, KHashA, Sched _YIELD, KInts, KExcept
  asm...) are replaced by HolyC/builtin versions in `port/`.
* Compiler: AOT-compiled to a BIN whose image holds the data image and the
  wasm bytes. `Load()` gets one added call (instantiate the wasm module and fill
  descriptors) before its unchanged LoadPass1/LoadPass2. Imports from other
  modules go through 8-byte slots patched by IET_IMM_I64 entries.
* Runtime JIT: the real TempleOS compiler (in wasm) runs OptPass012, then its
  COCCompile calls the JS backend through an import; the backend reads the IC
  list from linear memory.

## Tasks
JSPI: each TempleOS task is a suspendable wasm stack; Yield switches by
suspending to a JS scheduler.
