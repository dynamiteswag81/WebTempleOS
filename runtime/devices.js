// PC devices on the port I/O bus: the 8259 PICs, the 8254 PIT, the CMOS
// RTC and the odd ports TempleOS touches.  Disk, keyboard/mouse and VGA
// are in their own files.  Interrupts are only taken by wasm code (the
// kernel's _IrqPoll asks irqPending()), so all of this is plain JS state.

export const PIT_HZ = 1193182;

export class IOBus {
  constructor() { this.rd = new Map(); this.wr = new Map(); this.unknown = new Set(); this.log = null; }
  on(ports, rd, wr) { for (const p of ports) { if (rd) this.rd.set(p, rd); if (wr) this.wr.set(p, wr); } }
  in(port, size) {
    const f = this.rd.get(port);
    if (f) return f(port, size);
    this.miss('in', port);
    return size === 1 ? 0xFF : size === 2 ? 0xFFFF : 0xFFFFFFFF;
  }
  out(port, val, size) {
    const f = this.wr.get(port);
    if (f) return f(port, val, size);
    this.miss('out', port, val);
  }
  miss(dir, port, val) {
    const k = dir + port;
    if (this.unknown.has(k)) return;
    this.unknown.add(k);
    if (this.log) this.log(`io: unhandled ${dir} 0x${port.toString(16)}${val !== undefined ? ' = 0x' + val.toString(16) : ''}`);
  }
}

const range = (a, n) => Array.from({ length: n }, (_, i) => a + i);

// ---- 8259A pair
class PIC8259 {
  constructor(name) { this.name = name; this.irr = 0; this.isr = 0; this.imr = 0xFF; this.base = 0; this.icw = 0; this.icw4 = false; this.readIsr = false; }
  cmd(v) {
    if (v & 0x10) { this.icw = 2; this.icw4 = !!(v & 1); this.imr = 0; this.isr = 0; this.irr = 0; this.readIsr = false; return; }
    if (v & 0x08) { if (v & 2) this.readIsr = !!(v & 1); return; } // OCW3
    // OCW2
    const op = v >> 5;
    if (op === 1) { if (this.isr) this.isr &= this.isr - 1; } // non-specific EOI: lowest set bit = highest priority
    else if (op === 3) this.isr &= ~(1 << (v & 7));
  }
  data(v) {
    if (this.icw === 2) { this.base = v & 0xF8; this.icw = 3; return; }
    if (this.icw === 3) { this.icw = this.icw4 ? 4 : 0; return; }
    if (this.icw === 4) { this.icw = 0; return; }
    this.imr = v;
  }
  // highest-priority requested, unmasked line not blocked by one in service
  pending() {
    const req = this.irr & ~this.imr;
    if (!req) return -1;
    const n = 31 - Math.clz32(req & -req);
    if (this.isr && (31 - Math.clz32(this.isr & -this.isr)) <= n) return -1;
    return n;
  }
}

export class PICs {
  constructor(bus) {
    this.m = new PIC8259('master'); this.s = new PIC8259('slave');
    bus.on([0x20], () => (this.m.readIsr ? this.m.isr : this.m.irr), (p, v) => this.m.cmd(v));
    bus.on([0x21], () => this.m.imr, (p, v) => this.m.data(v));
    bus.on([0xA0], () => (this.s.readIsr ? this.s.isr : this.s.irr), (p, v) => this.s.cmd(v));
    bus.on([0xA1], () => this.s.imr, (p, v) => this.s.data(v));
  }
  raise(irq) { if (irq < 8) this.m.irr |= 1 << irq; else this.s.irr |= 1 << (irq - 8); }
  // INTA: the vector of the IRQ to take now, or -1.
  ack() {
    const sp = this.s.pending();
    if (sp >= 0) this.m.irr |= 4; else this.m.irr &= ~4;
    const n = this.m.pending();
    if (n < 0) return -1;
    this.m.irr &= ~(1 << n); this.m.isr |= 1 << n;
    if (n === 2 && sp >= 0) {
      this.s.irr &= ~(1 << sp); this.s.isr |= 1 << sp;
      return this.s.base + sp;
    }
    return this.m.base + n;
  }
  anyPending() { return this.m.pending() >= 0 || (this.s.pending() >= 0 && !(this.m.imr & 4)); }
}

