// Loading TempleOS BIN files that carry a wasm module (see DESIGN.md).
// Shared by the Node tests and the browser runtime.
export const HDR = 32; // sizeof(CBinFile)
export const IET = {
  END: 0, REL_I0: 2, IMM_U0: 3, REL_I8: 4, IMM_U8: 5, REL_I16: 6, IMM_U16: 7, REL_I32: 8, IMM_U32: 9,
  REL_I64: 10, IMM_I64: 11, REL32_EXPORT: 16, IMM32_EXPORT: 17, REL64_EXPORT: 18, IMM64_EXPORT: 19,
  ABS_ADDR: 20, CODE_HEAP: 21, ZEROED_CODE_HEAP: 22, DATA_HEAP: 23, ZEROED_DATA_HEAP: 24, MAIN: 25,
};

export function binInfo(bin) {
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const sig = dv.getUint32(4, true);
  if (sig !== 0x42534F54) throw new Error('not a TempleOS BIN');
  const patch = Number(dv.getBigInt64(16, true));
  const size = Number(dv.getBigInt64(24, true));
  let wasm = null, wasmOff = 0, ntable = 0;
  if (size >= 16 && dv.getUint32(size - 8, true) === 0x4D534157) {
    wasmOff = dv.getUint32(size - 16, true);
    wasm = bin.subarray(wasmOff, wasmOff + dv.getUint32(size - 12, true));
    ntable = dv.getUint32(size - 4, true);
  }
  // imgEnd: header, image and patch table (what must be in memory)
  return { patch, size, wasm, wasmOff, ntable, imgEnd: wasm ? wasmOff : size, alignBits: bin[2] };
}

// Parse a patch table (LoadPass1/2 format).
export function patchEntries(mem, at) {
  const u8 = new Uint8Array(mem.buffer);
  const dv = new DataView(mem.buffer);
  const out = [];
  let p = at;
  const str = () => { let s = ''; while (u8[p]) s += String.fromCharCode(u8[p++]); p++; return s; };
  for (;;) {
    const type = u8[p++];
    if (!type) break;
    const i = dv.getUint32(p, true); p += 4;
    const name = str();
    const e = { type, i, name };
    if (type === IET.ABS_ADDR) { e.rips = []; for (let k = 0; k < i; k++, p += 4) e.rips.push(dv.getUint32(p, true)); }
    else if (type === IET.CODE_HEAP || type === IET.ZEROED_CODE_HEAP) { e.size = dv.getInt32(p, true); p += 4; e.rips = []; for (let k = 0; k < i; k++, p += 4) e.rips.push(dv.getUint32(p, true)); }
    else if (type === IET.DATA_HEAP || type === IET.ZEROED_DATA_HEAP) { e.size = Number(dv.getBigInt64(p, true)); p += 8; e.rips = []; for (let k = 0; k < i; k++, p += 4) e.rips.push(dv.getUint32(p, true)); }
    out.push(e);
  }
  return out;
}

// The shared wasm state of a running TempleOS: memory, function table,
// the CPU "registers" that live in wasm globals, the resume tag.
export class Machine {
  constructor({ memPages = 8192, shared = true, imports = {} } = {}) {
    this.memPages = memPages;
    this.memory = new WebAssembly.Memory({ initial: memPages, maximum: memPages, shared });
    this.table = new WebAssembly.Table({ initial: 1, element: 'anyfunc' }); // slot 0: null
    const G = (t, v) => new WebAssembly.Global({ value: t, mutable: true }, v);
    this.sp = G('i32', 0); this.rbp = G('i32', 0);
    this.fs = G('i64', 0n); this.gs = G('i64', 0n); this.rflags = G('i64', 0x202n);
    this.resume = new WebAssembly.Tag({ parameters: ['i32', 'i64', 'i32'] });
    this.js = imports.js || {};
    this.env = Object.assign({
      in: (port, size) => 0n, out: () => {}, rdtsc: () => BigInt(Math.floor(performance.now() * 1e6)),
      hlt: () => {}, pause: () => {}, cpuid: () => {},
      divzero: () => { throw new Error('#DE divide error'); },
      catch_end: () => { throw new Error('catch_end with no kernel'); },
      pow: Math.pow, sin: Math.sin, cos: Math.cos, tan: Math.tan, atan: Math.atan,
      trace: (a, b) => console.log('trace', a, b),
    }, imports.env || {});
    this.modules = [];
  }
  get u8() { return new Uint8Array(this.memory.buffer); }
  get dv() { return new DataView(this.memory.buffer); }

  // Instantiate a wasm module whose image (module base) is at 'base'.
  instantiate(wasmBytes, base, ntable) {
    const tableBase = this.table.length;
    const mod = new WebAssembly.Module(wasmBytes);
    this.table.grow(ntable);
    const env = Object.assign({}, this.env, {
      mem: this.memory, table: this.table,
      sp: this.sp, rbp: this.rbp, fs: this.fs, gs: this.gs, rflags: this.rflags,
      base: new WebAssembly.Global({ value: 'i64', mutable: false }, BigInt(base)),
      table_base: new WebAssembly.Global({ value: 'i32', mutable: false }, tableBase),
      resume: this.resume,
    });
    const inst = new WebAssembly.Instance(mod, { env, js: this.js });
    inst.exports.__init();
    this.modules.push({ inst, base, tableBase });
    return inst;
  }

  // Call TempleOS code through its descriptor (Call(addr)).
  call(descAddr, args = []) {
    const dv = this.dv;
    const idx = dv.getUint32(Number(descAddr), true);
    let sp = this.sp.value;
    for (let i = args.length - 1; i >= 0; i--) { sp -= 8; dv.setBigInt64(sp, BigInt(args[i]), true); }
    sp -= 8; dv.setBigInt64(sp, 0n, true); // return marker
    this.sp.value = sp;
    const r = this.table.get(idx)();
    return r;
  }

  // Load a BIN (as Load() does) at a fixed address; returns its exports.
  // The wasm bytes are not copied: they are instantiated from 'bin'.
  loadBin(bin, at) {
    const info = binInfo(bin);
    this.u8.set(bin.subarray(0, info.imgEnd), at);
    const base = at + HDR;
    const ents = patchEntries(this.memory, at + info.patch);
    const dv = this.dv;
    for (const e of ents) if (e.type === IET.ABS_ADDR) for (const r of e.rips) dv.setUint32(base + r, (dv.getUint32(base + r, true) + base) >>> 0, true);
    const inst = info.wasm ? this.instantiate(info.wasm, base, info.ntable) : null;
    const exports = new Map();
    for (const e of ents) {
      if (e.type === IET.REL32_EXPORT || e.type === IET.REL64_EXPORT) exports.set(e.name, BigInt(base + e.i));
      else if (e.type === IET.IMM32_EXPORT || e.type === IET.IMM64_EXPORT) exports.set(e.name, BigInt(e.i));
    }
    const mains = ents.filter((e) => e.type === IET.MAIN).map((e) => BigInt(base + e.i));
    return { base, inst, exports, mains, ents };
  }
}
