// Port of TempleOS Compiler/PrsLib.HC, PrsExp.HC, PrsVar.HC, PrsStmt.HC.
// This is a literal port: it keeps the AOT (CCF_AOT_COMPILE) and JIT code
// paths of the original, so the ICs it generates are the ones TempleOS's own
// compiler generates.  Things that need the surrounding system (COCCompile,
// Call(), the host task for #exe{} blocks) go through cc.env / aot.js.
import * as K from './consts.js';
import {
  CompileError, HashFind, HashSingleTableFind, HashTable, PrsClassNew, PrsFunNew, cadd, csub, cbase,
  OptClassFwd, CHashExport, CHashGlblVar, CMemberLst, MemberFind, members,
} from './core.js';
import {
  Lex, LexExcept, LexWarn, LexGetChar, LexPush, LexPopRestore, LexPopNoRestore, LexExtStr,
  PrsKeyWord, srcLink, LexIncludeStr,
} from './lex.js';
import { I64, U64, f2b, b2f, f2i, bsf, bsr } from './util.js';
import { OptPass012, OptFree, intermediate_code_table } from './opt.js';

const bt = (flags, bit) => ((flags >> bit) & 1) !== 0;
const ccbt = (cc, bitBig) => (cc.flags & bitBig) !== 0n;
const RT = (cc, rt) => cc.cmp.internal_types[rt];
const AOT = (cc) => (cc.flags & K.CCF_AOT_COMPILE) !== 0n;
export const optOn = (cc, n) => ((cc.opts >> BigInt(n)) & 1n) !== 0n;
const throwCompiler = (cc) => { throw new CompileError('Compiler', cc.lastError ? cc.lastError.message : ''); };

// ------------------------------------------------------------- PrsLib
export class CIC {
  constructor() {
    this.next = this; this.last = this;
    this.code = 0; this.prec = 0; this.data = 0n; this.cls = null; this.cls2 = null;
    this.flags = 0; this.line = 0;
    this.t = { arg1_class: null, arg2_class: null, arg1_tree: null, arg2_tree: null, class2: null };
    this.arg1_type_pointed_to = 0;
  }
}
export function QueIns(e, pred) { const s = pred.next; e.next = s; e.last = pred; pred.next = e; s.last = e; }
export function QueRem(e) { e.last.next = e.next; e.next.last = e.last; }

export function PrsPush(ps, v) { ps.stk[++ps.ptr] = v; }
export function PrsPop(ps) { return ps.stk[ps.ptr--]; }
export function PrsPush2(ps, v) { ps.stk2[++ps.ptr2] = v; }
export function PrsPop2(ps) { return ps.stk2[ps.ptr2--]; }
export function newPrsStk() { return { ptr: 0, stk: [], ptr2: 0, stk2: [] }; }
function PrsPopDeref(ps) {
  const i = PrsPop(ps), c = PrsPop(ps);
  if ((i & 0xFFFF) !== K.IC_DEREF) { PrsPush(ps, c); PrsPush(ps, i); }
}

export function ICAdd(cc, opcode_and_prec, arg, c, flags = 0) {
  const t = new CIC();
  t.code = opcode_and_prec & 0xFFFF;
  t.prec = (opcode_and_prec >>> 16) & 0xFFFF;
  t.data = arg;
  t.cls = c;
  if (cc.lock_cnt) flags |= K.ICF_LOCK;
  t.flags = flags;
  t.line = cc.last_line_num;
  QueIns(t, cc.coc.head.last);
  return t;
}
// cc.coc is a CCodeCtrl: {coc_next, head (sentinel IC), misc (array of CCodeMisc)}
export function COCInit(cc) {
  const h = new CIC(); h.code = K.IC_END; h.sentinel = true;
  cc.coc.head = h; cc.coc.misc = [];
}
export function COCPush(cc) {
  cc.coc.coc_next = { head: cc.coc.head, misc: cc.coc.misc, coc_next: cc.coc.coc_next };
}
export function COCPopNoFree(cc) {
  const b = cc.coc.coc_next;
  cc.coc.head = b.head; cc.coc.misc = b.misc; cc.coc.coc_next = b.coc_next;
  return b;
}
export const COCPop = COCPopNoFree;
export function COCAppend(cc, b) {
  const h = b.head;
  if (h.next !== h && h !== cc.coc.head) {
    const first = h.next, last = h.last, ch = cc.coc.head;
    ch.last.next = first; first.last = ch.last;
    ch.last = last; last.next = ch;
    h.next = h.last = h;
  }
  if (b.misc !== cc.coc.misc) for (const m of b.misc) cc.coc.misc.push(m);
}
let miscSerial = 0;
export function COCMiscNew(cc, ty) {
  const m = { type: ty, flags: 0, str: null, use_cnt: 0, addr: -1, fwd: null, dft: null, begin: null,
    range: 0, st_len: 0, jmp_table: null, h: null, dim: null, id: ++miscSerial };
  cc.coc.misc.push(m);
  return m;
}
export function COCGoToLabelFind(cc, name) {
  for (const m of cc.coc.misc)
    if ((m.type === K.CMT_GOTO_LABEL || m.type === K.CMT_ASM_LABEL) && m.str === name) return m;
  return null;
}
// COCDel(): the only semantic part is the undefined goto label check.
export function COCDel(cc, coc) {
  let undef = null;
  for (const cm of coc.misc) {
    if ((cm.type === K.CMT_GOTO_LABEL || cm.type === K.CMT_ASM_LABEL) && !(cm.flags & K.CMF_DEFINED)) undef = cm.str;
  }
  if (undef) LexExcept(cc, `Undefined goto label ${undef} at `);
}

function HashSrcFileSet(cc, h, line_offset = 0) {
  const f = cc.lex_include_stk;
  h.src_link = f ? `FL:${f.full_name},${f.line_num + line_offset}` : null;
}
function UnusedExternWarning(cc, h) {
  if (cc.env.warn) cc.env.warn(`Unused extern '${h.str}'`);
  cc.warning_cnt++;
}

// ------------------------------------------------------------- PrsExp
const PE_UNARY_TERM1 = 0, PE_UNARY_TERM2 = 1, PE_MAYBE_MODIFIERS = 2, PE_UNARY_MODIFIERS = 3,
  PE_DEREFERENCE = 4, PE_CHECK_BINARY_OPS1 = 5, PE_CHECK_BINARY_OPS2 = 6, PE_DO_UNARY_OP = 7,
  PE_DO_BINARY_OP = 8, PE_POP_HIGHER = 9, PE_PUSH_LOWER = 10, PE_POP_ALL1 = 11, PE_POP_ALL2 = 12;

// cmp.binary_ops from CmpFillTables()
const binary_ops = {};
binary_ops[96] = ((K.PREC_EXP + K.ASSOCF_RIGHT) << 16) + K.IC_POWER;
binary_ops[K.TK_SHL] = ((K.PREC_EXP + K.ASSOCF_LEFT) << 16) + K.IC_SHL;
binary_ops[K.TK_SHR] = ((K.PREC_EXP + K.ASSOCF_LEFT) << 16) + K.IC_SHR;
binary_ops[42] = (K.PREC_MUL << 16) + K.IC_MUL;
binary_ops[47] = ((K.PREC_MUL + K.ASSOCF_LEFT) << 16) + K.IC_DIV;
binary_ops[37] = ((K.PREC_MUL + K.ASSOCF_LEFT) << 16) + K.IC_MOD;
binary_ops[38] = (K.PREC_AND << 16) + K.IC_AND;
binary_ops[94] = (K.PREC_XOR << 16) + K.IC_XOR;
binary_ops[124] = (K.PREC_OR << 16) + K.IC_OR;
binary_ops[43] = (K.PREC_ADD << 16) + K.IC_ADD;
binary_ops[45] = ((K.PREC_ADD + K.ASSOCF_LEFT) << 16) + K.IC_SUB;
binary_ops[60] = (K.PREC_CMP << 16) + K.IC_LESS;
binary_ops[62] = (K.PREC_CMP << 16) + K.IC_GREATER;
binary_ops[K.TK_LESS_EQU] = (K.PREC_CMP << 16) + K.IC_LESS_EQU;
binary_ops[K.TK_GREATER_EQU] = (K.PREC_CMP << 16) + K.IC_GREATER_EQU;
binary_ops[K.TK_EQU_EQU] = (K.PREC_CMP2 << 16) + K.IC_EQU_EQU;
binary_ops[K.TK_NOT_EQU] = (K.PREC_CMP2 << 16) + K.IC_NOT_EQU;
binary_ops[K.TK_AND_AND] = (K.PREC_AND_AND << 16) + K.IC_AND_AND;
binary_ops[K.TK_XOR_XOR] = (K.PREC_XOR_XOR << 16) + K.IC_XOR_XOR;
binary_ops[K.TK_OR_OR] = (K.PREC_OR_OR << 16) + K.IC_OR_OR;
const AS = (K.PREC_ASSIGN + K.ASSOCF_RIGHT) << 16;
binary_ops[61] = AS + K.IC_ASSIGN;
binary_ops[K.TK_SHL_EQU] = AS + K.IC_SHL_EQU;
binary_ops[K.TK_SHR_EQU] = AS + K.IC_SHR_EQU;
binary_ops[K.TK_MUL_EQU] = AS + K.IC_MUL_EQU;
binary_ops[K.TK_DIV_EQU] = AS + K.IC_DIV_EQU;
binary_ops[K.TK_MOD_EQU] = AS + K.IC_MOD_EQU;
binary_ops[K.TK_AND_EQU] = AS + K.IC_AND_EQU;
binary_ops[K.TK_OR_EQU] = AS + K.IC_OR_EQU;
binary_ops[K.TK_XOR_EQU] = AS + K.IC_XOR_EQU;
binary_ops[K.TK_ADD_EQU] = AS + K.IC_ADD_EQU;
binary_ops[K.TK_SUB_EQU] = AS + K.IC_SUB_EQU;

const u8_2 = (x) => (x >>> 16) & 0xFF;
const u8_3 = (x) => (x >>> 24) & 0xFF;
const u16_0 = (x) => x & 0xFFFF;
const i8_2 = (x) => ((x >>> 16) << 24) >> 24;
const setu8_2 = (x, v) => ((x & ~0xFF0000) | ((v & 0xFF) << 16)) >>> 0;

function ParenWarning(cc) {
  if (optOn(cc, K.OPTf_WARN_PAREN) && !(cc.lex_include_stk.flags & K.LFSF_DEFINE))
    LexWarn(cc, 'Unnecessary parenthesis ');
}

function PrsAddOp(cc, stk_op, tmpc) {
  let tmpi = cc.coc.head.last;
  let div_sizeof = false;
  switch (u16_0(stk_op)) {
    case K.IC_ADD:
      if (tmpc.ptr_stars_cnt && !tmpi.cls.ptr_stars_cnt && tmpi.cls.raw_type !== K.RT_F64) {
        ICAdd(cc, K.IC_SIZEOF, 1n, RT(cc, K.RT_I64));
        ICAdd(cc, K.IC_MUL, 0n, RT(cc, K.RT_I64));
      }
      break;
    case K.IC_SUB:
      if (tmpc.ptr_stars_cnt && tmpi.cls.raw_type !== K.RT_F64) {
        if (!tmpi.cls.ptr_stars_cnt) {
          ICAdd(cc, K.IC_SIZEOF, 1n, RT(cc, K.RT_I64));
          ICAdd(cc, K.IC_MUL, 0n, RT(cc, K.RT_I64));
        } else div_sizeof = true;
      }
      break;
    case K.IC_AND_AND: case K.IC_OR_OR:
      ICAdd(cc, K.IC_NOP1, 0n, RT(cc, K.RT_I64));
      break;
    case K.IC_ADD_EQU: case K.IC_SUB_EQU:
      if (tmpc.ptr_stars_cnt) {
        ICAdd(cc, K.IC_SIZEOF, 1n, RT(cc, K.RT_I64));
        ICAdd(cc, K.IC_MUL, 0n, RT(cc, K.RT_I64));
      }
      break;
  }
  tmpi = ICAdd(cc, stk_op, 0n, tmpc);
  if (u8_3(stk_op) & K.ECF_HAS_PUSH_CMP) {
    tmpi.flags |= K.ICF_POP_CMP;
    ICAdd(cc, K.IC_NOP1, 0n, RT(cc, K.RT_I64));
    ICAdd(cc, K.IC_AND_AND, 0n, RT(cc, K.RT_I64), K.ICF_POP_CMP);
  }
  if (div_sizeof) {
    tmpc = csub(tmpc);
    if (tmpc.size !== 1) {
      ICAdd(cc, K.IC_IMM_I64, BigInt(tmpc.size), RT(cc, K.RT_I64));
      ICAdd(cc, K.IC_DIV, 0n, RT(cc, K.RT_I64));
    }
  }
  return tmpi;
}