// ---- 8254 PIT.  Channel 0 drives IRQ0; channel 2 the speaker.
export class PIT {
  constructor(bus, pics, now) {
    this.pics = pics; this.now = now;
    this.ch = [0, 1, 2].map(() => ({ reload: 0x10000, mode: 0, access: 3, lohi: 0, latch: null, wlo: null, t0: now() }));
    this.nextTick = Infinity;
    this.speaker = null; // called when channel 2 changes (PC turns it into a tone)
    bus.on([0x40, 0x41, 0x42], (p) => this.read(p - 0x40), (p, v) => this.write(p - 0x40, v));
    bus.on([0x43], null, (p, v) => this.cmd(v));
  }
  periodMs(c) { return (c.reload || 0x10000) * 1000 / PIT_HZ; }
  count(c) {
    const r = c.reload || 0x10000;
    const ticks = Math.floor((this.now() - c.t0) * PIT_HZ / 1000);
    return r - (ticks % r);
  }
  cmd(v) {
    const n = v >> 6;
    if (n === 3) return; // read-back: unused
    const c = this.ch[n];
    const access = (v >> 4) & 3;
    if (!access) { c.latch = this.count(c); c.lohi = 0; return; }
    c.access = access; c.mode = (v >> 1) & 7; c.lohi = 0; c.wlo = null;
  }
  write(n, v) {
    const c = this.ch[n];
    if (c.access === 3) {
      if (c.wlo === null) { c.wlo = v; return; }
      v = c.wlo | (v << 8); c.wlo = null;
    } else if (c.access === 2) v <<= 8;
    c.reload = v & 0xFFFF;
    c.t0 = this.now();
    if (n === 0) this.nextTick = c.t0 + this.periodMs(c);
    if (n === 2 && this.speaker) this.speaker();
  }
  read(n) {
    const c = this.ch[n];
    const v = c.latch !== null ? c.latch : this.count(c);
    let r;
    if (c.access === 1) r = v & 0xFF;
    else if (c.access === 2) r = (v >> 8) & 0xFF;
    else { r = c.lohi ? (v >> 8) & 0xFF : v & 0xFF; c.lohi ^= 1; }
    if (c.access !== 3 || !c.lohi) c.latch = null;
    return r;
  }
  speakerHz() { const r = this.ch[2].reload || 0x10000; return PIT_HZ / r; }
  // Raise IRQ0 if a tick is due.  Ticks are coalesced like an edge-triggered
  // IRQ whose IRR bit is already set; if far behind, catch up at once.
  update() {
    const t = this.now();
    if (t < this.nextTick) return;
    this.pics.raise(0);
    const p = this.periodMs(this.ch[0]);
    this.nextTick += p;
    if (t - this.nextTick > 100) this.nextTick = t + p;
  }
}

// ---- CMOS RTC (BCD, 24 hour)
export class CMOS {
  constructor(bus, date = () => new Date()) {
    this.idx = 0; this.date = date;
    this.ram = new Uint8Array(128);
    bus.on([0x70], () => this.idx, (p, v) => { this.idx = v & 0x7F; });
    bus.on([0x71], () => this.read(this.idx), (p, v) => { this.ram[this.idx] = v; });
  }
  read(i) {
    const d = this.date(), bcd = (x) => ((x / 10) | 0) * 16 + (x % 10);
    switch (i) {
      case 0: return bcd(d.getSeconds());
      case 2: return bcd(d.getMinutes());
      case 4: return bcd(d.getHours());
      case 6: return bcd(d.getDay() + 1);
      case 7: return bcd(d.getDate());
      case 8: return bcd(d.getMonth() + 1);
      case 9: return bcd(d.getFullYear() % 100);
      case 0x32: return bcd((d.getFullYear() / 100) | 0);
      case 0x0A: return 0x26;
      case 0x0B: return 0x02;
      case 0x0D: return 0x80;
      default: return this.ram[i];
    }
  }
}

// ---- odd ports: POST delay, system control (A20, speaker gate)
export class Misc {
  constructor(bus, pit) {
    this.p61 = 0; this.p92 = 2;
    bus.on([0x80], () => 0xFF, () => {});
    bus.on([0x61], () => (this.p61 & 0x0F) | ((performance.now() * 66) & 1 ? 0x10 : 0), (p, v) => {
      this.p61 = v;
      if (pit.speaker) pit.speaker();
    });
    bus.on([0x92], () => this.p92, (p, v) => { this.p92 = v; if (v & 1 && this.onReset) this.onReset(); });
    // PCI config: no devices
    bus.on([0xCF8], () => this.pciAddr | 0, (p, v) => { this.pciAddr = v; });
    bus.on(range(0xCFC, 4), (p, size) => (size === 1 ? 0xFF : size === 2 ? 0xFFFF : 0xFFFFFFFF), () => {});
  }
}
