# WebTempleOS — handoff (2026-10-17)

Goal: a faithful port of TempleOS to WebAssembly. No x86 emulation, no
networking. TempleOS's own compiler front-end produces intermediate code (ICs),
and a shared IC→wasm backend replaces its x86 back-end. Read **DESIGN.md**
first; it holds the architecture and the reasons behind it. This file says
where things stand and what to do next.

## State (2026-10-17, session 4, ~11:15 UTC)
Setup on a fresh machine: `sh tools/fetch-vendor.sh`, Node 24+ (if the
machine has an older node first on PATH, put Node 24's bin dir first).

**Boot in Node reaches the normal TempleOS desktop** (VGA 640x480x16):
`node tools/build.js Kernel && node tools/build.js Compiler && node tools/mkdisk.js && node test/boot.mjs -secs=30`
writes `build/screen.png`: WinMgr, two user terminals, Tip of the Day,
"Take Tour(y or n)?".  The real Compiler (Compiler.BIN as wasm) JIT-compiles
StartOS/Adam through runtime/jit.js.

What session 4 added (see git log for details):
- Boot fixes: `sys_ctrl_alt_flags` is an array (Sched.HC tested its addr);
  `--*p` is `*(--p)` in HolyC (KHashA port); f2i opcode (trunc_sat_f64_s
  is 0xFC 6); RFLAGS/IRQ depth per stack (no nested timer IRQs).
- Devices: `runtime/ata.js` (ATA PIO disk on 0x1F0), `runtime/ps2.js`
  (8042, keyboard set 1, wheel mouse, `pc.typeText()`), `runtime/vga.js`
  (DAC/attr palette, planes at 0xA0000+p*0x10000, `render()`).
- `tools/mkdisk.js`: RedSea C: image (MBR + RedSea partition at 63) from
  vendor/TempleOS + port/ + build/{Kernel,Compiler}.{BIN,MAP}.
  `tools/rsls.js img [/dir]` lists a directory of an image.
- `tools/binfix.js`: the upstream git tree was extracted with
  `TOSZ -ascii`, which deleted every 0x05 byte and turned 0x1F into 0x20
  in whole files, so DolDoc sprite bins don't parse ("Bin Not Found",
  3 s RawPrint each).  binfix re-parses bins with the sprite grammar and
  re-inserts the 0x05s; 35 of 39 damaged docs are repaired, 4 fail
  (RawHide.HC, Titanium.HC and 2 more: run it to see).  .DATA files
  (AutoComplete dictionaries) may be damaged the same way.
- Compiler: `port/Compiler/` (Compiler.PRJ without the x86 back-end,
  Templates labels only, CMisc `_LAST_FUN` = copy of a descriptor,
  PrsLib `COCCompile` = OptPass012 then `JITCompile`/`JITStore`).
  `runtime/jit.js` reads CIntermediateCode lists from linear memory
  (offsets from build/layout.json, written by the Kernel build) into the
  backend's IC shape; one wasm module per compile unit.
- `port/Kernel/KLoad.HC`: `WasmLoad()` instantiates a BIN's wasm.
- Adam ports: `port/Adam/Gr/{GrAsm,GrTextBase,GrScrn}.HC` (asm in HolyC,
  VGA planes), `port/Adam/Opt/Boot/BootRAM.HC` (hard reboot).
- JSPI breathing: `_IRQ_PENDING` and port `in` may suspend about every
  10 ms so polling loops let the JS event loop run.

