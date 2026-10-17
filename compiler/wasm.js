// Minimal WebAssembly binary encoder: just what the IC backend emits.
export const T = { i32: 0x7F, i64: 0x7E, f32: 0x7D, f64: 0x7C, funcref: 0x70, void: 0x40 };

export const OP = {
  unreachable: 0x00, nop: 0x01, block: 0x02, loop: 0x03, if: 0x04, else: 0x05,
  try: 0x06, catch: 0x07, throw: 0x08, rethrow: 0x09, end: 0x0B, br: 0x0C, br_if: 0x0D,
  br_table: 0x0E, return: 0x0F, call: 0x10, call_indirect: 0x11, delegate: 0x18, catch_all: 0x19,
  drop: 0x1A, select: 0x1B,
  local_get: 0x20, local_set: 0x21, local_tee: 0x22, global_get: 0x23, global_set: 0x24,
  i32_load: 0x28, i64_load: 0x29, f32_load: 0x2A, f64_load: 0x2B,
  i32_load8_s: 0x2C, i32_load8_u: 0x2D, i32_load16_s: 0x2E, i32_load16_u: 0x2F,
  i64_load8_s: 0x30, i64_load8_u: 0x31, i64_load16_s: 0x32, i64_load16_u: 0x33,
  i64_load32_s: 0x34, i64_load32_u: 0x35,
  i32_store: 0x36, i64_store: 0x37, f32_store: 0x38, f64_store: 0x39,
  i32_store8: 0x3A, i32_store16: 0x3B, i64_store8: 0x3C, i64_store16: 0x3D, i64_store32: 0x3E,
  memory_size: 0x3F, memory_grow: 0x40,
  i32_const: 0x41, i64_const: 0x42, f32_const: 0x43, f64_const: 0x44,
  i32_eqz: 0x45, i32_eq: 0x46, i32_ne: 0x47, i32_lt_s: 0x48, i32_lt_u: 0x49, i32_gt_s: 0x4A,
  i32_gt_u: 0x4B, i32_le_s: 0x4C, i32_le_u: 0x4D, i32_ge_s: 0x4E, i32_ge_u: 0x4F,
  i64_eqz: 0x50, i64_eq: 0x51, i64_ne: 0x52, i64_lt_s: 0x53, i64_lt_u: 0x54, i64_gt_s: 0x55,
  i64_gt_u: 0x56, i64_le_s: 0x57, i64_le_u: 0x58, i64_ge_s: 0x59, i64_ge_u: 0x5A,
  f64_eq: 0x61, f64_ne: 0x62, f64_lt: 0x63, f64_gt: 0x64, f64_le: 0x65, f64_ge: 0x66,
  i32_clz: 0x67, i32_ctz: 0x68, i32_popcnt: 0x69, i32_add: 0x6A, i32_sub: 0x6B, i32_mul: 0x6C,
  i32_div_s: 0x6D, i32_div_u: 0x6E, i32_rem_s: 0x6F, i32_rem_u: 0x70, i32_and: 0x71, i32_or: 0x72,
  i32_xor: 0x73, i32_shl: 0x74, i32_shr_s: 0x75, i32_shr_u: 0x76,
  i64_clz: 0x79, i64_ctz: 0x7A, i64_popcnt: 0x7B, i64_add: 0x7C, i64_sub: 0x7D, i64_mul: 0x7E,
  i64_div_s: 0x7F, i64_div_u: 0x80, i64_rem_s: 0x81, i64_rem_u: 0x82, i64_and: 0x83, i64_or: 0x84,
  i64_xor: 0x85, i64_shl: 0x86, i64_shr_s: 0x87, i64_shr_u: 0x88, i64_rotl: 0x89, i64_rotr: 0x8A,
  f64_abs: 0x99, f64_neg: 0x9A, f64_ceil: 0x9B, f64_floor: 0x9C, f64_trunc: 0x9D, f64_nearest: 0x9E,
  f64_sqrt: 0x9F, f64_add: 0xA0, f64_sub: 0xA1, f64_mul: 0xA2, f64_div: 0xA3, f64_min: 0xA4,
  f64_max: 0xA5, f64_copysign: 0xA6,
  i32_wrap_i64: 0xA7, i64_extend_i32_s: 0xAC, i64_extend_i32_u: 0xAD,
  i64_trunc_f64_s: 0xB0, f64_convert_i64_s: 0xB9, f64_convert_i64_u: 0xBA,
  i64_reinterpret_f64: 0xBD, f64_reinterpret_i64: 0xBF,
};
// 0xFC prefixed
export const OPFC = { i64_trunc_sat_f64_s: 6, memory_copy: 10, memory_fill: 11 };
// 0xFE prefixed (threads)
export const OPFE = {
  memory_atomic_notify: 0x00, memory_atomic_wait32: 0x01,
  i32_atomic_load: 0x10, i64_atomic_load: 0x11,
  i32_atomic_rmw8_or_u: 0x34, i32_atomic_rmw8_and_u: 0x3B, i32_atomic_rmw8_xor_u: 0x42,
};

export class Bytes {
  constructor() { this.a = []; }
  u8(b) { this.a.push(b & 255); return this; }
  bytes(arr) { for (const b of arr) this.a.push(b & 255); return this; }
  u32(v) { // unsigned LEB128
    v >>>= 0;
    do { let b = v & 0x7F; v >>>= 7; if (v) b |= 0x80; this.a.push(b); } while (v);
    return this;
  }
  s32(v) { // signed LEB128
    v |= 0;
    for (;;) {
      const b = v & 0x7F; v >>= 7;
      if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { this.a.push(b); return this; }
      this.a.push(b | 0x80);
    }
  }
  s64(v) {
    v = BigInt.asIntN(64, BigInt(v));
    for (;;) {
      const b = Number(v & 0x7Fn); v >>= 7n;
      if ((v === 0n && !(b & 0x40)) || (v === -1n && (b & 0x40))) { this.a.push(b); return this; }
      this.a.push(b | 0x80);
    }
  }
  f64(x) { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, x, true); for (let i = 0; i < 8; i++) this.a.push(d.getUint8(i)); return this; }
  str(s) { const e = Buffer.from(s, 'utf8'); this.u32(e.length); this.bytes(e); return this; }
  vec(items, fn) { this.u32(items.length); for (const it of items) fn(this, it); return this; }
  get length() { return this.a.length; }
  toU8() { return Uint8Array.from(this.a); }
}

