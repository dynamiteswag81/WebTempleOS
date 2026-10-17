// Repair the binary (sprite) sections of DolDoc files in vendor/TempleOS.
//
// The git tree was extracted from the TempleOS ISO with "TOSZ -ascii", which
// deleted every 0x05 byte and turned 0x1F into 0x20 in the whole file, the
// binary part after the text's NUL included (see Linux/TOSZ.CPP Cvt()).
// The bins (Adam/DolDoc/DocFile.HC DocLoad: [U32 num,flags,size,use_cnt]
// [data]...) then no longer parse and TempleOS says "Bin Not Found".
// Here each bin is re-parsed with the sprite grammar (Adam/Gr/SpriteNew.HC
// SpriteElemSize) and the deleted 0x05 bytes are put back where the
// structure needs them.  0x1F->0x20 changes can't be seen and stay.
// A doc whose bins can't be repaired gets them dropped (TempleOS then
// shows its own "Bin Not Found"-free empty sprites... see repairDoc).
import fs from 'fs';

const T = { END: 0, COLOR: 1, DITHER: 2, THICK: 3, PLANAR: 4, XON: 5, XOFF: 6, SHIFT: 7, PT: 8, POLYPT: 9,
  LINE: 10, POLYLINE: 11, RECT: 12, RRECT: 13, CIRCLE: 14, ELLIPSE: 15, POLYGON: 16, BS2: 17, BS2C: 18,
  BS3: 19, BS3C: 20, FILL: 21, FILLNOT: 22, BITMAP: 23, MESH: 24, SMESH: 25, ARROW: 26, TEXT: 27,
  TEXTBOX: 28, TEXTDIA: 29 };

// candidate ways to read n bytes of the original at c[i..], with up to
// maxIns deleted 0x05 bytes re-inserted: [{bytes, used}] fewest inserts first
function* fieldCands(c, i, n, maxIns) {
  for (let k = 0; k <= Math.min(maxIns, n); k++) {
    if (i + n - k > c.length) break;
    // choose k positions among n for the 0x05s
    const pos = [];
    function* comb(start, left) {
      if (!left) {
        const b = new Uint8Array(n); let j = i;
        for (let p = 0; p < n; p++) b[p] = pos.includes(p) ? 5 : c[j++];
        yield { bytes: b, used: n - k };
        return;
      }
      for (let p = start; p <= n - left; p++) { pos.push(p); yield* comb(p + 1, left - 1); pos.pop(); }
    }
    yield* comb(0, k);
  }
}
const i32 = (b, o = 0) => b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24;
const u32 = (b, o = 0) => i32(b, o) >>> 0;
const f64 = (b) => new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
const coordOk = (v) => v > -0x40000 && v < 0x40000;
const cntOk = (v) => v >= 0 && v < 0x10000;

