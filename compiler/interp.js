// Bootstrap-time IC interpreter.  When TempleOS compiles something in JIT
// mode at compile time (constant expressions via LexExpression, #exe{}
// blocks, default arg values, JIT-compiled headers of the host environment),
// it COCCompiles to machine code and Call()s it.  The bootstrap instead keeps
// the post-OptPass012 IC list and runs it here, against a small "host"
// memory.  This is only used while building; the shipped system runs the
// real compiler in wasm.
import * as K from './consts.js';
import { intermediate_code_table } from './opt.js';
import { OptClassFwd, CHashFun } from './core.js';
import { I64, U64, f2b, b2f, f2i, bsf, bsr } from './util.js';
import { FieldRef, BufPtr } from './parse.js';

export const HOST_BASE = 0x01000000;
const LABEL_TAG = 0x7E000000; // label "addresses" handed to SUB_CALL/RET

export class HostVM {
  constructor(size = 1 << 22) {
    this.size = size;
    this.mem = new Uint8Array(size);
    this.dv = new DataView(this.mem.buffer);
    this.brk = 16;
    this.sp = size - 16; // machine stack grows down from the top
    this.builtins = new Map();
    this.task = 0;
  }
  off(addr) {
    const a = Number(BigInt.asUintN(64, BigInt(addr))) - HOST_BASE;
    if (!(a >= 0 && a < this.size)) throw new Error('host mem access ' + addr.toString(16));
    return a;
  }
  alloc(n) {
    const a = (this.brk + 7) & ~7;
    this.brk = a + Math.max(n, 1);
    if (this.brk > this.sp - 65536) throw new Error('host heap full');
    return BigInt(HOST_BASE + a);
  }
  str(s) {
    const a = this.alloc(s.length + 1);
    const o = this.off(a);
    for (let i = 0; i < s.length; i++) this.mem[o + i] = s.charCodeAt(i) & 255;
    this.mem[o + s.length] = 0;
    return a;
  }
  readStr(addr) {
    if (!addr) return '';
    let o = this.off(addr), s = '';
    while (this.mem[o]) s += String.fromCharCode(this.mem[o++]);
    return s;
  }
  load(addr, rt) {
    const o = this.off(addr), dv = this.dv;
    switch (rt) {
      case K.RT_I8: return BigInt(dv.getInt8(o));
      case K.RT_U8: return BigInt(dv.getUint8(o));
      case K.RT_I16: return BigInt(dv.getInt16(o, true));
      case K.RT_U16: return BigInt(dv.getUint16(o, true));
      case K.RT_I32: return BigInt(dv.getInt32(o, true));
      case K.RT_U32: return BigInt(dv.getUint32(o, true));
      case K.RT_I0: case K.RT_U0: return 0n;
      default: return dv.getBigInt64(o, true);
    }
  }
  store(addr, rt, v) {
    const o = this.off(addr), dv = this.dv;
    v = BigInt(v);
    switch (rt) {
      case K.RT_I8: case K.RT_U8: dv.setUint8(o, Number(BigInt.asUintN(8, v))); break;
      case K.RT_I16: case K.RT_U16: dv.setUint16(o, Number(BigInt.asUintN(16, v)), true); break;
      case K.RT_I32: case K.RT_U32: dv.setUint32(o, Number(BigInt.asUintN(32, v)), true); break;
      case K.RT_I0: case K.RT_U0: break;
      default: dv.setBigInt64(o, BigInt.asIntN(64, v), true);
    }
  }
  push(v) { this.sp -= 8; this.dv.setBigInt64(this.sp, BigInt.asIntN(64, BigInt(v)), true); }
  arg(i, frameSp) { return this.dv.getBigInt64(frameSp + 16 + 8 * i, true); }
}

const rawType = (c) => (c ? OptClassFwd(c).raw_type : 0);
const isF = (rt) => rt === K.RT_F64;
const isU = (rt) => (rt & K.RTF_UNSIGNED) !== 0 && rt !== K.RT_F64;

