// IC -> WebAssembly backend.  Replaces TempleOS's OptPass3..OptPass789A.
//
// Input: the IC list of one compile unit after OptPass012 pass 2 (what
// COCCompile has right after its OptPass012 calls).  The postfix IC stream
// is replayed on a compile-time "parse stack" exactly like OptPass3 does,
// and values flow on the wasm operand stack.  Values that are pushed for
// a call (ICF_PUSH_RES) go to the linear-memory shadow stack immediately,
// which mirrors the x86 code: the shadow stack is x86-exact (see DESIGN.md).
//
// Control flow: the unit is split into basic blocks laid out in order as
//   loop $dispatch
//     block $Bn ... block $B1 block $B0
//       br_table B0..Bn (local $state)
//     end <code of 0> end <code of 1> ... end <code of n>
//   end
// so fall-through and forward jumps are plain br's; backward jumps,
// SUB_CALL returns and try/catch resumes go through $state.
import * as K from './consts.js';
import { OP, OPFC, OPFE, T, Bytes, ModuleBuilder } from './wasm.js';
import { intermediate_code_table } from './opt.js';
import { OptClassFwd, CHashFun, CHashExport, cadd, csub } from './core.js';
import { I64, U64, b2f } from './util.js';
import { FieldRef } from './parse.js';

export const LABEL_LIMIT = 0x10000; // shadow stack values below this are local continuation ids
// Builtins (what the kernel's asm routines become) have their descriptors at
// fixed addresses so their symbols are HTF_IMM exports like any other code.
export const BUILTIN_BASE = 0x1000, BUILTIN_MAX = 0x200;
export const CATCH_END = 0xFFFF;    // pushed by TestExcept; the catch block's IC_RET calls _CatchEnd
const F = 'f', I = 'i';

const rawType = (c) => (c ? OptClassFwd(c).raw_type : K.RT_I64);
const isUns = (rt) => rt !== K.RT_F64 && (rt & K.RTF_UNSIGNED) !== 0;
const ICNAME = (c) => (intermediate_code_table[c] ? intermediate_code_table[c].name : String(c));
const bt = (flags, bit) => ((flags >> bit) & 1) !== 0;

const BRANCH_CODES = new Set([
  K.IC_JMP, K.IC_BR_ZERO, K.IC_BR_NOT_ZERO, K.IC_BR_CARRY, K.IC_BR_NOT_CARRY,
  K.IC_BR_EQU_EQU, K.IC_BR_NOT_EQU, K.IC_BR_LESS, K.IC_BR_GREATER_EQU, K.IC_BR_GREATER, K.IC_BR_LESS_EQU,
  K.IC_BR_EQU_EQU2, K.IC_BR_NOT_EQU2, K.IC_BR_LESS2, K.IC_BR_GREATER_EQU2, K.IC_BR_GREATER2, K.IC_BR_LESS_EQU2,
  K.IC_BR_AND_ZERO, K.IC_BR_AND_NOT_ZERO, K.IC_BR_MM_ZERO, K.IC_BR_MM_NOT_ZERO,
  K.IC_BR_AND_AND_ZERO, K.IC_BR_AND_AND_NOT_ZERO, K.IC_BR_OR_OR_ZERO, K.IC_BR_OR_OR_NOT_ZERO,
  K.IC_BR_BT, K.IC_BR_BTS, K.IC_BR_BTR, K.IC_BR_BTC, K.IC_BR_NOT_BT, K.IC_BR_NOT_BTS, K.IC_BR_NOT_BTR, K.IC_BR_NOT_BTC,
  K.IC_SWITCH, K.IC_NOBOUND_SWITCH, K.IC_SUB_CALL, K.IC_RET, K.IC_LEAVE,
]);
const NO_FALLTHRU = new Set([K.IC_JMP, K.IC_SWITCH, K.IC_NOBOUND_SWITCH, K.IC_SUB_CALL, K.IC_RET, K.IC_LEAVE]);

export class BackendError extends Error {}

// ------------------------------------------------------------- module
// The module-level imports every compile unit's module has.
export function moduleImports(mb, { tableMin = 1, memPages = 16384, memMax = 16384, shared = true } = {}) {
  const g = {};
  mb.importMemory('env', 'mem', memPages, memMax, shared);
  mb.importTable('env', 'table', tableMin);
  // imported functions (JS or kernel builtins)
  const f = (name, p, r) => { g[name] = mb.importFunc('env', name, p, r); };
  f('in', [T.i32, T.i32], [T.i64]);           // port, size
  f('out', [T.i32, T.i64, T.i32], []);        // port, val, size
  f('rdtsc', [], [T.i64]);
  f('hlt', [], []);
  f('pause', [], []);
  f('divzero', [], []);                       // raise #DE (kernel IntDivZero)
  f('catch_end', [], []);                     // kernel _CatchEnd: rest of throw()
  f('pow', [T.f64, T.f64], [T.f64]);
  f('sin', [T.f64], [T.f64]); f('cos', [T.f64], [T.f64]); f('tan', [T.f64], [T.f64]); f('atan', [T.f64], [T.f64]);
  f('cpuid', [], []);
  f('trace', [T.i32, T.i64], []);              // debug hook
  g.sp = mb.importGlobal('env', 'sp', T.i32, true);
  g.rbp = mb.importGlobal('env', 'rbp', T.i32, true);
  g.fs = mb.importGlobal('env', 'fs', T.i64, true);
  g.gs = mb.importGlobal('env', 'gs', T.i64, true);
  g.rflags = mb.importGlobal('env', 'rflags', T.i64, true);
  g.base = mb.importGlobal('env', 'base', T.i64, false);
  g.table_base = mb.importGlobal('env', 'table_base', T.i32, false);
  g.resume = mb.importTag('env', 'resume', [T.i32, T.i64, T.i32]); // fp, label id, sp
  return g;
}

// Small helper functions compiled into every module.
function addHelpers(mb, g, be) {
  const h = {};
  const fn = (name, params, results, locals, build) => {
    const r = mb.reserveFunc(params, results, name);
    const b = new Bytes();
    build(b);
    r.f.locals = locals;
    r.f.body = b.toU8();
    h[name] = r.idx;
  };
  // signed/unsigned div/rem with x86 #DE semantics (zero divisor, MIN/-1)
  for (const [name, op, signed, isRem] of [['$div_s', OP.i64_div_s, true, false], ['$div_u', OP.i64_div_u, false, false],
    ['$rem_s', OP.i64_rem_s, true, true], ['$rem_u', OP.i64_rem_u, false, true]]) {
    fn(name, [T.i64, T.i64], [T.i64], [], (b) => {
      b.u8(OP.local_get).u32(1).u8(OP.i64_eqz).u8(OP.if).u8(T.void); be.hook(b, '_INT_DIVZERO', g.divzero); b.u8(OP.end);
      if (signed) {
        // MIN/-1 overflows in IDIV (#DE)
        b.u8(OP.local_get).u32(1).u8(OP.i64_const).s64(-1n).u8(OP.i64_eq);
        b.u8(OP.local_get).u32(0).u8(OP.i64_const).s64(-0x8000000000000000n).u8(OP.i64_eq);
        b.u8(OP.i32_and).u8(OP.if).u8(T.void); be.hook(b, '_INT_DIVZERO', g.divzero); b.u8(OP.end);
      }
      b.u8(OP.local_get).u32(0).u8(OP.local_get).u32(1).u8(op);
    });
  }
  // FISTTP: truncation; NaN/out of range give 0x8000000000000000
  fn('$f2i', [T.f64], [T.i64], [], (b) => {
    b.u8(OP.local_get).u32(0).u8(OP.local_get).u32(0).u8(OP.f64_ne); // NaN
    b.u8(OP.local_get).u32(0).u8(OP.f64_const).f64(9223372036854775808).u8(OP.f64_ge).u8(OP.i32_or);
    b.u8(OP.local_get).u32(0).u8(OP.f64_const).f64(-9223372036854775808).u8(OP.f64_lt).u8(OP.i32_or);
    b.u8(OP.if).u8(T.i64).u8(OP.i64_const).s64(-0x8000000000000000n);
    b.u8(OP.else).u8(OP.local_get).u32(0).u8(0xFC).u32(OPFC.i64_trunc_sat_f64_s).u8(OP.end);
  });
  // StrLen(U8 *)
  fn('$strlen', [T.i64], [T.i64], [[1, T.i32]], (b) => {
    b.u8(OP.local_get).u32(0).u8(OP.i32_wrap_i64).u8(OP.local_set).u32(1);
    b.u8(OP.block).u8(T.void).u8(OP.loop).u8(T.void);
    b.u8(OP.local_get).u32(1).u8(OP.i32_load8_u).u32(0).u32(0).u8(OP.i32_eqz).u8(OP.br_if).u32(1);
    b.u8(OP.local_get).u32(1).u8(OP.i32_const).s32(1).u8(OP.i32_add).u8(OP.local_set).u32(1);
    b.u8(OP.br).u32(0).u8(OP.end).u8(OP.end);
    b.u8(OP.local_get).u32(1).u8(OP.local_get).u32(0).u8(OP.i32_wrap_i64).u8(OP.i32_sub).u8(OP.i64_extend_i32_u);
  });
  return h;
}

