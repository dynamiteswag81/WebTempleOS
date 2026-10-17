// The runtime back-end: TempleOS's own compiler (Compiler.BIN, running as
// wasm) parses and runs OptPass012, then its COCCompile (port/Compiler/
// PrsLib.HC) calls JITCompile()/JITStore().  We read the intermediate code
// from linear memory into the shape compiler/backend.js's Unit compiles
// (the same shape the bootstrap's front-end makes), build a one-function
// wasm module, instantiate it and bind it to the code blob:
//   blob = [descriptor: table index, 'WASM'][string constants]
// so exe_addr, Call(), Free() and fun ptrs work as in TempleOS.
import * as K from '../compiler/consts.js';
import { T, OP, Bytes, ModuleBuilder } from '../compiler/wasm.js';
import { Unit, addHelpers, moduleImports, BRANCH_CODES, BackendError, BUILTIN_BASE, CATCH_END } from '../compiler/backend.js';
import { BUILTINS } from './builtins.js';
import { intermediate_code_table } from '../compiler/opt.js';

const WASM_TAG = 0x4D534157, WBLT_TAG = 0x544C4257;
export const JIT_TRACE_BASE = 1 << 24;
const LABEL_DATA = new Set([...BRANCH_CODES, K.IC_LABEL, K.IC_GET_LABEL]);
LABEL_DATA.delete(K.IC_RET); LABEL_DATA.delete(K.IC_LEAVE);
LABEL_DATA.delete(K.IC_SWITCH); LABEL_DATA.delete(K.IC_NOBOUND_SWITCH);

export class JIT {
  constructor(pc, layout) {
    this.pc = pc; this.L = layout;
    this.opts = { memPages: pc.memPages, memMax: pc.memPages };
    this.builtins = BUILTINS.map((b, i) => ({ ...b, i }));
    this.pending = null;
    this.units = 0; this.ms = 0;
    this.traceNames = [];
    if (pc.tracing) this.opts.trace = true;
  }
  get dv() { return this.pc.dv; }
  q(a) { return this.dv.getBigInt64(a, true); }
  p(a) { return Number(this.dv.getBigUint64(a, true)); }
  cstr(a, n = -1) {
    const u8 = this.pc.u8; let s = '';
    if (n >= 0) { for (let i = 0; i < n; i++) s += String.fromCharCode(u8[a + i]); return s; }
    while (u8[a]) s += String.fromCharCode(u8[a++]);
    return s;
  }

