// The kernel's builtins: what the asm routines of the kernel became.
// Shared by the compiler (which predefines each name as an HTF_IMM export
// at BUILTIN_BASE+8*index, so `_extern _MEMCPY ...` binds to it) and the
// runtime (which supplies the JS implementations).  The order is the ABI:
// never reorder, only append.
//
// Kinds:
//  alias  a HolyC function in a port/ file (target), compiled in the kernel.
//  wasm   a hand-built function body (gen).
//  js     a JS import (args are i64 bits; suspend: runs as a JSPI
//         WebAssembly.Suspending import, i.e. may await).
// All of them use the HolyC ABI: [sp] = return marker, args at sp+8...;
// ret1 builtins pop their args like RET1.
import { OP, OPFC, T, Bytes } from '../compiler/wasm.js';

const f64 = (bits) => { const d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, BigInt.asIntN(64, bits), true); return d.getFloat64(0, true); };
const bits = (x) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, x, true); return d.getBigInt64(0, true); };
const math1 = (fn) => (m) => (a) => bits(fn(f64(a)));

// --- wasm body helpers
const argI64 = (by, g, i) => by.u8(OP.global_get).u32(g.sp).u8(OP.i64_load).u32(3).u32(8 + 8 * i);
const argI32 = (by, g, i) => argI64(by, g, i).u8(OP.i32_wrap_i64);
const ret = (by, g, nargs) => // pop marker (+args); the i64 result is on the stack
  by.u8(OP.global_get).u32(g.sp).u8(OP.i32_const).s32(8 + 8 * nargs).u8(OP.i32_add).u8(OP.global_set).u32(g.sp);
const fround = (op) => (by, g) => { argI64(by, g, 0).u8(OP.f64_reinterpret_i64).u8(op).u8(OP.i64_reinterpret_f64); ret(by, g, 1); };

