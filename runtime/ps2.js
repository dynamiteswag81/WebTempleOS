// 8042 PS/2 controller with a keyboard and a wheel mouse, as TempleOS's
// Kernel/SerialDev/Keyboard.HC and Mouse.HC drive it.  Keyboard bytes are
// scan code set 1 (the controller's translation is on), with IRQ1; mouse
// bytes raise IRQ12.  The host feeds input with key()/mouse().
export class PS2 {
  constructor(bus, pics) {
    this.pics = pics;
    this.q = [];            // pending output bytes: [byte, aux]
    this.out = null;        // byte in the output buffer: [byte, aux]
    this.cfg = 0x47;        // kbd int, aux int off, system flag, translate
    this.next60 = null;     // where the next 0x60 write goes: 'cfg' | 'aux' | null
    this.kbdCmd = null;     // keyboard command awaiting its parameter
    this.auxCmd = null;     // mouse command awaiting its parameter
    this.kbdOn = true; this.auxOn = false;
    this.rates = []; this.msId = 0; this.msOn = false;
    bus.on([0x64], () => this.status(), (p, v) => this.ctrl(v & 0xFF));
    bus.on([0x60], () => this.data(), (p, v) => this.write60(v & 0xFF));
  }
  status() { return (this.out ? 1 : 0) | 4 | (this.out && this.out[1] ? 0x20 : 0); }
  // move the next queued byte into the output buffer, raising its IRQ
  fill() {
    if (this.out || !this.q.length) return;
    this.out = this.q.shift();
    if (this.out[1]) { if (this.cfg & 2) this.pics.raise(12); }
    else if (this.cfg & 1) this.pics.raise(1);
    if (this.onIrq) this.onIrq();
  }
  push(b, aux = false) { this.q.push([b & 0xFF, aux]); this.fill(); }
  data() {
    if (!this.out) return this.lastByte || 0;
    const b = this.out[0];
    this.lastByte = b; this.out = null;
    this.fill();
    return b;
  }
  ctrl(v) {
    switch (v) {
      case 0x20: this.push(this.cfg); break;
      case 0x60: this.next60 = 'cfg'; break;
      case 0xA7: this.auxOn = false; break;
      case 0xA8: this.auxOn = true; break;
      case 0xA9: this.push(0); break;
      case 0xAA: this.push(0x55); break;
      case 0xAB: this.push(0); break;
      case 0xAD: this.kbdOn = false; break;
      case 0xAE: this.kbdOn = true; break;
      case 0xD4: this.next60 = 'aux'; break;
      default: break;
    }
  }
  write60(v) {
    const to = this.next60; this.next60 = null;
    if (to === 'cfg') { this.cfg = v; return; }
    if (to === 'aux') { this.auxWrite(v); return; }
    this.kbdWrite(v);
  }
  kbdWrite(v) {
    if (this.kbdCmd !== null) { this.kbdCmd = null; this.push(0xFA); return; } // the parameter
    switch (v) {
      case 0xED: case 0xF0: case 0xF3: this.kbdCmd = v; this.push(0xFA); break;
      case 0xF2: this.push(0xFA); this.push(0xAB); this.push(0x41); break;
      case 0xFF: this.push(0xFA); this.push(0xAA); break;
      case 0xEE: this.push(0xEE); break;
      default: this.push(0xFA);
    }
  }
  auxWrite(v) {
    const ack = () => this.push(0xFA, true);
    if (this.auxCmd !== null) {
      const c = this.auxCmd; this.auxCmd = null;
      if (c === 0xF3) {
        this.rates.push(v); this.rates = this.rates.slice(-3);
        if (this.rates.join() === '200,100,80') this.msId = 3;
      }
      ack(); return;
    }
    switch (v) {
      case 0xFF: ack(); this.msId = 0; this.msOn = false; this.push(0xAA, true); this.push(0x00, true); break;
      case 0xF2: ack(); this.push(this.msId, true); break;
      case 0xF3: case 0xE8: this.auxCmd = v; ack(); break;
      case 0xF4: this.msOn = true; ack(); break;
      case 0xF5: this.msOn = false; ack(); break;
      default: ack();
    }
  }
  // ---- host input
  // codes: set 1 make codes (0xE0-prefixed ones as 0xE0xx); up: break
  key(code, up) {
    if (!this.kbdOn) return;
    if (code > 0xFF) this.push(0xE0);
    this.push((code & 0x7F) | (up ? 0x80 : 0));
  }
  // dx right, dy down (screen pixels), buttons bit0 left bit1 right bit2 middle, dz wheel
  mouse(dx, dy, buttons, dz = 0) {
    if (!this.auxOn || !this.msOn) return;
    while (dx || dy || dz || buttons !== this.lastButtons) {
      const x = Math.max(-255, Math.min(255, dx)), y = Math.max(-255, Math.min(255, -dy)), z = Math.max(-8, Math.min(7, dz));
      dx -= x; dy += y; dz -= z;
      this.push(0x08 | (buttons & 7) | (x < 0 ? 0x10 : 0) | (y < 0 ? 0x20 : 0), true);
      this.push(x & 0xFF, true); this.push(y & 0xFF, true);
      if (this.msId === 3) this.push(z & 0x0F, true);
      this.lastButtons = buttons;
    }
  }
}

