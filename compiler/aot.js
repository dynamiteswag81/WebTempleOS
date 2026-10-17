// Bootstrap driver: the parts of TempleOS's compiler that tie the front-end
// to the system (CmpCtrlNew/CmpJoin/Cmp from CMain.HC, AOTGlblsResolve from
// AsmResolve.HC, file name handling, the host task for #exe{} blocks), plus
// the hook into the wasm backend.
import fs from 'fs';
import path from 'path';
import * as K from './consts.js';
import { HashTable, HashFind, makeCmpGlbls, CHashFun, CHashGeneric, CHashExport, CompileError, cbase } from './core.js';
import { CCmpCtrl, Lex, LexExcept } from './lex.js';
import {
  LexExpression, PrsStreamBlk, LexStmt2Bin, ExeCmdLine, COCInit, BufPtr, FieldRef,
  ICAdd as ICAddExport,
} from './parse.js';
import { PrsAsmBlk } from './asm.js';
import { HostVM, ICProgram, interpCall, HOST_BASE, icListing } from './interp.js';
import { I64, U64, b2f, f2b } from './util.js';

// Lexer strings keep their NUL terminator; this gives the C string.
export const cstr = (s) => { const i = s.indexOf('\0'); return i < 0 ? s : s.slice(0, i); };

// ------------------------------------------------------------ file names
export function ExtDft(name, ext) {
  const base = name.slice(name.lastIndexOf('/') + 1);
  return base.includes('.') ? name : name + '.' + ext;
}
export function FileNameAbs(name, cur_dir, home = 'C:/Home') {
  let p;
  if (/^[A-Za-z~]:/.test(name)) p = name;
  else if (name.startsWith('::')) p = 'C:' + name.slice(2);
  else if (name.startsWith('~')) p = home + name.slice(1);
  else if (name.startsWith('/')) p = cur_dir.slice(0, 2) + name;
  else p = cur_dir.replace(/\/$/, '') + '/' + name;
  const drv = p.slice(0, 2).toUpperCase();
  const parts = [];
  for (const c of p.slice(2).split('/')) {
    if (!c || c === '.') continue;
    if (c === '..') parts.pop(); else parts.push(c);
  }
  return drv + '/' + parts.join('/');
}

// Files come from the port overlay first, then the TempleOS tree (drive C:).
export class TempleFS {
  constructor(roots) { this.roots = roots; }
  hostPath(abs) {
    const rel = abs.slice(3);
    const cands = [rel];
    if (rel.endsWith('.Z')) cands.push(rel.slice(0, -2));
    for (const r of this.roots) for (const c of cands) {
      const hp = path.join(r, c);
      if (fs.existsSync(hp) && fs.statSync(hp).isFile()) return hp;
    }
    return null;
  }
  read(abs) {
    const hp = this.hostPath(abs);
    return hp ? fs.readFileSync(hp, 'latin1') : null;
  }
}

// ------------------------------------------------------------ OpCodes.DD
function loadAsmHash(text) {
  text = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const ents = [];
  for (let st of text.split(';')) {
    st = st.trim();
    if (!st) continue;
    const w = st.split(/\s+/);
    const kind = w[0], name = w[1];
    switch (kind) {
      case 'R8': case 'R16': case 'R32': case 'R64': case 'SEG': case 'FSTK': case 'MM': case 'XMM':
        ents.push([name, K.HTT_REG, Number(w[2])]); break;
      case 'OPCODE': {
        ents.push([name, K.HTT_OPCODE, 0]);
        const c = st.indexOf(':');
        if (c >= 0) for (const a of st.slice(c + 1).trim().split(/\s+/)) if (a) ents.push([a, K.HTT_OPCODE, 0]);
        break;
      }
      case 'KEYWORD': ents.push([name, K.HTT_KEYWORD, Number(w[2])]); break;
      case 'ASM_KEYWORD': ents.push([name, K.HTT_ASM_KEYWORD, Number(w[2])]); break;
    }
  }
  return ents;
}