function PrsExpression2(cc, ps, ctx) {
  let i = 0, cur_op = 0, stk_op = 0, state, max_prec = K.PREC_NULL, left_prec = K.PREC_MAX;
  let tmpi, tmpc;
  // unary_pre_prec, unary_post_prec, paren_prec, local_var, tmpad are passed
  // by reference to PrsUnaryTerm/PrsUnaryModifier in the original.
  const v = { local_var: null, tmpad: null, unary_pre_prec: 0, unary_post_prec: 0, paren_prec: 0, max_prec: K.PREC_NULL };
  state = PE_UNARY_TERM1;
  for (;;) {
    switch (state) {
      case PE_UNARY_TERM1:
        v.unary_pre_prec = K.PREC_NULL;
        v.unary_post_prec = K.PREC_NULL;
        cc.flags &= ~(K.CCF_PAREN | K.CCF_PREINC | K.CCF_PREDEC | K.CCF_POSTINC | K.CCF_POSTDEC | K.CCF_FUN_EXP);
      // fallthrough
      case PE_UNARY_TERM2:
        v.max_prec = max_prec;
        state = PrsUnaryTerm(cc, ps, v);
        max_prec = v.max_prec;
        continue;
      case PE_UNARY_MODIFIERS:
        state = PrsUnaryModifier(cc, ps, v);
        continue;
      case PE_MAYBE_MODIFIERS:
        if (cc.token === 40) { // Typecast or fun_ptr
          cc.flags |= K.CCF_RAX;
          state = PrsUnaryModifier(cc, ps, v);
          continue;
        }
        state = PE_CHECK_BINARY_OPS1;
        continue;
      case PE_DEREFERENCE:
        if (!(cc.flags & (K.CCF_PREINC | K.CCF_PREDEC | K.CCF_POSTINC | K.CCF_POSTDEC)))
          i = K.IC_DEREF + (K.PREC_UNARY_PRE << 16);
        else {
          if (cc.flags & K.CCF_POSTINC) i = K.IC__PP + (K.PREC_UNARY_POST << 16);
          else if (cc.flags & K.CCF_POSTDEC) i = K.IC__MM + (K.PREC_UNARY_POST << 16);
          else if (cc.flags & K.CCF_PREDEC) i = K.IC_MM_ + (K.PREC_UNARY_PRE << 16);
          else i = K.IC_PP_ + (K.PREC_UNARY_PRE << 16);
          cc.flags &= ~(K.CCF_PREINC | K.CCF_PREDEC | K.CCF_POSTINC | K.CCF_POSTDEC);
        }
        tmpi = cc.coc.head.last;
        if (cc.flags & (K.CCF_RAX | K.CCF_ARRAY)) {
          if (tmpi.code === K.IC_DEREF) tmpi.code = i & 0xFFFF; // (ic_code is U16; precedence unchanged)
        } else {
          tmpc = OptClassFwd(csub(tmpi.cls));
          ICAdd(cc, i, 0n, tmpc);
        }
      // fallthrough
      case PE_CHECK_BINARY_OPS1:
        if (v.paren_prec) {
          if (v.unary_pre_prec || v.unary_post_prec) {
            if (v.paren_prec <= v.unary_pre_prec && !v.unary_post_prec) ParenWarning(cc);
            v.paren_prec = K.PREC_NULL;
          } else if (v.paren_prec <= K.PREC_UNARY_PRE + K.ASSOC_MASK) ParenWarning(cc);
        }
        cur_op = binary_ops[cc.token] || 0;
      // fallthrough
      case PE_CHECK_BINARY_OPS2:
        stk_op = PrsPop(ps);
        tmpc = PrsPop(ps);
        if (!(0 < u8_2(stk_op) && u8_2(stk_op) <= K.PREC_UNARY_PRE + K.ASSOC_MASK)) {
          state = PE_DO_BINARY_OP; continue;
        }
      // fallthrough
      case PE_DO_UNARY_OP:
        if (u16_0(cur_op) === K.IC_POWER && u16_0(stk_op) === K.IC_UNARY_MINUS) {
          Lex(cc); // skip ` op
          left_prec = i8_2(cur_op);
          PrsPush(ps, tmpc); PrsPush(ps, stk_op);
          PrsPush(ps, cc.coc.head.last.cls); PrsPush(ps, cur_op);
          state = PE_UNARY_TERM1; continue;
        } else {
          tmpi = cc.coc.head.last;
          tmpc = tmpi.cls;
          if (u16_0(stk_op) === K.IC_DEREF && tmpc.ptr_stars_cnt) tmpc = csub(tmpc);
          else if (u16_0(stk_op) === K.IC_ADDR) {
            cc.abs_cnts.c_addres++;
            if (intermediate_code_table[tmpi.code].type === K.IST_DEREF) OptFree(tmpi);
            tmpc = cadd(tmpc);
          }
          tmpc = OptClassFwd(tmpc);
          if (stk_op) ICAdd(cc, stk_op, 0n, tmpc);
          state = PE_CHECK_BINARY_OPS2; continue;
        }
      case PE_DO_BINARY_OP:
        PrsPush(ps, tmpc); PrsPush(ps, stk_op);
        if (!cur_op) { state = PE_POP_ALL1; continue; }
        switch (u16_0(cur_op)) {
          case K.IC_ADD: case K.IC_SUB:
            tmpi = cc.coc.head.last;
            if (!tmpi.cls.ptr_stars_cnt && tmpi.cls.raw_type !== K.RT_F64) {
              ICAdd(cc, K.IC_SIZEOF, 1n, RT(cc, K.RT_I64));
              ICAdd(cc, K.IC_MUL, 0n, RT(cc, K.RT_I64));
            }
            break;
          case K.IC_AND_AND: case K.IC_OR_OR:
            ICAdd(cc, K.IC_NOP1, 0n, RT(cc, K.RT_I64));
            break;
        }
        if (cc.flags & K.CCF_FUN_EXP) { ps.ptr2--; cc.flags &= ~K.CCF_FUN_EXP; }
        Lex(cc); // skip op
        if (v.paren_prec > K.PREC_UNARY_PRE + K.ASSOC_MASK &&
          (v.paren_prec & ~K.ASSOC_MASK) < (left_prec & ~K.ASSOC_MASK) + (v.paren_prec & K.ASSOCF_RIGHT) &&
          (v.paren_prec & ~K.ASSOC_MASK) < (u8_2(cur_op) & ~K.ASSOC_MASK) + !(v.paren_prec & K.ASSOCF_RIGHT))
          ParenWarning(cc);
        if (u8_2(cur_op) > max_prec) max_prec = u8_2(cur_op);
        left_prec = u8_2(cur_op);
        if (intermediate_code_table[u16_0(cur_op)].type === K.IST_ASSIGN) {
          tmpi = cc.coc.head.last;
          tmpc = OptClassFwd(tmpi.cls);
          if (intermediate_code_table[tmpi.code].type !== K.IST_DEREF ||
            (!tmpc.ptr_stars_cnt && !bt(tmpc.flags, K.Cf_INTERNAL_TYPE)))
            LexExcept(cc, 'Invalid lval at ');
          tmpi.code = K.IC_NOP1; // Important for setting class (pretty sure)
          cur_op = setu8_2(cur_op, K.PREC_ASSIGN | K.ASSOCF_RIGHT);
        }
      // fallthrough
      case PE_POP_HIGHER:
        stk_op = PrsPop(ps); // pop ops of higher prec
        tmpc = PrsPop(ps);
        if (!stk_op) { state = PE_PUSH_LOWER; continue; }
        if ((u8_2(cur_op) & ~K.ASSOC_MASK) === (u8_2(stk_op) & ~K.ASSOC_MASK)) {
          if (u8_2(cur_op) & K.ASSOCF_RIGHT) { state = PE_PUSH_LOWER; continue; }
        } else if ((u8_2(cur_op) & ~K.ASSOC_MASK) <= (u8_2(stk_op) & ~K.ASSOC_MASK)) {
          state = PE_PUSH_LOWER; continue;
        }
        tmpi = PrsAddOp(cc, stk_op, tmpc);
        if (intermediate_code_table[u16_0(cur_op)].type === K.IST_CMP &&
          intermediate_code_table[u16_0(stk_op)].type === K.IST_CMP) {
          tmpi.flags |= K.ICF_PUSH_CMP;
          ICAdd(cc, K.IC_NOP1, 0n, RT(cc, K.RT_I64));
          ICAdd(cc, K.IC_PUSH_CMP, 0n, tmpc);
          cur_op = (cur_op | (K.ECF_HAS_PUSH_CMP << 24)) >>> 0;
        } else if (u16_0(cur_op) === K.IC_AND_AND || u16_0(cur_op) === K.IC_OR_OR)
          ICAdd(cc, K.IC_NOP1, 0n, RT(cc, K.RT_I64));
        state = PE_POP_HIGHER; continue;
      case PE_PUSH_LOWER:
        PrsPush(ps, tmpc); PrsPush(ps, stk_op);
        PrsPush(ps, cc.coc.head.last.cls); PrsPush(ps, cur_op);
        state = PE_UNARY_TERM1; continue;
      case PE_POP_ALL1:
        if (v.paren_prec > K.PREC_UNARY_PRE + K.ASSOC_MASK &&
          (v.paren_prec & ~K.ASSOC_MASK) <= (left_prec & ~K.ASSOC_MASK) -
          (v.paren_prec & K.ASSOCF_LEFT) - (left_prec & K.ASSOCF_LEFT))
          ParenWarning(cc);
      // fallthrough
      case PE_POP_ALL2:
        stk_op = PrsPop(ps);
        tmpc = PrsPop(ps);
        if (!u16_0(stk_op)) {
          if (ctx) ctx.max_prec = max_prec;
          return;
        }
        PrsAddOp(cc, stk_op, tmpc);
        state = PE_POP_ALL2; continue;
    }
  }
}

export function PrsExpression(cc, ctx, end_exp, _ps) {
  let res = true;
  const old_flags = cc.flags;
  const ps = _ps || newPrsStk();
  PrsPush(ps, 0); // terminate
  PrsPush(ps, 0); // terminate
  try {
    PrsExpression2(cc, ps, ctx);
  } catch (e) {
    if (!e.holyc || e.except_ch !== 'Compiler') throw e;
    res = false;
    cc.lastError = e;
    if (cc.env.rethrowErrors) throw e;
  }
  if (!_ps && ps.ptr) LexExcept(cc, 'Compiler Parse Error at ');
  if (res) {
    if (end_exp) ICAdd(cc, K.IC_END_EXP, 0n, null, K.ICF_RES_NOT_USED);
    if (cc.coc.head.last.cls === RT(cc, K.RT_U0)) LexWarn(cc, 'U0 Expression ');
  }
  cc.flags |= old_flags & (K.CCF_PREINC | K.CCF_PREDEC);
  return res;
}

function PrsSizeOf(cc) {
  let tmpc, tmpm, i;
  if (cc.token !== K.TK_IDENT) LexExcept(cc, 'Invalid class at ');
  let member = false;
  if ((tmpm = cc.local_var_entry)) {
    tmpc = tmpm.member_class;
    i = tmpc.size * tmpm.dim.total_cnt;
    member = Lex(cc) === 46;
  } else {
    if (!(tmpc = cc.hash_entry) || !(tmpc.type & (K.HTT_CLASS | K.HTT_INTERNAL_TYPE | K.HTT_GLBL_VAR |
      K.HTT_FUN | K.HTT_EXPORT_SYS_SYM)))
      LexExcept(cc, 'Invalid class at ');
    if (tmpc.type & (K.HTT_FUN | K.HTT_EXPORT_SYS_SYM)) {
      const dbg = tmpc.dbg_info;
      if (!dbg) LexExcept(cc, 'Size not defined at ');
      i = dbg.size;
      Lex(cc);
    } else {
      i = tmpc.size;
      member = Lex(cc) === 46;
    }
  }
  while (member) {
    if (!(tmpc.type & (K.HTT_CLASS | K.HTT_GLBL_VAR))) LexExcept(cc, 'Invalid class at ');
    else if (tmpc.type & K.HTT_GLBL_VAR) tmpc = tmpc.var_class;
    if (Lex(cc) !== K.TK_IDENT || !(tmpm = MemberFind(cc.cur_str, tmpc))) LexExcept(cc, 'Invalid member at ');
    else if (cc.local_var_entry) cc.local_var_entry.use_cnt--;
    tmpc = tmpm.member_class;
    i = tmpc.size * tmpm.dim.total_cnt;
    member = Lex(cc) === 46;
  }
  if (cc.token === 42) {
    while (Lex(cc) === 42);
    i = 8;
  }
  ICAdd(cc, K.IC_IMM_I64, BigInt(i), RT(cc, K.RT_I64));
}

function PrsOffsetOf(cc) {
  let tmpc, tmpm, i;
  if (cc.token !== K.TK_IDENT) LexExcept(cc, 'Invalid class at ');
  if ((tmpm = cc.local_var_entry)) tmpc = tmpm.member_class;
  else {
    tmpc = cc.hash_entry;
    if (!tmpc || !(tmpc.type & (K.HTT_CLASS | K.HTT_GLBL_VAR))) LexExcept(cc, 'Invalid class at ');
    else if (tmpc.type & K.HTT_GLBL_VAR) tmpc = tmpc.var_class;
  }
  if (Lex(cc) !== 46) LexExcept(cc, "Expecting '.' at ");
  i = 0;
  do {
    if (Lex(cc) !== K.TK_IDENT || !(tmpm = MemberFind(cc.cur_str, tmpc))) LexExcept(cc, 'Invalid member at ');
    else if (cc.local_var_entry) cc.local_var_entry.use_cnt--;
    i += tmpm.offset;
    tmpc = tmpm.member_class;
  } while (Lex(cc) === 46);
  ICAdd(cc, K.IC_IMM_I64, BigInt(i), RT(cc, K.RT_I64));
}

// A pointer to a field of a JS object, for ICs whose ic_data is the address
// of a variable (IC_CALL_INDIRECT2 &tmpf->exe_addr etc.) in JIT mode.
export class FieldRef {
  constructor(obj, field) { this.obj = obj; this.field = field; }
  get() { return this.obj[this.field]; }
}

function PrsFunCall(cc, ps, indirect, tmpf) {
  let argc_cnt, dft_val, is_first_arg = true, needs_right_paren, is_print, is_putchars, is_template_fun;
  let last_class = null, tmpm, tmpi, tmpc2, tmpcbh, tmpcbh1;
  if (!tmpf) {
    if (cc.token === K.TK_CHAR_CONST) {
      if (!(tmpf = HashFind('PutChars', cc.htc.hash_table_lst, K.HTT_FUN)))
        LexExcept(cc, 'Missing header for Print() and PutChars() at ');
      if (!cc.cur_i64) Lex(cc); // empty char signals PutChars with variable
      is_print = false; is_putchars = true;
    } else {
      if (!(tmpf = HashFind('Print', cc.htc.hash_table_lst, K.HTT_FUN)))
        LexExcept(cc, 'Missing header for Print() and PutChars() at ');
      if (!cc.cur_str.charCodeAt(0)) Lex(cc); // empty string signals Print with variable fmt_str
      is_putchars = false; is_print = true;
    }
  } else { is_print = false; is_putchars = false; }

  is_template_fun = bt(tmpf.flags, K.Ff_INTERNAL) && K.IC_SQR <= Number(tmpf.exe_addr) && Number(tmpf.exe_addr) <= K.IC_ATAN;

  if (indirect) {
    if (!(cc.flags & (K.CCF_RAX | K.CCF_ARRAY))) ICAdd(cc, K.IC_DEREF, 0n, RT(cc, K.RT_PTR));
    cc.coc.head.last.cls = RT(cc, K.RT_PTR);
    ICAdd(cc, K.IC_SET_RAX, 0n, RT(cc, K.RT_PTR));
    ICAdd(cc, K.IC_NOP2, 1n, RT(cc, K.RT_PTR)); // balance the books
  }
  COCPush(cc);
  tmpcbh = cc.coc.coc_next;
  cc.coc.coc_next = null;
  let i = tmpf.arg_cnt;
  tmpm = tmpf.member_lst_and_root;
  argc_cnt = 0;
  if (cc.token === 40) { Lex(cc); needs_right_paren = true; } else needs_right_paren = false;
  while (i--) {
    COCInit(cc);
    if (!is_first_arg) {
      if (is_print) {
        if (cc.token === 44) Lex(cc);
        else if (cc.token !== 59) LexExcept(cc, "Expecting ',' at ");
      } else if (needs_right_paren) {
        if (cc.token === 44) Lex(cc);
        else if (cc.token !== 41) LexExcept(cc, "Expecting ',' at ");
      }
    }
    if (tmpm.flags & K.MLF_DFT_AVAILABLE && (cc.token === 41 || cc.token === 44 || !needs_right_paren)) {
      dft_val = tmpm.dft_val;
      if (tmpm.flags & K.MLF_LASTCLASS && last_class) dft_val = cbase(last_class).str;
      if (tmpm.flags & (K.MLF_STR_DFT_AVAILABLE | K.MLF_LASTCLASS) && AOT(cc)) {
        const cm = COCMiscNew(cc, K.CMT_STR_CONST);
        ICAdd(cc, K.IC_STR_CONST, cm, cadd(RT(cc, K.RT_U8)));
        cm.st_len = dft_val.length + 1;
        cm.str = dft_val + '\0';
        cc.flags |= K.CCF_HAS_MISC_DATA;
      } else if (typeof dft_val === 'string') {
        // JIT (host) compile: the default is a pointer to the string
        ICAdd(cc, K.IC_IMM_I64, cc.env.hostStr ? cc.env.hostStr(cc, dft_val) : 0n, tmpm.member_class);
      } else ICAdd(cc, K.IC_IMM_I64, dft_val, tmpm.member_class);
    } else {
      if (!PrsExpression(cc, null, false, ps)) throwCompiler(cc);
      else {
        COCPush(cc);
        cc.pass = 0; OptPass012(cc);
        cc.pass = 1; tmpi = OptPass012(cc);
        COCPop(cc);
        last_class = OptClassFwd(tmpi.cls);
        tmpc2 = OptClassFwd(tmpm.member_class);
        if (tmpc2.raw_type === K.RT_F64 && !tmpm.dim.next && last_class.raw_type !== K.RT_F64)
          tmpi.flags |= K.ICF_RES_TO_F64;
        else if (tmpc2.raw_type !== K.RT_F64 && last_class.raw_type === K.RT_F64)
          tmpi.flags |= K.ICF_RES_TO_INT;
      }
    }
    COCPush(cc);
    is_first_arg = false;
    tmpm = tmpm.next;
  }
  if (tmpm && tmpm.flags & K.MLF_DOT_DOT_DOT) {
    COCInit(cc);
    tmpi = ICAdd(cc, K.IC_IMM_I64, 0n, tmpm.member_class);
    COCPush(cc);
    const varArgs = () => {
      do {
        if (!is_first_arg) {
          if (cc.token === 44) Lex(cc);
          else LexExcept(cc, "Expecting ',' at ");
        }
        COCInit(cc);
        if (!PrsExpression(cc, null, false, ps)) throwCompiler(cc);
        COCPush(cc);
        is_first_arg = false;
        argc_cnt++;
      } while (cc.token === 44);
    };
    if (is_print) { if (cc.token !== 59) varArgs(); }
    else if (needs_right_paren) { if (cc.token !== 41) varArgs(); }
    tmpi.data = BigInt(argc_cnt++); // ++ so add_esp latter works
  }
  if (needs_right_paren) {
    if (cc.token === 41) Lex(cc);
    else LexExcept(cc, "Missing ')' at ");
  }
  tmpcbh1 = tmpcbh.coc_next;
  tmpcbh.coc_next = cc.coc.coc_next;
  cc.coc.coc_next = tmpcbh;
  COCPop(cc);
  tmpcbh = cc.coc.coc_next;
  cc.coc.coc_next = tmpcbh1;
  if (!is_template_fun) ICAdd(cc, K.IC_CALL_START, tmpf, null);
  if (indirect) ICAdd(cc, K.IC_PUSH_REGS, BigInt(1 << K.REG_RAX), tmpf.return_class);
  while (tmpcbh) {
    tmpcbh1 = tmpcbh.coc_next;
    COCAppend(cc, tmpcbh);
    if (!bt(tmpf.flags, K.Ff_INTERNAL)) cc.coc.head.last.flags |= K.ICF_PUSH_RES;
    tmpcbh = tmpcbh1;
  }
  if (bt(tmpf.flags, K.Ff_INTERNAL)) ICAdd(cc, Number(tmpf.exe_addr), 0n, tmpf.return_class);
  else {
    if (indirect) ICAdd(cc, K.IC_CALL_INDIRECT, BigInt((argc_cnt + tmpf.arg_cnt) << 3), tmpf.return_class);
    else if (bt(tmpf.flags, K.Cf_EXTERN)) {
      cc.abs_cnts.externs++;
      if (AOT(cc)) {
        if (tmpf.type & K.HTF_IMPORT) ICAdd(cc, K.IC_CALL_IMPORT, tmpf, tmpf.return_class);
        else ICAdd(cc, K.IC_CALL_EXTERN, tmpf, tmpf.return_class);
      } else ICAdd(cc, K.IC_CALL_INDIRECT2, new FieldRef(tmpf, 'exe_addr'), tmpf.return_class);
    } else ICAdd(cc, K.IC_CALL, tmpf.exe_addr, tmpf.return_class);
    if ((bt(tmpf.flags, K.Ff_RET1) || bt(tmpf.flags, K.Ff_ARGPOP)) && !bt(tmpf.flags, K.Ff_NOARGPOP)) {
      if (indirect) {
        ICAdd(cc, K.IC_ADD_RSP1, BigInt((argc_cnt + tmpf.arg_cnt) << 3), tmpf.return_class);
        ICAdd(cc, K.IC_ADD_RSP, 8n, tmpf.return_class);
      } else ICAdd(cc, K.IC_ADD_RSP1, BigInt((argc_cnt + tmpf.arg_cnt) << 3), tmpf.return_class);
    } else {
      if (indirect) argc_cnt++;
      ICAdd(cc, K.IC_ADD_RSP, BigInt((argc_cnt + tmpf.arg_cnt) << 3), tmpf.return_class);
    }
  }
  if (!is_template_fun) ICAdd(cc, K.IC_CALL_END, tmpf, tmpf.return_class);
  if (is_print || is_putchars) ICAdd(cc, K.IC_END_EXP, 0n, null, K.ICF_RES_NOT_USED);
  cc.flags = (cc.flags | K.CCF_RAX) & ~(K.CCF_ARRAY | K.CCF_FUN_EXP);
  return PE_UNARY_MODIFIERS;
}