// KeyboardEvent.code -> scan code set 1
export const SCANCODES = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07,
  Digit7: 0x08, Digit8: 0x09, Digit9: 0x0A, Digit0: 0x0B, Minus: 0x0C, Equal: 0x0D, Backspace: 0x0E,
  Tab: 0x0F, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16,
  KeyI: 0x17, KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1A, BracketRight: 0x1B, Enter: 0x1C,
  ControlLeft: 0x1D, KeyA: 0x1E, KeyS: 0x1F, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23,
  KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2A,
  Backslash: 0x2B, KeyZ: 0x2C, KeyX: 0x2D, KeyC: 0x2E, KeyV: 0x2F, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32,
  Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38,
  Space: 0x39, CapsLock: 0x3A, F1: 0x3B, F2: 0x3C, F3: 0x3D, F4: 0x3E, F5: 0x3F, F6: 0x40, F7: 0x41,
  F8: 0x42, F9: 0x43, F10: 0x44, NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48,
  Numpad9: 0x49, NumpadSubtract: 0x4A, Numpad4: 0x4B, Numpad5: 0x4C, Numpad6: 0x4D, NumpadAdd: 0x4E,
  Numpad1: 0x4F, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53, IntlBackslash: 0x56,
  F11: 0x57, F12: 0x58,
  NumpadEnter: 0xE01C, ControlRight: 0xE01D, NumpadDivide: 0xE035, AltRight: 0xE038,
  Home: 0xE047, ArrowUp: 0xE048, PageUp: 0xE049, ArrowLeft: 0xE04B, ArrowRight: 0xE04D, End: 0xE04F,
  ArrowDown: 0xE050, PageDown: 0xE051, Insert: 0xE052, Delete: 0xE053, MetaLeft: 0xE05B, MetaRight: 0xE05C,
  ContextMenu: 0xE05D,
};

// ASCII -> [code, shift] for typing text in tests (US layout)
const ROWS = [['1234567890-=', '!@#$%^&*()_+', 0x02], ['qwertyuiop[]', 'QWERTYUIOP{}', 0x10], ["asdfghjkl;'`", 'ASDFGHJKL:"~', 0x1E], ['\\zxcvbnm,./', '|ZXCVBNM<>?', 0x2B]];
export function charScan(ch) {
  if (ch === '\n') return [0x1C, false];
  if (ch === ' ') return [0x39, false];
  if (ch === '\t') return [0x0F, false];
  if (ch === '\b') return [0x0E, false];
  for (const [lo, hi, base] of ROWS) {
    let i = lo.indexOf(ch);
    if (i >= 0) return [base + i, false];
    i = hi.indexOf(ch);
    if (i >= 0) return [base + i, true];
  }
  return null;
}
