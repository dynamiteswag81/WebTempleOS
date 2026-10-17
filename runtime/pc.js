// The machine: wasm state (runtime/wasmload.js), devices, the boot loader
// (what KStart16/KStart32 did before KStartWasm()), and the JS services the
// kernel's builtins call.  Shared by the Node tests and the browser worker.
import { Machine, binInfo, HDR } from './wasmload.js';
import { BUILTINS } from './builtins.js';
import { BUILTIN_BASE } from '../compiler/backend.js';
import { Sched, Halt } from './sched.js';
import { IOBus, PICs, PIT, CMOS, Misc } from './devices.js';

export const MEM_PAGES = 65536; // 4 GB: the uncached alias wraps to 0 (HANDOFF.md)
const GB = 0x100000000;
const BOOT_RAM_BASE = 0x7C00, BOOT_RAM_LIMIT = 0x97000;
const RLF_16BIT = 1, RLF_VGA = 2;
const BOOT_SRC_HARDDRV = 3;
const builtinAddr = (name) => BUILTIN_BASE + 8 * BUILTINS.findIndex((b) => b.name === name);

export class PC {
  constructor({ ramMB = 1024, vga = false, log = console.log, now = () => performance.now(), trace = null } = {}) {
    this.log = log;
    this.ramMB = ramMB;
    this.vga = vga;
    this.now = now;
    this.port = {};
    this.RET = builtinAddr('_RET');
    this.halted = null;
    this.waiters = [];
    const js = {};
    const m = this.m = new Machine({ memPages: MEM_PAGES, imports: { js, env: {
      in: (port, size) => BigInt(this.io.in(port, size) >>> 0),
      out: (port, val, size) => this.io.out(port, Number(BigInt.asUintN(32, val)), size),
      rdtsc: () => BigInt(Math.floor(this.now() * 1e6)),
      ...(trace ? { trace } : {}),
    } } });
    for (const b of BUILTINS) if (b.kind === 'js') {
      const f = b.js(this);
      js[b.name] = b.suspend ? new WebAssembly.Suspending(f) : f;
    }
    // devices
    const io = this.io = new IOBus();
    io.log = (s) => this.log(s);
    this.pics = new PICs(io);
    this.pit = new PIT(io, this.pics, now);
    this.cmos = new CMOS(io);
    this.misc = new Misc(io, this.pit);
    this.sched = new Sched(this);
  }
  get dv() { return this.m.dv; }
  get u8() { return this.m.u8; }
  get sp() { return this.m.sp; }
  get rbp() { return this.m.rbp; }
  get rflags() { return this.m.rflags; }
  get memory() { return this.m.memory; }
  get table() { return this.m.table; }
  get memPages() { return this.m.memPages; }