function PrsUnaryTerm(cc, ps, v) {
  let i, j, tmpex, tmpc, tmpf, tmpg, tmpm, cm;
  v.local_var = null;
  v.paren_prec = K.PREC_NULL;
  const term = () => { if (K.PREC_TERM > v.max_prec) v.max_prec = K.PREC_TERM; return PE_MAYBE_MODIFIERS; };
  const unaryOp = (ic) => {
    // end: PrsPush(ps,tmpc); PrsPush(ps,PREC_UNARY_PRE<<16+i);
    PrsPush(ps, tmpc);
    PrsPush(ps, (K.PREC_UNARY_PRE << 16) + ic);
    return PE_UNARY_TERM2;
  };
  switch (cc.token) {
    case 126: case 33: case 45: case 42: case 38: {
      if (K.PREC_UNARY_PRE > v.max_prec) v.max_prec = K.PREC_UNARY_PRE;
      v.unary_pre_prec = K.PREC_UNARY_PRE;
      if (cc.token !== 38) {
        i = cc.token === 126 ? K.IC_COM : cc.token === 33 ? K.IC_NOT : cc.token === 45 ? K.IC_UNARY_MINUS : K.IC_DEREF;
        Lex(cc); // Skip op
        return unaryOp(i);
      }
      // '&'
      if (Lex(cc) === K.TK_IDENT) {
        if ((tmpc = cc.hash_entry)) {
          if (tmpc.type & K.HTT_FUN) {
            tmpf = tmpc;
            if (!bt(tmpf.flags, K.Ff_INTERNAL)) {
              if (bt(tmpf.flags, K.Cf_EXTERN)) {
                if (AOT(cc)) {
                  if (cc.flags & K.CCF_ASM_EXPRESSIONS) LexExcept(cc, 'asm expressions not supported ');
                  LexExcept(cc, "Can't take addr of extern fun");
                }
                cc.abs_cnts.externs++;
                ICAdd(cc, K.IC_IMM_I64, new FieldRef(tmpf, 'exe_addr'), RT(cc, K.RT_PTR));
                ICAdd(cc, K.IC_DEREF, 0n, RT(cc, K.RT_PTR));
              } else {
                if (AOT(cc)) {
                  ICAdd(cc, K.IC_ABS_ADDR, tmpf.exe_addr, RT(cc, K.RT_PTR));
                  if (cc.flags & K.CCF_ASM_EXPRESSIONS) cc.abs_cnts.abs_addres++;
                } else ICAdd(cc, K.IC_IMM_I64, tmpf.exe_addr, RT(cc, K.RT_PTR));
              }
              cc.abs_cnts.c_addres++;
              Lex(cc);
              return PE_MAYBE_MODIFIERS;
            }
          } else if (tmpc.type & K.HTT_EXPORT_SYS_SYM) {
            tmpex = tmpc;
            if (cc.flags & K.CCF_ASM_EXPRESSIONS && !AOT(cc) && tmpex.type & K.HTF_IMM) {
              cc.abs_cnts.c_addres++;
              ICAdd(cc, K.IC_IMM_I64, tmpex.val, RT(cc, K.RT_PTR));
              Lex(cc);
              return PE_MAYBE_MODIFIERS;
            }
            return exportSysSym(cc, v, tmpex);
          }
        }
      }
      return unaryOp(K.IC_ADDR);
    }
    case K.TK_I64: case K.TK_CHAR_CONST: case K.TK_INS_BIN_SIZE:
      if (cc.cur_i64 < 0n) ICAdd(cc, K.IC_IMM_I64, cc.cur_i64, RT(cc, K.RT_U64));
      else ICAdd(cc, K.IC_IMM_I64, cc.cur_i64, RT(cc, K.RT_I64));
      Lex(cc);
      return term();
    case K.TK_F64:
      ICAdd(cc, K.IC_IMM_F64, f2b(cc.cur_f64), RT(cc, K.RT_F64));
      Lex(cc);
      return term();
    case K.TK_STR: {
      cm = COCMiscNew(cc, K.CMT_STR_CONST);
      ICAdd(cc, K.IC_STR_CONST, cm, cadd(RT(cc, K.RT_U8)));
      const sz = {};
      cm.str = LexExtStr(cc, sz);
      cm.st_len = sz.v;
      cc.flags |= K.CCF_HAS_MISC_DATA;
      return term();
    }
    case K.TK_INS_BIN:
      cm = COCMiscNew(cc, K.CMT_STR_CONST);
      ICAdd(cc, K.IC_STR_CONST, cm, cadd(RT(cc, K.RT_U8)));
      cm.str = cc.cur_str; cm.st_len = cc.cur_str_len;
      cc.cur_str = null;
      cc.flags |= K.CCF_HAS_MISC_DATA;
      Lex(cc);
      return term();
    case 36: // $
      if (cc.flags & K.CCF_ASM_EXPRESSIONS) {
        cc.abs_cnts.abs_addres++;
        if (AOT(cc)) ICAdd(cc, K.IC_ABS_ADDR, BigInt(cc.aotc.rip), RT(cc, K.RT_PTR));
        else ICAdd(cc, K.IC_IMM_I64, BigInt(cc.aotc.rip), RT(cc, K.RT_PTR));
      } else if (cc.flags & K.CCF_CLASS_DOL_OFFSET)
        ICAdd(cc, K.IC_IMM_I64, BigInt(cc.class_dol_offset), RT(cc, K.RT_I64));
      else ICAdd(cc, K.IC_RIP, 0n, RT(cc, K.RT_PTR));
      Lex(cc);
      return term();
    case 40: { // (
      if (Lex(cc) === K.TK_IDENT && cc.hash_entry && cc.hash_entry.type & (K.HTT_CLASS | K.HTT_INTERNAL_TYPE))
        LexExcept(cc, 'Use TempleOS postfix typecasting at ');
      if (K.PREC_TERM > v.max_prec) v.max_prec = K.PREC_TERM;
      const paren_warn = !(cc.lex_include_stk.flags & K.LFSF_DEFINE);
      const ctx = { max_prec: 0 };
      if (!PrsExpression(cc, ctx, false, ps)) throwCompiler(cc);
      v.paren_prec = paren_warn ? ctx.max_prec : K.PREC_NULL;
      if (cc.token !== 41) LexExcept(cc, "Missing ')' at ");
      Lex(cc); // skip )
      cc.flags = (cc.flags & ~K.CCF_ARRAY) | K.CCF_RAX | K.CCF_PAREN;
      return PE_UNARY_MODIFIERS;
    }
    case 43: case K.TK_PLUS_PLUS: case K.TK_MINUS_MINUS:
      if (cc.token === K.TK_PLUS_PLUS) cc.flags |= K.CCF_PREINC;
      else if (cc.token === K.TK_MINUS_MINUS) cc.flags |= K.CCF_PREDEC;
      if (K.PREC_UNARY_PRE > v.max_prec) v.max_prec = K.PREC_UNARY_PRE;
      v.unary_pre_prec = K.PREC_UNARY_PRE;
      Lex(cc);
      return PE_UNARY_TERM2;
    case K.TK_IDENT: {
      if ((tmpm = cc.local_var_entry)) {
        if (K.PREC_TERM > v.max_prec) v.max_prec = K.PREC_TERM;
        cc.flags &= ~(K.CCF_RAX | K.CCF_ARRAY | K.CCF_FUN_EXP);
        tmpc = cadd(tmpm.member_class);
        if (tmpm.flags & K.MLF_FUN && !(cc.flags & K.CCF_ASM_EXPRESSIONS)) {
          PrsPopDeref(ps);
          cc.flags |= K.CCF_FUN_EXP;
          PrsPush2(ps, cbase(tmpm.fun_ptr));
        }
        if (tmpm.dim.next) { v.tmpad = tmpm.dim.next; cc.flags |= K.CCF_ARRAY; }
        if (tmpm.flags & K.MLF_STATIC) {
          if (AOT(cc)) ICAdd(cc, K.IC_ABS_ADDR, BigInt(tmpm.static_data_rip), tmpc);
          else ICAdd(cc, K.IC_IMM_I64, tmpm.static_data, tmpc);
        } else {
          if (cc.flags & K.CCF_ASM_EXPRESSIONS) LexExcept(cc, 'asm expressions not supported ');
          if (tmpm.dim.next && tmpm.offset > 0 && tmpm.str !== 'argv') {
            tmpc = cadd(tmpc);
            cc.flags &= ~K.CCF_ARRAY;
          }
          ICAdd(cc, K.IC_RBP, 0n, tmpc);
          ICAdd(cc, K.IC_IMM_I64, BigInt(tmpm.offset), tmpc);
          ICAdd(cc, K.IC_ADD, 0n, tmpc);
        }
        Lex(cc); // skip var name
        v.local_var = tmpm;
        return PE_UNARY_MODIFIERS;
      }
      if (!(tmpex = cc.hash_entry)) {
        if (!(cc.flags & K.CCF_ASM_EXPRESSIONS)) LexExcept(cc, 'Invalid lval at ');
        LexExcept(cc, 'asm expressions not supported ');
      }
      const ty = bsf(BigInt(tmpex.type >>> 0));
      switch (ty) {
        case K.HTt_EXPORT_SYS_SYM:
          return exportSysSym(cc, v, tmpex);
        case K.HTt_FUN:
          if (K.PREC_TERM > v.max_prec) v.max_prec = K.PREC_TERM;
          Lex(cc); // skip fun name
          return PrsFunCall(cc, ps, false, tmpex);
        case K.HTt_GLBL_VAR:
          if (K.PREC_TERM > v.max_prec) v.max_prec = K.PREC_TERM;
          tmpg = tmpex;
          tmpc = cadd(tmpg.var_class);
          cc.flags &= ~(K.CCF_RAX | K.CCF_ARRAY | K.CCF_FUN_EXP);
          if (tmpg.flags & K.GVF_ARRAY) { v.tmpad = tmpg.dim.next; cc.flags |= K.CCF_ARRAY; }
          if (AOT(cc)) {
            if (tmpg.flags & K.GVF_EXTERN) LexExcept(cc, 'Feature not implemented ');
            else {
              if (tmpg.flags & K.GVF_IMPORT) ICAdd(cc, K.IC_ADDR_IMPORT, tmpg, tmpc);
              else if (tmpg.flags & K.GVF_DATA_HEAP) ICAdd(cc, K.IC_HEAP_GLBL, tmpg.heap_glbl, tmpc);
              else ICAdd(cc, K.IC_ABS_ADDR, BigInt(tmpg.data_addr_rip), tmpc);
            }
          } else {
            if (tmpg.flags & K.GVF_EXTERN) {
              cc.abs_cnts.externs++;
              ICAdd(cc, K.IC_IMM_I64, new FieldRef(tmpg, 'data_addr'), tmpc);
              ICAdd(cc, K.IC_DEREF, 0n, tmpc);
            } else ICAdd(cc, K.IC_IMM_I64, tmpg.data_addr, tmpc);
          }
          Lex(cc);
          if (tmpg.flags & K.GVF_FUN) {
            PrsPopDeref(ps);
            cc.flags |= K.CCF_FUN_EXP;
            PrsPush2(ps, cbase(tmpg.fun_ptr));
          }
          return PE_UNARY_MODIFIERS;
        case K.HTt_CLASS:
          PrsOffsetOf(cc);
          return PE_MAYBE_MODIFIERS;
        case K.HTt_KEYWORD:
          switch (tmpex.user_data0) {
            case K.KW_SIZEOF: case K.KW_OFFSET: case K.KW_DEFINED: {
              if (K.PREC_TERM > v.max_prec) v.max_prec = K.PREC_TERM;
              j = 0;
              while (Lex(cc) === 40) j++;
              if (tmpex.user_data0 === K.KW_SIZEOF) PrsSizeOf(cc);
              else if (tmpex.user_data0 === K.KW_OFFSET) PrsOffsetOf(cc);
              else {
                ICAdd(cc, K.IC_IMM_I64, (cc.token === K.TK_IDENT && (cc.hash_entry || cc.local_var_entry)) ? 1n : 0n,
                  RT(cc, K.RT_I64));
                Lex(cc);
              }
              while (j--) {
                if (cc.token !== 41) LexExcept(cc, "Missing ')' at ");
                Lex(cc);
              }
              return PE_MAYBE_MODIFIERS;
            }
          }
          break;
      }
      break;
    }
  }
  LexExcept(cc, 'Missing expression at ');
}

function exportSysSym(cc, v, tmpex) {
  // pu_export_sys_sym:
  if (K.PREC_TERM > v.max_prec) v.max_prec = K.PREC_TERM;
  if (!(tmpex.type & (K.HTF_IMM | K.HTF_IMPORT))) cc.abs_cnts.abs_addres++;
  if (tmpex.type & K.HTF_UNRESOLVED) {
    if (!(cc.flags & K.CCF_ASM_EXPRESSIONS)) LexExcept(cc, 'Illegal fwd ref at ');
    LexExcept(cc, 'asm expressions not supported ');
  } else {
    if (AOT(cc) && !(tmpex.type & K.HTF_IMM)) ICAdd(cc, K.IC_ABS_ADDR, tmpex.val, RT(cc, K.RT_PTR));
    else {
      if (tmpex.type & K.HTF_IMM) cc.abs_cnts.c_addres++;
      ICAdd(cc, K.IC_IMM_I64, tmpex.val, RT(cc, K.RT_PTR));
    }
  }
  Lex(cc);
  return PE_MAYBE_MODIFIERS;
}