// The parses of one element at c[i] (o: its offset in the bin), fewest
// re-inserted bytes first: [{chunks, i, o, end}]
function elemCands(c, i, o, size) {
  const out = [];
  const types = [];
  if (i < c.length && (c[i] & 0x7F) < 30) types.push([c[i], 1]);
  types.push([5, 0]); // a deleted SPT_TRANSFORM_ON
  for (const [ty, used] of types) {
    const t = ty & 0x7F;
    if (t === 0) { if (o + 1 === size) out.push({ chunks: [[ty]], i: i + used, o: o + 1, end: true }); continue; }
    bodyCands(c, t, i + used, o + 1, size, (chunks, i2, o2) => { if (o2 < size) out.push({ chunks: [[ty], ...chunks], i: i2, o: o2 }); });
    if (out.length > 64) break;
  }
  return out;
}
function bodyCands(c, t, i, o, size, emit) {
  const F = [];
  const I = 'i32', C = 'cnt', U8 = 'u8', U16 = 'u16', D = 'f64';
  switch (t) {
    case T.COLOR: F.push(U8); break;
    case T.DITHER: F.push(U16); break;
    case T.THICK: F.push(C); break;
    case T.XON: case T.XOFF: break;
    case T.SHIFT: case T.PT: case T.FILL: case T.FILLNOT: F.push(I, I); break;
    case T.PLANAR: case T.LINE: case T.RECT: case T.ARROW: F.push(I, I, I, I); break;
    case T.RRECT: F.push(I, I, I, I, D); break;
    case T.CIRCLE: F.push(I, I, I); break;
    case T.ELLIPSE: F.push(I, I, I, I, D); break;
    case T.POLYGON: F.push(I, I, I, I, D, C); break;
    case T.POLYPT: F.push(C, I, I); break;
    case T.POLYLINE: case T.BS2: case T.BS2C: case T.BS3: case T.BS3C: F.push(C); break;
    case T.BITMAP: F.push(I, I, C, C); break;
    case T.MESH: F.push(C, C); break;
    case T.SMESH: F.push(I, I, I, C, C); break;
    case T.TEXT: case T.TEXTBOX: case T.TEXTDIA: F.push(I, I); break;
    default: return;
  }
  let n = 0;
  const vals = [], chunks = [];
  const fields = (k, i, o) => {
    if (n > 200) return;
    if (k === F.length) { n++; payloadCands(c, t, vals, i, o, size, (ch, i2, o2) => emit([...chunks, ...ch], i2, o2)); return; }
    const f = F[k], len = f === U8 ? 1 : f === U16 ? 2 : f === D ? 8 : 4;
    for (const cand of fieldCands(c, i, len, f === D ? 2 : f === U8 || f === U16 ? 1 : 2)) {
      const b = cand.bytes;
      let v;
      if (f === I) { v = i32(b); if (!coordOk(v)) continue; }
      else if (f === C) { v = u32(b); if (!cntOk(v)) continue; }
      else if (f === D) { v = f64(b); if (!(Math.abs(v) < 1e4)) continue; }
      else v = f === U8 ? b[0] : b[0] | b[1] << 8;
      vals.push(v); chunks.push(b);
      fields(k + 1, i + cand.used, o + len);
      vals.pop(); chunks.pop();
    }
  };
  fields(0, i, o);
}
// payload: structured I32s are read one by one greedily (an I32 that is
// not a small number had a 0x05 deleted); opaque bytes get the missing
// 0x05s at the end, as many as the bin size leaves room for (all counts).
function payloadCands(c, t, v, i, o, size, emit) {
  const I32s = (cnt) => {
    const out = [];
    for (let k = 0; k < cnt; k++) {
      let got = null;
      for (const cand of fieldCands(c, i, 4, 2)) if (coordOk(i32(cand.bytes))) { got = cand; break; }
      if (!got) return;
      out.push(got.bytes); i += got.used; o += 4;
    }
    emit(out, i, o);
  };
  const opaque = (len) => {
    for (let k = 0; k <= len && k <= 4096; k++) {
      if (i + len - k > c.length || o + len >= size) continue;
      const b = new Uint8Array(len);
      b.set(c.subarray(i, i + len - k));
      b.fill(5, len - k);
      emit([b], i + len - k, o + len);
    }
  };
  switch (t) {
    case T.POLYPT: return opaque((v[0] * 3 + 7) >> 3);
    case T.POLYLINE: return I32s(v[0] * 2);
    case T.BS2: case T.BS2C: case T.BS3: case T.BS3C: return I32s(v[0] * 3);
    case T.BITMAP: return opaque(((v[2] + 7) & ~7) * v[3]);
    case T.MESH: return I32s(v[0] * 3 + v[1] * 4);
    case T.SMESH: return I32s(v[3] * 3 + v[4] * 4);
    case T.TEXT: case T.TEXTBOX: case T.TEXTDIA: {
      let j = i; while (j < c.length && c[j]) j++;
      if (j < c.length) emit([c.slice(i, j + 1)], j + 1, o + j + 1 - i);
      return;
    }
    default: emit([], i, o);
  }
}
// can the bin go on from (i,o) for 'depth' more elements (or end right)?
function viable(c, i, o, size, depth) {
  if (depth === 0) return true;
  for (const e of elemCands(c, i, o, size)) {
    if (e.end) return true;
    if (viable(c, e.i, e.o, size, depth - 1)) return true;
  }
  return false;
}
function headerCands(c, i) {
  const out = [];
  for (const h of fieldCands(c, i, 16, 2)) {
    const b = h.bytes, num = u32(b, 0), flags = u32(b, 4), size = u32(b, 8), use = u32(b, 12);
    if (!num || num > 100000 || flags > 0xFFFF || !size || size > 0x1000000 || use > 100000) continue;
    out.push({ b, num, size, i: i + h.used, ins: 16 - h.used });
  }
  return out.sort((x, y) => x.ins - y.ins || x.size - y.size);
}
// The fields each element type has after its type byte.
const I = 'i32', C = 'cnt', U8 = 'u8', U16 = 'u16', D = 'f64';
const FIELDS = {
  [T.COLOR]: [U8], [T.DITHER]: [U16], [T.THICK]: [C], [T.XON]: [], [T.XOFF]: [],
  [T.SHIFT]: [I, I], [T.PT]: [I, I], [T.FILL]: [I, I], [T.FILLNOT]: [I, I],
  [T.PLANAR]: [I, I, I, I], [T.LINE]: [I, I, I, I], [T.RECT]: [I, I, I, I], [T.ARROW]: [I, I, I, I],
  [T.RRECT]: [I, I, I, I, D], [T.CIRCLE]: [I, I, I], [T.ELLIPSE]: [I, I, I, I, D], [T.POLYGON]: [I, I, I, I, D, C],
  [T.POLYPT]: [C, I, I], [T.POLYLINE]: [C], [T.BS2]: [C], [T.BS2C]: [C], [T.BS3]: [C], [T.BS3C]: [C],
  [T.BITMAP]: [I, I, C, C], [T.MESH]: [C, C], [T.SMESH]: [I, I, I, C, C],
  [T.TEXT]: [I, I], [T.TEXTBOX]: [I, I], [T.TEXTDIA]: [I, I],
};
// what follows the fixed fields (v: their values)
function payloadSpec(t, v) {
  switch (t) {
    case T.POLYPT: return { k: 'opaque', n: (v[0] * 3 + 7) >> 3 };
    case T.POLYLINE: return { k: I, n: v[0] * 2 };
    case T.BS2: case T.BS2C: case T.BS3: case T.BS3C: return { k: I, n: v[0] * 3 };
    case T.BITMAP: return { k: 'opaque', n: ((v[2] + 7) & ~7) * v[3] };
    case T.MESH: return { k: I, n: v[0] * 3 + v[1] * 4 };
    case T.SMESH: return { k: I, n: v[3] * 3 + v[4] * 4 };
    case T.TEXT: case T.TEXTBOX: case T.TEXTDIA: return { k: 'text', n: 1 };
    default: return null;
  }
}
// Candidate next states from state s = {i, o, t, fi, v, arr}:
//  arr: a payload being read; else fi: index of the next fixed field of
//  element type t (t<0: a type byte is next).
function steps(c, s, size, out) {
  const len = (k) => (k === U8 ? 1 : k === U16 ? 2 : k === D ? 8 : 4);
  if (s.arr) {
    const a = s.arr;
    if (a.k === 'text') {
      let j = s.i; while (j < c.length && c[j]) j++;
      if (j < c.length) out.push({ i: j + 1, o: s.o + j + 1 - s.i, t: -1, b: c.slice(s.i, j + 1) });
      return;
    }
    if (a.k === 'opaque') {
      for (let k = 0; k <= Math.min(a.n, 4096); k++) { // fewest missing first
        if (s.i + a.n - k > c.length || s.o + a.n >= size) continue;
        const b = new Uint8Array(a.n); b.set(c.subarray(s.i, s.i + a.n - k)); b.fill(5, a.n - k);
        out.push({ i: s.i + a.n - k, o: s.o + a.n, t: -1, b });
      }
      return;
    }
    for (const cand of fieldCands(c, s.i, 4, 2)) {
      if (!coordOk(i32(cand.bytes))) continue;
      out.push({ i: s.i + cand.used, o: s.o + 4, t: -1, arr: a.n > 1 ? { k: a.k, n: a.n - 1 } : null, b: cand.bytes });
    }
    return;
  }
  if (s.t < 0) { // type byte
    if (s.o >= size) return;
    const types = [];
    if (s.i < c.length && (c[s.i] & 0x7F) < 30) types.push([c[s.i], 1]);
    // a deleted SPT_TRANSFORM_ON (0x05): the next byte is then a type too
    if (!s.phantom && s.i < c.length && (c[s.i] & 0x7F) < 30) types.push([5, 0]);
    for (const [ty, used] of types) {
      const t = ty & 0x7F;
      if (t === T.END) { if (s.o + 1 === size) out.push({ i: s.i + used, o: s.o + 1, end: true, b: Uint8Array.of(ty) }); continue; }
      if (s.o + 1 >= size) continue;
      const n = { i: s.i + used, o: s.o + 1, t, fi: 0, v: [], b: Uint8Array.of(ty), phantom: !used };
      if (!FIELDS[t].length) { n.t = -1; }
      out.push(n);
    }
    return;
  }
  const F = FIELDS[s.t], f = F[s.fi], n = len(f);
  for (const cand of fieldCands(c, s.i, n, f === U8 || f === U16 ? 1 : 2)) {
    const b = cand.bytes;
    let v;
    if (f === I) { v = i32(b); if (!coordOk(v)) continue; }
    else if (f === C) { v = u32(b); if (!cntOk(v)) continue; }
    else if (f === D) { v = f64(b); if (!(Math.abs(v) < 1e4)) continue; }
    else v = f === U8 ? b[0] : b[0] | b[1] << 8;
    const vals = [...s.v, v];
    const ns = { i: s.i + cand.used, o: s.o + n, t: s.t, fi: s.fi + 1, v: vals, b };
    if (ns.fi === F.length) {
      const p = payloadSpec(s.t, vals);
      ns.t = -1;
      if (p && p.n > 0) { if (ns.o + (p.k === I ? 4 * p.n : p.k === 'opaque' ? p.n : 1) >= size) continue; ns.arr = p; }
    }
    out.push(ns);
  }
}
// One bin from c[i]: [chunks, i after] or null.  A depth-first search over
// field parses with an explicit stack (bins can have thousands of fields).
function* bin(c, i) {
  for (const h of headerCands(c, i)) {
    const root = { i: h.i, o: 0, t: -1 };
    const first = []; steps(c, root, h.size, first);
    const stack = [{ cands: first, k: 0 }];
    let n = 0;
    while (stack.length && n++ < 300000) {
      const top = stack[stack.length - 1];
      if (top.k >= top.cands.length) { stack.pop(); continue; }
      const e = top.cands[top.k++];
      if (e.end) {
        if (e.i === c.length || headerCands(c, e.i).length) {
          const chunks = [h.b];
          for (const f of stack) chunks.push(f.cands[f.k - 1].b);
          yield [chunks, e.i];
        }
        continue;
      }
      const next = []; steps(c, e, h.size, next);
      if (next.length) stack.push({ cands: next, k: 0 });
    }
    if (process.env.BINFIX_DEBUG > 1) console.log(`bin ${h.num} size ${h.size} at ${i}: no more parses (${n} steps)`);
  }
}
// all the bins from c[i] to the end: chunks or null
function bins(c, i, failed = new Set()) {
  if (i === c.length) return [];
  if (failed.has(i)) return null;
  let tries = 0;
  for (const [chunks, j] of bin(c, i)) {
    const rest = bins(c, j, failed);
    if (rest) return [...chunks, ...rest];
    if (++tries > 50) break;
  }
  if (process.env.BINFIX_DEBUG) console.log(`no bins parse from ${i}`);
  failed.add(i);
  return null;
}