// ------------------------------------------------------------- unit
// One compile unit (function, statement, initializer).
class Unit {
  constructor(be, cc, prog, opts) {
    this.be = be; this.cc = cc; this.opts = opts;
    this.ics = prog.ics.filter((t) => t.code !== K.IC_NOP1);
    this.fun = cc.htc.fun;
    this.b = new Bytes();
    this.locals = []; // [type]
    this.L = {};
    this.nParams = 0;
  }
  local(t) { this.locals.push(t); return this.nParams + this.locals.length - 1; }
  op(o) { this.b.u8(o); return this; }
  u8(x) { this.b.u8(x); return this; }
  u32(x) { this.b.u32(x); return this; }
  lget(i) { this.b.u8(OP.local_get).u32(i); return this; }
  lset(i) { this.b.u8(OP.local_set).u32(i); return this; }
  ltee(i) { this.b.u8(OP.local_tee).u32(i); return this; }
  gget(i) { this.b.u8(OP.global_get).u32(i); return this; }
  gset(i) { this.b.u8(OP.global_set).u32(i); return this; }
  i32(v) { this.b.u8(OP.i32_const).s32(v); return this; }
  i64(v) { this.b.u8(OP.i64_const).s64(v); return this; }
  f64(v) { this.b.u8(OP.f64_const).f64(v); return this; }
  call(f) { this.b.u8(OP.call).u32(f); return this; }
  mem(o, align = 0, off = 0) { this.b.u8(o).u32(align).u32(off); return this; }

  // ---- shadow stack (sp is an i32 global)
  spAdd(n) { if (n) { this.gget(this.be.g.sp).i32(n).op(OP.i32_add).gset(this.be.g.sp); } return this; }
  // push the i64 (or f64) on top of the wasm stack to the shadow stack
  push(type) {
    const t = type === F ? this.L.tf : this.L.ti;
    this.lset(t);
    this.spAdd(-8);
    this.gget(this.be.g.sp).lget(t).mem(type === F ? OP.f64_store : OP.i64_store, 3);
    return this;
  }
  pop64() { this.gget(this.be.g.sp).mem(OP.i64_load, 3).spAdd(8); return this; }

  // ---- value representation on the wasm stack
  conv(from, to) { // reinterpret bits (x86 registers just hold bits)
    if (from === to) return this;
    this.op(to === F ? OP.f64_reinterpret_i64 : OP.i64_reinterpret_f64);
    return this;
  }
  // memory access for raw type rt at the i64 address on the stack
  addr() { this.op(OP.i32_wrap_i64); return this; }
  load(rt) {
    switch (rt) {
      case K.RT_I8: this.mem(OP.i64_load8_s, 0); return I;
      case K.RT_U8: this.mem(OP.i64_load8_u, 0); return I;
      case K.RT_I16: this.mem(OP.i64_load16_s, 1); return I;
      case K.RT_U16: this.mem(OP.i64_load16_u, 1); return I;
      case K.RT_I32: this.mem(OP.i64_load32_s, 2); return I;
      case K.RT_U32: this.mem(OP.i64_load32_u, 2); return I;
      case K.RT_F64: this.mem(OP.f64_load, 3); return F;
      case K.RT_I0: case K.RT_U0: this.op(OP.drop).i64(0); return I;
      default: this.mem(OP.i64_load, 3); return I;
    }
  }
  store(rt) { // [addr i32, value(of rt kind)]
    switch (rt) {
      case K.RT_I8: case K.RT_U8: this.mem(OP.i64_store8, 0); break;
      case K.RT_I16: case K.RT_U16: this.mem(OP.i64_store16, 1); break;
      case K.RT_I32: case K.RT_U32: this.mem(OP.i64_store32, 2); break;
      case K.RT_F64: this.mem(OP.f64_store, 3); break;
      case K.RT_I0: case K.RT_U0: this.op(OP.drop).op(OP.drop); break;
      default: this.mem(OP.i64_store, 3);
    }
  }
  memKind(rt) { return rt === K.RT_F64 ? F : I; }

  err(msg, t) {
    throw new BackendError(`${msg} (IC ${t ? ICNAME(t.code) : '?'}) in ${this.fun ? this.fun.str : 'stmt'} ${t ? 'line ' + t.line : ''}`);
  }

  // ------------------------------------------------------------ compile
  compile() {
    const ics = this.ics, be = this.be, g = be.g;
    // locals
    this.L.fp = this.local(T.i32);
    this.L.rax = this.local(T.i64);
    this.L.state = this.local(T.i32);
    this.L.ti = this.local(T.i64); this.L.ti2 = this.local(T.i64); this.L.ti3 = this.local(T.i64);
    this.L.tf = this.local(T.f64); this.L.tf2 = this.local(T.f64);
    this.L.ta = this.local(T.i32); this.L.ta2 = this.local(T.i32);
    this.L.pci = this.local(T.i64); this.L.pcf = this.local(T.f64);
    this.spill = { i: [], f: [] };

    // ---- basic blocks
    const blocks = []; // {start, end (exclusive), labels:[]}
    const labelBlock = new Map(); // CCodeMisc (OptLabelFwd'd) -> block index
    let cur = null;
    const newBlock = (i) => { cur = { start: i, end: i, labels: [] }; blocks.push(cur); };
    newBlock(0);
    for (let i = 0; i < ics.length; i++) {
      const t = ics[i];
      if (t.code === K.IC_LABEL) {
        if (cur.end > cur.start) newBlock(i);
        cur.labels.push(t.data);
        cur.end = i + 1;
        continue;
      }
      cur.end = i + 1;
      if (BRANCH_CODES.has(t.code) && i + 1 < ics.length) newBlock(i + 1);
    }
    // A label maps to its own block.  Branches go to the label at the end
    // of its fwd chain (OptPass012 threads "LABEL x; JMP y" as x.fwd=y, and
    // x keeps its LABEL IC: mapping x by fwd(x) would make y's block x's).
    blocks.forEach((bl, k) => { for (const lb of bl.labels) labelBlock.set(lb, k); });
    this.blocks = blocks; this.labelBlock = labelBlock;
    const blockOf = (lb) => {
      let k = labelBlock.get(fwd(lb));
      if (k === undefined) k = labelBlock.get(lb);
      if (k === undefined) this.err('branch to undefined label');
      return k;
    };
    this.blockOf = blockOf;

    // ---- which features this unit needs
    let hasSubCall = false, hasGetLabel = false;
    for (const t of ics) {
      if (t.code === K.IC_SUB_CALL) hasSubCall = true;
      if (t.code === K.IC_GET_LABEL) hasGetLabel = true;
    }
    this.hasRetDispatch = hasSubCall || hasGetLabel;
    const n = blocks.length;

    // ---- prologue
    this.gget(g.rbp).lset(this.L.fp);
    if (be.opts.trace) this.i32(be.traceId(this.fun)).gget(g.sp).op(OP.i64_extend_i32_u).call(g.trace); // debug: fn entry
    // structure
    if (hasGetLabel) {
      // loop $restart (try (do <dispatch>) (catch $resume ...))
      this.op(OP.loop).u8(T.void);
      this.op(OP.try).u8(T.void);
    }
    this.op(OP.loop).u8(T.void); // $dispatch
    for (let k = n - 1; k >= 0; k--) this.op(OP.block).u8(T.void);
    // br_table B0..B(n-1) on $state
    this.lget(this.L.state);
    this.op(OP.br_table).u32(n);
    for (let k = 0; k < n; k++) this.b.u32(k);
    this.b.u32(0);
    // depth bookkeeping: inside code of block k, label $B_j (j>k) is at
    // depth j-k-1+extra, $dispatch at n-1-k+extra.
    this.extra = 0;
    this.stack = []; // compile-time parse stack: {k: 'i'|'f'|null(phantom), ic}
    const entryStack = new Array(n);
    // linear stack simulation: entry stack of a block = stack after previous IC
    for (let k = 0; k < n; k++) {
      const bl = blocks[k];
      this.op(OP.end); // end of $B_k : code of block k starts
      this.curBlock = k;
      // block entry: reload spilled values
      if (k === 0) this.stack = [];
      else {
        const prevEnd = blocks[k - 1];
        this.stack = this.fallStack ? this.fallStack : [];
      }
      entryStack[k] = this.stack.slice();
      this.reloadStack();
      this.fallStack = null;
      let fell = true;
      for (let i = bl.start; i < bl.end; i++) {
        const t = ics[i];
        if (t.code === K.IC_LABEL) continue;
        this.ic(t, i);
        if (NO_FALLTHRU.has(t.code)) fell = false;
      }
      // fall through into block k+1: spill
      if (fell) {
        this.spillStack();
        this.fallStack = this.stack.map((e) => ({ ...e }));
        if (k === n - 1) {
          // end of unit without RET: return rax
          this.retRax();
        }
      } else this.fallStack = this.stack.map((e) => ({ ...e })); // linear accounting continues
    }
    this.op(OP.end); // $dispatch loop
    if (hasGetLabel) {
      // catch $resume: [fp i32, label i64, sp i32]
      this.op(OP.catch).u32(g.resume);
      this.lset(this.L.ta2);           // sp
      this.lset(this.L.ti);            // label id
      this.lset(this.L.ta);            // fp
      this.lget(this.L.ta).lget(this.L.fp).op(OP.i32_ne);
      this.op(OP.if).u8(T.void);
      this.lget(this.L.ta).lget(this.L.ti).lget(this.L.ta2).op(OP.throw).u32(g.resume);
      this.op(OP.end);
      this.lget(this.L.ta2).gset(g.sp);
      this.lget(this.L.fp).gset(g.rbp);
      this.lget(this.L.ti).op(OP.i32_wrap_i64).i32(1).op(OP.i32_sub).lset(this.L.state);
      this.op(OP.br).u32(1); // $restart
      this.op(OP.end); // try
      this.op(OP.end); // loop $restart
    }
    this.op(OP.unreachable);
    return { body: this.b.toU8(), locals: compressLocals(this.locals) };
  }