// A compiled JIT unit: the IC list snapshot plus labels.
export class ICProgram {
  constructor(cc) {
    this.ics = [];
    for (let t = cc.coc.head.next; t !== cc.coc.head; t = t.next) this.ics.push(t);
    this.labels = new Map();
    this.ics.forEach((t, i) => { if (t.code === K.IC_LABEL) this.labels.set(t.data, i); });
    this.fun = cc.htc.fun;
    this.strs = new Map();
    this.name = cc.htc.fun ? cc.htc.fun.str : '(stmt)';
  }
  labelIdx(lb) {
    while (lb.fwd) lb = lb.fwd;
    const i = this.labels.get(lb);
    if (i === undefined) throw new Error('interp: unknown label');
    return i;
  }
}

// Calls the code at exe_addr (an ICProgram, a host builtin or a FieldRef'd
// function) with the args already pushed on the machine stack.
export function interpCall(vm, target, ctx, fun = null) {
  if (target instanceof FieldRef) { fun = target.obj; target = target.get(); }
  if (target instanceof ICProgram) return interpRun(vm, target, ctx);
  if (target && target.hostFn) {
    vm.push(0); // return address slot
    const frame = vm.sp - 8; // pretend fp so args are at frame+16
    try { return BigInt(target.hostFn(vm, frame, ctx)); } finally {
      vm.sp += 8;
      // RET1 functions pop their own args (see IC_ADD_RSP1)
      if (fun && fun.arg_cnt && (fun.flags & (1 << K.Ff_RET1) || fun.flags & (1 << K.Ff_ARGPOP)) && !(fun.flags & (1 << K.Ff_NOARGPOP)))
        vm.sp += fun.arg_cnt << 3;
    }
  }
  throw new Error('interp: call to unresolved code ' + (target && target.str ? target.str : String(target)));
}

// ic_data of an IC_IMM_I64 can be a host pointer (BufPtr into host memory,
// for JIT-mode globals) or &field (FieldRef, only ever DEREF'd).
function immVal(d) {
  if (typeof d === 'bigint') return I64(d);
  if (d instanceof BufPtr && d.hostAddr !== undefined) return d.hostAddr + BigInt(0);
  if (d instanceof FieldRef) return d;
  if (d === null || d === undefined) return 0n;
  if (typeof d === 'number') return BigInt(d);
  if (typeof d === 'object' && d.hostFn) return d;
  throw new Error('interp: IMM of ' + (d && d.constructor ? d.constructor.name : typeof d));
}