// ------------------------------------------------------------ bootstrap
export class Bootstrap {
  constructor({ roots, backend = null, log = console.log, warnings = false }) {
    this.fs = new TempleFS(roots);
    this.log = log;
    this.warnings = warnings;
    this.backend = backend;
    // cmp: CInit/AsmHashLoad
    const asmEnts = loadAsmHash(this.fs.read('C:/Compiler/OpCodes.DD'));
    this.cmp = makeCmpGlbls([]);
    const asm_hash = new HashTable('asm');
    for (const [name, type, v] of asmEnts) asm_hash.add(new CHashGeneric(name, type, v));
    for (const c of this.cmp.asm_hash.entries()) asm_hash.add(c); // internal types after asm keywords
    this.cmp.asm_hash = asm_hash;
    // The host ("Adam") environment #exe{} blocks run in.
    this.vm = new HostVM();
    this.hostTable = new HashTable('host', this.cmp.asm_hash);
    this.cur_dir = 'C:/';
    this.hostOpts = 0n;
    this.builtins = this.makeBuiltins();
    this.env = this.makeEnv();
  }

  // ---------------- host builtins (functions #exe{} blocks call)
  makeBuiltins() {
    const self = this;
    const vm = this.vm;
    const b = new Map();
    const fmtPrint = (fmt, args) => {
      // Enough of StrPrint for #exe{} use: %d %X %s %c %C %D %T %%
      let out = '', ai = 0;
      for (let i = 0; i < fmt.length; i++) {
        const ch = fmt[i];
        if (ch !== '%') { out += ch; continue; }
        let j = i + 1, spec = '';
        while (j < fmt.length && /[-+ 0-9.*thz$]/.test(fmt[j])) spec += fmt[j++];
        const c = fmt[j];
        i = j;
        const a = args[ai++];
        switch (c) {
          case 'd': case 'i': out += I64(a).toString(); break;
          case 'u': out += U64(a).toString(); break;
          case 'X': out += U64(a).toString(16).toUpperCase(); break;
          case 'x': out += U64(a).toString(16); break;
          case 's': out += vm.readStr(a); break;
          case 'c': case 'C': {
            let v = U64(a), cs = '';
            while (v) { cs += String.fromCharCode(Number(v & 255n)); v >>= 8n; }
            out += c === 'C' ? cs.toUpperCase() : cs;
            break;
          }
          case 'D': out += new Date().toISOString().slice(0, 10); break;
          case 'T': out += new Date().toISOString().slice(11, 19); break;
          case '%': out += '%'; ai--; break;
          default: throw new Error('#exe StreamPrint: unsupported format %' + c);
        }
      }
      return out;
    };
    const varargs = (frame, nfixed) => {
      const argc = Number(vm.arg(nfixed, frame));
      const a = [];
      for (let i = 0; i < argc; i++) a.push(vm.arg(nfixed + 1 + i, frame));
      return a;
    };
    b.set('Option', (vm, fr, ctx) => {
      const num = BigInt(vm.arg(0, fr)), val = vm.arg(1, fr);
      const cc = ctx.cc.htc.next ? ctx.cc : ctx.cc; // the compiling cc
      const tgt = ctx.target || cc;
      const old = (tgt.opts >> num) & 1n;
      if (val) tgt.opts |= 1n << num; else tgt.opts &= ~(1n << num);
      return old;
    });
    b.set('GetOption', (vm, fr, ctx) => ((ctx.target || ctx.cc).opts >> BigInt(vm.arg(0, fr))) & 1n);
    b.set('Cd', (vm, fr) => {
      const name = vm.readStr(vm.arg(0, fr));
      if (name) self.cur_dir = FileNameAbs(name, self.cur_dir);
      return 1n;
    });
    b.set('StreamPrint', (vm, fr, ctx) => {
      const s = fmtPrint(vm.readStr(vm.arg(0, fr)), varargs(fr, 1));
      const cc = ctx.target || ctx.cc;
      cc.stream_blks[cc.stream_blks.length - 1].body += s;
      return 0n;
    });
    b.set('StreamDir', (vm, fr, ctx) => {
      const cc = ctx.target || ctx.cc;
      const f = cc.lex_include_stk;
      let name = f.full_name;
      for (let t = f; t; t = t.next) if (t.full_name && t.full_name !== 'StreamBlk' && !(t.flags & K.LFSF_DEFINE) && t.full_name !== 'Tmp') { name = t.full_name; break; }
      const dir = name.slice(0, name.lastIndexOf('/')) || name.slice(0, 2) + '/';
      cc.stream_blks[cc.stream_blks.length - 1].body += '"' + dir + '"';
      return 0n;
    });
    b.set('Now', () => 0n);
    b.set('CAlloc', (vm, fr) => vm.alloc(Number(vm.arg(0, fr))));
    b.set('MAlloc', (vm, fr) => vm.alloc(Number(vm.arg(0, fr))));
    b.set('Free', () => 0n);
    b.set('StrNew', (vm, fr) => vm.str(vm.readStr(vm.arg(0, fr))));
    b.set('StreamDoc', (vm, fr) => {
      if (vm.arg(0, fr)) throw new Error('#exe StreamDoc of a real CDoc is not supported');
      return 0n;
    });
    b.set('PrintWarn', (vm, fr) => { self.log('Warn: ' + fmtPrint(vm.readStr(vm.arg(0, fr)), varargs(fr, 1))); return 0n; });
    return b;
  }