  // spill locals for values live across a block boundary (by depth)
  spillLocal(kind, depth) {
    const a = this.spill[kind];
    while (a.length <= depth) a.push(this.local(kind === F ? T.f64 : T.i64));
    return a[depth];
  }
  spillStack() {
    // pops real values off the wasm stack into depth locals (top first)
    for (let d = this.stack.length - 1; d >= 0; d--) {
      const e = this.stack[d];
      if (!e.k) continue;
      this.lset(this.spillLocal(e.k, d));
    }
  }
  reloadStack() {
    for (let d = 0; d < this.stack.length; d++) {
      const e = this.stack[d];
      if (e.k) this.lget(this.spillLocal(e.k, d));
    }
  }
  // Branch to block k from the current position (stack already spilled).
  jump(k) {
    if (k > this.curBlock) this.op(OP.br).u32(k - this.curBlock - 1 + this.extra);
    else {
      this.i32(k).lset(this.L.state);
      this.op(OP.br).u32(this.blocks.length - 1 - this.curBlock + this.extra);
    }
  }
  // Conditional branch: condition (i32) on the wasm stack below spilled values?
  // We evaluate the condition into $ta first, spill, then branch.
  condJump(k) {
    this.lset(this.L.ta);
    this.spillStack();
    this.lget(this.L.ta);
    this.op(OP.if).u8(T.void); this.extra++;
    this.jump(k);
    this.extra--; this.op(OP.end);
    this.reloadStack();
  }
  retRax() {
    // RET: pop the return marker and return RAX
    this.spAdd(8);
    this.lget(this.L.rax).op(OP.return);
  }

  // pop n args for an IC: returns kinds (bottom..top)
  pops(cnt, t) {
    const r = [];
    for (let i = 0; i < cnt; i++) {
      const e = this.stack.pop();
      if (!e) this.err('parse stack underflow', t);
      r.unshift(e);
    }
    for (const e of r) if (!e.k) this.err('phantom used as operand', t);
    return r.map((e) => e.k);
  }
  // result: value of kind 'kind' on the wasm stack; apply RES_TO_* and PUSH_RES
  result(t, kind) {
    if (t.flags & K.ICF_RES_TO_F64 && kind === I) { this.op(OP.f64_convert_i64_s); kind = F; }
    else if (t.flags & K.ICF_RES_TO_INT && kind === F) { this.call(this.be.h.$f2i); kind = I; }
    if (t.flags & K.ICF_PUSH_RES) { this.push(kind); this.stack.push({ k: null, ic: t }); }
    else this.stack.push({ k: kind, ic: t });
  }
  // The two operands, as the given kind (reinterpreting).
  args2(kinds, want) {
    // stack: a b
    if (kinds[1] !== want) { this.conv(kinds[1], want); }
    if (kinds[0] !== want) {
      // need a converted: stash b
      if (want === F) { this.lset(this.L.tf2); this.conv(kinds[0], want); this.lget(this.L.tf2); }
      else { this.lset(this.L.ti2); this.conv(kinds[0], want); this.lget(this.L.ti2); }
    }
  }
  arg1(kind, want) { this.conv(kind, want); }

  absAddr(rip) { // module-relative address -> absolute i64
    this.gget(this.be.g.base).i64(BigInt(rip)).op(OP.i64_add);
  }
  marker() { this.be.markerExpr(this); } // i64: return address marker