  // ---- reading TempleOS structures
  cls(a) {
    if (!a) return null;
    let c = this.clsCache.get(a);
    if (c) return c;
    const L = this.L.CHashClass, dv = this.dv, jit = this;
    const ptr = dv.getUint8(a + L.ptr_stars_cnt);
    c = {
      addr: a, raw_type: dv.getUint8(a + L.raw_type), ptr_stars_cnt: ptr, size: this.p(a + L.size),
      get fwd_class() { return jit.cls(jit.p(a + L.fwd_class)); },
      get lvl() { const base = a - ptr * L.sizeof; return [0, 1, 2, 3, 4].map((i) => jit.cls(base + i * L.sizeof)); },
    };
    this.clsCache.set(a, c);
    return c;
  }
  misc(a) {
    if (!a) return null;
    let m = this.miscCache.get(a);
    if (m) return m;
    const L = this.L.CCodeMisc, jit = this;
    const type = this.dv.getUint32(a + L.type, true);
    m = { addr: a, type, get fwd() { return jit.misc(jit.p(a + L.fwd)); } };
    if (type === K.CMT_STR_CONST) { m.st_len = this.p(a + L.st_len); m.str = this.cstr(this.p(a + L.str), m.st_len); }
    else if (type === K.CMT_JMP_TABLE) {
      m.range = this.p(a + L.range);
      const jt = this.p(a + L.jmp_table);
      m.jmp_table = []; for (let i = 0; i < m.range; i++) m.jmp_table.push(this.misc(this.p(jt + 8 * i)));
      m.dft = this.misc(this.p(a + L.dft));
    }
    this.miscCache.set(a, m);
    return m;
  }
  readUnit(cc) {
    const L = this.L, CC = L.CCmpCtrl, IC = L.CIntermediateCode, dv = this.dv;
    this.clsCache = new Map(); this.miscCache = new Map();
    const coc = cc + CC.coc, head = coc + L.CCodeCtrl.coc_head;
    const ics = [];
    for (let t = this.p(head); t !== head; t = this.p(t + IC.next)) {
      if (!t) throw new BackendError('broken IC list');
      const code = dv.getUint16(t + IC.ic_code, true);
      const raw = this.q(t + IC.ic_data);
      let data = raw;
      if (LABEL_DATA.has(code) || code === K.IC_STR_CONST || code === K.IC_SWITCH || code === K.IC_NOBOUND_SWITCH)
        data = this.misc(Number(BigInt.asUintN(64, raw)));
      else if (code === K.IC_ASM) {
        const a = Number(BigInt.asUintN(64, raw)), A = L.CAOT;
        data = { buf: this.pc.u8.slice(this.p(a + A.buf), this.p(a + A.buf) + this.p(a + A.aot_U8s)) };
      }
      ics.push({ code, data, flags: Number(this.q(t + IC.ic_flags) & 0xFFFFFFFFn), line: this.p(t + IC.ic_line),
        cls: this.cls(this.p(t + IC.ic_class)), t: this.treeLinks(t) });
    }
    const misc = [];
    for (let m = this.p(coc + L.CCodeCtrl.coc_next_misc); m && m !== coc + L.CCodeCtrl.coc_next_misc; m = this.p(m + L.CCodeMisc.next)) misc.push(this.misc(m));
    const fa = this.p(cc + CC.htc + L.CLexHashTableContext.fun);
    const fun = fa ? { addr: fa, str: this.cstr(this.p(fa + L.CHash.str)), flags: dv.getUint16(fa + L.CHashClass.flags, true),
      arg_cnt: dv.getUint32(fa + L.CHashFun.arg_cnt, true) } : null;
    return { ics, misc, fun, flags: this.q(cc + CC.flags) };
  }
  // ic_body is a union: the tree links are only read where the backend
  // needs them (when the IC list is still alive, before COCDel)
  treeLinks(t) {
    const jit = this, a = t + this.L.CIntermediateCode.t + this.L.CICTreeLinks.class2;
    return { get class2() { return jit.cls(jit.p(a)); } };
  }
  // The *_type result of OptPass4: the raw type IC_RETURN_VAL(2) returns.
  exprType(ics) {
    let type = K.RT_I64;
    ics.forEach((t, i) => {
      if (t.code !== K.IC_RETURN_VAL && t.code !== K.IC_RETURN_VAL2) return;
      if (!t.cls) {
        for (let j = i - 1; j >= 0; j--) {
          const l = ics[j];
          if (l.code === K.IC_NOP1 || l.code === K.IC_NOP2) continue;
          if (l.cls) {
            if (l.flags & K.ICF_RES_TO_F64) type = K.RT_F64;
            else if (l.flags & K.ICF_RES_TO_INT) type = K.RT_I64;
            else type = l.cls.raw_type;
            break;
          }
        }
      } else type = t.cls.raw_type;
    });
    return type;
  }

  // ---- JITCompile(cc,_type): read the unit, return the blob size (or -1)
  compile(cc, typePtr) {
    const t0 = performance.now();
    try {
      const u = this.readUnit(cc);
      if (u.flags & K.CCF_AOT_COMPILE) throw new BackendError('AOT compile at run time is not supported');
      if (this.dump && this.dump(u)) this.pc.log('--- jit unit ' + (u.fun ? u.fun.str : '(stmt)') + ':\n' + u.ics.map((t) => `${(intermediate_code_table[t.code] || {}).name || t.code} ${typeof t.data === 'bigint' ? t.data : t.data ? '[obj]' : ''} cls=${t.cls ? t.cls.raw_type + '/' + t.cls.ptr_stars_cnt : '-'} f=${t.flags.toString(16)}`).join('\n'));
      if (typePtr) this.dv.setBigInt64(typePtr, BigInt(this.exprType(u.ics)), true);
      const strOffs = new Map();
      let off = 8;
      for (const m of u.misc) if (m.type === K.CMT_STR_CONST) { strOffs.set(m, off); off += m.st_len; }
      u.strOffs = strOffs; u.size = (off + 7) & ~7;
      this.pending = u;
      return BigInt(u.size);
    } catch (e) {
      this.fail(e);
      return -1n;
    } finally { this.ms += performance.now() - t0; }
  }
  fail(e) {
    this.pending = null;
    this.lastError = e;
    this.pc.log('jit: ' + (e instanceof BackendError ? e.message : e.stack));
  }