function PrsUnaryModifier(cc, ps, v) {
  let tmpc, tmpc1, tmpm = v.local_var, tmpi, tmpi1, tmpad1, cm, old_flags;
  const was_paren = (cc.flags & K.CCF_PAREN) !== 0n;
  cc.flags &= ~K.CCF_PAREN;
  v.local_var = null;
  switch (cc.token) {
    case 46: case K.TK_DEREFERENCE: {
      if (cc.token === 46) {
        if (tmpm) tmpm.reg = K.REG_NONE;
      } else {
        tmpi = cc.coc.head.last;
        if (!(cc.flags & (K.CCF_RAX | K.CCF_ARRAY)))
          ICAdd(cc, K.IC_DEREF + (K.PREC_UNARY_PRE << 16), 0n, csub(tmpi.cls));
        else tmpi.cls = csub(tmpi.cls);
      }
      // um_join:
      if (!v.unary_post_prec) v.unary_post_prec = K.PREC_TERM;
      tmpc = cc.coc.head.last.cls;
      if ((!tmpc.ptr_stars_cnt || cc.flags & K.CCF_ARRAY) && cc.token === 46)
        LexExcept(cc, 'Must be address, not value ');
      if (!(cc.flags & K.CCF_RAX)) tmpc = csub(tmpc);
      if (!tmpc || !(tmpc.type & K.HTT_CLASS)) LexExcept(cc, 'Invalid class at ');
      if (Lex(cc) !== K.TK_IDENT || !(tmpm = MemberFind(cc.cur_str, tmpc))) LexExcept(cc, 'Invalid member at ');
      else if (cc.local_var_entry) cc.local_var_entry.use_cnt--;
      Lex(cc); // skip member name
      tmpc1 = cadd(tmpm.member_class);
      ICAdd(cc, K.IC_IMM_I64, BigInt(tmpm.offset), tmpc1);
      cc.flags &= ~(K.CCF_RAX | K.CCF_ARRAY | K.CCF_FUN_EXP);
      if (tmpm.dim.next) { v.tmpad = tmpm.dim.next; cc.flags |= K.CCF_ARRAY; }
      if (tmpm.flags & K.MLF_FUN) {
        PrsPopDeref(ps);
        PrsPush2(ps, cbase(tmpm.fun_ptr));
        cc.flags |= K.CCF_FUN_EXP;
      }
      ICAdd(cc, K.IC_ADD, 0n, tmpc1);
      return PE_UNARY_MODIFIERS;
    }
    case 40: {
      if (cc.flags & K.CCF_FUN_EXP) {
        if (!v.unary_post_prec) v.unary_post_prec = K.PREC_TERM;
        return PrsFunCall(cc, ps, true, PrsPop2(ps));
      }
      if (!v.unary_post_prec) v.unary_post_prec = K.PREC_TERM;
      if (Lex(cc) !== K.TK_IDENT) LexExcept(cc, 'Invalid class at ');
      if (cc.flags & K.CCF_FUN_EXP) { cc.flags &= ~K.CCF_FUN_EXP; ps.ptr2--; }
      cc.flags &= ~K.CCF_ARRAY;
      tmpc = cc.hash_entry;
      Lex(cc);
      const r = PrsType(cc, tmpc, K.PRS0_TYPECAST | K.PRS1_NULL, null, false, 0);
      tmpc = r.cls;
      if (r.fun_ptr) {
        PrsPopDeref(ps);
        cc.flags |= K.CCF_FUN_EXP;
        PrsPush2(ps, r.fun_ptr);
        cm = COCMiscNew(cc, K.CMT_HASH_ENTRY); cm.h = r.fun_ptr;
      }
      if ((v.tmpad = r.dim.next)) {
        cc.flags |= K.CCF_ARRAY;
        tmpc = cadd(tmpc);
        cm = COCMiscNew(cc, K.CMT_ARRAY_DIM); cm.dim = v.tmpad;
      }
      if (!(cc.flags & (K.CCF_RAX | K.CCF_ARRAY))) tmpc = cadd(tmpc);
      tmpi = cc.coc.head.last;
      tmpi.cls = tmpc;
      ICAdd(cc, K.IC_HOLYC_TYPECAST, was_paren ? 1n : 0n, tmpc);
      if (cc.token !== 41) LexExcept(cc, "Missing ')' at ");
      Lex(cc);
      return PE_UNARY_MODIFIERS;
    }
    case 91: {
      if (!v.unary_post_prec) v.unary_post_prec = K.PREC_TERM;
      Lex(cc);
      tmpc = OptClassFwd(cc.coc.head.last.cls);
      if (!tmpc.ptr_stars_cnt) LexExcept(cc, 'Not array or ptr ');
      if (!(cc.flags & (K.CCF_ARRAY | K.CCF_RAX))) {
        tmpc = OptClassFwd(csub(tmpc));
        if (!tmpc.ptr_stars_cnt) LexExcept(cc, 'Not array or ptr ');
        ICAdd(cc, K.IC_DEREF + (K.PREC_UNARY_PRE << 16), 0n, tmpc);
      }
      tmpc1 = csub(tmpc);
      if ((tmpad1 = v.tmpad)) {
        ICAdd(cc, K.IC_IMM_I64, BigInt(tmpad1.total_cnt * tmpc1.size), tmpc);
        if ((v.tmpad = tmpad1.next)) {
          old_flags = cc.flags;
          if (!PrsExpression(cc, null, false, ps)) throwCompiler(cc);
          cc.flags = (cc.flags & ~K.CCF_FUN_EXP) | (old_flags & K.CCF_FUN_EXP);
          if (cc.token !== 93) LexExcept(cc, "Missing ']' at ");
          Lex(cc); // skip ]
          tmpi1 = cc.coc.head.last;
          tmpi1.flags |= K.ICF_RES_TO_INT;
          ICAdd(cc, K.IC_MUL, 0n, tmpc);
          ICAdd(cc, K.IC_ADD, 0n, tmpc);
          cc.flags |= K.CCF_RAX;
          return PE_UNARY_MODIFIERS;
        }
      } else ICAdd(cc, K.IC_IMM_I64, BigInt(tmpc1.size), tmpc);
      old_flags = cc.flags;
      if (!PrsExpression(cc, null, false, ps)) throwCompiler(cc);
      cc.flags = (cc.flags & ~K.CCF_FUN_EXP) | (old_flags & K.CCF_FUN_EXP);
      if (cc.token !== 93) LexExcept(cc, "Missing ']' at ");
      Lex(cc); // skip ]
      tmpi1 = cc.coc.head.last;
      tmpi1.flags |= K.ICF_RES_TO_INT;
      ICAdd(cc, K.IC_MUL, 0n, tmpc);
      ICAdd(cc, K.IC_ADD, 0n, tmpc);
      cc.flags &= ~(K.CCF_RAX | K.CCF_ARRAY);
      return PE_UNARY_MODIFIERS;
    }
    case K.TK_PLUS_PLUS: case K.TK_MINUS_MINUS:
      cc.flags |= cc.token === K.TK_PLUS_PLUS ? K.CCF_POSTINC : K.CCF_POSTDEC;
      if (!v.unary_post_prec) v.unary_post_prec = K.PREC_UNARY_POST;
      Lex(cc);
      return PE_DEREFERENCE;
  }
  return PE_DEREFERENCE;
}

// LexExpression2Bin() and friends (PrsExp.HC).  The machine code is whatever
// cc.env.COCCompile returns; Call() is cc.env.Call.
export function LexExpression2Bin(cc, typeOut) {
  let res;
  COCPush(cc);
  COCInit(cc);
  if (PrsExpression(cc, null, false)) {
    ICAdd(cc, K.IC_RETURN_VAL, 0n, null);
    ICAdd(cc, K.IC_RET, 0n, null);
    res = COCCompile(cc, typeOut);
  } else res = null;
  COCPop(cc);
  return res;
}
export function LexExpressionI64(cc) {
  const ty = {};
  const mc = LexExpression2Bin(cc, ty);
  if (!mc) return 0n;
  let res = cc.env.Call(cc, mc);
  if (ty.v === K.RT_F64) res = f2i(b2f(res));
  return I64(res);
}
export function LexExpressionF64(cc) {
  const ty = {};
  const mc = LexExpression2Bin(cc, ty);
  if (!mc) return 0;
  let res = cc.env.Call(cc, mc);
  if (ty.v !== K.RT_F64) return Number(I64(res));
  return b2f(res);
}
export function LexExpression(cc) {
  const mc = LexExpression2Bin(cc);
  if (!mc) return 0n;
  return I64(cc.env.Call(cc, mc));
}

// COCCompile(): front half (OptPass012 x2) is TempleOS's; the back half is
// the wasm backend (AOT) or the bootstrap IC interpreter (JIT).
export function COCCompile(cc, typeOut, dbgOut) {
  cc.pass = 1;
  OptPass012(cc);
  cc.pass = 2;
  OptPass012(cc);
  const res = cc.env.COCCompile(cc, typeOut, dbgOut);
  COCDel(cc, cc.coc);
  return res;
}

// ------------------------------------------------------------- PrsVar
// A byte pointer into a buffer: {buf: Uint8Array, off}.  Used where the
// original writes initializer bytes through a U8 * (PrsVarInit).
export class BufPtr {
  constructor(buf, off = 0) { this.buf = buf; this.off = off; }
  add(n) { return new BufPtr(this.buf, this.off + n); }
}
// AOT initializers are built in JS buffers and copied to the image; JIT
// (bootstrap host) globals live in host memory and data_addr is the address.
function ptrOf(cc, v) {
  if (v instanceof BufPtr) return v;
  if (typeof v === 'bigint') return cc.env.hostPtr(v);
  return v;
}
function newBase(cc, n) {
  return AOT(cc) ? new BufPtr(new Uint8Array(Math.max(n, 0)), 0) : cc.env.hostBuf(n);
}
function memCpyToPtr(dst, bytes, n) {
  for (let k = 0; k < n; k++) dst.buf[dst.off + k] = bytes[k];
}
function i64Bytes(v) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, U64(v), true);
  return b;
}

function PrsVarInit(cc, dstRef, tmpc, tmpad, data_addr_rip, baseRef, data_heap, pass) {
  let dst = dstRef.v, machine_code, i, j, r, old_flags, size, tmpm, tmpi;
  const aotc = cc.aotc;
  let is_str;
  tmpc = OptClassFwd(tmpc);
  if ((tmpm = tmpc.member_lst_and_root)) {
    if (cc.token !== 123) LexExcept(cc, "Expecting '{' at ");
    LexPopNoRestore(cc);
    LexPush(cc);
    Lex(cc);
    while (tmpm) {
      const r2 = { v: dst };
      PrsVarInit2(cc, r2, tmpm.member_class, tmpm.dim, data_addr_rip, baseRef, data_heap, pass);
      dst = r2.v;
      if (cc.token === 44) Lex(cc);
      tmpm = tmpm.next;
    }
    LexPopNoRestore(cc);
    if (cc.token !== 125) LexExcept(cc, "Missing '}' at ");
    Lex(cc);
  } else {
    const tm1 = csub(tmpc);
    is_str = tmpc.ptr_stars_cnt === 1 && (tm1.raw_type === K.RT_I8 || tm1.raw_type === K.RT_U8) &&
      !tmpad && cc.token === K.TK_STR;
    old_flags = cc.flags;
    if (AOT(cc) && is_str) {
      LexPopNoRestore(cc);
      const sz = {};
      machine_code = LexExtStr(cc, sz);
      i = sz.v;
      if (pass === 2) {
        aotc.abss.push({ type: K.AAT_ADD_U64, rip: data_addr_rip + (dst.off - baseRef.v.off) });
        memCpyToPtr(dst, i64Bytes(BigInt(aotc.rip)), 8);
        for (j = 0; j < i; j++) AOTStoreCodeU8(cc, machine_code.charCodeAt(j));
      }
    } else {
      cc.flags = K.CCF_NO_ABSS | (cc.flags & ~(K.CCF_AOT_COMPILE | K.CCF_HAS_MISC_DATA | K.CCF_NOT_CONST));
      const ty = {};
      machine_code = LexExpression2Bin(cc, ty);
      const type = ty.v;
      if (old_flags & K.CCF_AOT_COMPILE && cc.flags & K.CCF_NOT_CONST && !optOn(cc, K.OPTf_GLBLS_ON_DATA_HEAP)) {
        cc.flags = (cc.flags & ~K.CCF_NO_ABSS) | K.CCF_AOT_COMPILE;
        if (pass === 2) {
          dst.buf.fill(0, dst.off, dst.off + tmpc.size);
          LexPopRestore(cc);
          Lex(cc);
          COCPush(cc);
          COCInit(cc);
          ICAdd(cc, K.IC_ABS_ADDR, BigInt(data_addr_rip), cadd(tmpc));
          ICAdd(cc, K.IC_IMM_I64, BigInt(dst.off - baseRef.v.off), cadd(tmpc));
          ICAdd(cc, K.IC_ADD, 0n, cadd(tmpc));
          if (!PrsExpression(cc, null, true)) throwCompiler(cc);
          tmpi = cc.coc.head.last;
          if (tmpi.code === K.IC_END_EXP) { tmpi.code = K.IC_NOP1; tmpi.flags = 0; }
          ICAdd(cc, K.IC_ASSIGN, 0n, tmpc);
          ICAdd(cc, K.IC_END_EXP, 0n, tmpc, K.ICF_RES_NOT_USED);
          ICAdd(cc, K.IC_RET, 0n, null);
          if ((machine_code = COCCompile(cc))) {
            cc.aot.ie.push({ type: K.IET_MAIN, rip: aotc.rip, str: null, flags: 0 });
            AOTStoreBlob(cc, machine_code);
          }
          COCPop(cc);
        } else LexPopNoRestore(cc);
      } else {
        LexPopNoRestore(cc);
        if (!machine_code) throwCompiler(cc);
        r = cc.env.Call(cc, machine_code);
        if (type === K.RT_F64 && tmpc.raw_type !== K.RT_F64) r = f2i(b2f(r));
        else if (type !== K.RT_F64 && tmpc.raw_type === K.RT_F64) r = f2b(Number(I64(r)));
        memCpyToPtr(dst, i64Bytes(r), tmpc.size);
      }
    }
    dst = dst.add(tmpc.size);
    cc.flags = (cc.flags & ~K.CCF_NO_ABSS) | (old_flags & (K.CCF_HAS_MISC_DATA | K.CCF_AOT_COMPILE));
  }
  dstRef.v = dst;
}

function PrsVarInit2(cc, dstRef, tmpc, tmpad, data_addr_rip, baseRef, data_heap, pass) {
  let i, j, cnt, st, tmpad1;
  tmpc = OptClassFwd(tmpc);
  if ((tmpad1 = tmpad.next)) {
    if (!tmpc.ptr_stars_cnt && (tmpc.raw_type === K.RT_I8 || tmpc.raw_type === K.RT_U8) && cc.token === K.TK_STR) {
      LexPopNoRestore(cc);
      const sz = {};
      st = LexExtStr(cc, sz);
      i = sz.v;
      if (tmpad1.cnt < 0) { // []
        tmpad1.cnt = i;
        tmpad.total_cnt = i * tmpad1.total_cnt;
        baseRef.v = newBase(cc, i);
        for (j = 0; j < i; j++) baseRef.v.buf[baseRef.v.off + j] = st.charCodeAt(j);
        dstRef.v = baseRef.v.add(i);
      } else {
        for (j = 0; j < tmpad1.cnt; j++) dstRef.v.buf[dstRef.v.off + j] = j < st.length ? st.charCodeAt(j) : 0;
        dstRef.v = dstRef.v.add(tmpad1.cnt);
      }
      LexPush(cc);
    } else {
      if (cc.token === 123) {
        LexPopNoRestore(cc);
        LexPush(cc);
        Lex(cc);
      }
      if (tmpad1.cnt < 0) { // []
        const elems = [];
        cnt = 0;
        while (cc.token !== 125) {
          const eb = new BufPtr(new Uint8Array(Math.max(0, tmpad1.total_cnt * tmpc.size)), 0);
          const r2 = { v: eb };
          PrsVarInit2(cc, r2, tmpc, tmpad1, data_addr_rip, baseRef, data_heap, pass);
          elems.push(eb);
          if (cc.token === 44) Lex(cc);
          cnt++;
        }
        Lex(cc); // skip '}'
        tmpad1.cnt = cnt;
        tmpad.total_cnt = cnt * tmpad1.total_cnt;
        j = tmpad1.total_cnt * tmpc.size;
        i = cnt * j;
        const nb = newBase(cc, i);
        let p = nb.off;
        for (const eb of elems) { nb.buf.set(eb.buf.subarray(0, j), p); p += j; }
        baseRef.v = nb;
        dstRef.v = nb.add(i);
      } else {
        for (i = 0; i < tmpad1.cnt; i++) {
          PrsVarInit2(cc, dstRef, tmpc, tmpad1, data_addr_rip, baseRef, data_heap, pass);
          if (tmpad1.cnt > 1 && cc.token === 44) Lex(cc);
        }
        if (cc.token === 125) Lex(cc);
      }
    }
  } else {
    PrsVarInit(cc, dstRef, tmpc, tmpad1, data_addr_rip, baseRef, data_heap, pass);
    LexPush(cc);
  }
}

function PrsGlblInit(cc, tmpg, pass) {
  const dstRef = { v: ptrOf(cc, tmpg.data_addr) };
  const baseRef = {
    get v() { return ptrOf(cc, tmpg.data_addr); },
    set v(x) { tmpg.data_addr = AOT(cc) ? x : x.hostAddr; },
  };
  PrsVarInit2(cc, dstRef, tmpg.var_class, tmpg.dim, tmpg.data_addr_rip, baseRef,
    optOn(cc, K.OPTf_GLBLS_ON_DATA_HEAP) || AOT(cc), pass);
}

function PrsStaticInit(cc, tmpm, pass) {
  const tmpc = tmpm.member_class;
  if (AOT(cc) && pass === 2) { COCPush(cc); COCInit(cc); }
  const dstRef = { v: ptrOf(cc, tmpm.static_data) };
  const baseRef = { get v() { return ptrOf(cc, tmpm.static_data); }, set v(x) { tmpm.static_data = AOT(cc) ? x : x.hostAddr; } };
  PrsVarInit2(cc, dstRef, tmpc, tmpm.dim, tmpm.static_data_rip, baseRef, AOT(cc), pass);
  if (AOT(cc) && pass === 2) {
    if (cc.coc.head.next !== cc.coc.head) {
      ICAdd(cc, K.IC_RET, 0n, null);
      const mc = COCCompile(cc);
      if (mc) {
        cc.aot.ie.push({ type: K.IET_MAIN, rip: cc.aotc.rip, str: null, flags: 0 });
        AOTStoreBlob(cc, mc);
      }
    }
    COCPop(cc);
  }
}

export function PrsArrayDims(cc, mode, dim) {
  dim.next = null; dim.cnt = 0; dim.total_cnt = 1;
  if (cc.token === 91) {
    if (((mode >> 8) & 0xFF) === K.PRS1B_FUN_ARG) LexExcept(cc, 'No arrays in fun args at ');
    do {
      let j;
      if (Lex(cc) === 93 && !dim.next) j = 0;
      else if ((j = Number(LexExpressionI64(cc))) < 0) LexExcept(cc, 'Invalid array size at ');
      const tmpad = { next: null, cnt: j, total_cnt: 1 };
      let t = dim;
      for (;;) {
        t.total_cnt *= j;
        if (!t.next) { t.next = tmpad; break; }
        t = t.next;
      }
      if (cc.token !== 93) LexExcept(cc, "Missing ']' at ");
    } while (Lex(cc) === 91);
  }
}