  // ------------------------------------------------------------ one IC
  ic(t, i) {
    const be = this.be, g = be.g, code = t.code;
    const ent = intermediate_code_table[code];
    const rt = rawType(t.cls);
    // ---- the IS_V_ARG / NOP2 stack accounting
    if (ent.arg_cnt === K.IS_V_ARG) {
      for (let n = Number(I64(t.data)) >> 3; n--;) {
        const e = this.stack.pop();
        if (!e) this.err('V_ARG underflow', t);
        if (e.k) this.err('V_ARG popped a real value', t);
      }
      if (code === K.IC_ADD_RSP) this.spAdd(Number(I64(t.data)));
      return;
    }
    let k = null;
    switch (code) {
      case K.IC_NOP2: for (let n = Number(I64(t.data)); n--;) this.stack.push({ k: null, ic: t }); return;
      case K.IC_END: return;
      case K.IC_IMM_I64: this.i64(I64(this.immData(t))); return this.result(t, rt === K.RT_F64 ? (this.conv(I, F), F) : I);
      case K.IC_IMM_F64: this.f64(b2f(t.data)); return this.result(t, rt === K.RT_F64 ? F : (this.conv(F, I), I));
      case K.IC_STR_CONST: case K.IC_GET_LABEL: case K.IC_ABS_ADDR: case K.IC_ADDR_IMPORT: case K.IC_HEAP_GLBL: case K.IC_RIP:
        this.addressOf(t);
        return this.result(t, I);
      case K.IC_RBP: this.lget(this.L.fp).op(OP.i64_extend_i32_u); return this.result(t, I);
      case K.IC_SIZEOF: case K.IC_TYPE: this.err('unexpected IC after OptPass012', t);
      // ---- FS/GS (intern Fs()/Gs(): FS:[0])
      case K.IC_FS: case K.IC_GS:
        this.gget(code === K.IC_FS ? g.fs : g.gs).op(OP.i32_wrap_i64).mem(OP.i64_load, 3).lset(this.L.rax);
        return;
      case K.IC_MOV_FS: case K.IC_MOV_GS:
        this.gget(code === K.IC_MOV_FS ? g.fs : g.gs).i64(I64(t.data)).op(OP.i64_add).addr();
        return this.result(t, this.load(rt));
      // ---- conversions/casts
      case K.IC_HOLYC_TYPECAST: {
        const [a] = this.pops(1, t);
        const want = rt === K.RT_F64 ? F : I;
        this.conv(a, want);
        return this.result(t, want);
      }
      case K.IC_ADDR: { const [a] = this.pops(1, t); this.conv(a, I); return this.result(t, I); }
      case K.IC_COM: { const [a] = this.pops(1, t); this.conv(a, I); this.i64(-1).op(OP.i64_xor); return this.result(t, I); }
      case K.IC_NOT: {
        const [a] = this.pops(1, t);
        if (a === F && rt === K.RT_F64) { this.f64(0).op(OP.f64_eq).op(OP.i64_extend_i32_u).op(OP.f64_convert_i64_s); return this.result(t, F); }
        this.conv(a, I); this.op(OP.i64_eqz).op(OP.i64_extend_i32_u);
        return this.result(t, rt === K.RT_F64 ? (this.op(OP.f64_convert_i64_s), F) : I);
      }
      case K.IC_UNARY_MINUS: {
        const [a] = this.pops(1, t);
        if (rt === K.RT_F64) { this.conv(a, F); this.op(OP.f64_neg); return this.result(t, F); }
        this.conv(a, I); this.lset(this.L.ti).i64(0).lget(this.L.ti).op(OP.i64_sub);
        return this.result(t, I);
      }
      // ---- memory
      case K.IC_DEREF: { const [a] = this.pops(1, t); this.conv(a, I); this.addr(); return this.result(t, this.load(rt)); }
      case K.IC__PP: case K.IC__MM: case K.IC_PP_: case K.IC_MM_:
        return this.incDec(t, code === K.IC__PP || code === K.IC_PP_, code === K.IC_PP_ || code === K.IC_MM_);
      case K.IC_DEREF_PP: case K.IC_DEREF_MM: return this.derefIncDec(t, code === K.IC_DEREF_PP);
      case K.IC_ASSIGN: case K.IC_ASSIGN_PP: case K.IC_ASSIGN_MM: return this.assign(t);
      case K.IC_ADD_EQU: case K.IC_SUB_EQU: case K.IC_MUL_EQU: case K.IC_DIV_EQU: case K.IC_MOD_EQU:
      case K.IC_AND_EQU: case K.IC_OR_EQU: case K.IC_XOR_EQU: case K.IC_SHL_EQU: case K.IC_SHR_EQU:
        return this.opEqu(t);
      // ---- arithmetic
      case K.IC_ADD: case K.IC_SUB: case K.IC_MUL: case K.IC_DIV: case K.IC_MOD:
      case K.IC_AND: case K.IC_OR: case K.IC_XOR: case K.IC_SHL: case K.IC_SHR: case K.IC_POWER:
        return this.binop(t);
      case K.IC_SHL_CONST: case K.IC_SHR_CONST: {
        const [a] = this.pops(1, t);
        // (F64 shifts are integer shifts of the bits, as in ICShift)
        this.conv(a, I); this.i64(I64(t.data) & 63n);
        this.op(code === K.IC_SHL_CONST ? OP.i64_shl : (isUns(rt) || t.flags & K.ICF_USE_UNSIGNED) ? OP.i64_shr_u : OP.i64_shr_s);
        return this.result(t, rt === K.RT_F64 ? (this.conv(I, F), F) : I);
      }
      case K.IC_EQU_EQU: case K.IC_NOT_EQU: case K.IC_LESS: case K.IC_GREATER_EQU: case K.IC_GREATER: case K.IC_LESS_EQU:
        return this.compare(t);
      case K.IC_PUSH_CMP: {
        // the right operand of the previous ICF_PUSH_CMP compare
        const pk = this.pushCmpKind || I;
        this.lget(pk === F ? this.L.pcf : this.L.pci);
        return this.result(t, pk);
      }
      case K.IC_AND_AND: case K.IC_OR_OR: case K.IC_XOR_XOR: {
        const ks = this.pops(2, t);
        this.args2(ks, I);
        this.lset(this.L.ti2).op(OP.i64_eqz).op(OP.i32_eqz).lget(this.L.ti2).op(OP.i64_eqz).op(OP.i32_eqz);
        this.op(code === K.IC_AND_AND ? OP.i32_and : code === K.IC_OR_OR ? OP.i32_or : OP.i32_xor).op(OP.i64_extend_i32_u);
        return this.result(t, I);
      }
      // ---- expression statement end / returns
      case K.IC_END_EXP: {
        const [a] = this.pops(1, t);
        if (t.flags & K.ICF_RES_NOT_USED) this.op(OP.drop);
        else { this.conv(a, I); this.lset(this.L.rax); }
        return;
      }
      case K.IC_RETURN_VAL: case K.IC_SET_RAX: { const [a] = this.pops(1, t); this.conv(a, I); this.lset(this.L.rax); return; }
      case K.IC_RETURN_VAL2: return;
      case K.IC_GET_RAX: return; // the value is RAX, which CALL_END pushes
      // ---- calls
      case K.IC_CALL_START: case K.IC_CALL_END2: return;
      case K.IC_CALL_END: {
        this.lget(this.L.rax);
        return this.result(t, rt === K.RT_F64 ? (this.conv(I, F), F) : I);
      }
      case K.IC_PUSH_REGS:
        if (I64(t.data) !== 1n << BigInt(K.REG_RAX)) this.err('PUSH_REGS other than RAX', t);
        this.lget(this.L.rax).push(I);
        return;
      case K.IC_POP_REGS: this.err('POP_REGS', t);
      case K.IC_CALL: case K.IC_CALL_EXTERN: case K.IC_CALL_IMPORT: case K.IC_CALL_INDIRECT: case K.IC_CALL_INDIRECT2:
        return this.callIC(t);
      // ---- intern functions (args reversed: arg1 = last param)
      case K.IC_BT: case K.IC_BTS: case K.IC_BTR: case K.IC_BTC: case K.IC_LBTS: case K.IC_LBTR: case K.IC_LBTC:
        return this.bitOp(t, null);
      case K.IC_BSF: case K.IC_BSR: {
        const [a] = this.pops(1, t); this.conv(a, I);
        this.ltee(this.L.ti).op(OP.i64_eqz);
        this.op(OP.if).u8(T.i64).i64(-1).op(OP.else);
        if (code === K.IC_BSF) this.lget(this.L.ti).op(OP.i64_ctz);
        else this.i64(63).lget(this.L.ti).op(OP.i64_clz).op(OP.i64_sub);
        this.op(OP.end).lset(this.L.rax);
        return;
      }
      case K.IC_STRLEN: { const [a] = this.pops(1, t); this.conv(a, I); this.call(be.h.$strlen).lset(this.L.rax); return; }
      case K.IC_TOUPPER: {
        const [a] = this.pops(1, t); this.conv(a, I);
        this.ltee(this.L.ti).i64(97).op(OP.i64_ge_s).lget(this.L.ti).i64(122).op(OP.i64_le_s).op(OP.i32_and);
        this.op(OP.if).u8(T.i64).lget(this.L.ti).i64(32).op(OP.i64_sub).op(OP.else).lget(this.L.ti).op(OP.end);
        this.lset(this.L.rax);
        return;
      }
      case K.IC_TO_I64: { const [a] = this.pops(1, t); this.conv(a, F); this.call(be.h.$f2i).lset(this.L.rax); return; }
      case K.IC_TO_F64: { const [a] = this.pops(1, t); this.conv(a, I); this.op(OP.f64_convert_i64_s).op(OP.i64_reinterpret_f64).lset(this.L.rax); return; }
      case K.IC_TO_BOOL: { const [a] = this.pops(1, t); this.conv(a, I); this.op(OP.i64_eqz).op(OP.i32_eqz).op(OP.i64_extend_i32_u).lset(this.L.rax); return; }
      case K.IC_ABS_I64: {
        const [a] = this.pops(1, t); this.conv(a, I);
        this.ltee(this.L.ti).i64(0).op(OP.i64_lt_s);
        this.op(OP.if).u8(T.i64).i64(0).lget(this.L.ti).op(OP.i64_sub).op(OP.else).lget(this.L.ti).op(OP.end).lset(this.L.rax);
        return;
      }
      case K.IC_SIGN_I64: {
        const [a] = this.pops(1, t); this.conv(a, I);
        this.ltee(this.L.ti).i64(0).op(OP.i64_gt_s).op(OP.i64_extend_i32_u);
        this.lget(this.L.ti).i64(0).op(OP.i64_lt_s).op(OP.i64_extend_i32_u).op(OP.i64_sub).lset(this.L.rax);
        return;
      }
      case K.IC_MIN_I64: case K.IC_MAX_I64: case K.IC_MIN_U64: case K.IC_MAX_U64: {
        const ks = this.pops(2, t); this.args2(ks, I);
        this.lset(this.L.ti2).lset(this.L.ti);
        this.lget(this.L.ti).lget(this.L.ti2).lget(this.L.ti).lget(this.L.ti2);
        this.op(code === K.IC_MIN_I64 ? OP.i64_lt_s : code === K.IC_MAX_I64 ? OP.i64_gt_s : code === K.IC_MIN_U64 ? OP.i64_lt_u : OP.i64_gt_u);
        this.op(OP.select).lset(this.L.rax);
        return;
      }
      case K.IC_SQR_I64: case K.IC_SQR_U64: { const [a] = this.pops(1, t); this.conv(a, I); this.ltee(this.L.ti).lget(this.L.ti).op(OP.i64_mul).lset(this.L.rax); return; }
      case K.IC_MOD_U64: { // ModU64(U64 *q,U64 d): arg1=d arg2=q; *q/=d; return remainder
        const ks = this.pops(2, t); this.args2(ks, I);
        this.lset(this.L.ti2).lset(this.L.ti); // q, d
        this.lget(this.L.ti2).addr().mem(OP.i64_load, 3).lget(this.L.ti).call(be.h.$rem_u).lset(this.L.rax);
        this.lget(this.L.ti2).addr();
        this.lget(this.L.ti2).addr().mem(OP.i64_load, 3).lget(this.L.ti).call(be.h.$div_u);
        this.mem(OP.i64_store, 3);
        return;
      }
      case K.IC_SWAP_U8: case K.IC_SWAP_U16: case K.IC_SWAP_U32: case K.IC_SWAP_I64: {
        const ks = this.pops(2, t); this.args2(ks, I);
        const srt = { [K.IC_SWAP_U8]: K.RT_U8, [K.IC_SWAP_U16]: K.RT_U16, [K.IC_SWAP_U32]: K.RT_U32, [K.IC_SWAP_I64]: K.RT_I64 }[code];
        this.lset(this.L.ti2).lset(this.L.ti);
        this.lget(this.L.ti).addr().load(srt); this.lset(this.L.ti3);
        this.lget(this.L.ti).addr().lget(this.L.ti2).addr().load(srt); this.store(srt);
        this.lget(this.L.ti2).addr().lget(this.L.ti3); this.store(srt);
        return;
      }
      case K.IC_QUE_INIT: {
        const [a] = this.pops(1, t); this.conv(a, I);
        this.ltee(this.L.ti).addr().lget(this.L.ti).mem(OP.i64_store, 3, 0);
        this.lget(this.L.ti).addr().lget(this.L.ti).mem(OP.i64_store, 3, 8);
        return;
      }
      case K.IC_QUE_INS: case K.IC_QUE_INS_REV: {
        // QueIns(entry,pred): arg1=pred arg2=entry
        const ks = this.pops(2, t); this.args2(ks, I);
        const ent = this.L.ti2, pred = this.L.ti, nx = this.L.ti3;
        this.lset(ent).lset(pred);
        if (code === K.IC_QUE_INS) {
          this.lget(pred).addr().mem(OP.i64_load, 3, 0).lset(nx);           // nx=pred->next
          this.lget(pred).addr().lget(ent).mem(OP.i64_store, 3, 0);          // pred->next=entry
          this.lget(ent).addr().lget(nx).mem(OP.i64_store, 3, 0);            // entry->next=nx
          this.lget(ent).addr().lget(pred).mem(OP.i64_store, 3, 8);          // entry->last=pred
          this.lget(nx).addr().lget(ent).mem(OP.i64_store, 3, 8);            // nx->last=entry
        } else { // QueInsRev(entry,succ)
          this.lget(pred).addr().mem(OP.i64_load, 3, 8).lset(nx);           // nx=succ->last
          this.lget(nx).addr().lget(ent).mem(OP.i64_store, 3, 0);            // nx->next=entry
          this.lget(ent).addr().lget(pred).mem(OP.i64_store, 3, 0);          // entry->next=succ
          this.lget(ent).addr().lget(nx).mem(OP.i64_store, 3, 8);            // entry->last=nx
          this.lget(pred).addr().lget(ent).mem(OP.i64_store, 3, 8);          // succ->last=entry
        }
        return;
      }
      case K.IC_QUE_REM: {
        const [a] = this.pops(1, t); this.conv(a, I);
        this.lset(this.L.ti);
        this.lget(this.L.ti).addr().mem(OP.i64_load, 3, 0).lset(this.L.ti2); // next
        this.lget(this.L.ti).addr().mem(OP.i64_load, 3, 8).lset(this.L.ti3); // last
        this.lget(this.L.ti3).addr().lget(this.L.ti2).mem(OP.i64_store, 3, 0); // last->next=next
        this.lget(this.L.ti2).addr().lget(this.L.ti3).mem(OP.i64_store, 3, 8); // next->last=last
        return;
      }
      case K.IC_SQR: case K.IC_ABS: case K.IC_SQRT: case K.IC_SIN: case K.IC_COS: case K.IC_TAN: case K.IC_ATAN: {
        const [a] = this.pops(1, t); this.conv(a, F);
        switch (code) {
          case K.IC_SQR: this.ltee(this.L.tf).lget(this.L.tf).op(OP.f64_mul); break;
          case K.IC_ABS: this.op(OP.f64_abs); break;
          case K.IC_SQRT: this.op(OP.f64_sqrt); break;
          case K.IC_SIN: this.call(g.sin); break;
          case K.IC_COS: this.call(g.cos); break;
          case K.IC_TAN: this.call(g.tan); break;
          case K.IC_ATAN: this.call(g.atan); break;
        }
        return this.result(t, F);
      }
      case K.IC_IN_U8: case K.IC_IN_U16: case K.IC_IN_U32: {
        const [a] = this.pops(1, t); this.conv(a, I);
        this.op(OP.i32_wrap_i64).i32(code === K.IC_IN_U8 ? 1 : code === K.IC_IN_U16 ? 2 : 4).call(g.in).lset(this.L.rax);
        return;
      }
      case K.IC_OUT_U8: case K.IC_OUT_U16: case K.IC_OUT_U32: { // OutU8(port,val): arg1=val arg2=port
        const ks = this.pops(2, t); this.args2(ks, I);
        this.op(OP.i32_wrap_i64).lset(this.L.ta).lset(this.L.ti);
        this.lget(this.L.ta).lget(this.L.ti).i32(code === K.IC_OUT_U8 ? 1 : code === K.IC_OUT_U16 ? 2 : 4).call(g.out);
        return;
      }
      case K.IC_RDTSC: this.call(g.rdtsc).lset(this.L.rax); return;
      case K.IC_GET_RFLAGS: this.gget(g.rflags).lset(this.L.rax); return;
      case K.IC_SET_RFLAGS: { const [a] = this.pops(1, t); this.conv(a, I); this.gset(g.rflags); this.irqCheck(); return; }
      case K.IC_GET_RBP: this.lget(this.L.fp).op(OP.i64_extend_i32_u).lset(this.L.rax); return;
      case K.IC_SET_RBP: { const [a] = this.pops(1, t); this.conv(a, I); this.op(OP.i32_wrap_i64).ltee(this.L.fp).gset(g.rbp); return; }
      case K.IC_GET_RSP: this.gget(g.sp).op(OP.i64_extend_i32_u).lset(this.L.rax); return;
      case K.IC_SET_RSP: { const [a] = this.pops(1, t); this.conv(a, I); this.op(OP.i32_wrap_i64).gset(g.sp); return; }
      case K.IC_PUSH: { const [a] = this.pops(1, t); this.conv(a, I); this.push(I); return; }
      case K.IC_POP: this.pop64().lset(this.L.rax); return;
      case K.IC_INVLPG: case K.IC_CLFLUSH: { const [a] = this.pops(1, t); this.op(OP.drop); return; }
      case K.IC_CARRY: this.err('Carry() is not supported', t);
      case K.IC_ASM: return this.asmIC(t);
      // ---- frame
      case K.IC_ENTER: {
        const size = Number(I64(t.data));
        this.spAdd(-8);
        this.gget(g.sp).lget(this.L.fp).op(OP.i64_extend_i32_u).mem(OP.i64_store, 3);
        this.gget(g.sp).ltee(this.L.fp).gset(g.rbp);
        this.spAdd(-size);
        // interrupt functions are entered like normal calls by the IRQ
        // delivery code, which saves/restores RFLAGS around them (IRET).
        return;
      }
      case K.IC_LEAVE: {
        this.lget(this.L.fp).gset(g.sp);
        this.pop64().op(OP.i32_wrap_i64).ltee(this.L.fp).gset(g.rbp);
        this.spAdd(8); // return marker
        const f = this.fun;
        if (f && f.arg_cnt && (bt(f.flags, K.Ff_RET1) || bt(f.flags, K.Ff_ARGPOP)) && !bt(f.flags, K.Ff_NOARGPOP))
          this.spAdd(f.arg_cnt << 3);
        this.lget(this.L.rax).op(OP.return);
        return;
      }
      case K.IC_RET: return this.retIC(t);
      // ---- control flow
      case K.IC_JMP: this.spillStack(); this.jump(this.blockOf(t.data)); return;
      case K.IC_SUB_CALL: {
        this.spillStack();
        this.i64(this.curBlock + 2).push(I); // continuation = next block, id = index+1
        this.jump(this.blockOf(t.data));
        return;
      }
      case K.IC_BR_ZERO: case K.IC_BR_NOT_ZERO: {
        const [a] = this.pops(1, t); this.conv(a, I);
        this.op(code === K.IC_BR_ZERO ? OP.i64_eqz : OP.i64_eqz);
        if (code === K.IC_BR_NOT_ZERO) this.op(OP.i32_eqz);
        return this.condJump(this.blockOf(t.data));
      }
      case K.IC_BR_EQU_EQU: case K.IC_BR_NOT_EQU: case K.IC_BR_LESS: case K.IC_BR_GREATER_EQU: case K.IC_BR_GREATER: case K.IC_BR_LESS_EQU:
      case K.IC_BR_EQU_EQU2: case K.IC_BR_NOT_EQU2: case K.IC_BR_LESS2: case K.IC_BR_GREATER_EQU2: case K.IC_BR_GREATER2: case K.IC_BR_LESS_EQU2:
        return this.cmpBranch(t);
      case K.IC_BR_AND_ZERO: case K.IC_BR_AND_NOT_ZERO: {
        const ks = this.pops(2, t); this.args2(ks, I);
        this.op(OP.i64_and).op(OP.i64_eqz);
        if (code === K.IC_BR_AND_NOT_ZERO) this.op(OP.i32_eqz);
        return this.condJump(this.blockOf(t.data));
      }
      case K.IC_BR_MM_ZERO: case K.IC_BR_MM_NOT_ZERO: {
        const [a] = this.pops(1, t); this.conv(a, I);
        // --*p, branch on zero (DEC sets ZF on the stored width)
        this.addr().lset(this.L.ta);
        this.lget(this.L.ta).lget(this.L.ta).load(rt); this.i64(1).op(OP.i64_sub); this.store(rt);
        this.lget(this.L.ta).load(rt); this.op(OP.i64_eqz);
        if (code === K.IC_BR_MM_NOT_ZERO) this.op(OP.i32_eqz);
        return this.condJump(this.blockOf(t.data));
      }
      case K.IC_BR_BT: case K.IC_BR_BTS: case K.IC_BR_BTR: case K.IC_BR_BTC:
      case K.IC_BR_NOT_BT: case K.IC_BR_NOT_BTS: case K.IC_BR_NOT_BTR: case K.IC_BR_NOT_BTC:
        return this.bitOp(t, this.blockOf(t.data));
      case K.IC_SWITCH: case K.IC_NOBOUND_SWITCH: return this.switchIC(t);
      default:
        this.err('unsupported IC', t);
    }
  }