// Returns the repaired file, the file unchanged if its bins parse, or null.
export function repairDoc(buf) {
  const t = buf.indexOf(0);
  if (t < 0) return buf;
  const c = buf.subarray(t + 1);
  // fine already?
  let q = 0;
  while (q + 16 <= c.length) q += 16 + u32(c, q + 8);
  if (q === c.length) return buf;
  const r = bins(c, 0);
  if (!r) return null;
  const len = r.reduce((n, x) => n + x.length, 0);
  const out = new Uint8Array(t + 1 + len);
  out.set(buf.subarray(0, t + 1));
  let o = t + 1;
  for (const x of r) { out.set(x, o); o += x.length; }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('binfix.js')) {
  let ok = 0, fixed = 0, bad = 0;
  for (const p of process.argv.slice(2)) {
    const b = new Uint8Array(fs.readFileSync(p));
    const t0 = Date.now();
    const r = repairDoc(b);
    if (r === b) ok++;
    else if (r) { fixed++; console.log(`fixed ${p}: +${r.length - b.length} bytes (${Date.now() - t0} ms)`); }
    else { bad++; console.log(`FAILED ${p} (${Date.now() - t0} ms)`); }
  }
  console.log(`${ok} fine, ${fixed} fixed, ${bad} failed`);
}
