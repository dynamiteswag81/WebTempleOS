// Core data structures of the HolyC front-end: hash tables, classes,
// member lists and the compile-control object.  Mirrors TempleOS's
// KernelA.HH structures (CHash, CHashClass, CHashFun, CMemberLst, ...)
// closely so the ported parser reads like the original HolyC.
import * as K from './consts.js';

export class CompileError extends Error {
  constructor(msg, where) { super(msg + (where ? ' ' + where : '')); this.holyc = true; }
}

// ---------------------------------------------------------------- hashes
export class HashTable {
  constructor(name = '', next = null) { this.map = new Map(); this.next = next; this.name = name; }
  add(h) {
    let a = this.map.get(h.str);
    if (!a) this.map.set(h.str, a = []);
    a.push(h);
    h.table = this;
  }
  // Insert so that h is found just after 'after' (HashAddAfter).
  addAfter(h, after) {
    let a = this.map.get(h.str);
    if (!a) { this.add(h); return; }
    const i = a.indexOf(after);
    if (i < 0) a.push(h); else a.splice(i, 0, h);
    h.table = this;
  }
  remove(h) {
    const a = this.map.get(h.str);
    if (!a) return;
    const i = a.lastIndexOf(h);
    if (i >= 0) a.splice(i, 1);
  }
  findSingle(str, mask) {
    const a = this.map.get(str);
    if (a) for (let i = a.length - 1; i >= 0; i--)
      if (a[i].type & mask) { a[i].use_cnt++; return a[i]; }
    return null;
  }
}
export function HashFind(str, table, mask) {
  for (let t = table; t; t = t.next) {
    const h = t.findSingle(str, mask);
    if (h) return h;
  }
  return null;
}
export function HashSingleTableFind(str, table, mask) {
  return table ? table.findSingle(str, mask) : null;
}

let hashSerial = 0;
export class CHash {
  constructor(str, type) {
    this.str = str; this.type = type >>> 0; this.use_cnt = 0; this.id = ++hashSerial;
    this.src_link = null; this.idx = null; this.import_name = null;
  }
}

// A class is represented by PTR_STARS_NUM+1 level objects; level k is the
// class pointed to k times.  TempleOS does "tmpc+1"/"tmpc-1" on these.
export class CHashClass extends CHash {
  constructor(type = K.HTT_CLASS) {
    super(null, type);
    this.size = 0; this.neg_offset = 0; this.member_cnt = 0;
    this.ptr_stars_cnt = 0; this.raw_type = K.RT_PTR; this.flags = 0;
    this.member_lst_and_root = null; this.member_class_base_root = null;
    this.member_lst = []; // ordered list (TempleOS ->next chain)
    this.base_class = null; this.fwd_class = null;
    this.lvl = null;
  }
}
export class CHashFun extends CHashClass {
  constructor() {
    super(K.HTT_FUN);
    this.return_class = null; this.arg_cnt = 0;
    this.used_reg_mask = 0; this.clobbered_reg_mask = 0;
    this.exe_addr = 0; this.ext_lst = null;
  }
}
function makeLevels(Ctor, type) {
  const lv = [];
  for (let i = 0; i <= K.PTR_STARS_NUM; i++) {
    const c = new Ctor();
    c.type = type; c.raw_type = K.RT_PTR; c.size = 8; c.ptr_stars_cnt = i; c.lvl = lv;
    lv.push(c);
  }
  lv[0].size = 0;
  return lv[0];
}
export function PrsClassNew() { return makeLevels(CHashClass, K.HTT_CLASS); }
export function PrsFunNew() { return makeLevels(CHashFun, K.HTT_FUN); }
// tmpc+n
export function cadd(c, n = 1) {
  if (!c) return c;
  const r = c.lvl[c.ptr_stars_cnt + n];
  if (!r) throw new CompileError('Too many *\'s');
  return r;
}
export const csub = (c, n = 1) => cadd(c, -n);
export const cbase = (c) => (c ? c.lvl[0] : c);
export function OptClassFwd(c) {
  while (c && c.fwd_class) c = c.fwd_class;
  return c;
}