  // ---------------- the cc->env the front-end calls back into
  makeEnv() {
    const self = this, vm = this.vm;
    const env = {
      cmp: this.cmp,
      hash_table: this.hostTable,
      rethrowErrors: true,
      aotMode: false,
      warn: (m) => { if (self.warnings) self.log('Warning: ' + m); },
      includeFile(cc, name) {
        name = cstr(name);
        const abs = FileNameAbs(ExtDft(name, 'HC.Z'), self.cur_dir);
        const text = self.fs.read(abs);
        if (text === null) LexExcept(cc, `File not found: ${abs} `);
        return { name: abs, text };
      },
      LexExpression: (cc) => LexExpression(cc),
      PrsStreamBlk: (cc) => PrsStreamBlk(cc),
      hostHashTable: () => self.hostTable,
      COCCompile(cc, typeOut, dbgOut) {
        const prog = new ICProgram(cc);
        if (typeOut) typeOut.v = exprType(cc);
        if (process.env.HCC_DUMP && cc.htc.fun && process.env.HCC_DUMP.split(',').includes(cc.htc.fun.str))
          self.log(`--- ICs of ${cc.htc.fun.str}:
` + icListing(prog.ics));
        if (cc.flags & K.CCF_AOT_COMPILE) {
          const blob = self.backend ? self.backend.compile(cc, prog) : stubBlob(cc);
          blob.prog = prog;
          return blob;
        }
        return prog;
      },
      Call(cc, mc) {
        const prog = mc && mc.prog ? mc.prog : mc;
        return interpCall(vm, prog, { cc, target: cc.htc.next ? cc : cc, codeAt: (a) => null });
      },
      blobStored(cc, blob, rip) {
        if (self.backend) self.backend.blobStored(cc, blob, rip);
      },
      undefinedExtern(cc, tmpf) {
        const fn = self.builtins.get(tmpf.str);
        return fn ? { hostFn: fn, str: tmpf.str } : { str: tmpf.str, undefinedExtern: true };
      },
      glblAlloc(cc, size) { return vm.alloc(size); },
      glblInitDone() {},
      staticAlloc(cc, tmpm, k) { tmpm.static_data = vm.alloc(k); },
      hostPtr(addr) { return hostPtr(vm, addr); },
      hostBuf(n) { return hostPtr(vm, vm.alloc(n)); },
      staticWrite() {},
      hostStr(cc, s) { return vm.str(s); },
      hostStrRead(cc, addr) { return vm.readStr(addr); },
      asmBlock(cc) {
        if (self.lenientAsm) return lenientAsmBlk(cc);
        Lex(cc);
        PrsAsmBlk(cc);
      },
      // One-line asm in a HolyC function: PrsStmt() does
      // CmpJoin(cc,CMPF_ASM_BLK|CMPF_ONE_ASM_INS) and an IC_ASM with the
      // assembled bytes.  We assemble the operand-less instructions TempleOS
      // uses this way (the backend translates them; see backend IC_ASM).
      asmIns(cc) {
        const bytes = [];
        while (cc.token === K.TK_IDENT && cc.hash_entry && cc.hash_entry.type & K.HTT_OPCODE) {
          if (cc.cur_str === 'INT') { // INT imm8 (Panic's INT I_DBG)
            Lex(cc);
            bytes.push(0xCD, Number(LexExpression(cc) & 255n));
            continue;
          }
          const enc = ONE_ASM_INS[cc.cur_str];
          if (!enc && self.lenientAsm) { // skip the rest of the line
            const tokLine = () => cc.lex_include_stk.line_num - (cc.last_U16 === 10 ? 1 : 0);
            const ln = tokLine();
            while (Lex(cc) && tokLine() === ln);
            continue;
          }
          if (!enc) LexExcept(cc, `asm instruction ${cc.cur_str} must be replaced by port/ files: `);
          bytes.push(...enc);
          Lex(cc);
        }
        const aot = { buf: Uint8Array.from(bytes), aot_U8s: bytes.length, ie: [], abss: [] };
        ICAddExport(cc, K.IC_ASM, aot, null);
      },
    };
    return env;
  }