// A wasm module.  Function index space = imported funcs then defined funcs.
export class ModuleBuilder {
  constructor() {
    this.types = []; this.typeKey = new Map();
    this.imports = []; // {mod, name, kind, desc}
    this.nImportFuncs = 0; this.nImportGlobals = 0; this.nImportTags = 0;
    this.funcs = []; // {type, locals:[[n,t]], body:Uint8Array, name}
    this.globals = []; // {type, mut, init: Bytes}
    this.exports = [];
    this.tags = [];
    this.elems = []; // {offsetExpr (Bytes), funcs: [idx]}
    this.names = [];
  }
  type(params, results) {
    const k = params.join(',') + '>' + results.join(',');
    let i = this.typeKey.get(k);
    if (i === undefined) { i = this.types.length; this.types.push([params, results]); this.typeKey.set(k, i); }
    return i;
  }
  importFunc(mod, name, params, results) {
    if (this.funcs.length) throw new Error('imports must precede defined funcs');
    this.imports.push({ mod, name, kind: 0, type: this.type(params, results) });
    return this.nImportFuncs++;
  }
  importMemory(mod, name, min, max, shared) { this.imports.push({ mod, name, kind: 2, min, max, shared }); }
  importTable(mod, name, min) { this.imports.push({ mod, name, kind: 1, min }); }
  importGlobal(mod, name, type, mut) { this.imports.push({ mod, name, kind: 3, type, mut }); return this.nImportGlobals++; }
  importTag(mod, name, params) { this.imports.push({ mod, name, kind: 4, type: this.type(params, []) }); return this.nImportTags++; }
  // Reserve a defined function slot (index known before the body is).
  reserveFunc(params, results, name) {
    const f = { type: this.type(params, results), locals: [], body: null, name };
    this.funcs.push(f);
    return { idx: this.nImportFuncs + this.funcs.length - 1, f };
  }
  addGlobal(type, mut, initBytes) { this.globals.push({ type, mut, init: initBytes }); return this.nImportGlobals + this.globals.length - 1; }
  export(name, kind, idx) { this.exports.push({ name, kind, idx }); }
  encode() {
    const out = new Bytes();
    out.bytes([0, 0x61, 0x73, 0x6D, 1, 0, 0, 0]);
    const section = (id, fn) => {
      const b = new Bytes(); fn(b);
      out.u8(id); out.u32(b.length); out.bytes(b.a);
    };
    section(1, (b) => b.vec(this.types, (b, [p, r]) => { b.u8(0x60); b.vec(p, (b, t) => b.u8(t)); b.vec(r, (b, t) => b.u8(t)); }));
    if (this.imports.length) section(2, (b) => b.vec(this.imports, (b, im) => {
      b.str(im.mod); b.str(im.name); b.u8(im.kind);
      switch (im.kind) {
        case 0: b.u32(im.type); break;
        case 1: b.u8(T.funcref); b.u8(0); b.u32(im.min); break;
        case 2: b.u8(im.shared ? 3 : 1); b.u32(im.min); b.u32(im.max); break;
        case 3: b.u8(im.type); b.u8(im.mut ? 1 : 0); break;
        case 4: b.u8(0); b.u32(im.type); break;
      }
    }));
    section(3, (b) => b.vec(this.funcs, (b, f) => b.u32(f.type)));
    if (this.tags.length) section(13, (b) => b.vec(this.tags, (b, t) => { b.u8(0); b.u32(t.type); }));
    if (this.globals.length) section(6, (b) => b.vec(this.globals, (b, g) => { b.u8(g.type); b.u8(g.mut ? 1 : 0); b.bytes(g.init.a); b.u8(OP.end); }));
    if (this.exports.length) section(7, (b) => b.vec(this.exports, (b, e) => { b.str(e.name); b.u8(e.kind); b.u32(e.idx); }));
    if (this.elems.length) section(9, (b) => b.vec(this.elems, (b, e) => {
      b.u8(0); b.bytes(e.offset.a); b.u8(OP.end); b.vec(e.funcs, (b, i) => b.u32(i));
    }));
    section(10, (b) => b.vec(this.funcs, (b, f) => {
      if (!f.body) throw new Error('function without body: ' + f.name);
      const fb = new Bytes();
      fb.vec(f.locals, (b, [n, t]) => { b.u32(n); b.u8(t); });
      fb.bytes(f.body); fb.u8(OP.end);
      b.u32(fb.length); b.bytes(fb.a);
    }));
    // name section (function names) for readable stack traces
    const named = this.funcs.map((f, i) => [this.nImportFuncs + i, f.name]).filter(([, n]) => n);
    if (named.length) {
      const b = new Bytes();
      b.str('name');
      const sub = new Bytes();
      sub.vec(named, (s, [i, n]) => { s.u32(i); s.str(n); });
      const tmp = new Bytes();
      tmp.u8(1); tmp.u32(sub.length); tmp.bytes(sub.a);
      out.u8(0); out.u32(b.length + tmp.length); out.bytes(b.a); out.bytes(tmp.a);
    }
    return out.toU8();
  }
}