export class CHashExport extends CHash {
  constructor(str, type) { super(str, type); this.val = 0n; }
}
export class CHashGlblVar extends CHash {
  constructor(str) {
    super(str, K.HTT_GLBL_VAR);
    this.size = 0; this.flags = 0; this.var_class = null; this.fun_ptr = null;
    this.dim = { next: null, cnt: 0, total_cnt: 0 }; this.data_addr = 0;
  }
}
export class CHashDefineStr extends CHash {
  constructor(str) { super(str, K.HTT_DEFINE_STR); this.data = ''; this.cnt = -1; }
}
export class CHashGeneric extends CHash {
  constructor(str, type, d0 = 0) { super(str, type); this.user_data0 = d0; this.user_data1 = 0; this.user_data2 = 0; }
}

export class CMemberLst {
  constructor(reg) {
    this.next = null; this.left = null; this.right = null;
    this.left_class_base = null; this.right_class_base = null;
    this.str = null; this.member_class = null; this.member_class_base = null;
    this.meta = null; this.use_cnt = 0; this.flags = 0; this.reg = reg;
    this.offset = 0; this.size = 0;
    this.dim = { next: null, cnt: 0, total_cnt: 1 };
    this.static_data = 0; this.dft_val = 0n; this.fun_ptr = null;
  }
}

export function MemberFind(needle, cls) {
  do {
    let m = cls.member_lst_and_root;
    while (m) {
      if (m.str === needle) { m.use_cnt++; return m; }
      m = (m.str < needle) ? m.left : m.right;
    }
  } while ((cls = cls.base_class));
  return null;
}

// --------------------------------------------------------- internal types
export const INTERNAL_TYPES = [
  [K.RT_I0, 0, 'I0i'], [K.RT_I0, 0, 'I0'], [K.RT_U0, 0, 'U0i'], [K.RT_U0, 0, 'U0'],
  [K.RT_I8, 1, 'I8i'], [K.RT_I8, 1, 'I8'], [K.RT_I8, 1, 'Bool'],
  [K.RT_U8, 1, 'U8i'], [K.RT_U8, 1, 'U8'],
  [K.RT_I16, 2, 'I16i'], [K.RT_U16, 2, 'U16i'],
  [K.RT_I32, 4, 'I32i'], [K.RT_U32, 4, 'U32i'],
  [K.RT_I64, 8, 'I64i'], [K.RT_U64, 8, 'U64i'],
  [K.RT_F64, 8, 'F64i'], [K.RT_F64, 8, 'F64'],
];

export const KEYWORDS = {
  include: 0, define: 1, union: 2, catch: 3, class: 4, try: 5, if: 6, else: 7,
  for: 8, while: 9, extern: 10, _extern: 11, return: 12, sizeof: 13, _intern: 14,
  do: 15, asm: 16, goto: 17, exe: 18, break: 19, switch: 20, start: 21, end: 22,
  case: 23, default: 24, public: 25, offset: 26, import: 27, _import: 28,
  ifdef: 29, ifndef: 30, ifaot: 31, ifjit: 32, endif: 33, assert: 34, reg: 35,
  noreg: 36, lastclass: 37, no_warn: 38, help_index: 39, help_file: 40,
  static: 41, lock: 42, defined: 43, interrupt: 44, haserrcode: 45,
  argpop: 46, noargpop: 47,
};

// The compiler-wide tables (TempleOS "cmp" global).
export function makeCmpGlbls() {
  const asm_hash = new HashTable('asm');
  for (const k in KEYWORDS) asm_hash.add(new CHashGeneric(k, K.HTT_KEYWORD, KEYWORDS[k]));
  const internal_types = [];
  for (const [rt, size, name] of INTERNAL_TYPES) {
    const c = PrsClassNew();
    for (const l of c.lvl) l.type = K.HTT_INTERNAL_TYPE;
    c.raw_type = rt; c.flags |= 1 << K.Cf_INTERNAL_TYPE; c.size = size; c.str = name;
    asm_hash.add(c);
    internal_types[rt] = c;
  }
  return { asm_hash, internal_types, compiled_lines: 0 };
}

// Opcodes that may appear as one-instruction asm statements inside HolyC
// functions.  We only support the handful the kernel/Adam use.
export const ASM_OPCODES = ['CLI', 'STI', 'PUSHFD', 'POPFD', 'PAUSE', 'HLT', 'NOP',
  'CLD', 'STD', 'WBINVD', 'INVD', 'FNINIT', 'FWAIT', 'LFENCE', 'MFENCE', 'SFENCE'];