export function interpRun(vm, prog, ctx) {
  try { return interpRun1(vm, prog, ctx); } catch (e) {
    if (!e.dumped) { e.dumped = true; e.message += `
--- in ${prog.name}:
` + icListing(prog.ics); }
    throw e;
  }
}
function interpRun1(vm, prog, ctx) {
  const ics = prog.ics;
  const vs = []; // parse-stack values (BigInt); undefined = phantom (pushed to the machine stack)
  let rax = 0n, pc = 0, fp = 0, pushCmp = 0n;
  vm.push(0); // return address
  const entrySp = vm.sp;
  const conv = (t, v) => {
    if (t.flags & K.ICF_RES_TO_F64) return f2b(Number(I64(v)));
    if (t.flags & K.ICF_RES_TO_INT) return f2i(b2f(v));
    return v;
  };
  const produce = (t, v) => {
    v = conv(t, v);
    if (t.flags & K.ICF_PUSH_RES) { vm.push(v); vs.push(undefined); }
    else vs.push(v);
  };
  const pop = () => vs.pop();
  const ARG2 = () => { const b = pop(), a = pop(); return [a, b]; };
  for (;;) {
    const t = ics[pc++];
    if (!t) { // fell off the end (no RET)
      vm.sp = entrySp + 8;
      return rax;
    }
    const rt = rawType(t.cls);
    const code = t.code;
    const binop = (fn, ffn) => {
      const [a, b] = ARG2();
      if (isF(rt)) produce(t, f2b(ffn(b2f(a), b2f(b))));
      else produce(t, I64(fn(I64(a), I64(b), isU(rawType(t.cls2)))));
    };
    // Comparisons: == and != always compare raw bits (as the x86 backend
    // does); ordering compares honour ICF_USE_F64/ICF_USE_UNSIGNED.
    // ICF_PUSH_CMP also makes the right operand available to IC_PUSH_CMP.
    const cmp = (fn, raw) => {
      const [a, b] = ARG2();
      let r;
      if (raw) r = fn(I64(a), I64(b));
      else if (t.flags & K.ICF_USE_F64) r = fn(b2f(a), b2f(b));
      else if (t.flags & K.ICF_USE_UNSIGNED) r = fn(U64(a), U64(b));
      else r = fn(I64(a), I64(b));
      if (t.flags & K.ICF_PUSH_CMP) pushCmp = b;
      produce(t, r ? 1n : 0n);
    };
    switch (code) {
      case K.IC_ADD_RSP1: for (let i = Number(t.data) >> 3; i--;) vs.pop(); break;
      case K.IC_NOP1: case K.IC_END: case K.IC_LABEL: case K.IC_CALL_START:
      case K.IC_CALL_END2: case K.IC_PUSH_REGS:
        if (code === K.IC_PUSH_REGS) vm.push(rax);
        break;
      case K.IC_NOP2: for (let i = 0; i < Number(t.data); i++) vs.push(undefined); break;
      case K.IC_IMM_I64: case K.IC_IMM_F64: produce(t, immVal(t.data)); break;
      case K.IC_ABS_ADDR: produce(t, I64(t.data)); break; // unrelocated AOT address
      case K.IC_STR_CONST: {
        let a = prog.strs.get(t);
        if (a === undefined) { a = vm.str(t.data.str.replace(/\0$/, '')); prog.strs.set(t, a); }
        produce(t, a);
        break;
      }
      case K.IC_RBP: produce(t, BigInt(HOST_BASE + fp)); break;
      case K.IC_FS: case K.IC_MOV_FS:
        if (!vm.task) vm.task = vm.alloc(4096);
        if (code === K.IC_FS) rax = vm.task; else produce(t, vm.load(vm.task + t.data, rt));
        break;
      case K.IC_HOLYC_TYPECAST: produce(t, pop()); break;
      case K.IC_ADDR: produce(t, pop()); break;
      case K.IC_DEREF: {
        const p = pop();
        produce(t, p instanceof FieldRef ? immVal(p.get()) : vm.load(p, rt));
        break;
      }
      case K.IC_COM: produce(t, I64(~I64(pop()))); break;
      case K.IC_NOT: { const a = pop(); produce(t, (isF(rt) ? !b2f(a) : !I64(a)) ? 1n : 0n); break; }
      case K.IC_UNARY_MINUS: { const a = pop(); produce(t, isF(rt) ? f2b(-b2f(a)) : I64(-I64(a))); break; }
      case K.IC_ADD: binop((a, b) => a + b, (a, b) => a + b); break;
      case K.IC_SUB: binop((a, b) => a - b, (a, b) => a - b); break;
      case K.IC_MUL: binop((a, b) => a * b, (a, b) => a * b); break;
      case K.IC_DIV: binop((a, b, u) => (u ? U64(a) / U64(b) : a / b), (a, b) => a / b); break;
      case K.IC_MOD: binop((a, b, u) => (u ? U64(a) % U64(b) : a % b), (a, b) => a % b); break;
      case K.IC_AND: { const [a, b] = ARG2(); produce(t, I64(a & b)); break; }
      case K.IC_OR: { const [a, b] = ARG2(); produce(t, I64(a | b)); break; }
      case K.IC_XOR: { const [a, b] = ARG2(); produce(t, I64(a ^ b)); break; }
      case K.IC_SHL: { const [a, b] = ARG2(); produce(t, I64(I64(a) << (U64(b) & 63n))); break; }
      case K.IC_SHR: { const [a, b] = ARG2(); produce(t, isU(rt) ? I64(U64(a) >> (U64(b) & 63n)) : I64(I64(a) >> (U64(b) & 63n))); break; }
      case K.IC_SHL_CONST: produce(t, I64(I64(pop()) << (U64(t.data) & 63n))); break;
      case K.IC_SHR_CONST: { const a = pop(); produce(t, isU(rt) ? I64(U64(a) >> (U64(t.data) & 63n)) : I64(I64(a) >> (U64(t.data) & 63n))); break; }
      case K.IC_POWER: { const [a, b] = ARG2(); produce(t, f2b(Math.pow(b2f(a), b2f(b)))); break; }
      case K.IC_EQU_EQU: cmp((a, b) => a === b, true); break;
      case K.IC_NOT_EQU: cmp((a, b) => a !== b, true); break;
      case K.IC_LESS: cmp((a, b) => a < b); break;
      case K.IC_GREATER_EQU: cmp((a, b) => a >= b); break;
      case K.IC_GREATER: cmp((a, b) => a > b); break;
      case K.IC_LESS_EQU: cmp((a, b) => a <= b); break;
      case K.IC_PUSH_CMP: produce(t, pushCmp); break;
      case K.IC_AND_AND: { const [a, b] = ARG2(); produce(t, I64(a) && I64(b) ? 1n : 0n); break; }
      case K.IC_OR_OR: { const [a, b] = ARG2(); produce(t, I64(a) || I64(b) ? 1n : 0n); break; }
      case K.IC_XOR_XOR: { const [a, b] = ARG2(); produce(t, (!!I64(a)) !== (!!I64(b)) ? 1n : 0n); break; }
      case K.IC_ASSIGN: { const [p, v] = ARG2(); vm.store(p, rt, v); produce(t, v); break; }
      case K.IC_ADD_EQU: case K.IC_SUB_EQU: case K.IC_MUL_EQU: case K.IC_DIV_EQU: case K.IC_MOD_EQU:
      case K.IC_AND_EQU: case K.IC_OR_EQU: case K.IC_XOR_EQU: case K.IC_SHL_EQU: case K.IC_SHR_EQU: {
        const [p, b] = ARG2();
        const a = vm.load(p, rt);
        let r;
        if (isF(rt)) {
          const x = b2f(a), y = b2f(b);
          r = f2b(code === K.IC_ADD_EQU ? x + y : code === K.IC_SUB_EQU ? x - y : code === K.IC_MUL_EQU ? x * y :
            code === K.IC_DIV_EQU ? x / y : x % y);
        } else {
          const x = I64(a), y = I64(b), u = isU(rt);
          switch (code) {
            case K.IC_ADD_EQU: r = x + y; break;
            case K.IC_SUB_EQU: r = x - y; break;
            case K.IC_MUL_EQU: r = x * y; break;
            case K.IC_DIV_EQU: r = u ? U64(x) / U64(y) : x / y; break;
            case K.IC_MOD_EQU: r = u ? U64(x) % U64(y) : x % y; break;
            case K.IC_AND_EQU: r = x & y; break;
            case K.IC_OR_EQU: r = x | y; break;
            case K.IC_XOR_EQU: r = x ^ y; break;
            case K.IC_SHL_EQU: r = x << (U64(y) & 63n); break;
            case K.IC_SHR_EQU: r = u ? U64(x) >> (U64(y) & 63n) : x >> (U64(y) & 63n); break;
          }
          r = I64(r);
        }
        vm.store(p, rt, r);
        produce(t, vm.load(p, rt));
        break;
      }
      case K.IC__PP: case K.IC__MM: case K.IC_PP_: case K.IC_MM_: case K.IC_DEREF_PP: case K.IC_DEREF_MM: {
        const p = pop();
        const old = vm.load(p, rt);
        const c = OptClassFwd(t.cls);
        const step = BigInt(c && c.ptr_stars_cnt ? Math.max(1, OptClassFwd(c.lvl[c.ptr_stars_cnt - 1]).size) : 1);
        const inc = code === K.IC__PP || code === K.IC_PP_ || code === K.IC_DEREF_PP;
        const nv = isF(rt) ? f2b(b2f(old) + (inc ? 1 : -1)) : I64(inc ? I64(old) + step : I64(old) - step);
        vm.store(p, rt, nv);
        produce(t, code === K.IC_PP_ || code === K.IC_MM_ ? vm.load(p, rt) : old);
        break;
      }
      case K.IC_END_EXP: rax = pop() ?? rax; break;
      case K.IC_RETURN_VAL: case K.IC_SET_RAX: rax = pop(); break;
      case K.IC_RETURN_VAL2: case K.IC_GET_RAX: if (code === K.IC_GET_RAX) produce(t, rax); break;
      case K.IC_ENTER:
        vm.push(BigInt(HOST_BASE + fp));
        fp = vm.sp;
        vm.sp -= Number(-I64(t.data));
        break;
      case K.IC_LEAVE: {
        vm.sp = fp;
        fp = Number(vm.dv.getBigInt64(vm.sp, true)) - HOST_BASE; vm.sp += 8;
        vm.sp += 8; // return address
        const f = prog.fun;
        if (f && f.arg_cnt && (f.flags & (1 << K.Ff_RET1) || f.flags & (1 << K.Ff_ARGPOP)) && !(f.flags & (1 << K.Ff_NOARGPOP)))
          vm.sp += f.arg_cnt << 3;
        return rax;
      }
      case K.IC_RET: {
        const v = vm.dv.getBigInt64(vm.sp, true); vm.sp += 8;
        if (v >= BigInt(LABEL_TAG) && v < BigInt(LABEL_TAG + ics.length + 1)) { pc = Number(v) - LABEL_TAG; break; }
        return rax;
      }
      case K.IC_SUB_CALL: vm.push(BigInt(LABEL_TAG + pc)); pc = prog.labelIdx(t.data); break;
      case K.IC_JMP: pc = prog.labelIdx(t.data); break;
      case K.IC_BR_ZERO: if (!I64(pop())) pc = prog.labelIdx(t.data); break;
      case K.IC_BR_NOT_ZERO: if (I64(pop())) pc = prog.labelIdx(t.data); break;
      case K.IC_BR_EQU_EQU: case K.IC_BR_NOT_EQU: case K.IC_BR_LESS: case K.IC_BR_GREATER_EQU:
      case K.IC_BR_GREATER: case K.IC_BR_LESS_EQU:
      case K.IC_BR_EQU_EQU2: case K.IC_BR_NOT_EQU2: case K.IC_BR_LESS2: case K.IC_BR_GREATER_EQU2:
      case K.IC_BR_GREATER2: case K.IC_BR_LESS_EQU2: {
        const two = code >= K.IC_BR_EQU_EQU2;
        const [a, b] = ARG2();
        const k = (code - (two ? K.IC_BR_EQU_EQU2 : K.IC_BR_EQU_EQU));
        let x = a, y = b;
        let r;
        if (k < 2) { x = I64(a); y = I64(b); }
        else if (t.flags & K.ICF_USE_F64) { x = b2f(a); y = b2f(b); }
        else if (t.flags & K.ICF_USE_UNSIGNED) { x = U64(a); y = U64(b); }
        else { x = I64(a); y = I64(b); }
        switch (k) {
          case 0: r = x === y; break; case 1: r = x !== y; break; case 2: r = x < y; break;
          case 3: r = x >= y; break; case 4: r = x > y; break; case 5: r = x <= y; break;
        }
        if (r) pc = prog.labelIdx(t.data);
        else if (two) vs.push(b);
        break;
      }
      case K.IC_BR_AND_ZERO: { const [a, b] = ARG2(); if (!(I64(a) & I64(b))) pc = prog.labelIdx(t.data); break; }
      case K.IC_BR_AND_NOT_ZERO: { const [a, b] = ARG2(); if (I64(a) & I64(b)) pc = prog.labelIdx(t.data); break; }
      case K.IC_BR_MM_ZERO: case K.IC_BR_MM_NOT_ZERO: {
        const p = pop(); const nv = I64(vm.load(p, rt) - 1n); vm.store(p, rt, nv);
        const z = vm.load(p, rt) === 0n;
        if (z === (code === K.IC_BR_MM_ZERO)) pc = prog.labelIdx(t.data);
        break;
      }
      case K.IC_BR_BT: case K.IC_BR_BTS: case K.IC_BR_BTR: case K.IC_BR_BTC:
      case K.IC_BR_NOT_BT: case K.IC_BR_NOT_BTS: case K.IC_BR_NOT_BTR: case K.IC_BR_NOT_BTC: {
        const [p, b] = ARG2();
        const bit = Number(U64(b) & 63n);
        const byVal = !!(t.flags & K.ICF_BY_VAL);
        let old;
        if (byVal) old = (I64(p) >> BigInt(bit)) & 1n;
        else {
          const word = vm.load(p + (BigInt(bit) >> 6n << 3n), K.RT_I64);
          old = (word >> BigInt(bit & 63)) & 1n;
          const kind = (code - K.IC_BR_BT) & 3;
          if (kind) {
            const m = 1n << BigInt(bit & 63);
            vm.store(p, K.RT_I64, kind === 1 ? word | m : kind === 2 ? word & ~m : word ^ m);
          }
        }
        const neg = code >= K.IC_BR_NOT_BT;
        if (!!old !== neg) pc = prog.labelIdx(t.data);
        break;
      }
      case K.IC_SWITCH: case K.IC_NOBOUND_SWITCH: {
        const [v, range] = ARG2();
        const jt = t.data;
        let lb;
        if (code === K.IC_SWITCH && !(U64(v) < U64(range))) lb = jt.dft;
        else lb = jt.jmp_table[Number(U64(v))];
        pc = prog.labelIdx(lb);
        break;
      }
      case K.IC_CALL: case K.IC_CALL_INDIRECT2: case K.IC_CALL_EXTERN: case K.IC_CALL_IMPORT: {
        let target = t.data, fun = null;
        if (target instanceof FieldRef) { fun = target.obj; target = target.get(); }
        else if (target instanceof CHashFun) { fun = target; target = target.exe_addr; }
        rax = interpCall(vm, target, ctx, fun);
        break;
      }
      case K.IC_CALL_INDIRECT: {
        const fnp = vm.dv.getBigInt64(vm.sp + Number(t.data), true);
        rax = interpCall(vm, ctx.codeAt(fnp), ctx);
        break;
      }
      case K.IC_ADD_RSP: {
        vm.sp += Number(t.data);
        for (let i = Number(t.data) >> 3; i--;) vs.pop();
        break;
      }
      case K.IC_CALL_END: produce(t, rax); break;
      case K.IC_BT: case K.IC_BTS: case K.IC_BTR: case K.IC_BTC: case K.IC_LBTS: case K.IC_LBTR: case K.IC_LBTC: {
        const [p, b] = ARG2();
        const bit = U64(b);
        const addr = I64(p) + ((bit >> 6n) << 3n);
        const word = vm.load(addr, K.RT_I64);
        const m = 1n << (bit & 63n);
        rax = (word & m) ? 1n : 0n;
        if (code === K.IC_BTS || code === K.IC_LBTS) vm.store(addr, K.RT_I64, word | m);
        else if (code === K.IC_BTR || code === K.IC_LBTR) vm.store(addr, K.RT_I64, word & ~m);
        else if (code === K.IC_BTC || code === K.IC_LBTC) vm.store(addr, K.RT_I64, word ^ m);
        break;
      }
      case K.IC_STRLEN: rax = BigInt(vm.readStr(pop()).length); break;
      case K.IC_TO_I64: rax = f2i(b2f(pop())); break;
      case K.IC_TO_F64: rax = f2b(Number(I64(pop()))); break;
      case K.IC_TO_BOOL: rax = I64(pop()) ? 1n : 0n; break;
      case K.IC_TOUPPER: { const c = Number(U64(pop()) & 255n); rax = BigInt(c >= 97 && c <= 122 ? c - 32 : c); break; }
      case K.IC_ABS_I64: { const a = I64(pop()); rax = a < 0n ? I64(-a) : a; break; }
      case K.IC_SIGN_I64: { const a = I64(pop()); rax = a > 0n ? 1n : a < 0n ? -1n : 0n; break; }
      case K.IC_MIN_I64: { const [a, b] = ARG2(); rax = I64(a) < I64(b) ? I64(a) : I64(b); break; }
      case K.IC_MAX_I64: { const [a, b] = ARG2(); rax = I64(a) > I64(b) ? I64(a) : I64(b); break; }
      case K.IC_MIN_U64: { const [a, b] = ARG2(); rax = U64(a) < U64(b) ? I64(a) : I64(b); break; }
      case K.IC_MAX_U64: { const [a, b] = ARG2(); rax = U64(a) > U64(b) ? I64(a) : I64(b); break; }
      case K.IC_SQR_I64: { const a = I64(pop()); rax = I64(a * a); break; }
      case K.IC_SQR_U64: { const a = U64(pop()); rax = I64(a * a); break; }
      case K.IC_BSF: { const a = pop(); rax = BigInt(bsf(a)); break; }
      case K.IC_BSR: { const a = pop(); rax = BigInt(bsr(a)); break; }
      case K.IC_SQR: { const a = b2f(pop()); produce(t, f2b(a * a)); break; }
      case K.IC_ABS: produce(t, f2b(Math.abs(b2f(pop())))); break;
      case K.IC_SQRT: produce(t, f2b(Math.sqrt(b2f(pop())))); break;
      case K.IC_SIN: produce(t, f2b(Math.sin(b2f(pop())))); break;
      case K.IC_COS: produce(t, f2b(Math.cos(b2f(pop())))); break;
      case K.IC_TAN: produce(t, f2b(Math.tan(b2f(pop())))); break;
      case K.IC_ATAN: produce(t, f2b(Math.atan(b2f(pop())))); break;
      case K.IC_GET_RBP: rax = BigInt(HOST_BASE + fp); break;
      case K.IC_GET_RSP: rax = BigInt(HOST_BASE + vm.sp); break;
      default:
        throw new Error(`interp: unsupported IC ${intermediate_code_table[code] ? intermediate_code_table[code].name : code} in ${prog.name}`);
    }
  }
}

