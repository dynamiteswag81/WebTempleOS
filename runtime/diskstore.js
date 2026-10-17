// The C: drive in the browser: the image built by tools/mkdisk.js, with the
// sectors TempleOS writes kept in IndexedDB so files survive a reload.
// Written sectors are saved in 64K chunks (an overlay on the base image),
// keyed by the base image's identity: a new build/C.img starts clean.
const CHUNK = 65536, DB = 'WebTempleOS', STORE = 'chunks', META = 'meta';

function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

export class DiskStore {
  static async open() {
    const o = indexedDB.open(DB, 1);
    o.onupgradeneeded = () => { o.result.createObjectStore(STORE); o.result.createObjectStore(META); };
    const s = new DiskStore();
    s.db = await req(o);
    s.dirty = new Set();
    return s;
  }
  tx(mode, ...stores) { return this.db.transaction(stores, mode); }
  // Apply the saved chunks to img if they belong to this base image.
  async load(img, baseId) {
    const t = this.tx('readwrite', STORE, META);
    const id = await req(t.objectStore(META).get('base'));
    this.img = img;
    if (id !== baseId) {
      await req(t.objectStore(STORE).clear());
      await req(t.objectStore(META).put(baseId, 'base'));
      return 0;
    }
    const keys = await req(t.objectStore(STORE).getAllKeys());
    for (const k of keys) {
      const data = await req(t.objectStore(STORE).get(k));
      img.set(new Uint8Array(data), k * CHUNK);
    }
    return keys.length;
  }
  // the ATA device's write hook
  written(lba, n) {
    for (let a = lba * 512, e = (lba + n) * 512; a < e; a += CHUNK - (a % CHUNK)) this.dirty.add(Math.floor(a / CHUNK));
  }
  async flush() {
    if (!this.dirty.size) return 0;
    const ks = [...this.dirty]; this.dirty.clear();
    const t = this.tx('readwrite', STORE);
    for (const k of ks) t.objectStore(STORE).put(this.img.slice(k * CHUNK, (k + 1) * CHUNK).buffer, k);
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
    return ks.length;
  }
  async reset() {
    const t = this.tx('readwrite', STORE, META);
    await req(t.objectStore(STORE).clear());
    await req(t.objectStore(META).delete('base'));
  }
}