  newCC(buf, flags, filename) {
    const cc = new CCmpCtrl(this.env, buf, flags, filename);
    COCInit(cc);
    return cc;
  }

  // ExeFile() into the host task: used to give #exe{} blocks the
  // declarations Adam would have (KernelA.HH, CompilerA.HH...).
  hostExeFile(name) {
    const cc = this.newCC(`#include "${name}";`, K.CCF_DONT_FREE_BUF, 'C:/Home/Host');
    Lex(cc);
    ExeCmdLine(cc);
    return cc;
  }

  hostExePutS(text, name = 'C:/Home/HostPrelude') {
    const cc = this.newCC(text, K.CCF_DONT_FREE_BUF, name);
    Lex(cc);
    ExeCmdLine(cc);
  }

  // The host env Adam would provide: TempleOS's own headers for the
  // declarations, plus prototypes (from KernelC.HH/CompilerB.HH) of the
  // functions #exe{} blocks may call, bound to JS builtins.
  hostInit() {
    this.hostExeFile('/Kernel/KernelA.HH');
    this.hostExeFile('/Compiler/CompilerA.HH');
    this.hostExePutS(`
public extern Bool Option(I64 num,Bool val);
public extern Bool GetOption(I64 num);
public extern Bool Cd(U8 *dirname=NULL,Bool make_dirs=FALSE);
public extern U0 StreamPrint(U8 *fmt,...);
extern U0 StreamDir();
public extern U0 StreamDoc(CDoc *doc);
public extern CDate Now();
public extern U8 *MAlloc(I64 size,CTask *mem_task=NULL);
public extern U8 *CAlloc(I64 size,CTask *mem_task=NULL);
public extern U0 Free(U8 *addr);
public extern U8 *StrNew(U8 *buf,CTask *mem_task=NULL);
public extern U0 PrintWarn(U8 *fmt,...);
CBlkDevGlbls blkdev; //Install-time device info KMain's #exe{} reads (none: zeros).
`);
  }

  // Cmp(): AOT compile a PRJ/HC file into a TempleOS BIN.
  Cmp(filename) {
    const fbuf = FileNameAbs(ExtDft(filename, 'PRJ.Z'), this.cur_dir);
    const cc = this.newCC(`#include "${fbuf}"`, K.CCF_DONT_FREE_BUF, 'C:/Home/Cmp');
    cc.flags |= K.CCF_AOT_COMPILE;
    const aot = CmpJoin(this, cc, K.CMPF_LEX_FIRST);
    return { aot, cc, bin: writeBin(aot) };
  }
}