// PrsType(cc,&tmpc1,&mode,tmpm,&ident,&fun_ptr,&tmpex,tmpad,fsp_flags)
// Returns {cls, mode, tmpc1 (possibly replaced by an inline class), ident,
// fun_ptr, tmpex, dim}.
export function PrsType(cc, tmpc1, mode, tmpm, wantIdent, fsp_flags = 0, dim = null) {
  let k, ptr_stars_cnt, tmpc2, fun_ptr = null, tmpex = null, ident = null;
  const tmpad = dim || (tmpm ? tmpm.dim : { next: null, cnt: 0, total_cnt: 1 });
  let out_tmpc1 = tmpc1;
  for (;;) { // pt_start:
    if (!tmpc1 || !(tmpc1.type & (K.HTT_CLASS | K.HTT_INTERNAL_TYPE))) LexExcept(cc, 'Invalid class at ');
    ptr_stars_cnt = 0;
    while (cc.token === 42) {
      if ((mode >> 8) & 0xFF) { LexPopNoRestore(cc); LexPush(cc); }
      Lex(cc);
      tmpc1 = cadd(tmpc1);
      if (++ptr_stars_cnt > K.PTR_STARS_NUM) LexExcept(cc, "Too many *'s at ");
    }
    k = PrsKeyWord(cc);
    if (k === K.KW_UNION || k === K.KW_CLASS) {
      Lex(cc);
      tmpc2 = PrsClass(cc, k, fsp_flags, (mode & 255) === K.PRS0_EXTERN);
      tmpc2.fwd_class = tmpc1;
      tmpc1 = tmpc2;
      out_tmpc1 = tmpc1;
      mode = K.PRS0_NULL | K.PRS1_NULL;
      continue;
    }
    break;
  }
  if (cc.token === 40) {
    if (Lex(cc) !== 42) LexExcept(cc, "Expecting '*' at ");
    ptr_stars_cnt = 1; // fun_ptr
    while (Lex(cc) === 42) ptr_stars_cnt++;
    if (ptr_stars_cnt > K.PTR_STARS_NUM) LexExcept(cc, "Too many *'s at ");
  } else ptr_stars_cnt = -1;
  if (wantIdent) {
    if (cc.token === K.TK_IDENT) {
      tmpex = cc.hash_entry;
      ident = cc.cur_str;
      cc.cur_str = null;
      Lex(cc);
    } else {
      if (!((mode >> 8) & 0xFF)) ident = null;
      else if (cc.token === 44 || cc.token === 59 || cc.token === 41) {
        tmpex = null; ident = '_anon_';
        tmpm.flags |= K.MLF_NO_UNUSED_WARN;
      } else LexExcept(cc, 'Expecting identifier at ');
    }
  }
  if (ptr_stars_cnt >= 0) { // fun_ptr
    if (cc.token !== 41) LexExcept(cc, "Missing ')' at ");
    if (Lex(cc) !== 40) LexExcept(cc, "Expecting '(' at ");
    fun_ptr = cadd(PrsFunJoin(cc, tmpc1, null, fsp_flags), ptr_stars_cnt);
    tmpc1 = cadd(RT(cc, K.RT_PTR), ptr_stars_cnt);
  }
  PrsArrayDims(cc, mode, tmpad);
  tmpc2 = OptClassFwd(tmpc1);
  if (tmpc2.ptr_stars_cnt) {
    tmpc2 = cbase(tmpc2);
    if (tmpc2.type & K.HTT_INTERNAL_TYPE && !tmpc2.size) LexWarn(cc, 'use "U8 *" instead of "U0 *" at ');
  }
  return { cls: tmpc1, mode, tmpc1: out_tmpc1, ident, fun_ptr, tmpex, dim: tmpad };
}

function PrsDotDotDot(cc, tmpf, _reg) {
  tmpf.flags |= 1 << K.Ff_DOT_DOT_DOT;
  Lex(cc);
  let tmpm = new CMemberLst(_reg);
  tmpm.flags = K.MLF_DOT_DOT_DOT;
  tmpm.member_class = RT(cc, K.RT_I64);
  tmpm.str = 'argc';
  tmpm.offset = tmpf.size;
  tmpm.size = 8;
  tmpf.size += 8;
  MemberAdd(cc, tmpm, tmpf, K.PRS1B_FUN_ARG);
  tmpm = new CMemberLst(_reg);
  tmpm.flags = K.MLF_DOT_DOT_DOT;
  tmpm.member_class = RT(cc, K.RT_I64);
  tmpm.str = 'argv';
  tmpm.dim.total_cnt = 127; // arbitrary
  tmpm.dim.next = { next: null, cnt: 127, total_cnt: 1 };
  tmpm.offset = tmpf.size;
  tmpm.size = 8; // Close enough
  tmpf.size += 8; // Close enough
  MemberAdd(cc, tmpm, tmpf, K.PRS1B_FUN_ARG);
  if (cc.token === 41) Lex(cc);
}

// LexLib.HC MemberAdd(): BST by name rooted at member_lst_and_root, which is
// also the head of the ->next list.
function MemberAdd(cc, tmpm, tmpc, mode) {
  const st = tmpm.str;
  if (MemberFind(st, tmpc) && st !== 'pad' && st !== 'reserved' && st !== '_anon_')
    LexExcept(cc, 'Duplicate member at ');
  if (!tmpc.member_lst_and_root) {
    tmpc.member_lst_and_root = tmpm;
  } else {
    let t = tmpc.member_lst_and_root;
    for (;;) {
      if (t.str <= st) { if (!t.left) { t.left = tmpm; break; } t = t.left; }
      else { if (!t.right) { t.right = tmpm; break; } t = t.right; }
    }
  }
  tmpm.member_class_base = mode === K.PRS1B_LOCAL_VAR ? cbase(tmpm.member_class) : null;
  tmpm.left = tmpm.right = null;
  tmpm.left_class_base = tmpm.right_class_base = null;
  if (tmpc.last_in_member_lst) tmpc.last_in_member_lst.next = tmpm;
  tmpc.last_in_member_lst = tmpm;
}
function ClassMemberLstDel(tmpc) {
  tmpc.size = 0;
  tmpc.last_in_member_lst = null;
  tmpc.member_lst_and_root = null;
  tmpc.member_class_base_root = null;
  tmpc.member_cnt = 0;
  if (tmpc.type & K.HTT_FUN) tmpc.arg_cnt = 0;
}

