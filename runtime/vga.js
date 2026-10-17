// VGA: the registers TempleOS programs (sequencer, CRTC, attribute
// controller palette, DAC) and the 640x480 16-color planar screen.  The
// four planes are not behind the map mask (no MMIO in wasm): each has its
// own 64K at PLANE_BASE+plane*0x10000 (port/Adam/Gr/GrScrn.HC), 80 bytes a
// line, the leftmost pixel in bit 7.
export const PLANE_BASE = 0xA0000, W = 640, H = 480;

export class VGA {
  constructor(bus) {
    this.seq = new Uint8Array(8); this.seqIdx = 0;
    this.crtc = new Uint8Array(32); this.crtcIdx = 0;
    this.attr = new Uint8Array(32); this.attrIdx = 0; this.attrFlip = false;
    for (let i = 0; i < 16; i++) this.attr[i] = i;
    this.dac = new Uint8Array(256 * 3); this.dacW = 0; this.dacR = 0; this.dacK = 0; this.dacRK = 0;
    // the standard 16 colors until TempleOS sets its palette
    const std = [0, 0, 0, 0, 0, 42, 0, 42, 0, 0, 42, 42, 42, 0, 0, 42, 0, 42, 42, 21, 0, 42, 42, 42,
      21, 21, 21, 21, 21, 63, 21, 63, 21, 21, 63, 63, 63, 21, 21, 63, 21, 63, 63, 63, 21, 63, 63, 63];
    this.dac.set(std);
    this.misc = 0; this.retrace = 0;
    bus.on([0x3C0], () => this.attrIdx, (p, v) => {
      if (!this.attrFlip) this.attrIdx = v & 0x1F; else this.attr[this.attrIdx] = v;
      this.attrFlip = !this.attrFlip;
    });
    bus.on([0x3C1], () => this.attr[this.attrIdx], null);
    bus.on([0x3C2], () => 0, (p, v) => { this.misc = v; });
    bus.on([0x3CC], () => this.misc, null);
    bus.on([0x3C4], () => this.seqIdx, (p, v, size) => { this.seqIdx = v & 7; if (size === 2) this.seq[this.seqIdx] = v >> 8; });
    bus.on([0x3C5], () => this.seq[this.seqIdx], (p, v) => { this.seq[this.seqIdx] = v; });
    bus.on([0x3C6], () => 0xFF, () => {});
    bus.on([0x3C7], () => 0, (p, v) => { this.dacR = v; this.dacRK = 0; });
    bus.on([0x3C8], () => this.dacW, (p, v) => { this.dacW = v; this.dacK = 0; });
    bus.on([0x3C9], () => { const r = this.dac[this.dacR * 3 + this.dacRK]; if (++this.dacRK === 3) { this.dacRK = 0; this.dacR = (this.dacR + 1) & 255; } return r; },
      (p, v) => { this.dac[this.dacW * 3 + this.dacK] = v & 63; if (++this.dacK === 3) { this.dacK = 0; this.dacW = (this.dacW + 1) & 255; } this.dirty = true; });
    bus.on([0x3CE, 0x3CF], () => 0, () => {});
    bus.on([0x3D4], () => this.crtcIdx, (p, v, size) => { this.crtcIdx = v & 31; if (size === 2) this.crtc[this.crtcIdx] = v >> 8; });
    bus.on([0x3D5], () => this.crtc[this.crtcIdx], (p, v) => { this.crtc[this.crtcIdx] = v; });
    bus.on([0x3DA], () => { this.attrFlip = false; this.retrace ^= 9; return this.retrace; }, () => {});
  }
  // 16 colors as 0xAABBGGRR (little-endian RGBA)
  palette() {
    const pal = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
      const d = (this.attr[i] & 0x3F) * 3, s = (c) => (this.dac[d + c] * 255 / 63) | 0;
      pal[i] = 0xFF000000 | s(2) << 16 | s(1) << 8 | s(0);
    }
    return pal;
  }
  // render the planes in 'u8' (linear memory) into rgba (Uint32Array W*H)
  render(u8, rgba) {
    const pal = this.palette();
    const p0 = PLANE_BASE, p1 = p0 + 0x10000, p2 = p1 + 0x10000, p3 = p2 + 0x10000;
    let o = 0;
    for (let i = 0; i < W * H / 8; i++) {
      const b0 = u8[p0 + i], b1 = u8[p1 + i], b2 = u8[p2 + i], b3 = u8[p3 + i];
      for (let k = 7; k >= 0; k--)
        rgba[o++] = pal[(b0 >> k & 1) | (b1 >> k & 1) << 1 | (b2 >> k & 1) << 2 | (b3 >> k & 1) << 3];
    }
  }
  // the 4-bit color index of each pixel (tests)
  indices(u8) {
    const out = new Uint8Array(W * H);
    for (let i = 0; i < W * H / 8; i++)
      for (let k = 7; k >= 0; k--) {
        let c = 0;
        for (let p = 0; p < 4; p++) c |= (u8[PLANE_BASE + p * 0x10000 + i] >> k & 1) << p;
        out[i * 8 + 7 - k] = c;
      }
    return out;
  }
}