// The *_type result of OptPass4 (COCCompile): the raw type of what
// IC_RETURN_VAL/IC_RETURN_VAL2 returns.
export function exprType(cc) {
  let type = K.RT_I64;
  for (let t = cc.coc.head.next; t !== cc.coc.head; t = t.next) {
    if (t.code !== K.IC_RETURN_VAL && t.code !== K.IC_RETURN_VAL2) continue;
    if (!t.cls) {
      for (let l = t.last; l !== cc.coc.head; l = l.last) {
        if (l.code === K.IC_NOP1 || l.code === K.IC_NOP2) continue;
        if (l.cls) {
          if (l.flags & K.ICF_RES_TO_F64) type = K.RT_F64;
          else if (l.flags & K.ICF_RES_TO_INT) type = K.RT_I64;
          else type = l.cls.raw_type;
          break;
        }
      }
    } else type = t.cls.raw_type;
  }
  return type;
}

// x86 encodings of the operand-less instructions used inline in HolyC.
export const ONE_ASM_INS = {
  CLI: [0xFA], STI: [0xFB], PUSHFD: [0x9C], POPFD: [0x9D], PAUSE: [0xF3, 0x90], HLT: [0xF4],
  NOP: [0x90], CLD: [0xFC], STD: [0xFD], WBINVD: [0x0F, 0x09], INVD: [0x0F, 0x08],
  LFENCE: [0x0F, 0xAE, 0xE8], MFENCE: [0x0F, 0xAE, 0xF0], SFENCE: [0x0F, 0xAE, 0xF8],
  FNINIT: [0xDB, 0xE3], FWAIT: [0x9B], INT3: [0xCC], CPUID: [0x0F, 0xA2], RDTSC: [0x0F, 0x31],
  MOV_RAX_CR2: [0x0F, 0x20, 0xD0],
};

// Front-end testing aid: skip an asm{} block, defining its labels (val 0).
function lenientAsmBlk(cc) {
  const old = cc.flags & K.CCF_ASM_EXPRESSIONS;
  cc.flags |= K.CCF_ASM_EXPRESSIONS;
  if (Lex(cc) !== 123) LexExcept(cc, "Expecting '{' at ");
  Lex(cc);
  let depth = 0;
  while (cc.token) {
    if (cc.token === 123) depth++;
    else if (cc.token === 125) { if (!depth--) break; }
    if (cc.token === K.TK_IDENT && !(cc.hash_entry && cc.hash_entry.type & (K.HTT_REG | K.HTT_OPCODE | K.HTT_ASM_KEYWORD))) {
      const name = cc.cur_str;
      const t = Lex(cc);
      if (t === 58 || t === K.TK_DBL_COLON) {
        const ex = new CHashExport(name, K.HTT_EXPORT_SYS_SYM | (t === K.TK_DBL_COLON ? K.HTF_EXPORT : 0));
        ex.val = 0n;
        (name.startsWith('@@') ? cc.htc.local_hash_table : cc.htc.glbl_hash_table).add(ex);
        Lex(cc);
      }
      continue;
    }
    Lex(cc);
  }
  cc.flags = (cc.flags & ~K.CCF_ASM_EXPRESSIONS) | old;
  // The caller's PrsStmt expects the '}' to be the current token for
  // global asm blocks (it Lex()es past it).
  Lex(cc);
}

function hostPtr(vm, addr) {
  const p = new BufPtr(vm.mem, Number(addr) - HOST_BASE);
  p.hostAddr = addr;
  return p;
}

// Before the backend exists: a blob is a descriptor plus the string consts.
function stubBlob(cc) {
  const bytes = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const m of cc.coc.misc) if (m.type === K.CMT_STR_CONST) for (let i = 0; i < m.st_len; i++) bytes.push(m.str.charCodeAt(i) & 255 || 0);
  while (bytes.length & 7) bytes.push(0);
  return { bytes };
}