  immData(t) {
    const d = t.data;
    if (typeof d === 'bigint') return d;
    if (typeof d === 'number') return BigInt(d);
    return this.be.immObject(this, t, d);
  }

  addressOf(t) {
    const be = this.be;
    switch (t.code) {
      case K.IC_STR_CONST: be.strConstAddr(this, t.data); return;
      case K.IC_GET_LABEL: this.i64(this.blockOf(t.data) + 1); return;
      case K.IC_ABS_ADDR: this.absAddr(Number(I64(t.data))); return;
      case K.IC_RIP: be.selfAddr(this); return;
      case K.IC_ADDR_IMPORT: be.importSlot(this, t.data, 'var'); this.addr(); this.mem(OP.i64_load, 3); return;
      case K.IC_HEAP_GLBL: be.heapGlblSlot(this, t.data); this.addr(); this.mem(OP.i64_load, 3); return;
    }
  }

  binop(t) {
    const code = t.code, rt = rawType(t.cls);
    const ks = this.pops(2, t);
    if (code === K.IC_POWER) { this.args2(ks, F); this.call(this.be.g.pow); return this.result(t, F); }
    if (rt === K.RT_F64 && code !== K.IC_AND && code !== K.IC_OR && code !== K.IC_XOR && code !== K.IC_SHL && code !== K.IC_SHR) {
      this.args2(ks, F);
      switch (code) {
        case K.IC_ADD: this.op(OP.f64_add); break;
        case K.IC_SUB: this.op(OP.f64_sub); break;
        case K.IC_MUL: this.op(OP.f64_mul); break;
        case K.IC_DIV: this.op(OP.f64_div); break;
        case K.IC_MOD: this.fmod(); break;
      }
      return this.result(t, F);
    }
    this.args2(ks, I);
    const uns = isUns(rt);
    switch (code) {
      case K.IC_ADD: this.op(OP.i64_add); break;
      case K.IC_SUB: this.op(OP.i64_sub); break;
      case K.IC_MUL: this.op(OP.i64_mul); break;
      case K.IC_DIV: this.call(uns ? this.be.h.$div_u : this.be.h.$div_s); break;
      case K.IC_MOD: this.call(uns ? this.be.h.$rem_u : this.be.h.$rem_s); break;
      case K.IC_AND: this.op(OP.i64_and); break;
      case K.IC_OR: this.op(OP.i64_or); break;
      case K.IC_XOR: this.op(OP.i64_xor); break;
      case K.IC_SHL: this.op(OP.i64_shl); break;
      case K.IC_SHR: this.op(uns || t.flags & K.ICF_USE_UNSIGNED ? OP.i64_shr_u : OP.i64_shr_s); break;
    }
    return this.result(t, rt === K.RT_F64 ? (this.conv(I, F), F) : I);
  }
  fmod() { // x87 FPREM: x - trunc(x/y)*y
    this.lset(this.L.tf2).lset(this.L.tf);
    this.lget(this.L.tf).lget(this.L.tf).lget(this.L.tf2).op(OP.f64_div).op(OP.f64_trunc).lget(this.L.tf2).op(OP.f64_mul).op(OP.f64_sub);
  }