Tests:
- `node test/run.mjs` (AOT backend tests), `node test/jit.mjs` (the same
  test/hc files compiled at run time by the real Compiler, ~2 s),
  `node test/jit.mjs -adam` (test/hca/*.HC after MakeAdam).
- `node test/boot.mjs -secs=N [-type="text\n" -typeat=S] [-text]` boots,
  types, and saves build/screen.png.  With a `-trace` kernel build:
  `-trace -until=Fn -ring=N -skip=A,B -args=Fn` (JIT'd functions are
  traced too, as `jit:Name`).

Next steps: see "Next steps" at the end of this file.

Debugging tools (session 3):
- `node tools/build.js Kernel -trace` compiles a call to the `trace`
  import at every function entry (names in `build/Kernel.trace.json`).
- `node test/boot-trace.mjs -secs=3 [-dump]` boots that build in a worker
  thread and prints the last function entries even while wasm spins
  synchronously; `-dump` prints heap/pool state from the shared memory
  (edit it to dump what you need).
- `HCC_DUMP=Fn` listings now print threaded labels as `Lx->Ly`.

Backend bugs fixed (session 3, tests in `test/hc/heap.HC`):
- Labels were mapped to blocks by `fwd(label)`. OptPass012 threads
  `LABEL x; JMP y` as `x.fwd=y` but keeps x's LABEL IC, so x's block
  replaced y's and `JMP y` jumped to itself (infinite loop in
  MemPagTaskAlloc). Now a label maps to its own block; branches use fwd.
- A switch case threaded backward (case label -> loop head) is now
  supported with trampoline blocks (was an error).

What was added for the boot (session 3):
- `port/Kernel/KMain.HC`: original + `KStartWasm()` (KStart32/64's jobs:
  page tables, sys_code_bp, CPU0 struct, Adam's heap ctrl, TaskInit, then
  `CtxSwitch(Fs)` so the boot stack becomes Adam's, `SetRSP`, `KMain`).
  It tells JS the CTask field offsets through the new js builtin
  `_PORT_SET` (`PortSet(key,val)`, keys `PORT_*` in PortA.HC).
- `runtime/pc.js`: `PC` = Machine + devices + boot loader (fills the
  KStart16 vars: E801/E820 with a reserved entry up to 4 GB, boot base
  0x7C20, patch table base, run level) + the builtins' JS services
  (`cpuid`, `irqPending`, `hltWait`, `portSet`, `textScreen()`).
- `runtime/sched.js`: JSPI task switching as designed below. A new task is
  started by a small wasm trampoline (`task_start`) on a fresh promising()
  stack; suspended stacks are keyed by CTask address + task_num.
  `enter()` restores RFLAGS from `CTask.rflags` (IRET).
- `runtime/devices.js`: IOBus, 8259 PIC pair, 8254 PIT (IRQ0 from real time,
  coalesced), CMOS RTC (BCD), ports 0x61/0x80/0x92, PCI config (no devices).
  Still to write: PS/2 keyboard/mouse, ATA disk + RedSea image builder, VGA.
- `tools/build.js` (builds `build/Kernel.BIN` with 65536-page memory
  imports; the AOT backend default is 16384) and `test/boot.mjs`.
- `runtime/wasmload.js`: `loadBin` copies only header+image+patch table.

**Earlier (session 2): the kernel asm port is done.**
`MSYS_NO_PATHCONV=1 node test/cmpkernel.mjs -strict` compiles all of Kernel.PRJ
with no asm skipped (715 KB valid wasm, every builtin alias resolved).
`test/run.mjs` still passes.

What session 2 added:
- `compiler/asm.js`: a data-only port of PrsAsmBlk (labels, `::` exports,
  `@@` locals, DU8..DU64 with strings and DUP, ALIGN, USE16/32/64, IMPORT).
  An opcode is an error. The lenient mode still uses the old skipper.
- `runtime/builtins.js`: the builtin registry (order = ABI, append only).
  Kinds: `alias` (HolyC fn in port/), `wasm` (hand-built: _MEMCPY, _MEMSET,
  _RET, _SET_FS_BASE, _SET_GS_BASE, _CALL_ARGV, _RESUME, _FLOOR/_CEIL/
  _TRUNC/_ROUND), `js` (math, _CPUID, _CTX_SWITCH, _HLT_WAIT, _IRQ_PENDING,
  _DBG_PUTC; `suspend:true` = must be a JSPI `WebAssembly.Suspending` import).
  cmpkernel `-strict` passes it with `requireAliases`.
- backend: `be.hook(name)` calls a builtin through its fixed descriptor
  (works in every module): catch end -> `_CATCH_END`, #DE -> `_INT_DIVZERO`,
  HLT -> `_HLT`, PAUSE -> `_PAUSE`, STI/POPFD/SetRFlags with IF -> `_STI`,
  `INT n` -> `_INT` (= `_IntDeliver(n)`). One-line asm also gained
  `MOV_RAX_CR2` (rax=0) and `INT imm`.
- `port/Kernel/`: Kernel.PRJ (adds `#include "PortA"` after KExts: KMathA and
  KUtils need KernelB.HH's intrinsics), PortA.HC, KStart16/32 (data only),
  KStart64/KMathA/KUtils (comments), StrA, Sched, KHashA, KInts, KExcept,
  Compress, KTask (CallStkGrow), PCIBIOS (no BIOS: FarCall32 = FALSE),
  MultiProc (single core), Mem/PageTables, Mem/MAllocFree. Each keeps the
  original file and swaps the asm for HolyC at the same spot.

Design decisions to keep:
- **Tasks**: each task runs on its own JSPI wasm stack. `_Yield`/`_RestoreTask`
  /`_TaskContextRestore` (Sched.HC) are the asm's scheduler in HolyC, and
  `CtxSwitch(task)` (js `_CTX_SWITCH`, suspend) switches stacks. The rule for a
  task's `rip`: `_RET` = resume its suspended stack. Anything else
  (Break, task_end_cb) is called on top of the resumed stack, then rip is
  reset to `_RET`. A task with no stack yet is started fresh by JS: sp=task->rsp,
  call rip with no marker pushed ([rsp] is the return addr, e.g. &Exit), then
  call that addr when it returns. Idle is a task whose rip is `_IdleLoop`.
- **IRQs** are taken only from wasm (`_IrqPoll` at STI/PAUSE/HLT), never from
  JS, so a handler may switch stacks. `_IntDeliver` reads dev.idt (no LIDT),
  clears IF, calls the gate, restores RFLAGS. IRQ_TIMER = `_IrqTimer`.
- **try/catch**: `_TestExcept`/`_TakeExcept` call `_RESUME(rbp,label,rsp)`;
  `_CatchEnd` (KExcept.HC) is the rest of throw()'s loop.
- **Memory must be 4 GB** (65536 pages, shared; Node 24 is fine, RSS stays
  small). HPET/LAPIC/VGA go through `dev.uncached_alias`. So the boot loader
  must report a reserved E820 entry up to exactly 4 GB: then
  mem_physical_space=4G, the alias lands at 4G, and alias+x wraps to x.
- Known deviations: MemCpy is memory.copy (memmove, not forward-overlap);
  no x87 control word; no code breakpoints; `_CFG_HEAP_DBG` unsupported;
  CallStkGrow fixes up argpop of its varargs by moving its saved RBP/marker.
- **Gotcha**: a lone `$` in a port file comment starts a DolDoc command and
  silently eats the rest of the file. Write `$$`.

## Boot plan (next session)
1. `port/Kernel/KMain.HC`: copy the original and add `U0 KStartWasm()` after
   KMain. It does what KStart32/64 did: `*INT_MP_CRASH_ADDR(U32 *)=&IntMPCrash;`
   SysInitPageTables; SysInit16MegSysCodeBp; RLf_64BIT;
   `SetGsBase(CPUStructInit(0,&fixed->boot_cpu,&fixed->adam))`; init
   fixed->adam_hc as KStart64 did; `SetFsBase(TaskInit(adam,MEM_ADAM_STK))`.
   Then give JS the CTask rip/rsp/rbp/rflags offsets (add a js builtin), call
   `CtxSwitch(Fs)` once so the boot stack becomes Adam's, `SetRSP(Fs->rsp)`
   and call KMain.
2. `runtime/boot.js` + `runtime/sched.js`: create a Machine with 65536 pages
   and the js builtins (Suspending where needed). Copy the BIN *without* the
   wasm bytes to 0x7C00 (base 0x7C20; the wasm is too big for low memory).
   Patch abs addrs and instantiate. Fill the KStart16 vars through the
   exports: MEM_BOOT_BASE=base, SYS_BOOT_PATCH_TABLE_BASE=0x7C00+patch_off,
   E801/E820, MEM_PHYSICAL_SPACE, SYS_RUN_LEVEL (16BIT|32BIT|PATCHED, no VGA
   at first, so text mode at 0xB8000 is easy to dump), SYS_PCI_BUSES. Set
   sp below 0x97000 and call KStartWasm through `WebAssembly.promising`.
3. Minimal devices: PIT (0x40/0x43, IRQ0 at 1 kHz), PIC (0x20/0x21 mask,
   ICW2 base, EOI), CMOS RTC, keyboard status 0. `_HLT_WAIT` awaits the next
   tick and throws if IF is off.

## How to run things (Git Bash, from the repo root)
Git Bash rewrites `/Kernel/...` arguments into Windows paths, so prefix
commands with `MSYS_NO_PATHCONV=1`.
```bash
MSYS_NO_PATHCONV=1 node test/run.mjs                    # backend unit tests (test/hc/*.HC)
MSYS_NO_PATHCONV=1 node test/cmpkernel.mjs              # Kernel -> build/Kernel.wasm (lenient asm)
MSYS_NO_PATHCONV=1 node test/cmpkernel.mjs /Compiler/Compiler
MSYS_NO_PATHCONV=1 node test/cmpkernel.mjs -strict      # fails at the first asm block (this is the port to-do list)
MSYS_NO_PATHCONV=1 HCC_DUMP=QueCnt,Fib node test/cmpkernel.mjs   # print the post-OptPass012 ICs of those functions
HCC_TRACE=20000 ...                                      # lexer progress trace, written to stderr
```
`vendor/TempleOS/` (gitignored) is the TempleOS source tree; drive `C:` maps to
it, with `port/` overlaid on top (`TempleFS` in aot.js).

## File map
| File | What it is |
|---|---|
| `compiler/consts.js` | Generated by `node tools/gen-consts.js` from KernelA.HH/CompilerA.HH. Add prefixes in the regex there if a constant is missing. |
| `compiler/core.js` | CHash* classes, HashTable (finds the most recent entry first, keeps insertion order), class pointer levels (`cadd`/`csub`/`cbase` stand for `tmpc±1`). |
| `compiler/doldoc.js` | Minimal DolDoc reader. Source files are lexed as documents, as `LexAttachDoc` does. |
| `compiler/lex.js` | Port of Lex.HC/LexLib.HC, including the doc-mode `LexGetChar`. |
| `compiler/parse.js` | **Literal** port of PrsLib/PrsExp/PrsVar/PrsStmt with the AOT code paths, plus LexStmt2Bin/ExeCmdLine/PrsStreamBlk. |
| `compiler/opt.js` | Port of OptLib/OptPass012 (checked against the original). |
| `compiler/interp.js` | IC interpreter for compile-time `Call()`s: `#exe{}`, `LexExpression`, default args. Includes `icListing()` for debugging. |
| `compiler/aot.js` | Bootstrap driver: the env hooks, host environment for `#exe{}` (JIT-compiles KernelA.HH and CompilerA.HH plus JS builtins), CmpJoin/AOTGlblsResolve/Cmp, the BIN writer, lenient asm, inline single-instruction asm (`ONE_ASM_INS`). |
| `compiler/wasm.js` | Wasm binary encoder. |
| `compiler/backend.js` | IC→wasm (`Unit`) and `AOTBackend` (module building, blobs and descriptors, builtins, `__init`). |
| `runtime/wasmload.js` | `Machine`: memory, table, CPU globals, resume tag; `loadBin()`, `call()`. Used by the tests; meant to become the browser runtime. |
| `port/Kernel/KCfg.HC` | Non-interactive kernel config (single core, IDE auto-mount on C:). |
| `test/hc/*.HC` | Backend tests. Expected output goes on `//> ` lines. |

## Key design facts (details in DESIGN.md)
- **Code address = 8-byte descriptor** `[u32 table index][u32 'WASM']`. A
  COCCompile "code blob" is `[descriptor][string consts][import slots]` and is
  stored at `aotc->rip`. `AOTStoreBlob` binds the wasm function to that rip,
  and the module's exported `__init()` turns slot numbers into table indices.
- **ABI is x86-exact on a linear-memory shadow stack.** Globals are `sp` (i32),
  `rbp` (i32), `fs`, `gs`, `rflags`, `base`, `table_base`. The caller pushes
  args, then a return marker (its own descriptor address); ENTER pushes fp;
  `Ff_RET1` callees pop their own args. Wasm functions are `() -> i64` (RAX).
- **Control flow:** the blocks of a unit are nested wasm `block`s inside a
  dispatch `loop`. Forward jumps are plain `br`. Backward jumps, SUB_CALL
  returns (`IC_RET` pops a continuation id below `LABEL_LIMIT`) and try/catch
  resumes go through `$state`. Functions with `IC_GET_LABEL` (try) get a
  `try/catch $resume(fp,label,sp)` wrapper. The Ramsey-style structuring
  (for speed) is **not done yet**.
- **Builtins** (what asm routines become) have descriptors at fixed addresses
  `BUILTIN_BASE=0x1000 + 8*i` and are predefined as `HTF_IMM|HTF_EXPORT`
  export symbols, so the original `_extern _MEMCPY ...` headers bind to them
  unchanged. Kinds: `js` (wrapper around a JS import), `wasm` (hand-built body
  via `gen`), `alias` (a HolyC function in a port file, by name; reserved
  through `aliasSlots`).

## Faithfulness findings worth knowing
- Default args come from the prototype *at the call site*. Kernel callers of
  `LexStmt2Bin` see CompilerB.HH's `CMPF_PRS_SEMICOLON`, not the definition's
  `0`; ExeCmdLine depends on this.
- Intrinsic (`_intern`) 2-arg ICs have **reversed args**: IC arg1 is the
  *last* parameter (`Bt`: arg1=bit, arg2=field; `QueIns`: arg1=pred).
- `==`/`!=` compare raw bits even for F64. F64 `<<`/`>>`/`&` are integer ops on
  the bits (opt.js folding fixed to match). Float→int is FISTTP (NaN and
  overflow give `0x8000000000000000`, helper `$f2i`). DIV/MOD raise #DE
  (`divzero` import) on 0 and MIN/-1. Assignment results are *not* truncated.
- Lexing `1.9` gives `19*0.1` (bits ...855, not JS's ...854), as in TempleOS.
- `T x[]=...` arrays get size 0 in this compiler source (the cnt<0 path is
  unreachable); `test/hc/lang.HC` avoids them. A local fun-ptr can't be
  initialized in its declaration. Both behaviours match the original.
- Interrupt functions compile as normal functions. IRQ delivery should call
  them and save/restore RFLAGS (IRET).
- The bootstrap must strip lexer strings' trailing NUL (`cstr()` in aot.js).

## Next steps, in order
1. Keyboard/mouse at the desktop: type at the prompt (`-type=`), answer
   the Tour question, run HolyC at the command line, check the output.
2. Browser UI: `server.cjs` (static files + COOP/COEP for
   SharedArrayBuffer), `web/index.html` + a worker running `PC`
   (canvas 640x480 from `vga.render`, key/mouse events -> `pc.key`/
   `pc.mouse`), disk image fetched from build/C.img and kept in
   IndexedDB (dirty sectors written back via the ATA `onWrite` hook).
3. Performance: boot takes ~20 s of JIT; dominator-based structuring,
   wasm locals for non-address-taken locals, batching JIT units.
4. The 4 docs binfix can't repair; .DATA files.
