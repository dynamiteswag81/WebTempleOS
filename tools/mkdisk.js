// Build the C: hard drive image: an MBR with one RedSea partition holding
// the TempleOS tree (vendor/TempleOS), the port/ overlay and our BINs.
//   node tools/mkdisk.js [-mb=N]          -> build/C.img
// The layout is what TempleOS's own RedSeaFmt/RedSeaMkDir/RedSeaFileWrite
// produce (Kernel/BlkDev/FileSysRedSea.HC): absolute block clusters,
// contiguous files, an allocation bitmap after the boot block, and
// directories whose first entry describes the directory itself.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const BLK = 512;
const CDIR = 64, NAME_LEN = 38;
const RS_ATTR_DIR = 0x10, RS_ATTR_CONTIGUOUS = 0x800;
const MBR_PT_REDSEA = 0x88;
export const PRT_OFFSET = 63;

// KDate.HC Struct2Date
function yearStart(y) { const y1 = y - 1; return y * 365 + Math.floor(y1 / 4) - Math.floor(y1 / 100) + Math.floor(y1 / 400) - Math.floor(y1 / 4000); }
const MON1 = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334], MON2 = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
export function cdate(d) {
  const y = d.getFullYear();
  let day = yearStart(y);
  day += (yearStart(y + 1) - day === 365 ? MON1 : MON2)[d.getMonth()] + d.getDate() - 1;
  const x = BigInt(Math.floor(d.getMilliseconds() / 10) * 100 + 10000 * (d.getSeconds() + 60 * (d.getMinutes() + 60 * d.getHours())));
  const time = (x << 21n) / BigInt(15 * 15 * 3 * 625);
  return (BigInt(day) << 32n) | (time & 0xFFFFFFFFn);
}

// tree: Map name -> Uint8Array (file) | Map (dir)
export function buildImage(tree, { mb = 128, date = new Date() } = {}) {
  const sectors = mb * 2048;
  const img = new Uint8Array(sectors * BLK);
  const dv = new DataView(img.buffer);
  const dt = cdate(date);
  const off = PRT_OFFSET, sects = sectors - off;
  // MBR
  const p = 446;
  img[p] = 0x80; img[p + 4] = MBR_PT_REDSEA;
  dv.setUint32(p + 8, off, true); dv.setUint32(p + 12, sects, true);
  dv.setUint16(510, 0xAA55, true);
  // RedSeaFmt
  const bitmapSects = Math.ceil(sects / (BLK * 8));
  const dataArea = off + bitmapSects;
  let next = dataArea;
  const alloc = (n) => {
    const c = next; next += n;
    if (next > off + sects) throw new Error('disk image full: use a bigger -mb');
    return c;
  };
  alloc(1); // "Alloc #1"
  const dirSize = (m) => Math.ceil(((m.size + 3) << 6) / BLK) * BLK; // RedSeaMkDir
  const entry = (a, attr, name, clus, size) => {
    dv.setUint16(a, attr, true);
    const nb = Buffer.from(name, 'latin1');
    if (nb.length >= NAME_LEN) throw new Error('file name too long: ' + name);
    img.set(nb, a + 2);
    dv.setBigInt64(a + 40, BigInt(clus), true);
    dv.setBigInt64(a + 48, BigInt(size), true);
    dv.setBigInt64(a + 56, dt, true);
  };
  const writeDir = (m, selfName, clus, size, parentClus) => {
    let a = clus * BLK;
    entry(a, RS_ATTR_DIR | RS_ATTR_CONTIGUOUS, selfName, clus, size); a += CDIR;
    entry(a, RS_ATTR_DIR | RS_ATTR_CONTIGUOUS, '..', parentClus, 0); a += CDIR;
    for (const [name, v] of [...m].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      if (v instanceof Map) {
        const sz = dirSize(v), c = alloc(sz / BLK);
        entry(a, RS_ATTR_DIR | RS_ATTR_CONTIGUOUS, name, c, sz);
        writeDir(v, name, c, sz, clus);
      } else {
        const n = Math.ceil(v.length / BLK), c = n ? alloc(n) : -1;
        entry(a, RS_ATTR_CONTIGUOUS, name, c, v.length);
        if (n) img.set(v, c * BLK);
      }
      a += CDIR;
    }
  };
  const rootSize = dirSize(tree), root = alloc(rootSize / BLK);
  writeDir(tree, '.', root, rootSize, root);
  // boot block
  const b = off * BLK;
  img[b + 3] = MBR_PT_REDSEA;
  dv.setBigInt64(b + 8, BigInt(off), true);
  dv.setBigInt64(b + 16, BigInt(sects), true);
  dv.setBigInt64(b + 24, BigInt(root), true);
  dv.setBigInt64(b + 32, BigInt(bitmapSects), true);
  dv.setBigUint64(b + 40, BigInt(date.getTime()) * 0x9E3779B1n & 0xFFFFFFFFFFFFFFFFn, true);
  dv.setUint16(b + 510, 0xAA55, true);
  // allocation bitmap at off+1: bit i is block dataArea+i
  for (let i = 0; i < next - dataArea; i++) img[(off + 1) * BLK + (i >> 3)] |= 1 << (i & 7);
  return { img, used: next };
}

// Read a host directory into a tree; later roots override earlier ones.
export function addHostDir(tree, dir, { skip = () => false } = {}) {
  for (const de of fs.readdirSync(dir, { withFileTypes: true })) {
    const hp = path.join(dir, de.name);
    if (skip(hp, de)) continue;
    if (de.isDirectory()) {
      let sub = tree.get(de.name);
      if (!(sub instanceof Map)) tree.set(de.name, sub = new Map());
      addHostDir(sub, hp, { skip });
    } else if (de.isFile()) tree.set(de.name, new Uint8Array(fs.readFileSync(hp)));
  }
  return tree;
}
export function treePut(tree, p, data) {
  const parts = p.split('/').filter(Boolean);
  let t = tree;
  for (const d of parts.slice(0, -1)) { if (!(t.get(d) instanceof Map)) t.set(d, new Map()); t = t.get(d); }
  t.set(parts[parts.length - 1], data);
}

// The standard C: drive.
export function standardTree(root) {
  const tree = new Map();
  addHostDir(tree, path.join(root, 'vendor', 'TempleOS'), { skip: (hp, de) => de.name === '.git' });
  addHostDir(tree, path.join(root, 'port'));
  for (const [bin, dst] of [['Kernel.BIN', '0000Boot/0000Kernel.BIN.C'], ['Compiler.BIN', 'Compiler/Compiler.BIN']]) {
    const hp = path.join(root, 'build', bin);
    if (fs.existsSync(hp)) treePut(tree, dst, new Uint8Array(fs.readFileSync(hp)));
  }
  return tree;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const a = process.argv.find((x) => x.startsWith('-mb='));
  const mb = a ? +a.slice(4) : 128;
  const { img, used } = buildImage(standardTree(root), { mb });
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'C.img'), img);
  console.log(`build/C.img: ${mb} MB, ${(used * BLK / 1048576).toFixed(1)} MB used`);
}