  cmpOp(code, useF, useU) {
    // code relative to EQU_EQU: 0 ==, 1 !=, 2 <, 3 >=, 4 >, 5 <=
    if (useF) return [OP.f64_eq, OP.f64_ne, OP.f64_lt, OP.f64_ge, OP.f64_gt, OP.f64_le][code];
    if (useU) return [OP.i64_eq, OP.i64_ne, OP.i64_lt_u, OP.i64_ge_u, OP.i64_gt_u, OP.i64_le_u][code];
    return [OP.i64_eq, OP.i64_ne, OP.i64_lt_s, OP.i64_ge_s, OP.i64_gt_s, OP.i64_le_s][code];
  }
  compare(t) {
    const ks = this.pops(2, t);
    const c = t.code - K.IC_EQU_EQU;
    const useF = c >= 2 && !!(t.flags & K.ICF_USE_F64); // == and != compare bits
    const want = useF ? F : I;
    this.args2(ks, want);
    this.keepPushCmp(t, want);
    this.op(this.cmpOp(c, useF, !!(t.flags & K.ICF_USE_UNSIGNED)));
    this.op(OP.i64_extend_i32_u);
    // result class: I64 normally, class2 (of the operands) with PUSH_CMP
    return this.result(t, I);
  }
  // ICF_PUSH_CMP (50<i<j chains): keep the right operand for IC_PUSH_CMP
  keepPushCmp(t, want) {
    if (!(t.flags & K.ICF_PUSH_CMP)) return;
    this.ltee(want === F ? this.L.pcf : this.L.pci);
    this.pushCmpKind = want;
  }
  cmpBranch(t) {
    const two = t.code >= K.IC_BR_EQU_EQU2;
    const c = t.code - (two ? K.IC_BR_EQU_EQU2 : K.IC_BR_EQU_EQU);
    const ks = this.pops(2, t);
    const useF = c >= 2 && !!(t.flags & K.ICF_USE_F64);
    const want = useF ? F : I;
    this.args2(ks, want);
    const keep = want === F ? this.L.tf2 : this.L.ti3;
    if (two) this.ltee(keep);
    else this.keepPushCmp(t, want);
    this.op(this.cmpOp(c, useF, !!(t.flags & K.ICF_USE_UNSIGNED)));
    this.condJump(this.blockOf(t.data));
    if (two) { this.lget(keep); this.result(t, want); }
  }

  // Bt/Bts/Btr/Btc (and branch forms): arg1=bit, arg2=bit_field.
  // Memory form uses x86 bit-string addressing (signed bit offset).
  bitOp(t, target) {
    const code = t.code;
    const ks = this.pops(2, t);
    this.args2(ks, I);
    let kind; // 0 bt 1 bts 2 btr 3 btc
    if (target === null) kind = code >= K.IC_LBTS ? code - K.IC_LBTS + 1 : code - K.IC_BT;
    else kind = (code - K.IC_BR_BT) & 3;
    const neg = target !== null && code >= K.IC_BR_NOT_BT;
    if (t.flags & K.ICF_BY_VAL) this.err('BY_VAL bit op', t);
    this.lset(this.L.ti2).lset(this.L.ti); // ti=bit ti2=field
    // byte address = field + (bit SAR 3); bit in byte = bit & 7
    this.lget(this.L.ti2).lget(this.L.ti).i64(3).op(OP.i64_shr_s).op(OP.i64_add).addr().lset(this.L.ta);
    this.lget(this.L.ti).op(OP.i32_wrap_i64).i32(7).op(OP.i32_and).lset(this.L.ta2);
    // old byte -> $ti3
    this.lget(this.L.ta).mem(OP.i32_load8_u, 0).op(OP.i64_extend_i32_u).lset(this.L.ti3);
    if (kind) {
      this.lget(this.L.ta);
      this.lget(this.L.ti3).op(OP.i32_wrap_i64);
      this.i32(1).lget(this.L.ta2).op(OP.i32_shl);
      if (kind === 1) this.op(OP.i32_or);
      else if (kind === 2) this.i32(-1).op(OP.i32_xor).op(OP.i32_and);
      else this.op(OP.i32_xor);
      this.mem(OP.i32_store8, 0);
    }
    // old bit (i32 0/1)
    this.lget(this.L.ti3).op(OP.i32_wrap_i64).lget(this.L.ta2).op(OP.i32_shr_u).i32(1).op(OP.i32_and);
    if (target === null) { this.op(OP.i64_extend_i32_u).lset(this.L.rax); return; }
    if (neg) this.op(OP.i32_eqz);
    this.condJump(target);
  }

  incDec(t, inc, pre) {
    const rt = rawType(t.cls);
    const [a] = this.pops(1, t); this.conv(a, I);
    this.addr().lset(this.L.ta);
    const c = t.cls;
    if (rt === K.RT_F64) {
      this.lget(this.L.ta).lget(this.L.ta).load(rt); this.ltee(this.L.tf);
      this.f64(1).op(inc ? OP.f64_add : OP.f64_sub).ltee(this.L.tf2); this.store(rt);
      this.lget(pre ? this.L.tf2 : this.L.tf);
      return this.result(t, F);
    }
    let step = 1;
    if (c && c.ptr_stars_cnt) { const c1 = csub(c); if (c1 && c1.size !== 1) step = c1.size; }
    this.lget(this.L.ta).lget(this.L.ta).load(rt); this.ltee(this.L.ti);
    this.i64(step).op(inc ? OP.i64_add : OP.i64_sub); this.store(rt);
    if (pre) { this.lget(this.L.ta); this.load(rt); } else this.lget(this.L.ti);
    return this.result(t, I);
  }
  derefIncDec(t, inc) { // *p++: arg = &p
    const rt = rawType(t.cls);
    const [a] = this.pops(1, t); this.conv(a, I);
    this.addr().lset(this.L.ta);
    const step = t.cls ? t.cls.size : 1;
    this.lget(this.L.ta).mem(OP.i64_load, 3).ltee(this.L.ti);           // p
    this.lget(this.L.ta).lget(this.L.ti).i64(step).op(inc ? OP.i64_add : OP.i64_sub).mem(OP.i64_store, 3);
    this.addr();
    return this.result(t, this.load(rt));
  }
  assign(t) {
    const rt = rawType(t.cls);
    const ks = this.pops(2, t);
    const mk = this.memKind(rt);
    // stack: addr value
    if (ks[1] !== mk) this.conv(ks[1], mk);
    const vl = mk === F ? this.L.tf : this.L.ti;
    this.lset(vl);
    this.conv(ks[0], I);
    if (t.code === K.IC_ASSIGN) {
      this.addr(); this.lget(vl); this.store(rt);
      this.lget(vl);
      return this.result(t, mk);
    }
    // *p++=v: arg1 is &p
    this.ltee(this.L.ti2).addr().mem(OP.i64_load, 3).addr().lget(vl); this.store(rt);
    const c1 = t.t.class2 ? csub(t.t.class2) : null;
    const step = c1 ? c1.size : 1;
    this.lget(this.L.ti2).addr();
    this.lget(this.L.ti2).addr().mem(OP.i64_load, 3).i64(step).op(t.code === K.IC_ASSIGN_PP ? OP.i64_add : OP.i64_sub);
    this.mem(OP.i64_store, 3);
    this.lget(vl);
    return this.result(t, mk);
  }
  opEqu(t) {
    const code = t.code, rt = rawType(t.cls);
    const ks = this.pops(2, t);
    const mk = this.memKind(rt);
    const useF = rt === K.RT_F64 && code !== K.IC_AND_EQU && code !== K.IC_OR_EQU && code !== K.IC_XOR_EQU &&
      code !== K.IC_SHL_EQU && code !== K.IC_SHR_EQU;
    const vk = useF ? F : I;
    if (ks[1] !== vk) this.conv(ks[1], vk);
    const vl = vk === F ? this.L.tf2 : this.L.ti2;
    this.lset(vl);
    this.conv(ks[0], I);
    this.addr().lset(this.L.ta);
    this.lget(this.L.ta);
    this.lget(this.L.ta); let k = this.load(rt); if (k !== vk) this.conv(k, vk);
    this.lget(vl);
    if (useF) {
      switch (code) {
        case K.IC_ADD_EQU: this.op(OP.f64_add); break;
        case K.IC_SUB_EQU: this.op(OP.f64_sub); break;
        case K.IC_MUL_EQU: this.op(OP.f64_mul); break;
        case K.IC_DIV_EQU: this.op(OP.f64_div); break;
        case K.IC_MOD_EQU: this.fmod(); break;
      }
    } else {
      const uns = isUns(rt);
      switch (code) {
        case K.IC_ADD_EQU: this.op(OP.i64_add); break;
        case K.IC_SUB_EQU: this.op(OP.i64_sub); break;
        case K.IC_MUL_EQU: this.op(OP.i64_mul); break;
        case K.IC_DIV_EQU: this.call(uns ? this.be.h.$div_u : this.be.h.$div_s); break;
        case K.IC_MOD_EQU: this.call(uns ? this.be.h.$rem_u : this.be.h.$rem_s); break;
        case K.IC_AND_EQU: this.op(OP.i64_and); break;
        case K.IC_OR_EQU: this.op(OP.i64_or); break;
        case K.IC_XOR_EQU: this.op(OP.i64_xor); break;
        case K.IC_SHL_EQU: this.op(OP.i64_shl); break;
        case K.IC_SHR_EQU: this.op(uns || t.flags & K.ICF_USE_UNSIGNED ? OP.i64_shr_u : OP.i64_shr_s); break;
      }
    }
    if (vk !== mk) this.conv(vk, mk);
    this.store(rt);
    // result: the new value as stored
    this.lget(this.L.ta); k = this.load(rt);
    return this.result(t, k);
  }

