// Small helpers for exact 64-bit HolyC semantics in JS.
export const I64 = (x) => BigInt.asIntN(64, BigInt(x));
export const U64 = (x) => BigInt.asUintN(64, BigInt(x));
const dv = new DataView(new ArrayBuffer(8));
export function f2b(f) { dv.setFloat64(0, f, true); return dv.getBigInt64(0, true); }
export function b2f(b) { dv.setBigInt64(0, BigInt.asIntN(64, BigInt(b)), true); return dv.getFloat64(0, true); }
// x86 cvttsd2si semantics: NaN/overflow give 0x8000000000000000.
export function f2i(f) {
  if (!(f > -9223372036854775808 && f < 9223372036854775808)) return -0x8000000000000000n;
  return BigInt(Math.trunc(f));
}
export function i2f(b) { return Number(BigInt.asIntN(64, BigInt(b))); }
export function bsf(b) {
  b = U64(b); if (b === 0n) return -1;
  let i = 0; while (!((b >> BigInt(i)) & 1n)) i++; return i;
}
export function bsr(b) {
  b = U64(b); if (b === 0n) return -1;
  let i = 63; while (!((b >> BigInt(i)) & 1n)) i--; return i;
}
export const bt = (x, bit) => ((BigInt(x) >> BigInt(bit)) & 1n) !== 0n;
// Strings are kept as JS strings whose char codes are TempleOS bytes (0-255).
export function bytesToStr(u8, start = 0, end = u8.length) {
  let s = '';
  for (let i = start; i < end; i += 8192)
    s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(end, i + 8192)));
  return s;
}
export function strToBytes(s) {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255;
  return u;
}
