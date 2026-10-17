# WebTempleOS — handoff (2026-10-17)

Goal: a faithful port of TempleOS to WebAssembly. No x86 emulation, no
networking. TempleOS's own compiler front-end produces intermediate code (ICs),
and a shared IC→wasm backend replaces its x86 back-end. Read **DESIGN.md**
first; it holds the architecture and the reasons behind it. This file says
where things stand and what to do next.

## State (2026-10-17, ~02:00 EDT)
Setup on a fresh machine: `sh tools/fetch-vendor.sh` (see CLAUDE.md).

**Boot in Node: started, not working yet.** Boot plan steps 1-2 below are
written but the first run hangs: `node test/boot.mjs -secs=5` never prints
(not even its 5 s timeout), so wasm is spinning in a synchronous loop
somewhere after `KStartWasm` starts (no JSPI suspension, no event loop).
Find where (e.g. a `trace` import call per function entry, or run with
`--cpu-prof`, or bisect with `PortSet`/`DbgPutc` calls in KStartWasm/KMain).
Suspects: a PAUSE/LBts spin lock whose flag starts set, `Busy()`
(PortNop loop), SysTimerRead/PIT behaviour, or `_IrqPoll` re-entering.
What was added for it (session 3):
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
1. **Kernel asm port (`port/Kernel/...`).** Run `cmpkernel.mjs -strict` and
   work through each asm block. Files with asm: KStart16/32/64, KUtils,
   StrA, KMathA, KHashA, Mem/MAllocFree, Mem/PageTables, Compress,
   KTask (2 blocks), Sched (`_YIELD`, task switching), KInts,
   KExcept, MultiProc, PCIBIOS, SerialDev/Keyboard, KMain (end label),
   plus inline `MOV ...` lines such as KInts.HC:156. The labels the C side
   `_extern`s:
   - *Data labels*: must be real labels in the image, defined by a small asm
     subset that still needs writing (labels, `DU8/16/32/64`, `ALIGN`, `DUP`).
     Examples: `SYS_*`, `MEM_*`, `SYS_PROGRESS*`, `SYS_SEMAS`, `SYS_GDT`,
     `SYS_CPU_STRUCTS`.
   - *Code labels*: become builtins (wasm or alias). Examples: `_MEMCPY`,
     `_MEMSET*`, `_STRCMP`/`_STRCPY`/`_STRI*`/`_STRN*`, `_MALLOC`/`_FREE`/
     `_MSIZE*`/`_MHEAP_CTRL`, `_HASH_*`, `_CALL`/`_CALL_IND`/
     `_CALLEXTSTR`/`_CALLEXTNUM`/`_LAST_FUN`, math (`_POW`, `_EXP`, `_LN`,
     `_LOG2`, `_LOG10`, `_FLOOR`, `_CEIL`, `_ROUND`, `_TRUNC`, `_ARG`,
     `_SIGN`, `_CLAMP_*`, `_D3_*`), `_XCHG_*`/`_LXCHG_*`, `_BEQU`/`_LBEQU`/
     `_BIT_FIELD_*`, `_REP_IN/OUT_*`, `_YIELD`, `_TASK_CONTEXT_RESTORE`,
     `_TASK_END_NOW`, `_TEST_EXCEPT`/`_TAKE_EXCEPT`/`_SAVE_EXCEPT_REGS`
     (see DESIGN.md try/catch), `_SYS_HLT`, `_CPUID`, `_SET_MSR`.
   - The Compiler also needs `_LAST_FUN` (CMisc.HC), and its `Templates.HC`
     asm is only used by the x86 back-end it no longer needs.
2. **Boot in Node:** a JS boot loader in place of KStart16/32 (E820 map, load
   Kernel.BIN.C at 0x7C00 so module base = 0x7C20, IET_ABS_ADDR relocations,
   instantiate, then call the port's KStart64 replacement →
   CPUStructInit/TaskInit/KMain). Set up a debug-port text output first.
3. **Device emulation** (JS port-I/O bus): PIT, PIC, PS/2, CMOS RTC, VGA DAC
   and a planar 640x480x16 framebuffer, ATA PIO disk with a RedSea C: image
   builder, speaker.
4. **Tasks with JSPI**, IRQ delivery at Yield/HLT/PAUSE.
5. **Load the Compiler.** Load() gets one added call that instantiates the
   BIN's wasm (trailer: `[u32 off][u32 len]['WASM'][u32 ntable]`). The
   COCCompile hook calls the JS backend on ICs read from linear memory (needs
   an adapter from the CIntermediateCode struct layout to the JS IC shape).
   The runtime backend also needs `IC_CALL_INDIRECT2` and absolute-address
   handling (AOTBackend's `immObject`/`indirect2Target` are the hooks).
6. Browser UI (worker, canvas, IndexedDB disk), then performance work:
   dominator-based structuring in place of the dispatch loop, and promoting
   non-address-taken locals to wasm locals.