// ------------------------------------------------------------ AOT
export class ByteBuf {
  constructor() { this.a = new Uint8Array(1 << 16); }
  set(i, b) {
    if (i >= this.a.length) { const n = new Uint8Array(Math.max(this.a.length * 2, i + 1)); n.set(this.a); this.a = n; }
    this.a[i] = b;
  }
  get(i) { return i < this.a.length ? this.a[i] : 0; }
  slice(n) { const r = new Uint8Array(n); r.set(this.a.subarray(0, Math.min(n, this.a.length))); return r; }
}

// CmpJoin() for the AOT case.
export function CmpJoin(boot, cc, cmp_flags) {
  const res = { parent_aot: cc.aot || null, ie: [], buf: null, aot_U8s: 0, abss: [], heap_glbls: [], max_align_bits: 0, org: null };
  cc.aot = res;
  const old_aotc = cc.aotc;
  const aotc = cc.aotc = { rip: 0, bin: new ByteBuf(), num_bin_U8s: 0, abss: [], heap_glbls: [], max_align_bits: 0, org: null };
  if (boot.backend) boot.backend.beginModule(cc, aotc);
  cc.aot_depth++;
  const htc = { ...cc.htc };
  cc.htc.glbl_hash_table = new HashTable('glbl');
  if (cc.flags & K.CCF_AOT_COMPILE) {
    cc.htc.define_hash_table = cc.htc.glbl_hash_table;
    cc.htc.glbl_hash_table.next = cc.aot_depth <= 1 ? boot.cmp.asm_hash : htc.glbl_hash_table;
  } else cc.htc.glbl_hash_table.next = boot.hostTable;
  cc.htc.hash_table_lst = cc.htc.local_hash_table = new HashTable('local', cc.htc.glbl_hash_table);
  if (boot.backend && cc.aot_depth === 1) boot.backend.predefine(cc);
  cc.htc.local_var_lst = cc.htc.fun;
  cc.htc.fun = null;
  if (cmp_flags & K.CMPF_LEX_FIRST) Lex(cc);
  if (!(cmp_flags & K.CMPF_ONE_ASM_INS)) cmp_flags |= K.CMPF_PRS_SEMICOLON;
  while (cc.token !== K.TK_EOF) {
    const buf = LexStmt2Bin(cc, null, cmp_flags);
    if (buf !== null && buf !== undefined) res.ie.push({ type: K.IET_MAIN, rip: buf, str: null, flags: 0 });
    if (cmp_flags & K.CMPF_ASM_BLK) break;
  }
  AOTGlblsResolve(cc, res);
  res.glbl_hash_table = cc.htc.glbl_hash_table;
  res.buf = aotc.bin.slice(aotc.num_bin_U8s);
  res.aot_U8s = aotc.num_bin_U8s;
  res.abss = aotc.abss;
  res.heap_glbls = aotc.heap_glbls;
  res.max_align_bits = aotc.max_align_bits;
  res.org = aotc.org;
  if (boot.backend) { res.wasm = boot.backend.endModule(cc, aotc, res); res.ntable = boot.backend.ntable; }
  cc.aot = res.parent_aot;
  Object.assign(cc.htc, htc);
  cc.aotc = old_aotc;
  cc.aot_depth--;
  return res;
}

// AOTGlblsResolve(): exports of everything HTF_EXPORT, import entries for
// everything HTF_IMPORT that was used, CALL_EXTERN fixups (HTF_RESOLVE).
function AOTGlblsResolve(cc, tmpaot) {
  for (const tmpex of cc.htc.glbl_hash_table.entries()) {
    if (tmpex.type & (K.HTF_IMPORT | K.HTF_GOTO_LABEL)) {
      if (tmpex.use_cnt && tmpex.ie_lst && tmpex.ie_lst.length) {
        const str = tmpex.import_name || tmpex.str;
        tmpex.ie_lst.forEach((ie, i) => { if (i === 0) ie.str = str; tmpaot.ie.push(ie); });
        tmpex.ie_lst = null;
      }
    } else if (tmpex.type & (K.HTF_EXPORT | K.HTF_RESOLVE)) {
      if (tmpex.type & K.HTF_UNRESOLVED) LexExcept(cc, `Undefined sym at ${tmpex.str} `);
      if (tmpex.type & K.HTF_RESOLVE) {
        // CALL_EXTERN sites are resolved by the backend at endModule().
        if (tmpex.type & K.HTT_FUN && tmpex.flags & (1 << K.Cf_EXTERN))
          LexExcept(cc, `Undefined sym at ${tmpex.str} `);
      }
      if (tmpex.type & K.HTF_EXPORT) {
        let rip;
        if (tmpex.type & K.HTT_FUN) rip = Number(tmpex.exe_addr);
        else if (tmpex.type & K.HTT_GLBL_VAR) rip = tmpex.data_addr_rip;
        else rip = Number(tmpex.val);
        let type = K.IET_REL32_EXPORT;
        if (tmpex.type & K.HTF_IMM) type++;
        tmpaot.ie.push({ type, rip, str: tmpex.str, flags: 0, src_link: tmpex.src_link });
      }
    }
  }
}

