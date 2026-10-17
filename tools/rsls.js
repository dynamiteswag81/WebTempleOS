// List a RedSea directory in a disk image:  node tools/rsls.js build/C.img [/Dir]
import fs from 'fs';
import { PRT_OFFSET, BLK } from './mkdisk.js';
export function rsList(img, dir = '/') {
  const dv = new DataView(img.buffer, img.byteOffset, img.byteLength);
  const off = Number(dv.getUint32(446 + 8, true)) || PRT_OFFSET;
  let clus = Number(dv.getBigInt64(off * BLK + 24, true));
  const read = (c) => {
    const size = Number(dv.getBigInt64(c * BLK + 48, true)), out = [];
    for (let a = c * BLK; a < c * BLK + Math.max(size, BLK); a += 64) {
      if (!img[a + 2]) break;
      let name = ''; for (let i = 0; i < 37 && img[a + 2 + i]; i++) name += String.fromCharCode(img[a + 2 + i]);
      out.push({ attr: dv.getUint16(a, true), name, clus: Number(dv.getBigInt64(a + 40, true)), size: Number(dv.getBigInt64(a + 48, true)) });
    }
    return out;
  };
  for (const part of dir.split('/').filter(Boolean)) {
    const e = read(clus).slice(2).find((x) => x.name === part && x.attr & 0x10 && !(x.attr & 0x100));
    if (!e) throw new Error('no dir ' + part);
    clus = e.clus;
  }
  return read(clus);
}
if (process.argv[1] && process.argv[1].endsWith('rsls.js')) {
  const img = new Uint8Array(fs.readFileSync(process.argv[2]));
  for (const e of rsList(img, process.argv[3] || '/')) console.log(e.attr.toString(16).padStart(4), String(e.clus).padStart(8), String(e.size).padStart(9), e.name);
}