// Debug listing of an IC program (like ICPut).
export function icListing(ics) {
  const lines = [];
  const lbl = new Map();
  const ln = (m) => { if (!m || typeof m !== 'object') return String(m); while (m.fwd) m = m.fwd; if (!lbl.has(m)) lbl.set(m, 'L' + lbl.size); return lbl.get(m); };
  for (const t of ics) {
    const e = intermediate_code_table[t.code];
    let d = t.data;
    if (t.code === K.IC_LABEL || t.code === K.IC_JMP || (t.code >= K.IC_BR_ZERO && t.code <= K.IC_BR_NOT_BTC) || t.code === K.IC_SUB_CALL || t.code === K.IC_GET_LABEL) d = ln(d);
    else if (d && typeof d === 'object') d = d.str !== undefined && d.str !== null ? (d.type === K.CMT_STR_CONST ? JSON.stringify(d.str) : d.str) : d.constructor.name;
    const c = t.cls ? (t.cls.str || (t.cls.lvl && t.cls.lvl[0].str) || '?') + '*'.repeat(t.cls.ptr_stars_cnt || 0) : '';
    const fl = [];
    for (const [n, v] of [['PUSH_RES', K.ICF_PUSH_RES], ['TO_F64', K.ICF_RES_TO_F64], ['TO_INT', K.ICF_RES_TO_INT], ['NOT_USED', K.ICF_RES_NOT_USED], ['PUSH_CMP', K.ICF_PUSH_CMP], ['POP_CMP', K.ICF_POP_CMP], ['F64', K.ICF_USE_F64], ['UNS', K.ICF_USE_UNSIGNED]])
      if (t.flags & v) fl.push(n);
    lines.push(`${(e ? e.name : t.code).padEnd(16)} ${String(d).padEnd(14)} ${c.padEnd(12)} ${fl.join(' ')}`);
  }
  return lines.join('\n');
}