// The patch table and CBinFile header of Cmp() (CMain.HC).  The wasm module
// is appended after the patch table, with a 16 byte trailer locating it.
export function writeBin(aot) {
  const pt = [];
  const u8 = (b) => pt.push(b & 255);
  const u32 = (v) => { for (let i = 0; i < 4; i++) pt.push((v >>> (8 * i)) & 255); };
  const i64 = (v) => { v = BigInt.asUintN(64, BigInt(v)); for (let i = 0n; i < 8n; i++) pt.push(Number((v >> (8n * i)) & 255n)); };
  const str = (s) => { if (s) for (let i = 0; i < s.length; i++) u8(s.charCodeAt(i)); u8(0); };
  const abss = aot.abss.filter((a) => !(a.type & K.IEF_IMM_NOT_REL));
  if (abss.length) {
    u8(K.IET_ABS_ADDR); u32(abss.length); u8(0);
    for (const a of abss) u32(a.rip);
  }
  for (const hg of aot.heap_glbls) {
    if (!hg.references.length) continue;
    u8(K.IET_DATA_HEAP); u32(hg.references.length); str(hg.str);
    i64(hg.size);
    for (const r of hg.references) u32(r);
  }
  const exports = aot.ie.filter((ie) => !ie.type || (K.IET_REL32_EXPORT <= ie.type && ie.type <= K.IET_IMM64_EXPORT));
  const imports = aot.ie.filter((ie) => !exports.includes(ie));
  for (const ie of exports) { u8(ie.type); u32(ie.rip); str(ie.str); }
  for (const ie of imports) { u8(ie.type); u32(ie.rip); str(ie.str); }
  u8(K.IET_END);
  const HDR = 32;
  const ptLen = pt.length;
  for (let i = 0; i < 16; i++) pt.push(0);
  let size = (HDR + aot.aot_U8s + ptLen + 15) & -16;
  const wasm = aot.wasm || new Uint8Array(0);
  const wasmOff = size;
  const total = wasm.length ? ((wasmOff + wasm.length + 15) & -16) + 16 : size;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0xEB + 256 * (HDR - 2), true); // jmp
  out[2] = aot.max_align_bits;
  out[3] = 0;
  dv.setUint32(4, 0x42534F54, true); // 'TOSB'
  dv.setBigInt64(8, aot.org === null ? 0x7FFFFFFFFFFFFFFFn : BigInt(aot.org), true);
  dv.setBigInt64(16, BigInt(HDR + aot.aot_U8s), true);
  dv.setBigInt64(24, BigInt(total), true);
  out.set(aot.buf, HDR);
  out.set(pt.slice(0, Math.min(pt.length, size - HDR - aot.aot_U8s)), HDR + aot.aot_U8s);
  if (wasm.length) {
    out.set(wasm, wasmOff);
    dv.setUint32(total - 16, wasmOff, true);
    dv.setUint32(total - 12, wasm.length, true);
    dv.setUint32(total - 8, 0x4D534157, true); // 'WASM'
    dv.setUint32(total - 4, aot.ntable || 0, true); // table entries the module needs
  }
  return out;
}