  // ---- JS services of the builtins
  portSet(k, v) {
    const names = { 1: 'rip', 2: 'rsp', 3: 'rbp', 4: 'rflags', 5: 'taskNum', 6: 'taskName' };
    if (names[k]) this.port[names[k]] = Number(v);
    else if (k === 7) this.booted = true;
  }
  cpuid(leaf, res) {
    const dv = this.dv;
    let a = 0, b = 0, c = 0, d = 0;
    if (leaf === 0) { a = 1; b = 0x756E6547; d = 0x49656E69; c = 0x6C65746E; } // GenuineIntel
    else if (leaf === 1) { a = 0x000306A9; b = 8 << 8; c = 0; d = 0x0383F9FF & ~(1 << 9); } // no APIC
    dv.setBigInt64(res, BigInt(a), true); dv.setBigInt64(res + 8, BigInt(b), true);
    dv.setBigInt64(res + 16, BigInt(c), true); dv.setBigInt64(res + 24, BigInt(d), true);
  }
  irqPending() {
    this.pit.update();
    return this.pics.ack();
  }
  // HLT: wait for an IRQ.  With IF off that's a halted CPU.
  hltWait() {
    if (!(this.m.rflags.value & 0x200n)) throw new Halt('HLT with interrupts off');
    this.pit.update();
    if (this.pics.anyPending()) return 0n;
    return new Promise((resolve) => {
      const w = { resolve, t: null };
      const wake = () => { clearTimeout(w.t); const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); resolve(0n); };
      w.wake = wake;
      w.t = setTimeout(wake, Math.max(0, this.pit.nextTick - this.now()));
      this.waiters.push(w);
    });
  }
  // a device raised an IRQ: wake a HLT
  irq(n) {
    this.pics.raise(n);
    for (const w of this.waiters.slice()) w.wake();
  }
  dbgPutc(ch) { this.dbgLine = (this.dbgLine || '') + String.fromCharCode(ch); if (ch === 10) { this.log('dbg: ' + this.dbgLine.trimEnd()); this.dbgLine = ''; } }
  fail(e) {
    if (this.halted) return;
    this.halted = e;
    if (this.onHalt) this.onHalt(e);
  }

  // ---- boot loader (KStart16/KStart32's jobs)
  boot(kernelBin) { this.load(kernelBin); this.start(); }
  load(kernelBin) {
    const m = this.m, dv = this.dv;
    const info = binInfo(kernelBin);
    if (BOOT_RAM_BASE + info.imgEnd > BOOT_RAM_LIMIT - 0x8000) throw new Error('kernel image too big for low memory');
    const lb = m.loadBin(kernelBin, BOOT_RAM_BASE);
    const ex = (n) => { const a = lb.exports.get(n); if (a === undefined) throw new Error('kernel lacks ' + n); return Number(a); };
    this.kernel = lb;
    // KStart16's variables
    dv.setUint32(ex('SYS_BOOT_SRC'), BOOT_SRC_HARDDRV, true);
    dv.setUint32(ex('SYS_BOOT_BLK'), 0, true);
    dv.setUint32(ex('MEM_BOOT_BASE'), lb.base, true);
    dv.setUint32(ex('SYS_BOOT_PATCH_TABLE_BASE'), BOOT_RAM_BASE + info.patch, true);
    dv.setUint32(ex('SYS_RUN_LEVEL'), RLF_16BIT | (this.vga ? RLF_VGA : 0), true);
    const ram = this.ramMB * 0x100000;
    // E801: KB between 1M and 16M, 64K blocks above 16M
    dv.setUint16(ex('MEM_E801'), 15 * 1024, true);
    dv.setUint16(ex('MEM_E801') + 2, Math.min(0xFFFF, (ram - 0x1000000) >> 16), true);
    const e820 = [[0, 0x9F000, 1], [0x9F000, 0x100000 - 0x9F000, 2], [0x100000, ram - 0x100000, 1], [ram, GB - ram, 2]];
    let a = ex('MEM_E820');
    for (const [base, len, type] of e820) {
      dv.setBigUint64(a, BigInt(base), true); dv.setBigUint64(a + 8, BigInt(len), true); dv.setUint32(a + 16, type, true);
      a += 24;
    }
    dv.setBigUint64(ex('MEM_PHYSICAL_SPACE'), BigInt(GB), true);
    dv.setUint16(ex('SYS_PCI_BUSES'), 0, true);
    this.kstart = ex('KStartWasm');
  }
  // Call KStartWasm() on its own stack, from below the boot RAM limit.  It
  // runs synchronously until the first suspension (HLT or a task switch).
  start() {
    const m = this.m, dv = this.dv, kstart = this.kstart;
    m.sp.value = BOOT_RAM_LIMIT - 64;
    m.sp.value -= 8; dv.setBigInt64(m.sp.value, 0n, true); // no return marker
    m.rflags.value = 0n;
    const idx = dv.getUint32(kstart, true);
    this.sched.start(idx).then(() => this.fail(new Error('KStartWasm returned')), (e) => this.fail(e));
  }

  // 80x25 text mode screen at 0xB8000
  textScreen() {
    const u8 = this.u8, rows = [];
    for (let r = 0; r < 25; r++) {
      let s = '';
      for (let c = 0; c < 80; c++) { const ch = u8[0xB8000 + 2 * (r * 80 + c)]; s += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : ch ? '?' : ' '; }
      rows.push(s.trimEnd());
    }
    while (rows.length && !rows[rows.length - 1]) rows.pop();
    return rows.join('\n');
  }
}