export const BUILTINS = [
  // ---- KUtils
  { name: '_MEMCPY', kind: 'wasm', locals: [[2, T.i32]], gen(by, g) { // returns dst+cnt (REP_MOVSB leaves RDI there)
    argI32(by, g, 0).u8(OP.local_tee).u32(0); argI32(by, g, 1); argI32(by, g, 2).u8(OP.local_tee).u32(1);
    by.u8(0xFC).u32(OPFC.memory_copy).u8(0).u8(0);
    by.u8(OP.local_get).u32(0).u8(OP.local_get).u32(1).u8(OP.i32_add).u8(OP.i64_extend_i32_u); ret(by, g, 3);
  } },
  { name: '_MEMSET', kind: 'wasm', locals: [[2, T.i32]], gen(by, g) {
    argI32(by, g, 0).u8(OP.local_tee).u32(0); argI32(by, g, 1); argI32(by, g, 2).u8(OP.local_tee).u32(1);
    by.u8(0xFC).u32(OPFC.memory_fill).u8(0);
    by.u8(OP.local_get).u32(0).u8(OP.local_get).u32(1).u8(OP.i32_add).u8(OP.i64_extend_i32_u); ret(by, g, 3);
  } },
  { name: '_MEMSET_U16', kind: 'alias', target: '_MemSetU16' },
  { name: '_MEMSET_U32', kind: 'alias', target: '_MemSetU32' },
  { name: '_MEMSET_I64', kind: 'alias', target: '_MemSetI64' },
  { name: '_MEMCMP', kind: 'alias', target: '_MemCmp' },
  { name: '_BEQU', kind: 'alias', target: '_BEqu' },
  { name: '_LBEQU', kind: 'alias', target: '_LBEqu' },
  { name: '_CLAMP_I64', kind: 'alias', target: '_ClampI64' },
  { name: '_CLAMP_U64', kind: 'alias', target: '_ClampU64' },
  { name: '_CALL', kind: 'alias', target: '_Call' },
  { name: '_BIT_FIELD_OR_U32', kind: 'alias', target: '_BFieldOrU32' },
  { name: '_BIT_FIELD_EXT_U32', kind: 'alias', target: '_BFieldExtU32' },
  { name: '_XCHG_I64', kind: 'alias', target: '_XchgI64' },
  { name: '_XCHG_U32', kind: 'alias', target: '_XchgU32' },
  { name: '_XCHG_U16', kind: 'alias', target: '_XchgU16' },
  { name: '_XCHG_U8', kind: 'alias', target: '_XchgU8' },
  { name: '_LXCHG_I64', kind: 'alias', target: '_XchgI64' },
  { name: '_LXCHG_U32', kind: 'alias', target: '_XchgU32' },
  { name: '_LXCHG_U16', kind: 'alias', target: '_XchgU16' },
  { name: '_LXCHG_U8', kind: 'alias', target: '_XchgU8' },
  { name: '_REP_IN_U32', kind: 'alias', target: '_RepInU32' },
  { name: '_REP_IN_U16', kind: 'alias', target: '_RepInU16' },
  { name: '_REP_IN_U8', kind: 'alias', target: '_RepInU8' },
  { name: '_REP_OUT_U32', kind: 'alias', target: '_RepOutU32' },
  { name: '_REP_OUT_U16', kind: 'alias', target: '_RepOutU16' },
  { name: '_REP_OUT_U8', kind: 'alias', target: '_RepOutU8' },
  { name: '_CPUID', kind: 'js', nargs: 2, ret1: true, js: (m) => (rax, res) => { m.cpuid(Number(rax), Number(res)); return 0n; } },
  { name: '_CALL_IND', kind: 'alias', target: '_CallInd' },
  { name: '_CALLEXTNUM', kind: 'alias', target: '_CallExtNum' },
  { name: '_CALLEXTSTR', kind: 'alias', target: '_CallExtStr' },
  { name: '_SET_MSR', kind: 'alias', target: '_SetMSR' },
  { name: '_SYS_HLT', kind: 'alias', target: '_SysHlt' },
  { name: '_RET', kind: 'wasm', gen(by, g) { by.u8(OP.i64_const).s64(0); ret(by, g, 0); } },
  // ---- port primitives (no asm label of the same name in TempleOS)
  { name: '_SET_FS_BASE', kind: 'wasm', gen(by, g) { argI64(by, g, 0).u8(OP.global_set).u32(g.fs); argI64(by, g, 0); ret(by, g, 1); } },
  { name: '_SET_GS_BASE', kind: 'wasm', gen(by, g) { argI64(by, g, 0).u8(OP.global_set).u32(g.gs); argI64(by, g, 0); ret(by, g, 1); } },
  // I64 _CallArgv(U8 *fp,I64 argc,I64 *argv): call fp with argc args copied from argv.
  { name: '_CALL_ARGV', kind: 'wasm', locals: [[3, T.i32]], gen(by, g, h, be) {
    // l0 = entry sp, l1 = argc*8, l2 = fp descriptor
    by.u8(OP.global_get).u32(g.sp).u8(OP.local_set).u32(0);
    argI32(by, g, 1).u8(OP.i32_const).s32(3).u8(OP.i32_shl).u8(OP.local_set).u32(1);
    argI32(by, g, 0).u8(OP.local_set).u32(2);
    by.u8(OP.local_get).u32(2).u8(OP.i32_eqz).u8(OP.if).u8(T.void);
    by.u8(OP.i64_const).s64(0); ret(by, g, 3); by.u8(OP.return).u8(OP.end);
    // sp -= argc*8; copy argv
    by.u8(OP.local_get).u32(0).u8(OP.local_get).u32(1).u8(OP.i32_sub).u8(OP.global_set).u32(g.sp);
    by.u8(OP.global_get).u32(g.sp);
    by.u8(OP.local_get).u32(0).u8(OP.i64_load).u32(3).u32(24).u8(OP.i32_wrap_i64);
    by.u8(OP.local_get).u32(1);
    by.u8(0xFC).u32(OPFC.memory_copy).u8(0).u8(0);
    // push marker (our own descriptor), call
    by.u8(OP.global_get).u32(g.sp).u8(OP.i32_const).s32(8).u8(OP.i32_sub).u8(OP.global_set).u32(g.sp);
    by.u8(OP.global_get).u32(g.sp).u8(OP.i64_const).s64(BigInt(be.builtinAddr('_CALL_ARGV'))).u8(OP.i64_store).u32(3).u32(0);
    by.u8(OP.local_get).u32(2).u8(OP.i32_load).u32(2).u32(0);
    by.u8(OP.call_indirect).u32(be.fnType).u32(0);
    // the callee popped what it takes; RET1 24 from the entry sp
    by.u8(OP.local_get).u32(0).u8(OP.i32_const).s32(32).u8(OP.i32_add).u8(OP.global_set).u32(g.sp);
  } },
  // U0 _Resume(I64 rbp,I64 label,I64 rsp): jump to a try label of the
  // function whose frame is rbp (see DESIGN.md try/catch).  rsp=0: the
  // catch block, run at the current sp with a CATCH_END marker pushed.
  { name: '_RESUME', kind: 'wasm', locals: [[1, T.i32]], gen(by, g, h, be) {
    argI32(by, g, 2).u8(OP.local_tee).u32(0).u8(OP.i32_eqz).u8(OP.if).u8(T.void);
    by.u8(OP.global_get).u32(g.sp).u8(OP.i32_const).s32(32).u8(OP.i32_add).u8(OP.i32_const).s32(8).u8(OP.i32_sub).u8(OP.local_set).u32(0);
    by.u8(OP.local_get).u32(0).u8(OP.i64_const).s64(BigInt(be.CATCH_END)).u8(OP.i64_store).u32(3).u32(0);
    by.u8(OP.end);
    argI32(by, g, 0); argI64(by, g, 1); by.u8(OP.local_get).u32(0);
    by.u8(OP.throw).u32(g.resume);
  } },
  // U0 _CtxSwitch(CTask *task): run task's context (see runtime/sched.js).
  { name: '_CTX_SWITCH', kind: 'js', nargs: 1, ret1: true, suspend: true, js: (m) => (task) => m.sched.switchTo(Number(task)) },
  { name: '_HLT_WAIT', kind: 'js', nargs: 0, suspend: true, js: (m) => () => m.hltWait() },
  { name: '_IRQ_PENDING', kind: 'js', nargs: 0, suspend: true, js: (m) => () => m.irqPendingOrBreathe() },
  { name: '_DBG_PUTC', kind: 'js', nargs: 1, ret1: true, js: (m) => (ch) => { m.dbgPutc(Number(ch & 0xFFn)); return 0n; } },
  // ---- KMathA
  { name: '_FLOOR', kind: 'wasm', gen: fround(OP.f64_floor) },
  { name: '_CEIL', kind: 'wasm', gen: fround(OP.f64_ceil) },
  { name: '_TRUNC', kind: 'wasm', gen: fround(OP.f64_trunc) },
  { name: '_ROUND', kind: 'wasm', gen: fround(OP.f64_nearest) },
  { name: '_EXP', kind: 'js', nargs: 1, ret1: true, js: math1(Math.exp) },
  { name: '_LN', kind: 'js', nargs: 1, ret1: true, js: math1(Math.log) },
  { name: '_LOG2', kind: 'js', nargs: 1, ret1: true, js: math1(Math.log2) },
  { name: '_LOG10', kind: 'js', nargs: 1, ret1: true, js: math1(Math.log10) },
  { name: '_POW10', kind: 'js', nargs: 1, ret1: true, js: math1((x) => Math.pow(10, x)) },
  { name: '_POW', kind: 'js', nargs: 2, ret1: true, js: () => (b, p) => bits(sysPow(f64(b), f64(p), b, p)) },
  { name: '_ARG', kind: 'js', nargs: 2, ret1: true, js: () => (x, y) => bits(Math.atan2(f64(y), f64(x))) },
  { name: '_SIGN', kind: 'alias', target: '_Sign' },
  { name: '_FLDCW', kind: 'alias', target: '_Fldcw' },
  { name: '_FSTCW', kind: 'alias', target: '_Fstcw' },
  { name: '_FSTSW', kind: 'alias', target: '_Fstsw' },
  { name: '_FCLEX', kind: 'alias', target: '_Fclex' },
  ...['ADD', 'ADD_EQU', 'COPY', 'CROSS', 'DIST', 'DIST_SQR', 'DIV', 'DIV_EQU', 'DOT', 'EQU', 'MUL', 'MUL_EQU',
    'NORM', 'NORM_SQR', 'SUB', 'SUB_EQU', 'UNIT', 'ZERO'].map((s) => ({
    name: '_D3_' + s, kind: 'alias', target: '_D3' + s.split('_').map((w) => w[0] + w.slice(1).toLowerCase()).join(''),
  })),
  // ---- StrA
  { name: '_STRCMP', kind: 'alias', target: '_StrCmp' },
  { name: '_STRICMP', kind: 'alias', target: '_StrICmp' },
  { name: '_STRNCMP', kind: 'alias', target: '_StrNCmp' },
  { name: '_STRNICMP', kind: 'alias', target: '_StrNICmp' },
  { name: '_STRMATCH', kind: 'alias', target: '_StrMatch' },
  { name: '_STRIMATCH', kind: 'alias', target: '_StrIMatch' },
  { name: '_STRCPY', kind: 'alias', target: '_StrCpy' },
  // ---- KHashA
  { name: '_HASH_STR', kind: 'alias', target: '_HashStr' },
  { name: '_HASH_FIND', kind: 'alias', target: '_HashFind' },
  { name: '_HASH_SINGLE_TABLE_FIND', kind: 'alias', target: '_HashSingleTableFind' },
  { name: '_HASH_BUCKET_FIND', kind: 'alias', target: '_HashBucketFind' },
  { name: '_HASH_ADD', kind: 'alias', target: '_HashAdd' },
  { name: '_HASH_ADD_AFTER', kind: 'alias', target: '_HashAddAfter' },
  { name: '_HASH_REM_DEL', kind: 'alias', target: '_HashRemDel' },
  // ---- MAllocFree
  { name: '_MALLOC', kind: 'alias', target: '_MAlloc' },
  { name: '_FREE', kind: 'alias', target: '_Free' },
  { name: '_MSIZE', kind: 'alias', target: '_MSize' },
  { name: '_MSIZE2', kind: 'alias', target: '_MSize2' },
  { name: '_MHEAP_CTRL', kind: 'alias', target: '_MHeapCtrl' },
  // ---- Compress, Sched, KExcept, PCIBIOS
  { name: '_ARC_ENTRY_GET', kind: 'alias', target: '_ArcEntryGet' },
  { name: '_TASK_CONTEXT_RESTORE', kind: 'alias', target: '_TaskContextRestore' },
  { name: '_TASK_END_NOW', kind: 'alias', target: '_TaskEndNow' },
  { name: '_YIELD', kind: 'alias', target: '_Yield' },
  { name: '_TEST_EXCEPT', kind: 'alias', target: '_TestExcept' },
  { name: '_TAKE_EXCEPT', kind: 'alias', target: '_TakeExcept' },
  { name: '_SAVE_EXCEPT_REGS', kind: 'alias', target: '_SaveExceptRegs' },
  { name: '_FAR_CALL32', kind: 'alias', target: '_FarCall32' },
  // ---- KInts: IDT entries are descriptors, called by _IntDeliver
  { name: 'IRQ_TIMER', kind: 'alias', target: '_IrqTimer' },
  { name: 'INT_WAKE', kind: 'alias', target: '_IntWake' },
  // ---- hooks the backend calls through the descriptors (every module)
  { name: '_CATCH_END', kind: 'alias', target: '_CatchEnd' },     // a catch block's final RET
  { name: '_INT_DIVZERO', kind: 'alias', target: '_IntDivZero' }, // #DE from a DIV/MOD
  { name: '_HLT', kind: 'alias', target: '_Hlt' },                // HLT
  { name: '_PAUSE', kind: 'alias', target: '_Pause' },            // PAUSE
  { name: '_STI', kind: 'alias', target: '_Sti' },                // STI/POPFD setting IF
  { name: '_INT', kind: 'alias', target: '_IntDeliver' },         // INT n (arg n)
  // ---- port runtime services
  { name: '_PORT_SET', kind: 'js', nargs: 2, ret1: true, js: (m) => (k, v) => { m.portSet(Number(k), v); return 0n; } },
  // ---- Load() and the Compiler's wasm back-end (runtime/jit.js)
  { name: '_WASM_LOAD', kind: 'js', nargs: 2, ret1: true, js: (m) => (bfh, base) => m.wasmLoad(Number(bfh), Number(base)) },
  { name: '_JIT_COMPILE', kind: 'js', nargs: 2, ret1: true, js: (m) => (cc, type) => m.jit.compile(Number(cc), Number(type)) },
  { name: '_JIT_STORE', kind: 'js', nargs: 2, ret1: true, js: (m) => (cc, res) => m.jit.store(Number(cc), Number(res)) },
];

// SYS_POW in KMathA.HC.
function sysPow(b, p, bb, pb) {
  if (!pb) return 1;
  if (!bb) return 0;
  let r = Math.pow(Math.abs(b), p);
  if (b < 0) {
    const n = Number.isFinite(p) ? Math.trunc(p) : NaN;
    if (Number.isFinite(n) && (BigInt.asIntN(64, BigInt(n)) & 1n)) r = -r;
  }
  return r;
}