  switchIC(t) {
    const ks = this.pops(2, t);
    this.args2(ks, I);
    const jt = t.data;
    this.lset(this.L.ti2); // range
    this.lset(this.L.ti);  // value-lo
    this.spillStack();
    const targets = jt.jmp_table.map((lb) => this.blockOf(lb));
    const dft = this.blockOf(jt.dft);
    // Backward targets (a case label threaded to a loop head) go through
    // trampoline blocks that set $state and branch to the dispatch loop.
    const back = [...new Set(targets.concat([dft]).filter((k) => k <= this.curBlock))];
    const extra0 = this.extra;
    for (let i = 0; i < back.length; i++) { this.op(OP.block).u8(T.void); this.extra++; }
    if (t.code === K.IC_SWITCH) {
      this.lget(this.L.ti).lget(this.L.ti2).op(OP.i64_ge_u);
      this.op(OP.if).u8(T.void); this.extra++;
      this.jump(dft);
      this.extra--; this.op(OP.end);
    }
    this.lget(this.L.ti).op(OP.i32_wrap_i64);
    this.op(OP.br_table).u32(targets.length);
    const d = (k) => (k <= this.curBlock ? back.indexOf(k) : k - this.curBlock - 1 + this.extra);
    for (const k of targets) this.b.u32(d(k));
    this.b.u32(d(dft));
    for (let i = 0; i < back.length; i++) {
      this.op(OP.end); this.extra--;
      this.jump(back[i]);
    }
    if (this.extra !== extra0) this.err('switch trampoline depth', t);
  }

  retIC(t) {
    // pop the top of the shadow stack: continuation id or return marker
    if (!this.hasRetDispatch) { this.retRax(); return; }
    this.pop64().lset(this.L.ti);
    this.lget(this.L.ti).i64(LABEL_LIMIT).op(OP.i64_lt_u);
    this.op(OP.if).u8(T.void); this.extra++;
    this.lget(this.L.ti).i64(CATCH_END).op(OP.i64_eq);
    this.op(OP.if).u8(T.void); this.be.hook(this.b, '_CATCH_END', this.be.g.catch_end); this.op(OP.unreachable).op(OP.end);
    this.lget(this.L.ti).op(OP.i32_wrap_i64).i32(1).op(OP.i32_sub).lset(this.L.state);
    this.op(OP.br).u32(this.blocks.length - 1 - this.curBlock + this.extra);
    this.extra--; this.op(OP.end);
    this.lget(this.L.rax).op(OP.return);
  }

  // STI/POPFD: IRQs that became deliverable are taken here (_Sti polls).
  irqCheck() {
    if (!this.be.builtinIndex('_STI')) return;
    this.gget(this.be.g.rflags).i64(0x200n).op(OP.i64_and).op(OP.i32_wrap_i64);
    this.op(OP.if).u8(T.void); this.be.hook(this.b, '_STI', null); this.op(OP.end);
  }

  // IC_ASM: the operand-less instructions HolyC uses inline.
  asmIC(t) {
    const g = this.be.g;
    const bytes = t.data.buf;
    for (let p = 0; p < bytes.length;) {
      const b0 = bytes[p];
      const IF = 0x200n;
      if (b0 === 0xFA) { this.gget(g.rflags).i64(~IF).op(OP.i64_and).gset(g.rflags); p++; }
      else if (b0 === 0xFB) { this.gget(g.rflags).i64(IF).op(OP.i64_or).gset(g.rflags); p++; this.irqCheck(); }
      else if (b0 === 0x9C) { this.gget(g.rflags).push(I); p++; }
      else if (b0 === 0x9D) { this.pop64().gset(g.rflags); p++; this.irqCheck(); }
      else if (b0 === 0xF3 && bytes[p + 1] === 0x90) { this.be.hook(this.b, '_PAUSE', g.pause); p += 2; }
      else if (b0 === 0xF4) { this.be.hook(this.b, '_HLT', g.hlt); p++; }
      else if (b0 === 0xCD) { this.i64(bytes[p + 1]).push(I); this.be.hook(this.b, '_INT', null); p += 2; } // INT n: _IntDeliver(n)
      else if (b0 === 0x90 || b0 === 0xFC || b0 === 0xFD || b0 === 0x9B || b0 === 0xCC) p++;
      else if (b0 === 0x0F && (bytes[p + 1] === 0x09 || bytes[p + 1] === 0x08)) p += 2;
      else if (b0 === 0x0F && bytes[p + 1] === 0xAE) p += 3;
      else if (b0 === 0xDB && bytes[p + 1] === 0xE3) p += 2;
      else if (b0 === 0x0F && bytes[p + 1] === 0xA2) { this.call(g.cpuid); p += 2; }
      else if (b0 === 0x0F && bytes[p + 1] === 0x31) { this.call(g.rdtsc).op(OP.drop); p += 2; }
      else if (b0 === 0x0F && bytes[p + 1] === 0x20 && bytes[p + 2] === 0xD0) { this.i64(0).lset(this.L.rax); p += 3; } // MOV_RAX_CR2: no page faults
      else this.err(`asm byte 0x${b0.toString(16)} not translatable`, t);
    }
  }

  // ---- calls.  Args are on the shadow stack already (PUSH_RES).
  callIC(t) {
    const be = this.be, g = be.g;
    switch (t.code) {
      case K.IC_CALL_INDIRECT:
        // CALL [RSP+disp]: the descriptor address was pushed by PUSH_REGS(RAX)
        this.gget(g.sp).mem(OP.i64_load, 3, Number(I64(t.data))).addr().mem(OP.i32_load, 2).lset(this.L.ta);
        this.marker(); this.push(I);
        this.lget(this.L.ta);
        this.b.u8(OP.call_indirect).u32(be.fnType).u32(0);
        break;
      case K.IC_CALL_INDIRECT2: // CALL [&tmpf->exe_addr] (JIT extern)
        be.indirect2Target(this, t.data); // pushes i32 table index into $ta
        this.marker(); this.push(I);
        this.lget(this.L.ta);
        this.b.u8(OP.call_indirect).u32(be.fnType).u32(0);
        break;
      case K.IC_CALL_IMPORT: {
        be.importSlot(this, t.data, 'fun'); // address of an 8 byte slot holding the descriptor address
        this.addr(); this.mem(OP.i64_load, 3); this.addr(); this.mem(OP.i32_load, 2); this.lset(this.L.ta);
        this.marker(); this.push(I);
        this.lget(this.L.ta);
        this.b.u8(OP.call_indirect).u32(be.fnType).u32(0);
        break;
      }
      default: { // IC_CALL / IC_CALL_EXTERN: direct when we can
        this.marker(); this.push(I);
        be.directCall(this, t);
      }
    }
    this.lset(this.L.rax);
  }
}

function fwd(lb) { while (lb && lb.fwd) lb = lb.fwd; return lb; }
function compressLocals(types) {
  const out = [];
  for (const t of types) {
    if (out.length && out[out.length - 1][1] === t) out[out.length - 1][0]++;
    else out.push([1, t]);
  }
  return out;
}

