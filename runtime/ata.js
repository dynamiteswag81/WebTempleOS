// ATA PIO hard drive on the primary IDE channel (0x1F0-0x1F7, 0x3F6), as
// TempleOS's Kernel/BlkDev/DskATA.HC drives it: IDENTIFY, READ NATIVE MAX
// (EXT, with the HOB bit of the control register), SET MAX, READ/WRITE
// MULTIPLE (EXT).  Commands complete at once, so BSY is never seen.  No
// IRQs (TempleOS polls; nIEN is set).  Unit 1 and the secondary channel
// are empty.
const ERR = 0x01, DRQ = 0x08, DSC = 0x10, DRDY = 0x40;

export class ATADisk {
  // img: Uint8Array of the whole disk (a multiple of 512 bytes)
  constructor(bus, img, { base0 = 0x1F0, base1 = 0x3F6, onWrite = null } = {}) {
    this.img = img;
    this.sectors = Math.floor(img.length / 512);
    this.onWrite = onWrite; // (first_sector, count) after a write
    this.reg = { feat: 0, nsect: [0, 0], sect: [0, 0], lcyl: [0, 0], hcyl: [0, 0], sel: 0xA0 };
    this.ctrl = 0; this.status = DRDY | DSC; this.error = 0;
    this.buf = null; this.pos = 0; this.writing = null;
    this.ident = this.identify();
    const R = (n) => base0 + n;
    bus.on([R(0)], (p, size) => this.dataIn(size), (p, v, size) => this.dataOut(v, size));
    bus.on([R(1)], () => this.cur() ? this.error : 0, (p, v) => { this.reg.feat = v & 0xFF; });
    for (const [k, n] of [['nsect', 2], ['sect', 3], ['lcyl', 4], ['hcyl', 5]])
      bus.on([R(n)], () => this.cur() ? this.reg[k][this.ctrl & 0x80 ? 1 : 0] : 0,
        (p, v) => { const r = this.reg[k]; r[1] = r[0]; r[0] = v & 0xFF; this.ctrl &= ~0x80; });
    bus.on([R(6)], () => this.reg.sel, (p, v) => { this.reg.sel = v & 0xFF; });
    bus.on([R(7)], () => this.cur() ? this.status : 0, (p, v) => this.cmd(v & 0xFF));
    bus.on([base1], () => this.cur() ? this.status : 0, (p, v) => { this.ctrl = v & 0xFF; });
  }
  cur() { return !(this.reg.sel & 0x10); } // unit 0 selected
  lba(ext) {
    const r = this.reg;
    if (ext) return r.sect[0] + r.lcyl[0] * 2 ** 8 + r.hcyl[0] * 2 ** 16 + r.sect[1] * 2 ** 24 + r.lcyl[1] * 2 ** 32 + r.hcyl[1] * 2 ** 40;
    return r.sect[0] | r.lcyl[0] << 8 | r.hcyl[0] << 16 | (r.sel & 0xF) << 24;
  }
  count(ext) {
    const r = this.reg;
    const n = ext ? r.nsect[0] | r.nsect[1] << 8 : r.nsect[0];
    return n || (ext ? 65536 : 256);
  }
  setLba(v, ext) {
    const r = this.reg;
    r.sect[0] = v & 0xFF; r.lcyl[0] = (v >>> 8) & 0xFF; r.hcyl[0] = (v >>> 16) & 0xFF;
    if (ext) { const h = Math.floor(v / 2 ** 24); r.sect[1] = h & 0xFF; r.lcyl[1] = (h >>> 8) & 0xFF; r.hcyl[1] = (h >>> 16) & 0xFF; }
    else r.sel = (r.sel & 0xF0) | ((v >>> 24) & 0xF);
  }
  fail() { this.status = DRDY | DSC | ERR; this.error = 0x04; this.buf = null; this.writing = null; } // ABRT
  ok() { this.status = DRDY | DSC; this.error = 0; }
  cmd(c) {
    if (!this.cur()) return;
    const ext = c === 0x27 || c === 0x29 || c === 0x37 || c === 0x39;
    switch (c) {
      case 0xEC: this.ok(); this.buf = this.ident; this.pos = 0; this.status |= DRQ; break; // IDENTIFY
      case 0x27: case 0xF8: this.ok(); this.setLba(this.sectors - 1, ext); break;         // READ NATIVE MAX
      case 0x37: case 0xF9: this.ok(); break;                                            // SET MAX
      case 0x29: case 0xC4: {                                                            // READ MULTIPLE
        const lba = this.lba(ext), n = this.count(ext);
        if (lba + n > this.sectors) { this.fail(); break; }
        this.ok(); this.buf = this.img.subarray(lba * 512, (lba + n) * 512); this.pos = 0; this.status |= DRQ;
        break;
      }
      case 0x39: case 0xC5: {                                                            // WRITE MULTIPLE
        const lba = this.lba(ext), n = this.count(ext);
        if (lba + n > this.sectors) { this.fail(); break; }
        this.ok(); this.writing = { lba, n }; this.buf = this.img.subarray(lba * 512, (lba + n) * 512); this.pos = 0; this.status |= DRQ;
        break;
      }
      case 0xE7: case 0xEA: case 0x00: this.ok(); break; // FLUSH CACHE (EXT), NOP
      default: this.fail();
    }
  }
  dataIn(size) {
    if (!this.cur() || !this.buf || this.writing) return 0;
    let v = 0;
    for (let i = 0; i < size; i++) v |= this.buf[this.pos++] << (8 * i);
    if (this.pos >= this.buf.length) { this.buf = null; this.status &= ~DRQ; }
    return v >>> 0;
  }
  dataOut(v, size) {
    if (!this.cur() || !this.buf || !this.writing) return;
    for (let i = 0; i < size; i++) this.buf[this.pos++] = (v >>> (8 * i)) & 0xFF;
    if (this.pos >= this.buf.length) {
      const w = this.writing;
      this.buf = null; this.writing = null; this.status &= ~DRQ;
      if (this.onWrite) this.onWrite(w.lba, w.n);
    }
  }
  // bulk transfers for REP INS/OUTS (RepInU32 etc.): bytes, returns false if not a data port
  repIn(dst, n) {
    if (!this.cur() || !this.buf || this.writing) { dst.fill(0, 0, n); return; }
    const k = Math.min(n, this.buf.length - this.pos);
    dst.set(this.buf.subarray(this.pos, this.pos + k)); dst.fill(0, k, n);
    this.pos += k;
    if (this.pos >= this.buf.length) { this.buf = null; this.status &= ~DRQ; }
  }
  repOut(src, n) {
    if (!this.cur() || !this.buf || !this.writing) return;
    const k = Math.min(n, this.buf.length - this.pos);
    this.buf.set(src.subarray(0, k), this.pos);
    this.pos += k;
    if (this.pos >= this.buf.length) {
      const w = this.writing;
      this.buf = null; this.writing = null; this.status &= ~DRQ;
      if (this.onWrite) this.onWrite(w.lba, w.n);
    }
  }
  identify() {
    const w = new Uint16Array(256);
    const str = (at, len, s) => { s = s.padEnd(len * 2); for (let i = 0; i < len; i++) w[at + i] = s.charCodeAt(2 * i) << 8 | s.charCodeAt(2 * i + 1); };
    w[0] = 0x0040; // fixed ATA device
    const cyl = Math.min(16383, Math.floor(this.sectors / (16 * 63)));
    w[1] = cyl; w[3] = 16; w[6] = 63;
    str(10, 10, 'WEBTEMPLEOS0001'); str(23, 4, '1.0'); str(27, 20, 'WebTempleOS RedSea Disk');
    w[47] = 0x8010; w[49] = 0x0200; // max multiple 16, LBA
    w[53] = 1; w[59] = 0x0110;
    const s28 = Math.min(this.sectors, 0x0FFFFFFF);
    w[60] = s28 & 0xFFFF; w[61] = s28 >>> 16;
    w[80] = 0x007E; w[83] = 1 << 10 | 1 << 14; w[86] = 1 << 10; w[87] = 1 << 14;
    w[100] = this.sectors & 0xFFFF; w[101] = (this.sectors >>> 16) & 0xFFFF;
    return new Uint8Array(w.buffer);
  }
}