  // ---- JITStore(cc,res): build and bind the wasm function
  store(cc, res) {
    const t0 = performance.now();
    const u = this.pending; this.pending = null;
    if (!u) return 0n;
    try {
      const mb = this.mb = new ModuleBuilder();
      this.g = moduleImports(mb, { ...this.opts, shared: true });
      this.fnType = mb.type([], [T.i64]);
      this.h = addHelpers(mb, this.g, this);
      const f = mb.reserveFunc([], [T.i64], u.fun ? u.fun.str : null);
      this.blob = { addr: res, strOffs: u.strOffs };
      const unit = new Unit(this, { htc: { fun: u.fun }, coc: { misc: u.misc }, flags: u.flags }, { ics: u.ics }, this.opts);
      const r = unit.compile();
      f.f.body = r.body; f.f.locals = r.locals;
      mb.export('f', 0, f.idx);
      const m = this.pc.m, tbl = m.table;
      const inst = new WebAssembly.Instance(new WebAssembly.Module(mb.encode()), { env: this.env() });
      const idx = tbl.length;
      tbl.grow(1);
      tbl.set(idx, inst.exports.f);
      const dv = this.dv, u8 = this.pc.u8;
      dv.setUint32(res, idx, true); dv.setUint32(res + 4, WASM_TAG, true);
      for (const [mi, o] of u.strOffs) for (let i = 0; i < mi.st_len; i++) u8[res + o + i] = mi.str.charCodeAt(i) & 255;
      this.units++;
    } catch (e) {
      this.fail(e);
      this.dv.setUint32(res, 0, true); // calling it traps (table slot 0 is null)
    } finally { this.ms += performance.now() - t0; }
    return 0n;
  }
  env() {
    if (this._env) return this._env;
    const m = this.pc.m;
    return this._env = Object.assign({}, m.env, {
      mem: m.memory, table: m.table, sp: m.sp, rbp: m.rbp, fs: m.fs, gs: m.gs, rflags: m.rflags,
      base: new WebAssembly.Global({ value: 'i64', mutable: false }, 0n),
      table_base: new WebAssembly.Global({ value: 'i32', mutable: false }, 0),
      resume: m.resume,
    });
  }

  // ---- the backend interface Unit uses (see AOTBackend)
  get CATCH_END() { return CATCH_END; }
  builtinIndex(name) { const b = this.builtins.find((x) => x.name === name); return b ? b.i + 1 : 0; }
  builtinAddr(name) { return BUILTIN_BASE + 8 * (this.builtinIndex(name) - 1); }
  hook(by, name, fallback) {
    if (!this.builtinIndex(name)) { by.u8(OP.call).u32(fallback); return; }
    const a = this.builtinAddr(name), sp = this.g.sp;
    by.u8(OP.global_get).u32(sp).u8(OP.i32_const).s32(8).u8(OP.i32_sub).u8(OP.global_set).u32(sp);
    by.u8(OP.global_get).u32(sp).u8(OP.i64_const).s64(BigInt(a)).u8(OP.i64_store).u32(3).u32(0);
    by.u8(OP.i32_const).s32(a).u8(OP.i32_load).u32(2).u32(0);
    by.u8(OP.call_indirect).u32(this.fnType).u32(0).u8(OP.drop);
  }
  // with a trace import (debugging), JIT'd functions report their entry too:
  // ids from JIT_TRACE_BASE name this.traceNames[id-JIT_TRACE_BASE]
  traceId(fun) { this.traceNames.push(fun ? fun.str : '<stmt>'); return JIT_TRACE_BASE + this.traceNames.length - 1; }
  traceIdStr(s) { this.traceNames.push(s); return JIT_TRACE_BASE + this.traceNames.length - 1; }
  markerExpr(u) { this.absAddrOfBlob(u, 0); }
  absAddrOfBlob(u, off) { u.absAddr(this.blob.addr + off); }
  selfAddr(u) { this.absAddrOfBlob(u, 0); }
  strConstAddr(u, m) {
    const o = this.blob.strOffs.get(m);
    if (o === undefined) u.err('string constant not in this unit');
    this.absAddrOfBlob(u, o);
  }
  importSlot(u) { u.err('import slot in JIT code'); }
  heapGlblSlot(u) { u.err('heap glbl in JIT code'); }
  immObject(u) { u.err('IMM of an object'); }
  // table index of the code a descriptor address names: a constant when the
  // descriptor is already bound, else read at run time
  descIndex(u, addr) {
    const dv = this.dv, tag = dv.getUint32(addr + 4, true);
    if (tag === WASM_TAG || tag === WBLT_TAG) u.i32(dv.getUint32(addr, true));
    else u.i32(addr).mem(OP.i32_load, 2);
  }
  // CALL [&tmpf->exe_addr]: the extern's exe_addr is read at run time
  indirect2Target(u, data) {
    u.i32(Number(BigInt.asUintN(32, BigInt(data)))).mem(OP.i64_load, 3).addr().mem(OP.i32_load, 2).lset(u.L.ta);
  }
  directCall(u, t) {
    const a = Number(BigInt.asUintN(32, BigInt(t.data)));
    this.descIndex(u, a);
    u.b.u8(OP.call_indirect).u32(this.fnType).u32(0);
  }
}