// ------------------------------------------------------------- AOT backend
// Used by the bootstrap: one wasm module per CmpJoin (Kernel, Compiler).
export class AOTBackend {
  constructor(opts = {}) { this.opts = opts; this.log = opts.log || (() => {}); this.traceNames = []; }
  traceId(fun) { this.traceNames.push(fun ? fun.str : '<stmt>'); return this.traceNames.length - 1; }
  beginModule(cc, aotc) {
    const mb = this.mb = new ModuleBuilder();
    // JS-implemented builtins are imports, so declare them first
    this.builtins = (this.opts.builtins || []).map((b, i) => ({ ...b, i }));
    this.jsImports = new Map();
    for (const b of this.builtins) if (b.kind === 'js')
      this.jsImports.set(b.name, mb.importFunc('js', b.name, new Array(b.nargs).fill(T.i64), [T.i64]));
    this.g = moduleImports(mb, this.opts);
    this.fnType = mb.type([], [T.i64]);
    this.h = addHelpers(mb, this.g, this);
    this.byFun = new Map();  // CHashFun -> {idx, f}
    this.byRip = new Map();  // rip of descriptor -> {idx, f}
    this.tableFuncs = [];    // wasm func idx in table order
    this.aotc = aotc;
    this.pendingBlobs = 0;
    this.aliasSlots = new Map(); // HolyC function name -> slot (builtin aliases)
    for (const b of this.builtins) {
      if (b.kind === 'js') b.slot = this.jsWrapper(b);
      else if (b.kind === 'wasm') b.slot = this.wasmBuiltin(b);
    }
  }
  // Called once the module's glbl hash table exists: the builtin symbols.
  predefine(cc) {
    for (const b of this.builtins) {
      const ex = new CHashExport(b.name, K.HTT_EXPORT_SYS_SYM | K.HTF_IMM | K.HTF_EXPORT);
      ex.val = BigInt(BUILTIN_BASE + 8 * b.i);
      cc.htc.glbl_hash_table.add(ex);
    }
  }
  builtinIndex(name) { const b = this.builtins.find((x) => x.name === name); return b ? b.i + 1 : 0; }
  builtinAddr(name) {
    const k = this.builtinIndex(name);
    if (!k) throw new Error('no builtin ' + name);
    return BUILTIN_BASE + 8 * (k - 1);
  }
  get CATCH_END() { return CATCH_END; }
  // Call a builtin through its descriptor (works in every module once the
  // kernel's __init ran), else the fallback import.  The result is dropped.
  hook(by, name, fallback) {
    if (!this.builtinIndex(name)) {
      if (fallback === null || fallback === undefined) throw new Error('no hook ' + name);
      by.u8(OP.call).u32(fallback);
      return;
    }
    const a = this.builtinAddr(name), sp = this.g.sp;
    by.u8(OP.global_get).u32(sp).u8(OP.i32_const).s32(8).u8(OP.i32_sub).u8(OP.global_set).u32(sp);
    by.u8(OP.global_get).u32(sp).u8(OP.i64_const).s64(BigInt(a)).u8(OP.i64_store).u32(3).u32(0);
    by.u8(OP.i32_const).s32(a).u8(OP.i32_load).u32(2).u32(0);
    by.u8(OP.call_indirect).u32(this.fnType).u32(0).u8(OP.drop);
  }
  builtinAt(addr) {
    const a = Number(addr) - BUILTIN_BASE;
    if (a < 0 || a >= 8 * BUILTIN_MAX || a & 7) return null;
    return this.builtins[a >> 3] || null;
  }
  builtinSlot(b) {
    if (b.slot) return b.slot;
    // alias of a HolyC function compiled in this module
    let s = this.aliasSlots.get(b.target);
    if (!s) { s = this.mb.reserveFunc([], [T.i64], b.target); this.aliasSlots.set(b.target, s); }
    return s;
  }
  // wrapper with the standard ABI around a JS import: args at sp+8.., marker at sp
  jsWrapper(b) {
    const r = this.mb.reserveFunc([], [T.i64], b.name);
    const by = new Bytes();
    const sp = this.g.sp;
    for (let i = 0; i < b.nargs; i++) by.u8(OP.global_get).u32(sp).u8(OP.i64_load).u32(3).u32(8 + 8 * i);
    by.u8(OP.call).u32(this.jsImports.get(b.name));
    by.u8(OP.global_get).u32(sp).u8(OP.i32_const).s32(8 + (b.ret1 ? 8 * b.nargs : 0)).u8(OP.i32_add).u8(OP.global_set).u32(sp);
    r.f.body = by.toU8(); r.f.locals = [];
    return r;
  }
  wasmBuiltin(b) {
    const r = this.mb.reserveFunc([], [T.i64], b.name);
    const by = new Bytes();
    b.gen(by, this.g, this.h, this);
    r.f.body = by.toU8(); r.f.locals = b.locals || [];
    return r;
  }
  // a function slot for a CHashFun (reserved on first reference)
  slotFor(fun) {
    let s = this.byFun.get(fun);
    if (!s) {
      s = (fun.str && this.aliasSlots.get(fun.str)) || this.mb.reserveFunc([], [T.i64], fun.str);
      this.byFun.set(fun, s);
      if (fun.str && this.builtins.some((b) => b.kind === 'alias' && b.target === fun.str)) this.aliasSlots.set(fun.str, s);
    }
    return s;
  }
  compile(cc, prog) {
    const fun = cc.htc.fun;
    const blob = { bytes: null, fun, strOffs: new Map(), imports: [], heapRefs: [], rip: cc.aotc.rip };
    // blob layout: [descriptor 8][string consts][import slots]
    let off = 8;
    for (const m of cc.coc.misc) if (m.type === K.CMT_STR_CONST) { blob.strOffs.set(m, off); off += m.st_len; }
    blob.strEnd = off;
    this.curBlob = blob;
    this.curSlotOff = (off + 7) & ~7;
    const slot = fun && prog.ics.length && prog.ics[0].code === K.IC_ENTER ? this.slotFor(fun) : this.mb.reserveFunc([], [T.i64], fun ? fun.str : null);
    blob.slot = slot;
    const u = new Unit(this, cc, prog, this.opts);
    let res;
    try { res = u.compile(); } catch (e) {
      if (e instanceof BackendError) e.message += '\n' + debugListing(prog);
      throw e;
    }
    slot.f.body = res.body;
    slot.f.locals = res.locals;
    const bytes = new Uint8Array(this.curSlotOff);
    for (const [m, o] of blob.strOffs) for (let i = 0; i < m.st_len; i++) bytes[o + i] = m.str.charCodeAt(i) & 255;
    blob.bytes = bytes;
    return blob;
  }
  blobStored(cc, blob, rip) {
    // binds the function to this rip; descriptor = table slot index (loader adds table_base)
    if (rip !== blob.rip) throw new Error(`blob stored at ${rip} but compiled for ${blob.rip}`);
    const k = this.tableFuncs.length;
    this.tableFuncs.push(blob.slot.idx);
    new DataView(blob.bytes.buffer).setUint32(0, k, true);
    new DataView(blob.bytes.buffer).setUint32(4, 0x4D534157, true); // 'WASM'
    this.byRip.set(rip, blob.slot);
    for (const im of blob.imports) {
      const ie = { type: K.IET_IMM_I64, rip: rip + im.off, str: null, flags: 0 };
      if (!im.h.ie_lst) im.h.ie_lst = [];
      im.h.ie_lst.push(ie);
    }
    for (const hr of blob.heapRefs) hr.hg.references.push(rip + hr.off);
  }
  endModule(cc, aotc, aot) {
    // unstored compile units (compile-time evaluation) get stub bodies
    for (const f of this.mb.funcs) if (!f.body) { f.body = Uint8Array.of(OP.unreachable); f.locals = []; }
    for (const [fun, s] of this.byFun) if (fun.flags & (1 << K.Cf_EXTERN) && !this.boundRip(s))
      throw new Error(`Undefined function ${fun.str}`);
    // builtins get table slots too; __init() writes their descriptors and
    // turns every descriptor's module-relative slot into a table index.
    const builtinK = [], missing = [];
    for (const b of this.builtins) {
      if (b.kind === 'alias' && !this.aliasSlots.has(b.target)) {
        if (this.opts.requireAliases) missing.push(`${b.name} -> ${b.target}`);
        continue;
      }
      const s = this.builtinSlot(b);
      if (!s.f.body) throw new Error(`builtin alias ${b.name} -> ${b.target}: function not defined`);
      builtinK.push([b, this.tableFuncs.length]);
      this.tableFuncs.push(s.idx);
    }
    if (missing.length) throw new Error('builtin aliases without a HolyC function: ' + missing.join(', '));
    {
      const init = this.mb.reserveFunc([], [], '__init');
      const by = new Bytes(), g = this.g;
      for (const rip of this.byRip.keys()) {
        // [base+rip] += table_base
        by.u8(OP.global_get).u32(g.base).u8(OP.i32_wrap_i64);
        by.u8(OP.global_get).u32(g.base).u8(OP.i32_wrap_i64).u8(OP.i32_load).u32(2).u32(rip);
        by.u8(OP.global_get).u32(g.table_base).u8(OP.i32_add);
        by.u8(OP.i32_store).u32(2).u32(rip);
      }
      for (const [b, k] of builtinK) {
        const a = BUILTIN_BASE + 8 * b.i;
        by.u8(OP.i32_const).s32(a).u8(OP.global_get).u32(g.table_base).u8(OP.i32_const).s32(k).u8(OP.i32_add).u8(OP.i32_store).u32(2).u32(0);
        by.u8(OP.i32_const).s32(a).u8(OP.i32_const).s32(0x544C4257).u8(OP.i32_store).u32(2).u32(4); // 'WBLT'
      }
      init.f.body = by.toU8(); init.f.locals = [];
      this.mb.export('__init', 0, init.idx);
    }
    this.mb.elems.push({ offset: new Bytes().u8(OP.global_get).u32(this.g.table_base), funcs: this.tableFuncs });
    this.mb.export('ntable', 3, this.mb.addGlobal(T.i32, false, new Bytes().u8(OP.i32_const).s32(this.tableFuncs.length)));
    this.ntable = this.tableFuncs.length;
    return this.mb.encode();
  }
  boundRip(s) { for (const v of this.byRip.values()) if (v === s) return true; return false; }

  // ---- address helpers used by Unit
  markerExpr(u) { this.absAddrOfBlob(u, 0); }
  absAddrOfBlob(u, off) { u.absAddr(this.curBlob.rip + off); }
  selfAddr(u) { this.absAddrOfBlob(u, 0); }
  strConstAddr(u, m) {
    const o = this.curBlob.strOffs.get(m);
    if (o === undefined) u.err('string constant not in this unit');
    this.absAddrOfBlob(u, o);
  }
  importSlot(u, h, kind) {
    let im = this.curBlob.imports.find((x) => x.h === h);
    if (!im) { im = { h, off: this.curSlotOff, kind }; this.curSlotOff += 8; this.curBlob.imports.push(im); }
    this.absAddrOfBlob(u, im.off);
  }
  heapGlblSlot(u, hg) {
    let r = this.curBlob.heapRefs.find((x) => x.hg === hg);
    if (!r) { r = { hg, off: this.curSlotOff }; this.curSlotOff += 8; this.curBlob.heapRefs.push(r); }
    this.absAddrOfBlob(u, r.off);
  }
  immObject(u, t, d) { u.err('IMM of an object in AOT code'); }
  indirect2Target(u) { u.err('CALL_INDIRECT2 in AOT code'); }
  directCall(u, t) {
    let s;
    if (t.code === K.IC_CALL_EXTERN) s = this.slotFor(t.data);
    else {
      const rip = Number(I64(t.data));
      const bi = this.builtinAt(rip);
      if (bi) { u.call(this.builtinSlot(bi).idx); return; }
      s = this.byRip.get(rip);
      if (!s) {
        // an _extern'ed asm label: rip of something that is not a compiled unit
        if (!this.opts.lenient) u.err(`IC_CALL to unknown code at rip ${rip}`, t);
        u.op(OP.unreachable);
        return;
      }
    }
    u.call(s.idx);
  }
}

function debugListing(prog) {
  return prog.ics.map((t) => ICNAME(t.code)).join(' ');
}