const REGS64 = ['RAX', 'RCX', 'RDX', 'RBX', 'RSP', 'RBP', 'RSI', 'RDI', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15'];

export function PrsVarLst(cc, tmpc, mode, union_base = 0) {
  let i, k, _reg, tmph, tmpm, tmpc1, tmpc2, first, undef_array_size;
  const old_flags = cc.flags;
  cc.flags |= K.CCF_DONT_MAKE_RES;
  const m1 = () => (mode >> 8) & 0xFF;
  if (m1() === K.PRS1B_CLASS) cc.flags |= K.CCF_CLASS_DOL_OFFSET;
  if ((m1() !== K.PRS1B_LOCAL_VAR && m1() !== K.PRS1B_STATIC_LOCAL_VAR || mode & K.PRSF_UNION) &&
    (cc.token === 40 || cc.token === 123))
    Lex(cc);
  pvl: for (;;) {
    cc.class_dol_offset = (mode & K.PRSF_UNION) ? union_base : tmpc.size;
    while (cc.token === 59) Lex(cc);
    while (cc.token === 36) {
      if (Lex(cc) !== 61) LexExcept(cc, "Expecting '=' at "); // skip $
      Lex(cc); // skip =
      cc.class_dol_offset = Number(LexExpression(cc));
      if (-cc.class_dol_offset > tmpc.neg_offset) tmpc.neg_offset = -cc.class_dol_offset;
      if (mode & K.PRSF_UNION) union_base = cc.class_dol_offset;
      else tmpc.size = cc.class_dol_offset;
      if (cc.token !== 59) LexExcept(cc, "Missing ';' at");
      Lex(cc); // skip ;
    }
    if (cc.token === 41 || cc.token === 125) { Lex(cc); break pvl; }
    _reg = K.REG_UNDEF;
    for (;;) { // pvl_restart1:
      const kw = PrsKeyWord(cc);
      if (kw === K.KW_REG) {
        _reg = K.REG_ALLOC;
        if (Lex(cc) === K.TK_IDENT) {
          k = REGS64.indexOf(cc.cur_str);
          if (k >= 0) { _reg = k; Lex(cc); }
        }
        continue;
      }
      if (kw === K.KW_NOREG) { _reg = K.REG_NONE; Lex(cc); continue; }
      break;
    }
    if (cc.token === K.TK_ELLIPSIS && m1() === K.PRS1B_FUN_ARG) {
      PrsDotDotDot(cc, tmpc, _reg);
      break pvl;
    }
    tmph = cc.token === K.TK_IDENT ? cc.hash_entry : null;
    if (!tmph) LexExcept(cc, 'Expecting type at ');
    k = PrsKeyWord(cc);
    if (k === K.KW_UNION) {
      Lex(cc);
      PrsVarLst(cc, tmpc, mode | K.PRSF_UNION, tmpc.size);
      continue pvl;
    }
    if (!(tmph.type & (K.HTT_CLASS | K.HTT_INTERNAL_TYPE))) LexExcept(cc, 'Expecting type at ');
    first = true;
    for (;;) { // pvl_restart2:
      tmpc1 = tmph;
      LexPush(cc);
      Lex(cc); // skip type or ','
      tmpm = new CMemberLst(_reg);
      _reg = K.REG_UNDEF;
      if (m1() === K.PRS1B_STATIC_LOCAL_VAR) { tmpm.flags |= K.MLF_STATIC; tmpm.reg = K.REG_NONE; }
      if (m1() === K.PRS1B_FUN_ARG || m1() === K.PRS1B_LOCAL_VAR) {
        for (;;) { // pvl_restart3:
          const kw = PrsKeyWord(cc);
          if (kw === K.KW_REG) {
            tmpm.reg = K.REG_ALLOC;
            LexPopNoRestore(cc); LexPush(cc);
            if (Lex(cc) === K.TK_IDENT) {
              k = REGS64.indexOf(cc.cur_str);
              if (k >= 0) { tmpm.reg = k; LexPopNoRestore(cc); LexPush(cc); Lex(cc); }
            }
            continue;
          }
          if (kw === K.KW_NOREG) {
            tmpm.reg = K.REG_NONE;
            LexPopNoRestore(cc); LexPush(cc);
            Lex(cc);
            continue;
          }
          break;
        }
      }
      const r = PrsType(cc, tmpc1, mode, tmpm, true, 0);
      mode = r.mode; tmph = r.tmpc1 === tmpc1 ? tmph : r.tmpc1;
      tmpm.member_class = r.cls;
      tmpm.str = r.ident;
      tmpm.fun_ptr = r.fun_ptr;
      if (tmpm.fun_ptr) tmpm.flags |= K.MLF_FUN;
      MemberAdd(cc, tmpm, tmpc, first ? m1() : K.PRS1B_NULL);
      tmpc.member_cnt++;
      tmpc2 = tmpm.member_class;
      i = tmpc2.size * tmpm.dim.total_cnt;
      switch (m1()) {
        case K.PRS1B_STATIC_LOCAL_VAR: {
          if (i < 0) { i = 0; undef_array_size = true; } else undef_array_size = false;
          if (mode & K.PRSF_UNION) LexExcept(cc, 'Static unions are not implemented ');
          k = (i + 7) & ~7;
          if (AOT(cc)) tmpm.static_data = new BufPtr(new Uint8Array(k), 0);
          if (AOT(cc)) {
            tmpm.static_data_rip = cc.aotc.rip;
            for (let q = k >> 3; q--;) AOTStoreCodeU64(cc, 0n);
          } else cc.env.staticAlloc(cc, tmpm, k);
          LexPopNoRestore(cc);
          if (cc.token === 61) {
            cc.flags = (cc.flags & ~K.CCF_DONT_MAKE_RES) | (old_flags & K.CCF_DONT_MAKE_RES);
            if (undef_array_size) {
              LexPush(cc); LexPush(cc);
              Lex(cc); // skip =
              PrsStaticInit(cc, tmpm, 1);
              LexPopNoRestore(cc);
              i = tmpc2.size * tmpm.dim.total_cnt;
              k = (i + 7) & ~7;
              if (AOT(cc)) for (let q = k >> 3; q--;) AOTStoreCodeU64(cc, 0n);
              LexPopRestore(cc);
            }
            LexPush(cc);
            Lex(cc); // skip =
            PrsStaticInit(cc, tmpm, 2);
            LexPopNoRestore(cc);
            if (AOT(cc))
              for (k = 0; k < i; k++) AOTStoreCodeU8At(cc, tmpm.static_data_rip + k, tmpm.static_data.buf[tmpm.static_data.off + k] || 0);
            else cc.env.staticWrite(cc, tmpm, i);
            tmpm.use_cnt = 0;
            cc.flags |= K.CCF_DONT_MAKE_RES;
          }
          if (AOT(cc)) tmpm.static_data = null;
          break;
        }
        case K.PRS1B_LOCAL_VAR:
          if (mode & K.PRSF_UNION) {
            if (union_base - tmpc.size < i) i = union_base - i - tmpc.size;
            else i = 0;
          }
          if (i >= 8) tmpc.size = (tmpc.size - i) & ~7;
          else if (i >= 4) tmpc.size = (tmpc.size - i) & ~3;
          else if (i >= 2) tmpc.size = (tmpc.size - i) & ~1;
          else tmpc.size -= i;
          tmpm.offset = tmpc.size;
          tmpm.size = i;
          if (cc.token === 61) {
            cc.flags = (cc.flags & ~K.CCF_DONT_MAKE_RES) | (old_flags & K.CCF_DONT_MAKE_RES);
            LexPopRestore(cc);
            Lex(cc);
            if (!PrsExpression(cc, null, true)) throwCompiler(cc);
            tmpm.use_cnt = 0;
            cc.flags |= K.CCF_DONT_MAKE_RES;
          } else LexPopNoRestore(cc);
          break;
        case K.PRS1B_FUN_ARG:
          if (mode & K.PRSF_UNION) {
            tmpm.offset = union_base;
            if (tmpc.size - union_base < 8) tmpc.size = 8 + union_base;
          } else { tmpm.offset = tmpc.size; tmpc.size += 8; }
          tmpm.size = 8;
          if (cc.token === 61) {
            Lex(cc);
            if (PrsKeyWord(cc) === K.KW_LASTCLASS) {
              tmpm.flags |= K.MLF_LASTCLASS;
              Lex(cc);
            } else {
              const old_flags2 = cc.flags;
              cc.flags &= ~K.CCF_HAS_MISC_DATA;
              const ty = {};
              const mc = LexExpression2Bin(cc, ty);
              if (!mc) throwCompiler(cc);
              tmpm.dft_val = I64(cc.env.Call(cc, mc));
              tmpc2 = OptClassFwd(tmpc2);
              if (tmpc2.raw_type === K.RT_F64) {
                if (ty.v !== K.RT_F64) tmpm.dft_val = f2b(Number(tmpm.dft_val));
              } else if (ty.v === K.RT_F64) tmpm.dft_val = f2i(b2f(tmpm.dft_val));
              if (cc.flags & K.CCF_HAS_MISC_DATA) {
                tmpm.dft_val = cc.env.hostStrRead(cc, tmpm.dft_val, mc); // StrNew(dft_val)
                tmpm.flags |= K.MLF_STR_DFT_AVAILABLE;
              }
              cc.flags |= old_flags2 & K.CCF_HAS_MISC_DATA;
            }
            tmpm.flags |= K.MLF_DFT_AVAILABLE;
          }
          LexPopNoRestore(cc);
          break;
        case K.PRS1B_CLASS:
          if (mode & K.PRSF_UNION) {
            tmpm.offset = union_base;
            if (tmpc.size - union_base < i) tmpc.size = i + union_base;
          } else { tmpm.offset = tmpc.size; tmpc.size += i; }
          tmpm.size = i;
          cc.class_dol_offset = (mode & K.PRSF_UNION) ? union_base : tmpc.size;
          while (cc.token === K.TK_IDENT) {
            const meta = { next: tmpm.meta, str: cc.cur_str, flags: 0, user_data: 0n };
            tmpm.meta = meta;
            cc.cur_str = null;
            if (Lex(cc) === K.TK_STR) {
              meta.user_data = LexExtStr(cc);
              meta.flags |= K.MLMF_IS_STR;
            } else meta.user_data = LexExpression(cc);
          }
          LexPopNoRestore(cc);
          break;
      }
      switch (cc.token) {
        case 44:
          if (m1() === K.PRS1B_FUN_ARG && !(mode & K.PRSF_UNION)) { Lex(cc); continue pvl; }
          first = false;
          continue; // pvl_restart2
        case 41: case 125:
          Lex(cc);
          break pvl;
        case 59:
          cc.flags = (cc.flags & ~K.CCF_DONT_MAKE_RES) | (old_flags & K.CCF_DONT_MAKE_RES);
          Lex(cc);
          cc.flags |= K.CCF_DONT_MAKE_RES;
          if ((m1() === K.PRS1B_LOCAL_VAR || m1() === K.PRS1B_STATIC_LOCAL_VAR) && !(mode & K.PRSF_UNION))
            break pvl;
          continue pvl;
        default:
          LexExcept(cc, "Missing ';' at");
      }
    }
  }
  // pvl_done:
  cc.flags = (cc.flags & ~(K.CCF_CLASS_DOL_OFFSET | K.CCF_DONT_MAKE_RES)) |
    (old_flags & (K.CCF_CLASS_DOL_OFFSET | K.CCF_DONT_MAKE_RES));
}

// ------------------------------------------------------------- AsmLib bits
export function AOTStoreCodeU8(cc, b) {
  const aotc = cc.aotc;
  aotc.bin.set(aotc.rip++, b & 255);
  if (aotc.rip > aotc.num_bin_U8s) aotc.num_bin_U8s = aotc.rip;
}
// Our addition: storing a code blob (what COCCompile returns in AOT mode)
// also binds its wasm function to this rip.
export function AOTStoreBlob(cc, blob) {
  if (cc.env.blobStored) cc.env.blobStored(cc, blob, cc.aotc.rip);
  for (const b of blob.bytes) AOTStoreCodeU8(cc, b);
}
export function AOTStoreCodeU64(cc, q) {
  const b = i64Bytes(q);
  for (let k = 0; k < 8; k++) AOTStoreCodeU8(cc, b[k]);
}
export function AOTStoreCodeU8At(cc, rip, ...bytes) {
  const aotc = cc.aotc;
  for (const b of bytes) aotc.bin.set(rip++, b & 255);
  if (rip > aotc.num_bin_U8s) aotc.num_bin_U8s = rip;
}

// ------------------------------------------------------------- PrsStmt
export function PrsClass(cc, keyword, fsp_flags, is_extern) {
  let tmpc, base_class;
  if (cc.token !== K.TK_IDENT) LexExcept(cc, 'Expecting identifier at ');
  if (is_extern) {
    tmpc = PrsClassNew();
    tmpc.str = cc.cur_str;
    cc.cur_str = null;
    cc.htc.glbl_hash_table.add(tmpc);
    tmpc.flags |= 1 << K.Cf_EXTERN;
    HashSrcFileSet(cc, tmpc);
    Lex(cc);
  } else {
    if (AOT(cc)) tmpc = HashFind(cc.cur_str, cc.htc.glbl_hash_table, K.HTT_CLASS);
    else tmpc = HashSingleTableFind(cc.cur_str, cc.htc.glbl_hash_table, K.HTT_CLASS);
    if (tmpc) {
      if (!bt(tmpc.flags, K.Cf_EXTERN)) tmpc = null;
      else if (tmpc.use_cnt < 3) UnusedExternWarning(cc, tmpc);
    }
    if (tmpc) {
      tmpc.src_link = null; tmpc.idx = null;
    } else {
      tmpc = PrsClassNew();
      tmpc.str = cc.cur_str;
      cc.cur_str = null;
      cc.htc.glbl_hash_table.add(tmpc);
    }
    tmpc.flags &= ~(1 << K.Cf_EXTERN);
    if (fsp_flags & K.FSF_PUBLIC) tmpc.type |= K.HTF_PUBLIC;
    tmpc.use_cnt = 0;
    HashSrcFileSet(cc, tmpc, cc.last_U16 === 10 ? -1 : 0);
    if (Lex(cc) === 58) {
      if (Lex(cc) !== K.TK_IDENT || !(base_class = cc.hash_entry) || !(base_class.type & K.HTT_CLASS))
        LexExcept(cc, 'Invalid class at ');
      if (Lex(cc) === 44) LexExcept(cc, 'Only one base class allowed at this time at ');
      tmpc.base_class = base_class;
      tmpc.size += base_class.size;
    }
    if (keyword === K.KW_UNION) PrsVarLst(cc, tmpc, K.PRS0_NULL | K.PRS1_CLASS | K.PRSF_UNION);
    else PrsVarLst(cc, tmpc, K.PRS0_NULL | K.PRS1_CLASS);
    tmpc.size += tmpc.neg_offset;
  }
  return tmpc;
}

export function PrsFunJoin(cc, tmp_return, name, fsp_flags) {
  let tmpf, header_lst = null, header_return = null, header_arg_cnt = 0;
  const aotc = cc.aotc;
  if (name) { // if not fun_ptr
    if (AOT(cc)) {
      if ((tmpf = HashFind(name, cc.htc.glbl_hash_table, K.HTT_FUN)) && tmpf.type & K.HTF_IMPORT) tmpf = null;
    } else if ((tmpf = HashSingleTableFind(name, cc.htc.glbl_hash_table, K.HTT_FUN)) && !bt(tmpf.flags, K.Cf_EXTERN))
      tmpf = null;
    if (tmpf && tmpf.use_cnt < 3) UnusedExternWarning(cc, tmpf);
  } else tmpf = null;
  if (tmpf) {
    tmpf.used_reg_mask = K.REGG_CLOBBERED + K.REGG_SAVED + K.REGG_STK_TMP;
    tmpf.src_link = null; tmpf.idx = null;
    header_arg_cnt = tmpf.arg_cnt;
    header_lst = tmpf.member_lst_and_root;
    header_return = tmpf.return_class;
    tmpf.member_lst_and_root = null;
    ClassMemberLstDel(tmpf);
  } else {
    tmpf = PrsFunNew();
    header_return = null;
    tmpf.used_reg_mask = K.REGG_CLOBBERED + K.REGG_SAVED + K.REGG_STK_TMP;
    tmpf.clobbered_reg_mask = K.REGG_CLOBBERED + K.REGG_STK_TMP;
    tmpf.str = name;
    if (AOT(cc)) tmpf.exe_addr = BigInt(aotc.rip);
    else tmpf.exe_addr = cc.env.undefinedExtern(cc, tmpf);
    tmpf.flags |= 1 << K.Cf_EXTERN;
    tmpf.flags |= fsp_flags & K.FSG_FUN_FLAGS1;
    if (name) cc.htc.glbl_hash_table.add(tmpf);
  }
  if (fsp_flags & K.FSF_PUBLIC) tmpf.type |= K.HTF_PUBLIC; else tmpf.type &= ~K.HTF_PUBLIC;
  tmpf.return_class = tmp_return;
  tmpf.use_cnt = 0;
  HashSrcFileSet(cc, tmpf);
  PrsVarLst(cc, tmpf, K.PRS0_NULL | K.PRS1_FUN_ARG);
  tmpf.arg_cnt = tmpf.member_cnt;
  if (0 < tmpf.arg_cnt << 3 && (tmpf.arg_cnt << 3) <= 0x7FFF && !bt(tmpf.flags, K.Ff_DOT_DOT_DOT))
    tmpf.flags |= 1 << K.Ff_RET1;
  for (const m of members(tmpf)) m.offset += 16; // RBP+RETURN
  tmpf.size = 0;
  if (header_return) {
    if (optOn(cc, K.OPTf_WARN_HEADER_MISMATCH)) {
      if (tmpf.return_class !== header_return) {
        if (cc.env.warn) cc.env.warn(`Fun Header return mismatch '${tmpf.str}'`);
        cc.warning_cnt++;
      }
      if (!MemberLstCmp(tmpf.member_lst_and_root, header_lst, header_arg_cnt)) {
        if (cc.env.warn) cc.env.warn(`Fun header args mismatch '${tmpf.str}'`);
        cc.warning_cnt++;
      }
    }
  }
  return tmpf;
}
function MemberLstCmp(m1, m2, cnt = Infinity) {
  while (m1 && m2 && cnt--) {
    if (m1.str !== m2.str || m1.member_class !== m2.member_class || m1.member_class_base !== m2.member_class_base) return false;
    if (m1.flags & K.MLF_DFT_AVAILABLE || m2.flags & K.MLF_DFT_AVAILABLE) {
      if ((m1.flags & (K.MLF_DFT_AVAILABLE | K.MLF_STR_DFT_AVAILABLE)) !== (m2.flags & (K.MLF_DFT_AVAILABLE | K.MLF_STR_DFT_AVAILABLE))) return false;
      if (m1.dft_val !== m2.dft_val) return false;
    }
    m1 = m1.next; m2 = m2.next;
  }
  return cnt < 0 || (!m1 && !m2);
}

function PrsFun(cc, tmp_return, name, fsp_flags) {
  cc.fun_lex_file = cc.lex_include_stk;
  cc.min_line = cc.max_line = cc.lex_include_stk.line_num;
  cc.flags &= ~K.CCF_NO_REG_OPT;
  cc.htc.local_var_lst = cc.htc.fun = PrsFunJoin(cc, tmp_return, name, fsp_flags);
  const fun = cc.htc.fun;
  COCPush(cc);
  COCInit(cc);
  ICAdd(cc, K.IC_ENTER, 0n, null);
  const saved_leave_label = cc.lb_leave;
  cc.lb_leave = COCMiscNew(cc, K.CMT_LABEL);
  cc.flags &= ~K.CCF_HAS_RETURN;
  PrsStmt(cc, 0, null, 0);
  if (cc.max_line < cc.min_line) cc.max_line = cc.min_line;
  if (fun.return_class.size && !(cc.flags & K.CCF_HAS_RETURN)) LexWarn(cc, 'Function should return val ');
  ICAdd(cc, K.IC_LABEL, cc.lb_leave, null);
  cc.lb_leave = saved_leave_label;
  ICAdd(cc, K.IC_LEAVE, 0n, fun.return_class);
  fun.size &= ~7;
  if (AOT(cc)) {
    fun.exe_addr = BigInt(cc.aotc.rip);
    fun.type |= K.HTF_EXPORT | K.HTF_RESOLVE;
    const dbg = {};
    const r = COCCompile(cc, null, dbg);
    fun.dbg_info = dbg.v || null;
    if (r) AOTStoreBlob(cc, r);
  } else {
    const dbg = {};
    fun.exe_addr = COCCompile(cc, null, dbg);
    fun.dbg_info = dbg.v || null;
    if (cc.env.SysSymImportsResolve) cc.env.SysSymImportsResolve(cc, fun.str);
  }
  fun.flags &= ~(1 << K.Cf_EXTERN);
  COCPop(cc);
  if (cc.env.warnUnused) {
    for (const m of members(fun)) {
      if (m.flags & K.MLF_NO_UNUSED_WARN) continue;
      if (!m.use_cnt && optOn(cc, K.OPTf_WARN_UNUSED_VAR)) cc.env.warnUnused(cc, fun, m);
    }
  }
  cc.htc.local_var_lst = cc.htc.fun = cc.fun_lex_file = null;
}

function PrsGlblVarLst(cc, saved_mode, saved_tmpc, saved_val, fsp_flags) {
  let i, j, mode, k, val, st, tmpex, tmpg, tmphg, tmpc, tmpf, tmpf_fun_ptr, has_alias, undef_array_size, is_array;
  const aotc = cc.aotc;
  for (;;) {
    const tmpad = { next: null, cnt: 0, total_cnt: 1 };
    const r = PrsType(cc, saved_tmpc, saved_mode, null, true, fsp_flags, tmpad);
    tmpc = r.cls; saved_tmpc = r.tmpc1; saved_mode = r.mode;
    st = r.ident; tmpf_fun_ptr = r.fun_ptr; tmpex = r.tmpex;
    if (!st) return;
    if (tmpad.next) is_array = true;
    else if (tmpad.total_cnt < 0) { is_array = true; tmpc = csub(tmpc); }
    else is_array = false;
    val = saved_val;
    mode = saved_mode;
    if (tmpex && (mode & 255) === K.PRS0_EXTERN && !AOT(cc) && tmpex.type & K.HTT_EXPORT_SYS_SYM) {
      val = tmpex.val;
      mode = K.PRS0__EXTERN | K.PRS1_NOT_REALLY__EXTERN;
    }
    if (cc.token === 40) {
      switch (mode & 255) {
        case K.PRS0__INTERN:
          tmpf = PrsFunJoin(cc, tmpc, st, fsp_flags);
          tmpf.exe_addr = val;
          tmpf.flags |= 1 << K.Ff_INTERNAL;
          tmpf.flags &= ~(1 << K.Cf_EXTERN);
          return;
        case K.PRS0__EXTERN:
          if (!(fsp_flags & K.FSF__) && !(mode & K.PRS1_NOT_REALLY__EXTERN))
            LexExcept(cc, 'Expecting label with underscore at ');
          tmpf = PrsFunJoin(cc, tmpc, st, fsp_flags);
          tmpf.exe_addr = val;
          if (cc.env.SysSymImportsResolve) cc.env.SysSymImportsResolve(cc, tmpf.str);
          tmpf.flags &= ~(1 << K.Cf_EXTERN);
          if ((saved_mode & 255) === K.PRS0__EXTERN) tmpf.flags |= 1 << K.Ff__EXTERN;
          if (AOT(cc)) tmpf.type |= K.HTF_RESOLVE;
          return;
        case K.PRS0_EXTERN:
          PrsFunJoin(cc, tmpc, st, fsp_flags);
          return;
        case K.PRS0__IMPORT:
          if (!(fsp_flags & K.FSF__)) LexExcept(cc, 'Expecting label with underscore at ');
        // fallthrough
        case K.PRS0_IMPORT:
          if (!AOT(cc)) LexExcept(cc, 'import not needed at ');
          else {
            tmpf = PrsFunJoin(cc, tmpc, st, fsp_flags);
            tmpf.type |= K.HTF_IMPORT;
            tmpf.import_name = (mode & 255) === K.PRS0__IMPORT ? val : st;
          }
          return;
        default:
          PrsFun(cc, tmpc, st, fsp_flags);
          return;
      }
    }
    if (tmpad.total_cnt < 0) { i = 0; undef_array_size = true; }
    else { i = tmpad.total_cnt; undef_array_size = false; }
    j = (tmpf_fun_ptr ? 8 : tmpc.size) * i;
    has_alias = false;
    tmphg = null;
    switch (mode & 255) {
      case K.PRS0__EXTERN:
        tmpg = new CHashGlblVar(st);
        if (AOT(cc)) { tmpg.data_addr_rip = Number(val); tmpg.type = K.HTT_GLBL_VAR | K.HTF_EXPORT; }
        else { tmpg.data_addr = val; tmpg.type = K.HTT_GLBL_VAR; }
        tmpg.flags |= K.GVF_ALIAS;
        break;
      case K.PRS0__IMPORT: case K.PRS0_IMPORT:
        if (!AOT(cc)) LexExcept(cc, 'import not needed at ');
        tmpg = new CHashGlblVar(st);
        tmpg.type = K.HTT_GLBL_VAR | K.HTF_IMPORT;
        tmpg.import_name = (mode & 255) === K.PRS0__IMPORT ? val : st;
        break;
      case K.PRS0_EXTERN:
        tmpg = new CHashGlblVar(st);
        tmpg.type = AOT(cc) ? K.HTT_GLBL_VAR : K.HTT_GLBL_VAR | K.HTF_UNRESOLVED;
        break;
      default:
        if (AOT(cc)) {
          if (optOn(cc, K.OPTf_GLBLS_ON_DATA_HEAP)) {
            if (cc.token === 61) LexExcept(cc, "Can't init glbl var on data heap in AOT module ");
            tmpg = new CHashGlblVar(st);
            tmphg = tmpg.heap_glbl = { size: j, str: st, references: [] };
            aotc.heap_glbls.push(tmphg);
            tmpg.flags = K.GVF_DATA_HEAP;
            tmpg.type = K.HTT_GLBL_VAR;
            if (tmpex && tmpex.type & K.HTT_GLBL_VAR) LexExcept(cc, 'Feature not implemented ');
          } else {
            tmpg = new CHashGlblVar(st);
            if (cc.token === 61) tmpg.data_addr = new BufPtr(new Uint8Array(Math.max(j, 0)), 0);
            if (tmpc.size >= 8) while (aotc.rip & 7) AOTStoreCodeU8(cc, 0); // align
            else if (tmpc.size === 4) while (aotc.rip & 3) AOTStoreCodeU8(cc, 0);
            else if (tmpc.size === 2) while (aotc.rip & 1) AOTStoreCodeU8(cc, 0);
            tmpg.data_addr_rip = aotc.rip;
            tmpg.type = K.HTT_GLBL_VAR | K.HTF_EXPORT;
            if (tmpex && tmpex.type & K.HTT_GLBL_VAR) has_alias = true;
            for (k = 0; k < j; k++) AOTStoreCodeU8(cc, 0); // Init AOT glbl to zero.
          }
        } else {
          tmpg = new CHashGlblVar(st);
          tmpg.data_addr = cc.env.glblAlloc(cc, j, optOn(cc, K.OPTf_GLBLS_ON_DATA_HEAP));
          if (optOn(cc, K.OPTf_GLBLS_ON_DATA_HEAP)) tmpg.flags = K.GVF_DATA_HEAP;
          tmpg.type = K.HTT_GLBL_VAR;
          if (tmpex && tmpex.type & K.HTT_GLBL_VAR && tmpex.type & K.HTF_UNRESOLVED) has_alias = true;
        }
    }
    tmpg.dim.next = tmpad.next;
    if (fsp_flags & K.FSF_PUBLIC) tmpg.type |= K.HTF_PUBLIC;
    tmpg.var_class = tmpc;
    tmpg.str = st;
    tmpg.size = j;
    tmpg.dim.total_cnt = i;
    tmpg.use_cnt = 0;
    HashSrcFileSet(cc, tmpg, cc.last_U16 === 10 ? -1 : 0);
    if ((mode & 255) === K.PRS0_IMPORT || (mode & 255) === K.PRS0__IMPORT) tmpg.flags |= K.GVF_IMPORT;
    if ((mode & 255) === K.PRS0_EXTERN) tmpg.flags |= K.GVF_EXTERN;
    if (tmpf_fun_ptr) { tmpg.fun_ptr = tmpf_fun_ptr; tmpg.flags |= K.GVF_FUN; }
    if (is_array) tmpg.flags |= K.GVF_ARRAY;
    cc.htc.glbl_hash_table.add(tmpg);
    if (!AOT(cc) && !(tmpg.flags & K.GVF_EXTERN) && cc.env.SysSymImportsResolve) cc.env.SysSymImportsResolve(cc, tmpg.str);
    if (cc.token === 61) {
      if (undef_array_size) {
        LexPush(cc); LexPush(cc);
        Lex(cc);
        PrsGlblInit(cc, tmpg, 1);
        LexPopNoRestore(cc);
        tmpg.size = tmpg.dim.total_cnt * tmpc.size;
        if (tmphg) tmphg.size = tmpg.size;
        if (AOT(cc)) for (k = 0; k < tmpg.size; k++) AOTStoreCodeU8(cc, 0);
        LexPopRestore(cc);
      }
      LexPush(cc);
      Lex(cc);
      PrsGlblInit(cc, tmpg, 2);
      if (AOT(cc)) {
        const d = tmpg.data_addr;
        for (k = 0; k < tmpg.size; k++) AOTStoreCodeU8At(cc, tmpg.data_addr_rip + k, d.buf[d.off + k] || 0);
      } else cc.env.glblInitDone(cc, tmpg);
      LexPopNoRestore(cc);
    }
    if (has_alias) {
      if (tmpex.use_cnt < 2) { if (cc.env.warn) cc.env.warn(`Unused extern '${tmpex.str}'`); cc.warning_cnt++; }
      tmpex.flags |= K.GVF_ALIAS;
      tmpex.data_addr = tmpg.data_addr;
      tmpex.data_addr_rip = tmpg.data_addr_rip;
    }
    if (cc.token === 44) Lex(cc);
    else {
      if (cc.token !== 59) LexExcept(cc, "Missing ';' at");
      Lex(cc);
      return;
    }
  }
}

function PrsIf(cc, try_cnt, lb_break) {
  if (cc.token !== 40) LexExcept(cc, "Expecting '(' at ");
  Lex(cc);
  if (!PrsExpression(cc, null, false)) throwCompiler(cc);
  if (cc.token !== 41) LexExcept(cc, "Missing ')' at ");
  Lex(cc);
  const lb = COCMiscNew(cc, K.CMT_LABEL);
  ICAdd(cc, K.IC_BR_ZERO, lb, null);
  PrsStmt(cc, try_cnt, lb_break);
  if (PrsKeyWord(cc) === K.KW_ELSE) {
    Lex(cc);
    const lb1 = COCMiscNew(cc, K.CMT_LABEL);
    ICAdd(cc, K.IC_JMP, lb1, null);
    ICAdd(cc, K.IC_LABEL, lb, null);
    PrsStmt(cc, try_cnt, lb_break);
    ICAdd(cc, K.IC_LABEL, lb1, null);
  } else ICAdd(cc, K.IC_LABEL, lb, null);
}
function PrsWhile(cc, try_cnt) {
  if (cc.token !== 40) LexExcept(cc, "Expecting '(' at ");
  Lex(cc);
  const lb = COCMiscNew(cc, K.CMT_LABEL);
  ICAdd(cc, K.IC_LABEL, lb, null);
  if (!PrsExpression(cc, null, false)) throwCompiler(cc);
  if (cc.token !== 41) LexExcept(cc, "Missing ')' at ");
  Lex(cc);
  const lb_done = COCMiscNew(cc, K.CMT_LABEL);
  ICAdd(cc, K.IC_BR_ZERO, lb_done, null);
  PrsStmt(cc, try_cnt, lb_done);
  ICAdd(cc, K.IC_JMP, lb, null);
  ICAdd(cc, K.IC_LABEL, lb_done, null);
}
function PrsDoWhile(cc, try_cnt) {
  const lb = COCMiscNew(cc, K.CMT_LABEL), lb_done = COCMiscNew(cc, K.CMT_LABEL);
  ICAdd(cc, K.IC_LABEL, lb, null);
  PrsStmt(cc, try_cnt, lb_done);
  if (PrsKeyWord(cc) !== K.KW_WHILE) LexExcept(cc, "Missing 'while' at");
  if (Lex(cc) !== 40) LexExcept(cc, "Expecting '(' at ");
  Lex(cc);
  if (!PrsExpression(cc, null, false)) throwCompiler(cc);
  if (cc.token !== 41) LexExcept(cc, "Missing ')' at ");
  ICAdd(cc, K.IC_BR_NOT_ZERO, lb, null);
  ICAdd(cc, K.IC_LABEL, lb_done, null);
  if (Lex(cc) !== 59) LexExcept(cc, "Missing ';' at");
  Lex(cc);
}
function PrsFor(cc, try_cnt) {
  if (cc.token !== 40) LexExcept(cc, "Expecting '(' at ");
  Lex(cc);
  PrsStmt(cc, try_cnt);
  const lb = COCMiscNew(cc, K.CMT_LABEL);
  ICAdd(cc, K.IC_LABEL, lb, null);
  if (!PrsExpression(cc, null, false)) throwCompiler(cc);
  const lb_done = COCMiscNew(cc, K.CMT_LABEL);
  ICAdd(cc, K.IC_BR_ZERO, lb_done, null);
  if (cc.token !== 59) LexExcept(cc, "Missing ';' at");
  Lex(cc);
  COCPush(cc);
  COCInit(cc);
  if (cc.token !== 41) PrsStmt(cc, try_cnt, null, 0);
  COCPush(cc);
  const tmpcbh = COCPopNoFree(cc);
  COCPop(cc);
  if (cc.token !== 41) LexExcept(cc, "Missing ')' at ");
  Lex(cc);
  PrsStmt(cc, try_cnt, lb_done);
  COCAppend(cc, tmpcbh);
  ICAdd(cc, K.IC_JMP, lb, null);
  ICAdd(cc, K.IC_LABEL, lb_done, null);
}

function PrsSwitch(cc, try_cnt) {
  let header = [], lb_fwd_case = null, tmpi_jmp = null, tmpi_start, dft_found = false, nobound;
  let k_start = null, k_end, lo = null, hi = null, tmpss;
  if (cc.token === 40) nobound = false;
  else if (cc.token === 91) nobound = true;
  else LexExcept(cc, "Expecting '(' or '[' at ");
  Lex(cc);
  // CSubSwitch queue; head is the sentinel and head.lb_break is the outer break label
  const head = { lb_start: null, lb_break: null, isHead: true };
  const subs = []; // subs[subs.length-1] is head.last when non-empty
  const last = () => (subs.length ? subs[subs.length - 1] : head);
  head.lb_break = COCMiscNew(cc, K.CMT_LABEL);
  head.lb_break.use_cnt++;
  const lb_dft = COCMiscNew(cc, K.CMT_LABEL);
  lb_dft.use_cnt++;
  const mc_jt = COCMiscNew(cc, K.CMT_JMP_TABLE);
  mc_jt.begin = COCMiscNew(cc, K.CMT_LABEL);
  mc_jt.begin.use_cnt++;
  if (!PrsExpression(cc, null, false)) throwCompiler(cc);
  const tmpi_sub = ICAdd(cc, K.IC_IMM_I64, 0n, RT(cc, K.RT_I64));
  ICAdd(cc, K.IC_SUB, 0n, RT(cc, K.RT_I64));
  const tmpi_cmp = ICAdd(cc, K.IC_IMM_I64, 0n, RT(cc, K.RT_I64));
  if (nobound) {
    ICAdd(cc, K.IC_NOBOUND_SWITCH, mc_jt, null);
    if (cc.token !== 93) LexExcept(cc, "Missing ']' at ");
  } else {
    ICAdd(cc, K.IC_SWITCH, mc_jt, null);
    if (cc.token !== 41) LexExcept(cc, "Missing ')' at ");
  }
  if (Lex(cc) !== 123) LexExcept(cc, "Expecting '{' at ");
  Lex(cc);
  ICAdd(cc, K.IC_LABEL, mc_jt.begin, null);
  const subCalls = () => {
    for (const s of subs) if (s.lb_start) ICAdd(cc, K.IC_SUB_CALL, s.lb_start, null);
  };
  for (;;) {
    sw: while (cc.token && cc.token !== 125) {
      let kw = PrsKeyWord(cc);
      sw_cont: for (;;) {
        switch (kw) {
          case K.KW_END:
            break sw; // goto sw_sub_end
          case K.KW_START: {
            if (Lex(cc) === 58) Lex(cc); else LexExcept(cc, "Expecting ':' at ");
            tmpss = { lb_start: null, lb_break: null };
            subs.push(tmpss); // QueIns(tmpss,head.last)
            last().lb_break = COCMiscNew(cc, K.CMT_LABEL);
            last().lb_break.use_cnt++;
            lb_fwd_case = COCMiscNew(cc, K.CMT_LABEL);
            tmpi_jmp = ICAdd(cc, K.IC_JMP, lb_fwd_case, null);
            tmpss.lb_start = COCMiscNew(cc, K.CMT_LABEL);
            tmpi_start = ICAdd(cc, K.IC_LABEL, tmpss.lb_start, null);
            while (cc.token && cc.token !== 125) {
              const kw2 = PrsKeyWord(cc);
              if (kw2 === K.KW_END) { OptFree(tmpi_jmp); break sw; }
              if (kw2 === K.KW_START || kw2 === K.KW_CASE || kw2 === K.KW_DFT) {
                if (cc.coc.head.last === tmpi_start) { OptFree(tmpi_jmp); tmpss.lb_start = null; }
                else {
                  ICAdd(cc, K.IC_RET, 0n, null);
                  ICAdd(cc, K.IC_LABEL, lb_fwd_case, null);
                  ICAdd(cc, K.IC_SUB_CALL, tmpss.lb_start, null); // In case fall-thru
                }
                kw = kw2;
                continue sw_cont;
              }
              PrsStmt(cc, try_cnt);
            }
            break sw_cont;
          }
          case K.KW_CASE: {
            if (subs.length) {
              lb_fwd_case = COCMiscNew(cc, K.CMT_LABEL);
              tmpi_jmp = ICAdd(cc, K.IC_JMP, lb_fwd_case, null); // In case fall-thru
            }
            Lex(cc);
            const lb_entry = COCMiscNew(cc, K.CMT_LABEL);
            ICAdd(cc, K.IC_LABEL, lb_entry, null);
            lb_entry.use_cnt++;
            if (subs.length) { subCalls(); ICAdd(cc, K.IC_LABEL, lb_fwd_case, null); }
            if (cc.token === 58) k_start = k_start === null ? 0n : k_start + 1n;
            else k_start = LexExpressionI64(cc);
            if (lo === null || k_start < lo) lo = k_start;
            if (hi === null || k_start > hi) hi = k_start;
            if (cc.token === 58) {
              Lex(cc);
              header.push([k_start, lb_entry]);
            } else if (cc.token === K.TK_ELLIPSIS) {
              Lex(cc);
              k_end = LexExpressionI64(cc);
              if (cc.token === 58) {
                Lex(cc);
                if (k_end < lo) lo = k_end;
                if (k_end > hi) hi = k_end;
                if (k_start > k_end) [k_start, k_end] = [k_end, k_start];
                for (let vv = k_start; vv <= k_end; vv++) header.push([vv, lb_entry]);
                k_start = k_end;
              } else LexExcept(cc, "Expecting ':' at ");
            } else LexExcept(cc, "Expecting ':' at ");
            break sw_cont;
          }
          case K.KW_DFT:
            if (subs.length) {
              lb_fwd_case = COCMiscNew(cc, K.CMT_LABEL);
              tmpi_jmp = ICAdd(cc, K.IC_JMP, lb_fwd_case, null); // In case fall-thru
            }
            Lex(cc);
            ICAdd(cc, K.IC_LABEL, lb_dft, null);
            if (cc.token === 58) Lex(cc); else LexExcept(cc, "Expecting ':' at ");
            if (subs.length) { subCalls(); ICAdd(cc, K.IC_LABEL, lb_fwd_case, null); }
            dft_found = true;
            break sw_cont;
          default:
            PrsStmt(cc, try_cnt, last().lb_break);
            break sw_cont;
        }
      }
    }
    // sw_sub_end:
    tmpss = last();
    ICAdd(cc, K.IC_LABEL, tmpss.lb_break, null);
    if (tmpss === head) {
      if (cc.token !== 125) LexExcept(cc, "Missing '}' at ");
      Lex(cc);
      break;
    }
    subs.pop();
    if (PrsKeyWord(cc) !== K.KW_END) LexExcept(cc, "Missing 'end' at ");
    if (Lex(cc) === 58) Lex(cc); else LexExcept(cc, "Expecting ':' at ");
  }
  if (!dft_found) ICAdd(cc, K.IC_LABEL, lb_dft, null);
  if (lo === null) { lo = 0x7FFFFFFFFFFFFFFFn; hi = -0x8000000000000000n; }
  if (0n < lo && lo <= 16n) lo = 0n;
  const range = hi - lo + 1n;
  if (lo > hi || !(0n < range && range <= 0xFFFFn)) LexExcept(cc, 'switch range error at ');
  const jmp_table = new Array(Number(range)).fill(lb_dft);
  tmpi_sub.data = lo;
  tmpi_cmp.data = range;
  for (let n = header.length - 1; n >= 0; n--) { // header is a LIFO list in the original
    const [val, lab] = header[n];
    if (jmp_table[Number(val - lo)] !== lb_dft) LexExcept(cc, 'Duplicate case at ');
    else jmp_table[Number(val - lo)] = lab;
  }
  mc_jt.dft = lb_dft;
  mc_jt.jmp_table = jmp_table;
  mc_jt.range = Number(range);
}

function PrsNoWarn(cc) {
  while (cc.token === K.TK_IDENT) {
    const m = cc.local_var_entry;
    if (!m) LexExcept(cc, 'Expecting local var at ');
    m.flags |= K.MLF_NO_UNUSED_WARN;
    if (Lex(cc) === 44) Lex(cc);
    else if (cc.token !== 59) LexExcept(cc, "Expecting ',' at ");
  }
}

// PrsStreamBlk(): #exe{} -- runs the block in the host and injects what it
// StreamPrint()s into the lex stream.
export function PrsStreamBlk(cc) {
  const htc = { ...cc.htc };
  htc.old_flags = cc.flags;
  const blk = { body: '' };
  cc.stream_blks.push(blk);
  COCPush(cc);
  cc.coc.misc = [];
  cc.htc.next = htc;
  cc.htc.fun = cc.htc.local_var_lst = null;
  const host = cc.env.hostHashTable(cc);
  cc.htc.define_hash_table = cc.htc.hash_table_lst = cc.htc.glbl_hash_table = cc.htc.local_hash_table = host;
  cc.flags = (cc.flags & ~(K.CCF_ASM_EXPRESSIONS | K.CCF_AOT_COMPILE)) | K.CCF_EXE_BLK;
  if (cc.token === 123) Lex(cc);
  else LexExcept(cc, "Missing '}' at ");
  while (cc.token && cc.token !== 125) ExeCmdLine(cc);
  Object.assign(cc.htc, htc);
  cc.htc.next = htc.next;
  cc.flags = (cc.flags & ~K.CCF_EXE_BLK) | (htc.old_flags & (K.CCF_ASM_EXPRESSIONS | K.CCF_EXE_BLK | K.CCF_AOT_COMPILE));
  COCPop(cc);
  cc.stream_blks.pop();
  if (blk.body.length) LexIncludeStr(cc, 'StreamBlk', blk.body, false);
  Lex(cc); // Skip '}'
}

// ExeCmdLine() from KTask.HC: JIT-compile-and-execute loop.
export function ExeCmdLine(cc) {
  let res = 0n;
  while (cc.token && (cc.token !== 125 || !(cc.flags & K.CCF_EXE_BLK))) {
    cc.flags &= ~K.CCF_HAS_MISC_DATA;
    const type = {};
    const code = LexStmt2Bin(cc, type, K.CMPF_PRS_SEMICOLON); // default from CompilerB.HH prototype
    if (code !== null && code !== undefined) res = cc.env.Call(cc, code);
  }
  return res;
}

// LexStmt2Bin() from CMain.HC
export function LexStmt2Bin(cc, typeOut, cmp_flags = 0) {
  let res = null, size;
  if (typeOut) typeOut.v = K.RT_I64;
  if (cc.aot_depth === 2) COCPush(cc);
  COCInit(cc);
  if (!PrsStmt(cc, 0, null, cmp_flags)) {
    if (cc.coc.head.next !== cc.coc.head) {
      cc.coc.head.last.flags &= ~K.ICF_RES_NOT_USED;
      ICAdd(cc, K.IC_RETURN_VAL2, 0n, null);
      ICAdd(cc, K.IC_RET, 0n, null);
      if ((res = COCCompile(cc, typeOut))) {
        if (AOT(cc)) {
          const j = cc.aotc.rip;
          AOTStoreBlob(cc, res);
          res = j;
        }
      }
    }
  }
  if (cc.aot_depth === 2) {
    const tmpcbh = COCPopNoFree(cc);
    COCAppend(cc, tmpcbh);
  }
  return res;
}

function PrsTryBlk(cc, try_cnt) {
  const tmpc = RT(cc, K.RT_PTR);
  const tmp_try = HashFind('SysTry', cc.htc.hash_table_lst, K.HTT_FUN);
  const tmp_untry = HashFind('SysUntry', cc.htc.hash_table_lst, K.HTT_FUN);
  if (!tmp_try || !tmp_untry) LexExcept(cc, 'Missing header for SysTry() and SysUntry() at ');
  cc.flags |= K.CCF_NO_REG_OPT; // TODO:Currently no reg vars in funs with try/catch
  const lb_catch = COCMiscNew(cc, K.CMT_LABEL), lb_done = COCMiscNew(cc, K.CMT_LABEL), lb_untry = COCMiscNew(cc, K.CMT_LABEL);
  const callIC = (f) => {
    if (bt(f.flags, K.Cf_EXTERN)) {
      cc.abs_cnts.externs++;
      if (AOT(cc)) ICAdd(cc, K.IC_CALL_IMPORT, f, tmpc);
      else ICAdd(cc, K.IC_CALL_INDIRECT2, new FieldRef(f, 'exe_addr'), tmpc);
    } else ICAdd(cc, K.IC_CALL, f.exe_addr, tmpc);
  };
  ICAdd(cc, K.IC_CALL_START, 0n, null);
  ICAdd(cc, K.IC_GET_LABEL, lb_untry, tmpc, K.ICF_PUSH_RES);
  ICAdd(cc, K.IC_GET_LABEL, lb_catch, tmpc, K.ICF_PUSH_RES);
  callIC(tmp_try);
  if ((bt(tmp_try.flags, K.Ff_RET1) || bt(tmp_try.flags, K.Ff_ARGPOP)) && !bt(tmp_try.flags, K.Ff_NOARGPOP))
    ICAdd(cc, K.IC_ADD_RSP1, 16n, tmpc);
  else ICAdd(cc, K.IC_ADD_RSP, 16n, tmpc);
  ICAdd(cc, K.IC_CALL_END, 0n, tmpc);
  ICAdd(cc, K.IC_END_EXP, 0n, null, K.ICF_RES_NOT_USED);
  PrsStmt(cc, try_cnt + 1);
  ICAdd(cc, K.IC_LABEL, lb_untry, null);
  ICAdd(cc, K.IC_CALL_START, 0n, null);
  callIC(tmp_untry);
  ICAdd(cc, K.IC_CALL_END, 0n, tmpc);
  ICAdd(cc, K.IC_END_EXP, 0n, null, K.ICF_RES_NOT_USED);
  ICAdd(cc, K.IC_JMP, lb_done, null);
  if (PrsKeyWord(cc) !== K.KW_CATCH) LexExcept(cc, "Missing 'catch' at");
  Lex(cc);
  ICAdd(cc, K.IC_LABEL, lb_catch, null);
  PrsStmt(cc, try_cnt + 1);
  ICAdd(cc, K.IC_RET, 0n, tmpc);
  ICAdd(cc, K.IC_LABEL, lb_done, null);
}

// Returns TRUE if the statement was an asm block (FSF_ASM).
export function PrsStmt(cc, try_cnt = 0, lb_break = null, cmp_flags = K.CMPF_PRS_SEMICOLON) {
  let i, fsp_flags = 0, tmpex, g_lb;
  const done = () => fsp_flags & K.FSF_ASM;
  if (cmp_flags & K.CMPF_ONE_ASM_INS) LexExcept(cc, 'asm not supported ');
  for (;;) {
    while (cc.token === 44) Lex(cc);
    if (cc.token === 123) {
      Lex(cc);
      while (cc.token !== 125 && cc.token !== K.TK_EOF) PrsStmt(cc, try_cnt, lb_break);
      if (cc.lex_include_stk === cc.fun_lex_file) cc.max_line = cc.lex_include_stk.line_num;
      if (Lex(cc) !== 44) return done();
      continue;
    }
    if (cc.token === 59) {
      if (cmp_flags & K.CMPF_PRS_SEMICOLON) Lex(cc);
      if (cc.token !== 44) return done();
      continue;
    }
    let semicolon = false, prs_exp = false;
    if (cc.token === K.TK_IDENT) {
      if ((tmpex = cc.hash_entry)) {
        let not_kw = !(tmpex.type & K.HTT_KEYWORD);
        if (!not_kw) {
          i = tmpex.user_data0;
          switch (i) {
            case K.KW_ASM:
              cc.env.asmBlock(cc);
              if (!cc.htc.fun) fsp_flags = K.FSF_ASM;
              if (cc.token !== 44) return done();
              break;
            case K.KW_LOCK: case K.KW_TRY: case K.KW_IF: case K.KW_FOR: case K.KW_WHILE:
            case K.KW_DO: case K.KW_SWITCH:
              Lex(cc);
              switch (i) {
                case K.KW_LOCK: cc.lock_cnt++; PrsStmt(cc, try_cnt); cc.lock_cnt--; break;
                case K.KW_TRY: PrsTryBlk(cc, try_cnt); break;
                case K.KW_IF: PrsIf(cc, try_cnt, lb_break); break;
                case K.KW_FOR: PrsFor(cc, try_cnt); break;
                case K.KW_WHILE: PrsWhile(cc, try_cnt); break;
                case K.KW_DO: PrsDoWhile(cc, try_cnt); break;
                case K.KW_SWITCH: PrsSwitch(cc, try_cnt); break;
              }
              if (cc.token !== 44) return done();
              break;
            case K.KW__EXTERN: case K.KW__IMPORT: case K.KW_EXTERN: case K.KW_IMPORT: case K.KW__INTERN: {
              if (cc.htc.fun) LexExcept(cc, 'Not allowed in fun');
              Lex(cc);
              let kw = i;
              if (kw === K.KW__EXTERN && optOn(cc, K.OPTf_EXTERNS_TO_IMPORTS)) kw = K.KW__IMPORT;
              if (kw === K.KW__EXTERN) {
                if (cc.token !== K.TK_IDENT || !(tmpex = cc.hash_entry) || !(tmpex.type & K.HTT_EXPORT_SYS_SYM))
                  LexExcept(cc, 'Expecting system sym at ');
                if (cc.cur_str[0] === '_') fsp_flags |= K.FSF__;
                const val = tmpex.val;
                Lex(cc);
                if (cc.token !== K.TK_IDENT || !(tmpex = cc.hash_entry) || !(tmpex.type & (K.HTT_CLASS | K.HTT_INTERNAL_TYPE)))
                  LexExcept(cc, 'Expecting type at ');
                Lex(cc);
                PrsGlblVarLst(cc, K.PRS0__EXTERN | K.PRS1_NULL, tmpex, val, fsp_flags);
              } else if (kw === K.KW__IMPORT) {
                if (cc.token !== K.TK_IDENT) LexExcept(cc, 'Expecting system sym at ');
                if (cc.cur_str[0] === '_') fsp_flags |= K.FSF__;
                const import_name = cc.cur_str;
                cc.cur_str = null;
                if (Lex(cc) !== K.TK_IDENT || !(tmpex = cc.hash_entry) || !(tmpex.type & (K.HTT_CLASS | K.HTT_INTERNAL_TYPE)))
                  LexExcept(cc, 'Expecting type at ');
                Lex(cc);
                PrsGlblVarLst(cc, K.PRS0__IMPORT | K.PRS1_NULL, tmpex, import_name, fsp_flags);
              } else if (kw === K.KW_EXTERN) {
                if (cc.token !== K.TK_IDENT) LexExcept(cc, 'Expecting type at ');
                tmpex = cc.hash_entry;
                const k2 = PrsKeyWord(cc);
                if (k2 === K.KW_CLASS || k2 === K.KW_UNION) {
                  Lex(cc);
                  PrsClass(cc, k2, fsp_flags, true);
                  fsp_flags &= K.FSF_ASM;
                  semicolon = true;
                  break;
                }
                if (!tmpex || !(tmpex.type & (K.HTT_CLASS | K.HTT_INTERNAL_TYPE))) LexExcept(cc, 'Expecting type at ');
                Lex(cc);
                if (optOn(cc, K.OPTf_EXTERNS_TO_IMPORTS)) PrsGlblVarLst(cc, K.PRS0_IMPORT | K.PRS1_NULL, tmpex, 0, fsp_flags);
                else PrsGlblVarLst(cc, K.PRS0_EXTERN | K.PRS1_NULL, tmpex, 0, fsp_flags);
              } else if (kw === K.KW_IMPORT) {
                if (cc.token !== K.TK_IDENT || !(tmpex = cc.hash_entry) || !(tmpex.type & (K.HTT_CLASS | K.HTT_INTERNAL_TYPE)))
                  LexExcept(cc, 'Expecting type at ');
                Lex(cc);
                PrsGlblVarLst(cc, K.PRS0_IMPORT | K.PRS1_NULL, tmpex, 0, fsp_flags);
              } else { // _intern
                const val = LexExpressionI64(cc);
                if (cc.token !== K.TK_IDENT || !(tmpex = cc.hash_entry) || !(tmpex.type & (K.HTT_CLASS | K.HTT_INTERNAL_TYPE)))
                  LexExcept(cc, 'Expecting type at ');
                Lex(cc);
                PrsGlblVarLst(cc, K.PRS0__INTERN | K.PRS1_NULL, tmpex, val, fsp_flags);
              }
              fsp_flags &= K.FSF_ASM;
              break;
            }
            case K.KW_STATIC: fsp_flags = K.FSF_STATIC | (fsp_flags & K.FSF_ASM); Lex(cc); break;
            case K.KW_INTERRUPT: fsp_flags = K.FSF_INTERRUPT | K.FSF_NOARGPOP | (fsp_flags & (K.FSG_FUN_FLAGS2 | K.FSF_ASM)); Lex(cc); break;
            case K.KW_HASERRCODE: fsp_flags = K.FSF_HASERRCODE | (fsp_flags & (K.FSG_FUN_FLAGS2 | K.FSF_ASM)); Lex(cc); break;
            case K.KW_ARGPOP: fsp_flags = K.FSF_ARGPOP | (fsp_flags & (K.FSG_FUN_FLAGS2 | K.FSF_ASM)); Lex(cc); break;
            case K.KW_NOARGPOP: fsp_flags = K.FSF_NOARGPOP | (fsp_flags & (K.FSG_FUN_FLAGS2 | K.FSF_ASM)); Lex(cc); break;
            case K.KW_PUBLIC: fsp_flags = K.FSF_PUBLIC | (fsp_flags & (K.FSG_FUN_FLAGS2 | K.FSF_ASM)); Lex(cc); break;
            case K.KW_RETURN: {
              if (!cc.htc.fun) LexExcept(cc, "Not in fun.  Can't return a val ");
              if (try_cnt) {
                const tu = HashFind('SysUntry', cc.htc.hash_table_lst, K.HTT_FUN);
                for (let n = 0; n < try_cnt; n++) {
                  if (bt(tu.flags, K.Cf_EXTERN)) {
                    cc.abs_cnts.externs++;
                    if (AOT(cc)) ICAdd(cc, K.IC_CALL_IMPORT, tu, RT(cc, K.RT_PTR));
                    else ICAdd(cc, K.IC_CALL_INDIRECT2, new FieldRef(tu, 'exe_addr'), RT(cc, K.RT_PTR));
                  } else ICAdd(cc, K.IC_CALL, tu.exe_addr, RT(cc, K.RT_PTR));
                }
              }
              if (Lex(cc) !== 59) {
                if (!cc.htc.fun.return_class.size) LexWarn(cc, 'Function should NOT return val ');
                if (!PrsExpression(cc, null, false)) throwCompiler(cc);
                ICAdd(cc, K.IC_RETURN_VAL, 0n, cc.htc.fun.return_class);
                cc.flags |= K.CCF_HAS_RETURN;
              } else if (cc.htc.fun.return_class.size) LexWarn(cc, 'Function should return val ');
              ICAdd(cc, K.IC_JMP, cc.lb_leave, null);
              semicolon = true;
              break;
            }
            case K.KW_GOTO:
              if (Lex(cc) !== K.TK_IDENT) LexExcept(cc, 'Expecting identifier at ');
              if (!(g_lb = COCGoToLabelFind(cc, cc.cur_str))) {
                g_lb = COCMiscNew(cc, K.CMT_GOTO_LABEL);
                g_lb.str = cc.cur_str;
                cc.cur_str = null;
              }
              g_lb.use_cnt++;
              ICAdd(cc, K.IC_JMP, g_lb, null);
              Lex(cc);
              semicolon = true;
              break;
            case K.KW_BREAK:
              Lex(cc);
              if (!lb_break) LexExcept(cc, "'break' not allowed\n");
              ICAdd(cc, K.IC_JMP, lb_break, null);
              semicolon = true;
              break;
            case K.KW_NO_WARN:
              Lex(cc);
              PrsNoWarn(cc);
              semicolon = true;
              break;
            case K.KW_UNION: case K.KW_CLASS: {
              Lex(cc);
              tmpex = PrsClass(cc, i, fsp_flags, false);
              if (!cc.htc.fun && cc.token !== 59) {
                PrsGlblVarLst(cc, K.PRS0_NULL | K.PRS1_NULL, tmpex, 0, fsp_flags);
                fsp_flags &= K.FSF_ASM;
                break;
              }
              fsp_flags &= K.FSF_ASM;
              semicolon = true;
              break;
            }
            default: // A keyword that is not valid here is just a symbol.
              not_kw = true;
          }
        }
        if (not_kw) { // sm_not_keyword_afterall:
          if (tmpex.type & (K.HTT_CLASS | K.HTT_INTERNAL_TYPE)) {
            if (cc.htc.fun) {
              if (fsp_flags & K.FSF_STATIC) PrsVarLst(cc, cc.htc.fun, K.PRS0_NULL | K.PRS1_STATIC_LOCAL_VAR);
              else PrsVarLst(cc, cc.htc.fun, K.PRS0_NULL | K.PRS1_LOCAL_VAR);
              if (cc.token === 125) return done();
            } else {
              Lex(cc);
              PrsGlblVarLst(cc, K.PRS0_NULL | K.PRS1_NULL, tmpex, 0, fsp_flags);
            }
          } else {
            if (tmpex.type & (K.HTT_OPCODE | K.HTT_ASM_KEYWORD)) {
              if (cc.htc.fun) cc.env.asmIns(cc);
              else LexExcept(cc, 'Use Asm Blk at ');
              if (cc.token !== 44) return done();
            } else prs_exp = true;
          }
          if (!prs_exp) fsp_flags &= K.FSF_ASM;
        }
      } else { // Ident, not in hash table
        if (cc.local_var_entry) prs_exp = true;
        else {
          if (!(g_lb = COCGoToLabelFind(cc, cc.cur_str))) {
            g_lb = COCMiscNew(cc, K.CMT_GOTO_LABEL);
            g_lb.str = cc.cur_str;
            cc.cur_str = null;
          } else if (g_lb.flags & K.CMF_DEFINED) LexExcept(cc, 'Duplicate goto label at ');
          g_lb.flags |= K.CMF_DEFINED;
          ICAdd(cc, K.IC_LABEL, g_lb, null);
          if (Lex(cc) === 58) Lex(cc); // skip colon
          else LexExcept(cc, 'Undefined identifier at ');
          if (!cc.htc.fun) LexExcept(cc, 'No global labels at ');
          if (cc.token !== 44) return done();
        }
      }
    } else if (cc.token === K.TK_STR || cc.token === K.TK_CHAR_CONST) {
      PrsFunCall(cc, null, false, null);
      semicolon = true;
    } else if (cc.token !== K.TK_EOF) prs_exp = true;
    else return done(); // TK_EOF
    if (prs_exp) { // sm_prs_exp:
      if (!PrsExpression(cc, null, true)) throwCompiler(cc);
      semicolon = true;
    }
    if (semicolon) { // sm_semicolon:
      if (cmp_flags & K.CMPF_PRS_SEMICOLON) {
        if (cc.token === 59) Lex(cc);
        else if (cc.token !== 44) LexExcept(cc, "Missing ';' at");
      }
      if (cc.token !== 44) return done();
    }
  }
}
