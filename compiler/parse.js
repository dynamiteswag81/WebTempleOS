// Port of TempleOS Compiler/PrsLib.HC, PrsExp.HC, PrsVar.HC, PrsStmt.HC.
// Generates TempleOS intermediate code (ICs) exactly the way the original
// front-end does, so the shared IC->wasm backend sees identical input both
// for the bootstrap build and for the in-browser JIT.
import * as K from './consts.js';
import {
  CompileError, HashFind, HashSingleTableFind, PrsClassNew, PrsFunNew, cadd, csub, cbase,
  OptClassFwd, CHashExport, CHashGlblVar, CMemberLst, MemberFind, HashTable,
} from './core.js';
import {
  Lex, LexExcept, LexWarn, LexGetChar, LexPush, LexPopRestore, LexPopNoRestore, LexExtStr,
  PrsKeyWord, srcLink, LexIncludeStr,
} from './lex.js';
import { I64, f2b, b2f, f2i } from './util.js';
import { OptPass012, OptFree, intermediate_code_table } from './opt.js';

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
function QueIns(e, pred) { const s = pred.next; e.next = s; e.last = pred; pred.next = e; s.last = e; }
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
  t.file = cc.lex_include_stk ? cc.lex_include_stk.full_name : '';
  QueIns(t, cc.coc.head.last);
  return t;
}
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
  if (h.next !== h) {
    const first = h.next, last = h.last, ch = cc.coc.head;
    ch.last.next = first; first.last = ch.last;
    ch.last = last; last.next = ch;
    h.next = h.last = h;
  }
  if (b.misc !== cc.coc.misc) for (const m of b.misc) cc.coc.misc.push(m);
}
export function COCMiscNew(cc, ty) {
  const m = { type: ty, flags: 0, str: null, use_cnt: 0, addr: -1, fwd: null, dft: null, begin: null,
    range: 0, jmp_table: null, st_len: 0, h: null, dim: null, id: ++miscSerial };
  cc.coc.misc.push(m);
  return m;
}
let miscSerial = 0;
export function COCGoToLabelFind(cc, name) {
  for (const m of cc.coc.misc)
    if ((m.type === K.CMT_GOTO_LABEL || m.type === K.CMT_ASM_LABEL) && m.str === name) return m;
  return null;
}
const RT = (cc, rt) => cc.cmp.internal_types[rt];

// ------------------------------------------------------------- PrsExp
const PE_UNARY_TERM1 = 0, PE_UNARY_TERM2 = 1, PE_MAYBE_MODIFIERS = 2, PE_UNARY_MODIFIERS = 3,
  PE_DEREFERENCE = 4, PE_CHECK_BINARY_OPS1 = 5, PE_CHECK_BINARY_OPS2 = 6, PE_DO_UNARY_OP = 7,
  PE_DO_BINARY_OP = 8, PE_POP_HIGHER = 9, PE_PUSH_LOWER = 10, PE_POP_ALL1 = 11, PE_POP_ALL2 = 12;

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

function ParenWarning(cc) { /* OPTf_WARN_PAREN is only a style warning; not needed */ }
export const optOn = (cc, n) => ((cc.opts >> BigInt(n)) & 1n) !== 0n;

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
  let i, cur_op = 0, stk_op = 0, state, max_prec = K.PREC_NULL, left_prec = K.PREC_MAX;
  let tmpi, tmpc;
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
        state = PrsUnaryTerm(cc, ps, v);
        continue;
      case PE_UNARY_MODIFIERS:
        state = PrsUnaryModifier(cc, ps, v);
        continue;
      case PE_MAYBE_MODIFIERS:
        if (cc.token === 40) {
          cc.flags |= K.CCF_RAX;
          state = PrsUnaryModifier(cc, ps, v);
        } else state = PE_CHECK_BINARY_OPS1;
        continue;
      case PE_DEREFERENCE: {
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
          if (tmpi.code === K.IC_DEREF) tmpi.code = i & 0xFFFF, tmpi.prec = i >>> 16;
        } else {
          tmpc = OptClassFwd(csub(tmpi.cls));
          ICAdd(cc, i, 0n, tmpc);
        }
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
          Lex(cc);
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
        Lex(cc);
        if (u8_2(cur_op) > max_prec) max_prec = u8_2(cur_op);
        left_prec = u8_2(cur_op);
        if (intermediate_code_table[u16_0(cur_op)].type === K.IST_ASSIGN) {
          tmpi = cc.coc.head.last;
          tmpc = OptClassFwd(tmpi.cls);
          if (intermediate_code_table[tmpi.code].type !== K.IST_DEREF ||
            (!tmpc.ptr_stars_cnt && !(tmpc.flags & (1 << K.Cf_INTERNAL_TYPE))))
            LexExcept(cc, 'Invalid lval at ');
          tmpi.code = K.IC_NOP1;
          cur_op = (cur_op & ~0xFF0000) | ((K.PREC_ASSIGN | K.ASSOCF_RIGHT) << 16);
        }
      // fallthrough
      case PE_POP_HIGHER:
        stk_op = PrsPop(ps);
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
          cur_op |= K.ECF_HAS_PUSH_CMP << 24;
        } else if (u16_0(cur_op) === K.IC_AND_AND || u16_0(cur_op) === K.IC_OR_OR)
          ICAdd(cc, K.IC_NOP1, 0n, RT(cc, K.RT_I64));
        state = PE_POP_HIGHER; continue;
      case PE_PUSH_LOWER:
        PrsPush(ps, tmpc); PrsPush(ps, stk_op);
        PrsPush(ps, cc.coc.head.last.cls); PrsPush(ps, cur_op);
        state = PE_UNARY_TERM1; continue;
      case PE_POP_ALL1:
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
  PrsPush(ps, 0); PrsPush(ps, 0);
  try {
    PrsExpression2(cc, ps, ctx);
  } catch (e) {
    if (e.holyc) res = false; else throw e;
    if (cc.env.rethrowErrors) throw e;
    cc.lastError = e;
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
    if (Lex(cc) === 46) member = true;
  } else {
    if (!(tmpc = cc.hash_entry) || !(tmpc.type & (K.HTT_CLASS | K.HTT_INTERNAL_TYPE | K.HTT_GLBL_VAR |
      K.HTT_FUN | K.HTT_EXPORT_SYS_SYM)))
      LexExcept(cc, 'Invalid class at ');
    if (tmpc.type & (K.HTT_FUN | K.HTT_EXPORT_SYS_SYM)) {
      LexExcept(cc, 'Size not defined at ');
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

function PrsFunCall(cc, ps, indirect, tmpf) {
  let argc_cnt, dft_val, is_first_arg = true, needs_right_paren, is_print = false, is_putchars = false;
  let last_class = null, tmpm, tmpi, tmpc2;
  if (!tmpf) {
    if (cc.token === K.TK_CHAR_CONST) {
      if (!(tmpf = HashFind('PutChars', cc.htc.hash_table_lst, K.HTT_FUN)))
        LexExcept(cc, 'Missing header for Print() and PutChars() at ');
      if (!cc.cur_i64) Lex(cc);
      is_putchars = true;
    } else {
      if (!(tmpf = HashFind('Print', cc.htc.hash_table_lst, K.HTT_FUN)))
        LexExcept(cc, 'Missing header for Print() and PutChars() at ');
      if (!cc.cur_str || cc.cur_str.length <= 1) Lex(cc);
      is_print = true;
    }
  }
  const is_template_fun = !!(tmpf.flags & (1 << K.Ff_INTERNAL)) &&
    K.IC_SQR <= Number(tmpf.exe_addr) && Number(tmpf.exe_addr) <= K.IC_ATAN;
  if (indirect) {
    if (!(cc.flags & (K.CCF_RAX | K.CCF_ARRAY))) ICAdd(cc, K.IC_DEREF, 0n, RT(cc, K.RT_PTR));
    cc.coc.head.last.cls = RT(cc, K.RT_PTR);
    ICAdd(cc, K.IC_SET_RAX, 0n, RT(cc, K.RT_PTR));
    ICAdd(cc, K.IC_NOP2, 1n, RT(cc, K.RT_PTR));
  }
  COCPush(cc);
  let tmpcbh = cc.coc.coc_next;
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
      if (tmpm.flags & K.MLF_LASTCLASS && last_class)
        dft_val = cc.env.classNameAddr(cc, cbase(last_class));
      ICAdd(cc, K.IC_IMM_I64, dft_val, tmpm.member_class);
    } else {
      if (!PrsExpression(cc, null, false, ps)) throw new CompileError('Compiler', cc.lastError ? cc.lastError.message : '');
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
    COCPush(cc);
    is_first_arg = false;
    tmpm = tmpm.next;
  }
  if (tmpm && tmpm.flags & K.MLF_DOT_DOT_DOT) {
    COCInit(cc);
    const argci = ICAdd(cc, K.IC_IMM_I64, 0n, tmpm.member_class);
    COCPush(cc);
    const parseVar = () => {
      do {
        if (!is_first_arg) {
          if (cc.token === 44) Lex(cc);
          else LexExcept(cc, "Expecting ',' at ");
        }
        COCInit(cc);
        if (!PrsExpression(cc, null, false, ps)) throw new CompileError('Compiler', '');
        COCPush(cc);
        is_first_arg = false;
        argc_cnt++;
      } while (cc.token === 44);
    };
    if (is_print) { if (cc.token !== 59) parseVar(); }
    else if (needs_right_paren) { if (cc.token !== 41) parseVar(); }
    argci.data = BigInt(argc_cnt++);
  }
  if (needs_right_paren) {
    if (cc.token === 41) Lex(cc);
    else LexExcept(cc, "Missing ')' at ");
  }
  const tmpcbh1 = tmpcbh.coc_next;
  tmpcbh.coc_next = cc.coc.coc_next;
  cc.coc.coc_next = tmpcbh;
  COCPop(cc);
  tmpcbh = cc.coc.coc_next;
  cc.coc.coc_next = tmpcbh1;
  if (!is_template_fun) ICAdd(cc, K.IC_CALL_START, tmpf, null);
  if (indirect) ICAdd(cc, K.IC_PUSH_REGS, 1n << BigInt(K.REG_RAX), tmpf.return_class);
  const internal = !!(tmpf.flags & (1 << K.Ff_INTERNAL));
  while (tmpcbh) {
    const nx = tmpcbh.coc_next;
    COCAppend(cc, tmpcbh);
    if (!internal) cc.coc.head.last.flags |= K.ICF_PUSH_RES;
    tmpcbh = nx;
  }
  if (internal) ICAdd(cc, Number(tmpf.exe_addr), 0n, tmpf.return_class);
  else {
    const nbytes = BigInt((argc_cnt + tmpf.arg_cnt) << 3);
    let call;
    if (indirect) call = ICAdd(cc, K.IC_CALL_INDIRECT, nbytes, tmpf.return_class);
    else if (tmpf.flags & (1 << K.Cf_EXTERN)) {
      cc.abs_cnts.externs++;
      call = ICAdd(cc, K.IC_CALL_INDIRECT2, cc.env.exeAddrRef(cc, tmpf), tmpf.return_class);
    } else call = ICAdd(cc, K.IC_CALL, tmpf.exe_addr, tmpf.return_class);
    call.fun = tmpf;
    call.argBytes = Number(nbytes);
    ICAdd(cc, K.IC_ADD_RSP, nbytes, tmpf.return_class);
  }
  if (!is_template_fun) ICAdd(cc, K.IC_CALL_END, tmpf, tmpf.return_class);
  if (is_print || is_putchars) ICAdd(cc, K.IC_END_EXP, 0n, null, K.ICF_RES_NOT_USED);
  cc.flags = (cc.flags | K.CCF_RAX) & ~(K.CCF_ARRAY | K.CCF_FUN_EXP);
  return PE_UNARY_MODIFIERS;
}

function PrsUnaryTerm(cc, ps, v) {
  let i, tmpc, tmpm, tmpex, tmpf, tmpg, cm;
  v.local_var = null;
  v.paren_prec = K.PREC_NULL;
  const tok = cc.token;
  const unaryPre = (ic) => {
    if (K.PREC_UNARY_PRE > v.max_prec) v.max_prec = K.PREC_UNARY_PRE;
    v.unary_pre_prec = K.PREC_UNARY_PRE;
    PrsPush(ps, tmpc);
    PrsPush(ps, (K.PREC_UNARY_PRE << 16) + ic);
    return PE_UNARY_TERM2;
  };
  const term = () => { if (K.PREC_TERM > v.max_prec) v.max_prec = K.PREC_TERM; return PE_MAYBE_MODIFIERS; };
  switch (tok) {
    case 126: Lex(cc); return unaryPre(K.IC_COM);
    case 33: Lex(cc); return unaryPre(K.IC_NOT);
    case 45: Lex(cc); return unaryPre(K.IC_UNARY_MINUS);
    case 42: Lex(cc); return unaryPre(K.IC_DEREF);
    case 38: // &
      if (Lex(cc) === K.TK_IDENT) {
        if ((tmpc = cc.hash_entry)) {
          if (tmpc.type & K.HTT_FUN) {
            tmpf = tmpc;
            if (!(tmpf.flags & (1 << K.Ff_INTERNAL))) {
              if (tmpf.flags & (1 << K.Cf_EXTERN)) {
                cc.abs_cnts.externs++;
                ICAdd(cc, K.IC_IMM_I64, cc.env.exeAddrRef(cc, tmpf), RT(cc, K.RT_PTR));
                ICAdd(cc, K.IC_DEREF, 0n, RT(cc, K.RT_PTR));
              } else ICAdd(cc, K.IC_IMM_I64, tmpf.exe_addr, RT(cc, K.RT_PTR));
              cc.abs_cnts.c_addres++;
              Lex(cc);
              return PE_MAYBE_MODIFIERS;
            }
          } else if (tmpc.type & K.HTT_EXPORT_SYS_SYM) {
            tmpex = tmpc;
            return exportSysSym(cc, v, tmpex);
          }
        }
      }
      return unaryPre(K.IC_ADDR);
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
    case 36: // $
      if (cc.flags & K.CCF_CLASS_DOL_OFFSET)
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
      if (!PrsExpression(cc, ctx, false, ps)) throw new CompileError('Compiler', cc.lastError ? cc.lastError.message : '');
      v.paren_prec = paren_warn ? ctx.max_prec : K.PREC_NULL;
      if (cc.token !== 41) LexExcept(cc, "Missing ')' at ");
      Lex(cc);
      cc.flags = (cc.flags & ~K.CCF_ARRAY) | K.CCF_RAX | K.CCF_PAREN;
      return PE_UNARY_MODIFIERS;
    }
    case 43: case K.TK_PLUS_PLUS: case K.TK_MINUS_MINUS:
      if (tok === K.TK_PLUS_PLUS) cc.flags |= K.CCF_PREINC;
      else if (tok === K.TK_MINUS_MINUS) cc.flags |= K.CCF_PREDEC;
      if (K.PREC_UNARY_PRE > v.max_prec) v.max_prec = K.PREC_UNARY_PRE;
      v.unary_pre_prec = K.PREC_UNARY_PRE;
      Lex(cc);
      return PE_UNARY_TERM2;
    case K.TK_IDENT: {
      if ((tmpm = cc.local_var_entry)) {
        if (K.PREC_TERM > v.max_prec) v.max_prec = K.PREC_TERM;
        cc.flags &= ~(K.CCF_RAX | K.CCF_ARRAY | K.CCF_FUN_EXP);
        tmpc = cadd(tmpm.member_class);
        if (tmpm.flags & K.MLF_FUN) {
          PrsPopDeref(ps);
          cc.flags |= K.CCF_FUN_EXP;
          PrsPush2(ps, cbase(tmpm.fun_ptr));
        }
        if (tmpm.dim.next) { v.tmpad = tmpm.dim.next; cc.flags |= K.CCF_ARRAY; }
        if (tmpm.flags & K.MLF_STATIC) {
          ICAdd(cc, K.IC_IMM_I64, cc.env.staticAddr(cc, tmpm), tmpc);
        } else {
          if (tmpm.dim.next && tmpm.offset > 0 && tmpm.str !== 'argv') {
            tmpc = cadd(tmpc);
            cc.flags &= ~K.CCF_ARRAY;
          }
          const r = ICAdd(cc, K.IC_RBP, 0n, tmpc);
          r.local = tmpm;
          ICAdd(cc, K.IC_IMM_I64, BigInt(tmpm.offset), tmpc);
          ICAdd(cc, K.IC_ADD, 0n, tmpc);
        }
        Lex(cc);
        v.local_var = tmpm;
        return PE_UNARY_MODIFIERS;
      }
      if (!(tmpex = cc.hash_entry)) LexExcept(cc, 'Invalid lval at ');
      const ty = tmpex.type;
      if (ty & K.HTT_EXPORT_SYS_SYM) return exportSysSym(cc, v, tmpex);
      if (ty & K.HTT_FUN) {
        if (K.PREC_TERM > v.max_prec) v.max_prec = K.PREC_TERM;
        Lex(cc);
        return PrsFunCall(cc, ps, false, tmpex);
      }
      if (ty & K.HTT_GLBL_VAR) {
        if (K.PREC_TERM > v.max_prec) v.max_prec = K.PREC_TERM;
        tmpg = tmpex;
        tmpc = cadd(tmpg.var_class);
        cc.flags &= ~(K.CCF_RAX | K.CCF_ARRAY | K.CCF_FUN_EXP);
        if (tmpg.flags & K.GVF_ARRAY) { v.tmpad = tmpg.dim.next; cc.flags |= K.CCF_ARRAY; }
        if (tmpg.flags & K.GVF_EXTERN) {
          cc.abs_cnts.externs++;
          ICAdd(cc, K.IC_IMM_I64, cc.env.dataAddrRef(cc, tmpg), tmpc);
          ICAdd(cc, K.IC_DEREF, 0n, tmpc);
        } else ICAdd(cc, K.IC_IMM_I64, cc.env.glblAddr(cc, tmpg), tmpc);
        Lex(cc);
        if (tmpg.flags & K.GVF_FUN) {
          PrsPopDeref(ps);
          cc.flags |= K.CCF_FUN_EXP;
          PrsPush2(ps, cbase(tmpg.fun_ptr));
        }
        return PE_UNARY_MODIFIERS;
      }
      if (ty & K.HTT_CLASS) { PrsOffsetOf(cc); return PE_MAYBE_MODIFIERS; }
      if (ty & K.HTT_KEYWORD) {
        let j;
        switch (tmpex.user_data0) {
          case K.KW_SIZEOF: case K.KW_OFFSET: case K.KW_DEFINED:
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
  }
  LexExcept(cc, 'Missing expression at ');
}

function exportSysSym(cc, v, tmpex) {
  if (K.PREC_TERM > v.max_prec) v.max_prec = K.PREC_TERM;
  if (tmpex.type & K.HTF_UNRESOLVED) LexExcept(cc, 'Illegal fwd ref at ');
  ICAdd(cc, K.IC_IMM_I64, tmpex.val, RT(cc, K.RT_PTR));
  Lex(cc);
  return PE_MAYBE_MODIFIERS;
}

function PrsUnaryModifier(cc, ps, v) {
  let tmpc, tmpc1, tmpm = v.local_var, tmpi, tmpi1, tmpad1, cm, old_flags;
  const was_paren = !!(cc.flags & K.CCF_PAREN);
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
      if (!v.unary_post_prec) v.unary_post_prec = K.PREC_TERM;
      tmpc = cc.coc.head.last.cls;
      if ((!tmpc.ptr_stars_cnt || cc.flags & K.CCF_ARRAY) && cc.token === 46)
        LexExcept(cc, 'Must be address, not value ');
      if (!(cc.flags & K.CCF_RAX)) tmpc = csub(tmpc);
      if (!(tmpc.type & K.HTT_CLASS)) LexExcept(cc, 'Invalid class at ');
      if (Lex(cc) !== K.TK_IDENT || !(tmpm = MemberFind(cc.cur_str, tmpc))) LexExcept(cc, 'Invalid member at ');
      else if (cc.local_var_entry) cc.local_var_entry.use_cnt--;
      Lex(cc);
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
      const r = PrsType(cc, tmpc, K.PRS0_TYPECAST | K.PRS1_NULL, null, false);
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
      const idx = (scale) => {
        ICAdd(cc, K.IC_IMM_I64, BigInt(scale), tmpc);
        old_flags = cc.flags;
        if (!PrsExpression(cc, null, false, ps)) throw new CompileError('Compiler', '');
        cc.flags = (cc.flags & ~K.CCF_FUN_EXP) | (old_flags & K.CCF_FUN_EXP);
        if (cc.token !== 93) LexExcept(cc, "Missing ']' at ");
        Lex(cc);
        tmpi1 = cc.coc.head.last;
        tmpi1.flags |= K.ICF_RES_TO_INT;
        ICAdd(cc, K.IC_MUL, 0n, tmpc);
        ICAdd(cc, K.IC_ADD, 0n, tmpc);
      };
      if ((tmpad1 = v.tmpad)) {
        if ((v.tmpad = tmpad1.next)) {
          idx(tmpad1.total_cnt * tmpc1.size);
          cc.flags |= K.CCF_RAX;
          return PE_UNARY_MODIFIERS;
        }
        idx(tmpad1.total_cnt * tmpc1.size);
      } else idx(tmpc1.size);
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

// ------------------------------------------------------------- PrsVar
export function PrsArrayDims(cc, mode, dim) {
  dim.next = null; dim.cnt = 0; dim.total_cnt = 1;
  if (cc.token === 91) {
    if (((mode >> 8) & 0xFF) === K.PRS1B_FUN_ARG) LexExcept(cc, 'No arrays in fun args at ');
    do {
      let j;
      if (Lex(cc) === 93 && !dim.next) j = 0;
      else if ((j = Number(cc.env.LexExpressionI64(cc))) < 0) LexExcept(cc, 'Invalid array size at ');
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

// Returns {cls, ident, fun_ptr, tmpex, dim, mode}
export function PrsType(cc, tmpc1, mode, tmpm, wantIdent, fsp_flags = 0, holder = null) {
  let ptr_stars_cnt, fun_ptr = null, tmpex = null, ident = null;
  const dim = tmpm ? tmpm.dim : { next: null, cnt: 0, total_cnt: 1 };
  for (;;) {
    if (!tmpc1 || !(tmpc1.type & (K.HTT_CLASS | K.HTT_INTERNAL_TYPE))) LexExcept(cc, 'Invalid class at ');
    ptr_stars_cnt = 0;
    while (cc.token === 42) {
      if ((mode >> 8) & 0xFF) { LexPopNoRestore(cc); LexPush(cc); }
      Lex(cc);
      tmpc1 = cadd(tmpc1);
      if (++ptr_stars_cnt > K.PTR_STARS_NUM) LexExcept(cc, "Too many *'s at ");
    }
    const k = PrsKeyWord(cc);
    if (k === K.KW_UNION || k === K.KW_CLASS) {
      Lex(cc);
      const tmpc2 = PrsClass(cc, k, fsp_flags, (mode & 255) === K.PRS0_EXTERN);
      tmpc2.fwd_class = tmpc1;
      tmpc1 = tmpc2;
      if (holder) holder.cls = tmpc1;
      mode = K.PRS0_NULL | K.PRS1_NULL;
      continue;
    }
    break;
  }
  if (cc.token === 40) {
    if (Lex(cc) !== 42) LexExcept(cc, "Expecting '*' at ");
    ptr_stars_cnt = 1;
    while (Lex(cc) === 42) ptr_stars_cnt++;
    if (ptr_stars_cnt > K.PTR_STARS_NUM) LexExcept(cc, "Too many *'s at ");
  } else ptr_stars_cnt = -1;
  if (wantIdent) {
    if (cc.token === K.TK_IDENT) {
      tmpex = cc.hash_entry;
      ident = cc.cur_str;
      Lex(cc);
    } else {
      if (!((mode >> 8) & 0xFF)) ident = null;
      else if (cc.token === 44 || cc.token === 59 || cc.token === 41) {
        tmpex = null; ident = '_anon_';
        if (tmpm) tmpm.flags |= K.MLF_NO_UNUSED_WARN;
      } else LexExcept(cc, 'Expecting identifier at ');
    }
  }
  if (ptr_stars_cnt >= 0) {
    if (cc.token !== 41) LexExcept(cc, "Missing ')' at ");
    if (Lex(cc) !== 40) LexExcept(cc, "Expecting '(' at ");
    fun_ptr = cadd(PrsFunJoin(cc, tmpc1, null, fsp_flags), ptr_stars_cnt);
    tmpc1 = cadd(RT(cc, K.RT_PTR), ptr_stars_cnt);
  }
  PrsArrayDims(cc, mode, dim);
  let tmpc2 = OptClassFwd(tmpc1);
  if (tmpc2.ptr_stars_cnt) {
    tmpc2 = cbase(tmpc2);
    if (tmpc2.type & K.HTT_INTERNAL_TYPE && !tmpc2.size) LexWarn(cc, 'use "U8 *" instead of "U0 *" at ');
  }
  return { cls: tmpc1, ident, fun_ptr, tmpex, dim, mode };
}

function MemberAdd(cc, tmpm, tmpc, mode) {
  const st = tmpm.str;
  if (MemberFind(st, tmpc) && st !== 'pad' && st !== 'reserved' && st !== '_anon_')
    LexExcept(cc, 'Duplicate member at ');
  if (!tmpc.member_lst_and_root) tmpc.member_lst_and_root = tmpm;
  else {
    let t = tmpc.member_lst_and_root;
    for (;;) {
      if (t.str <= st) { if (!t.left) { t.left = tmpm; break; } t = t.left; }
      else { if (!t.right) { t.right = tmpm; break; } t = t.right; }
    }
  }
  tmpm.member_class_base = mode === K.PRS1B_LOCAL_VAR ? cbase(tmpm.member_class) : null;
  tmpm.left = tmpm.right = null;
  if (tmpc.last_in_member_lst) tmpc.last_in_member_lst.next = tmpm;
  tmpc.last_in_member_lst = tmpm;
  // keep the tree root as list head
  if (tmpc.member_lst_and_root === tmpm) tmpc.last_in_member_lst = tmpm;
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
  tmpm.dim.total_cnt = 127;
  tmpm.dim.next = { next: null, cnt: 127, total_cnt: 1 };
  tmpm.offset = tmpf.size;
  tmpm.size = 8;
  tmpf.size += 8;
  MemberAdd(cc, tmpm, tmpf, K.PRS1B_FUN_ARG);
  if (cc.token === 41) Lex(cc);
}

export function PrsVarLst(cc, tmpc, mode, union_base = 0) {
  const old_flags = cc.flags;
  cc.flags |= K.CCF_DONT_MAKE_RES;
  const m1 = (mode >> 8) & 0xFF;
  if (m1 === K.PRS1B_CLASS) cc.flags |= K.CCF_CLASS_DOL_OFFSET;
  if ((m1 !== K.PRS1B_LOCAL_VAR && m1 !== K.PRS1B_STATIC_LOCAL_VAR || mode & K.PRSF_UNION) &&
    (cc.token === 40 || cc.token === 123))
    Lex(cc);
  outer: for (;;) {
    cc.class_dol_offset = (mode & K.PRSF_UNION) ? union_base : tmpc.size;
    while (cc.token === 59) Lex(cc);
    while (cc.token === 36) {
      if (Lex(cc) !== 61) LexExcept(cc, "Expecting '=' at ");
      Lex(cc);
      cc.class_dol_offset = Number(cc.env.LexExpressionI64(cc));
      if (-cc.class_dol_offset > tmpc.neg_offset) tmpc.neg_offset = -cc.class_dol_offset;
      if (mode & K.PRSF_UNION) union_base = cc.class_dol_offset;
      else tmpc.size = cc.class_dol_offset;
      if (cc.token !== 59) LexExcept(cc, "Missing ';' at");
      Lex(cc);
    }
    if (cc.token === 41 || cc.token === 125) { Lex(cc); break outer; }
    let _reg = K.REG_UNDEF;
    for (;;) {
      const kw = PrsKeyWord(cc);
      if (kw === K.KW_REG) {
        _reg = K.REG_ALLOC;
        if (Lex(cc) === K.TK_IDENT && REGS64.includes(cc.cur_str)) { _reg = REGS64.indexOf(cc.cur_str); Lex(cc); }
        continue;
      }
      if (kw === K.KW_NOREG) { _reg = K.REG_NONE; Lex(cc); continue; }
      break;
    }
    if (cc.token === K.TK_ELLIPSIS && m1 === K.PRS1B_FUN_ARG) {
      PrsDotDotDot(cc, tmpc, _reg);
      break outer;
    }
    const tmph = cc.token === K.TK_IDENT ? cc.hash_entry : null;
    if (!tmph) LexExcept(cc, 'Expecting type at ');
    const k = PrsKeyWord(cc);
    if (k === K.KW_UNION) {
      Lex(cc);
      PrsVarLst(cc, tmpc, mode | K.PRSF_UNION, tmpc.size);
      continue outer;
    }
    if (!(tmph.type & (K.HTT_CLASS | K.HTT_INTERNAL_TYPE))) LexExcept(cc, 'Expecting type at ');
    let first = true;
    restart2: for (;;) {
      const holder = { cls: tmph };
      LexPush(cc);
      Lex(cc);
      const tmpm = new CMemberLst(_reg);
      _reg = K.REG_UNDEF;
      if (m1 === K.PRS1B_STATIC_LOCAL_VAR) { tmpm.flags |= K.MLF_STATIC; tmpm.reg = K.REG_NONE; }
      if (m1 === K.PRS1B_FUN_ARG || m1 === K.PRS1B_LOCAL_VAR) {
        for (;;) {
          const kw = PrsKeyWord(cc);
          if (kw === K.KW_REG) {
            tmpm.reg = K.REG_ALLOC;
            LexPopNoRestore(cc); LexPush(cc);
            if (Lex(cc) === K.TK_IDENT && REGS64.includes(cc.cur_str)) {
              tmpm.reg = REGS64.indexOf(cc.cur_str);
              LexPopNoRestore(cc); LexPush(cc);
              Lex(cc);
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
      const r = PrsType(cc, holder.cls, mode, tmpm, true, 0, holder);
      tmpm.member_class = r.cls;
      tmpm.str = r.ident;
      tmpm.fun_ptr = r.fun_ptr;
      if (tmpm.fun_ptr) tmpm.flags |= K.MLF_FUN;
      MemberAdd(cc, tmpm, tmpc, first ? m1 : K.PRS1B_NULL);
      tmpc.member_cnt++;
      const tmpc2 = tmpm.member_class;
      let i = tmpc2.size * tmpm.dim.total_cnt;
      switch (m1) {
        case K.PRS1B_STATIC_LOCAL_VAR: {
          let undef = false;
          if (i < 0) { i = 0; undef = true; }
          if (mode & K.PRSF_UNION) LexExcept(cc, 'Static unions are not implemented ');
          LexPopNoRestore(cc);
          cc.env.staticAlloc(cc, tmpm, (i + 7) & ~7);
          if (cc.token === 61) {
            cc.flags = (cc.flags & ~K.CCF_DONT_MAKE_RES) | (old_flags & K.CCF_DONT_MAKE_RES);
            Lex(cc);
            cc.env.PrsStaticInit(cc, tmpm, undef);
            tmpm.use_cnt = 0;
            cc.flags |= K.CCF_DONT_MAKE_RES;
          }
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
            if (!PrsExpression(cc, null, true)) throw new CompileError('Compiler', cc.lastError ? cc.lastError.message : '');
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
              const r2 = cc.env.LexExpressionVal(cc);
              let dv = r2.val;
              const c2 = OptClassFwd(tmpc2);
              if (c2.raw_type === K.RT_F64) { if (r2.type !== K.RT_F64) dv = f2b(Number(I64(dv))); }
              else if (r2.type === K.RT_F64) dv = f2i(b2f(dv));
              tmpm.dft_val = dv;
              if (r2.isStr) tmpm.flags |= K.MLF_STR_DFT_AVAILABLE;
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
            if (Lex(cc) === K.TK_STR) {
              meta.user_data = LexExtStr(cc);
              meta.flags |= K.MLMF_IS_STR;
            } else meta.user_data = cc.env.LexExpressionI64(cc);
          }
          LexPopNoRestore(cc);
          break;
      }
      switch (cc.token) {
        case 44:
          if (m1 === K.PRS1B_FUN_ARG && !(mode & K.PRSF_UNION)) Lex(cc);
          else { first = false; continue restart2; }
          continue outer;
        case 41: case 125:
          Lex(cc);
          break outer;
        case 59:
          cc.flags = (cc.flags & ~K.CCF_DONT_MAKE_RES) | (old_flags & K.CCF_DONT_MAKE_RES);
          Lex(cc);
          cc.flags |= K.CCF_DONT_MAKE_RES;
          if ((m1 === K.PRS1B_LOCAL_VAR || m1 === K.PRS1B_STATIC_LOCAL_VAR) && !(mode & K.PRSF_UNION))
            break outer;
          continue outer;
        default:
          LexExcept(cc, "Missing ';' at");
      }
    }
  }
  cc.flags = (cc.flags & ~(K.CCF_CLASS_DOL_OFFSET | K.CCF_DONT_MAKE_RES)) |
    (old_flags & (K.CCF_CLASS_DOL_OFFSET | K.CCF_DONT_MAKE_RES));
}
const REGS64 = ['RAX', 'RCX', 'RDX', 'RBX', 'RSP', 'RBP', 'RSI', 'RDI', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15'];

// ------------------------------------------------------------- PrsStmt
export function PrsClass(cc, keyword, fsp_flags, is_extern) {
  let tmpc, base_class;
  if (cc.token !== K.TK_IDENT) LexExcept(cc, 'Expecting identifier at ');
  if (is_extern) {
    tmpc = PrsClassNew();
    tmpc.str = cc.cur_str;
    cc.htc.glbl_hash_table.add(tmpc);
    tmpc.flags |= 1 << K.Cf_EXTERN;
    tmpc.src_link = srcLink(cc);
    Lex(cc);
  } else {
    tmpc = HashSingleTableFind(cc.cur_str, cc.htc.glbl_hash_table, K.HTT_CLASS);
    if (tmpc && !(tmpc.flags & (1 << K.Cf_EXTERN))) tmpc = null;
    if (!tmpc) {
      tmpc = PrsClassNew();
      tmpc.str = cc.cur_str;
      cc.htc.glbl_hash_table.add(tmpc);
    }
    tmpc.flags &= ~(1 << K.Cf_EXTERN);
    if (fsp_flags & K.FSF_PUBLIC) tmpc.type |= K.HTF_PUBLIC;
    tmpc.use_cnt = 0;
    tmpc.src_link = srcLink(cc);
    tmpc.help_idx = cc.cur_help_idx;
    if (Lex(cc) === 58) {
      if (Lex(cc) !== K.TK_IDENT || !(base_class = cc.hash_entry) || !(base_class.type & K.HTT_CLASS))
        LexExcept(cc, 'Invalid class at ');
      if (Lex(cc) === 44) LexExcept(cc, 'Only one base class allowed at this time at ');
      tmpc.base_class = base_class;
      tmpc.size += base_class.size;
    }
    PrsVarLst(cc, tmpc, keyword === K.KW_UNION ? (K.PRS0_NULL | K.PRS1_CLASS | K.PRSF_UNION) : (K.PRS0_NULL | K.PRS1_CLASS));
    tmpc.size += tmpc.neg_offset;
  }
  return tmpc;
}

export function PrsFunJoin(cc, tmp_return, name, fsp_flags) {
  let tmpf = null, header_return = null;
  if (name) {
    tmpf = HashSingleTableFind(name, cc.htc.glbl_hash_table, K.HTT_FUN);
    if (tmpf && !(tmpf.flags & (1 << K.Cf_EXTERN))) tmpf = null;
  }
  if (tmpf) {
    header_return = tmpf.return_class;
    tmpf.headerArgs = tmpf.member_lst_and_root;
    tmpf.member_lst_and_root = null; tmpf.last_in_member_lst = null;
    tmpf.size = 0; tmpf.member_cnt = 0; tmpf.arg_cnt = 0;
    tmpf.flags &= ~(1 << K.Ff_DOT_DOT_DOT);
  } else {
    tmpf = PrsFunNew();
    tmpf.str = name;
    tmpf.flags |= 1 << K.Cf_EXTERN;
    tmpf.flags |= fsp_flags & K.FSG_FUN_FLAGS1;
    if (name) {
      cc.env.funDeclared(cc, tmpf);
      cc.htc.glbl_hash_table.add(tmpf);
    }
  }
  if (fsp_flags & K.FSF_PUBLIC) tmpf.type |= K.HTF_PUBLIC; else tmpf.type &= ~K.HTF_PUBLIC;
  tmpf.return_class = tmp_return;
  tmpf.use_cnt = 0;
  tmpf.src_link = srcLink(cc);
  tmpf.help_idx = cc.cur_help_idx;
  PrsVarLst(cc, tmpf, K.PRS0_NULL | K.PRS1_FUN_ARG);
  tmpf.arg_cnt = tmpf.member_cnt;
  if (0 < tmpf.arg_cnt << 3 && (tmpf.arg_cnt << 3) <= 0x7FFF && !(tmpf.flags & (1 << K.Ff_DOT_DOT_DOT)))
    tmpf.flags |= 1 << K.Ff_RET1;
  for (let m = tmpf.member_lst_and_root; m; m = m.next) m.offset += 16;
  tmpf.size = 0;
  return tmpf;
}

function PrsFun(cc, tmp_return, name, fsp_flags) {
  cc.fun_lex_file = cc.lex_include_stk;
  cc.min_line = cc.max_line = cc.lex_include_stk.line_num;
  cc.flags &= ~K.CCF_NO_REG_OPT;
  const fun = PrsFunJoin(cc, tmp_return, name, fsp_flags);
  cc.htc.local_var_lst = cc.htc.fun = fun;
  COCPush(cc);
  COCInit(cc);
  ICAdd(cc, K.IC_ENTER, 0n, null);
  const saved_leave = cc.lb_leave;
  cc.lb_leave = COCMiscNew(cc, K.CMT_LABEL);
  cc.flags &= ~K.CCF_HAS_RETURN;
  PrsStmt(cc, 0, null, 0);
  if (fun.return_class.size && !(cc.flags & K.CCF_HAS_RETURN)) LexWarn(cc, 'Function should return val ');
  ICAdd(cc, K.IC_LABEL, cc.lb_leave, null);
  cc.lb_leave = saved_leave;
  ICAdd(cc, K.IC_LEAVE, 0n, fun.return_class);
  fun.size &= ~7;
  cc.env.compileFun(cc, fun);
  fun.flags &= ~(1 << K.Cf_EXTERN);
  COCPop(cc);
  cc.htc.local_var_lst = cc.htc.fun = cc.fun_lex_file = null;
}

function PrsGlblVarLst(cc, saved_mode, saved_tmpc, saved_val, fsp_flags) {
  for (;;) {
    const holder = { cls: saved_tmpc };
    const r = PrsType(cc, saved_tmpc, saved_mode, null, true, fsp_flags, holder);
    saved_tmpc = holder.cls;
    let tmpc = r.cls;
    const st = r.ident, tmpad = r.dim, tmpex = r.tmpex, tmpf_fun_ptr = r.fun_ptr;
    if (!st) return;
    let is_array;
    if (tmpad.next) is_array = true;
    else if (tmpad.total_cnt < 0) { is_array = true; tmpc = csub(tmpc); }
    else is_array = false;
    let val = saved_val, mode = saved_mode;
    if (tmpex && (mode & 255) === K.PRS0_EXTERN && tmpex.type & K.HTT_EXPORT_SYS_SYM) {
      val = tmpex.val;
      mode = K.PRS0__EXTERN | K.PRS1_NOT_REALLY__EXTERN;
    }
    if (cc.token === 40) {
      let tmpf;
      switch (mode & 255) {
        case K.PRS0__INTERN:
          tmpf = PrsFunJoin(cc, tmpc, st, fsp_flags);
          tmpf.exe_addr = val;
          tmpf.flags |= 1 << K.Ff_INTERNAL;
          tmpf.flags &= ~(1 << K.Cf_EXTERN);
          return;
        case K.PRS0__EXTERN:
          tmpf = PrsFunJoin(cc, tmpc, st, fsp_flags);
          cc.env.bindExtern(cc, tmpf, val);
          tmpf.flags &= ~(1 << K.Cf_EXTERN);
          if ((saved_mode & 255) === K.PRS0__EXTERN) tmpf.flags |= 1 << K.Ff__EXTERN;
          return;
        case K.PRS0_EXTERN:
          PrsFunJoin(cc, tmpc, st, fsp_flags);
          return;
        case K.PRS0__IMPORT: case K.PRS0_IMPORT:
          tmpf = PrsFunJoin(cc, tmpc, st, fsp_flags);
          tmpf.type |= K.HTF_IMPORT;
          tmpf.import_name = (mode & 255) === K.PRS0__IMPORT ? val : st;
          cc.env.funImport(cc, tmpf);
          return;
        default:
          PrsFun(cc, tmpc, st, fsp_flags);
          return;
      }
    }
    let i, undef_array_size;
    if (tmpad.total_cnt < 0) { i = 0; undef_array_size = true; }
    else { i = tmpad.total_cnt; undef_array_size = false; }
    let j = (tmpf_fun_ptr ? 8 : tmpc.size) * i;
    let tmpg = new CHashGlblVar(st);
    switch (mode & 255) {
      case K.PRS0__EXTERN:
        cc.env.bindExternVar(cc, tmpg, val);
        tmpg.flags |= K.GVF_ALIAS;
        break;
      case K.PRS0__IMPORT: case K.PRS0_IMPORT:
        tmpg.flags |= K.GVF_IMPORT;
        tmpg.import_name = (mode & 255) === K.PRS0__IMPORT ? val : st;
        cc.env.varImport(cc, tmpg);
        break;
      case K.PRS0_EXTERN:
        tmpg.type = K.HTT_GLBL_VAR | K.HTF_UNRESOLVED;
        break;
      default:
        tmpg.allocSize = j;
        break;
    }
    tmpg.dim.next = tmpad.next;
    if (fsp_flags & K.FSF_PUBLIC) tmpg.type |= K.HTF_PUBLIC;
    tmpg.var_class = tmpc;
    tmpg.size = j;
    tmpg.dim.total_cnt = i;
    tmpg.use_cnt = 0;
    tmpg.src_link = srcLink(cc);
    tmpg.help_idx = cc.cur_help_idx;
    if ((mode & 255) === K.PRS0_EXTERN) tmpg.flags |= K.GVF_EXTERN;
    if (tmpf_fun_ptr) { tmpg.fun_ptr = tmpf_fun_ptr; tmpg.flags |= K.GVF_FUN; }
    if (is_array) tmpg.flags |= K.GVF_ARRAY;
    // A definition of a var previously declared extern resolves it.
    let alias = null;
    if (tmpex && tmpex.type & K.HTT_GLBL_VAR && tmpex.type & K.HTF_UNRESOLVED && !(mode & 255)) alias = tmpex;
    cc.htc.glbl_hash_table.add(tmpg);
    if (!((mode & 255) === K.PRS0__EXTERN || (mode & 255) === K.PRS0_EXTERN || (mode & 255) === K.PRS0__IMPORT || (mode & 255) === K.PRS0_IMPORT))
      cc.env.glblDefine(cc, tmpg, alias, cc.token === 61 && undef_array_size);
    if (cc.token === 61) cc.env.PrsGlblInit(cc, tmpg, undef_array_size);
    if (alias) {
      alias.flags |= K.GVF_ALIAS;
      alias.aliasOf = tmpg;
      alias.type &= ~K.HTF_UNRESOLVED;
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
  if (!PrsExpression(cc, null, false)) throw new CompileError('Compiler', cc.lastError ? cc.lastError.message : '');
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
  if (!PrsExpression(cc, null, false)) throw new CompileError('Compiler', '');
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
  if (!PrsExpression(cc, null, false)) throw new CompileError('Compiler', '');
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
  if (!PrsExpression(cc, null, false)) throw new CompileError('Compiler', '');
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
  const header = [];
  const head = []; // stack of sub-switches; head[0] is the outermost
  let lb_fwd_case, tmpi_jmp, tmpi_start, dft_found = false, nobound;
  let k_start = null, k_end, lo = null, hi = null;
  if (cc.token === 40) nobound = false;
  else if (cc.token === 91) nobound = true;
  else LexExcept(cc, "Expecting '(' or '[' at ");
  Lex(cc);
  const top = { lb_start: null, lb_break: COCMiscNew(cc, K.CMT_LABEL) };
  top.lb_break.use_cnt++;
  head.push(top);
  const lb_dft = COCMiscNew(cc, K.CMT_LABEL);
  lb_dft.use_cnt++;
  const mc_jt = COCMiscNew(cc, K.CMT_JMP_TABLE);
  mc_jt.begin = COCMiscNew(cc, K.CMT_LABEL);
  mc_jt.begin.use_cnt++;
  if (!PrsExpression(cc, null, false)) throw new CompileError('Compiler', '');
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
    for (let n = 1; n < head.length; n++) if (head[n].lb_start) ICAdd(cc, K.IC_SUB_CALL, head[n].lb_start, null);
  };
  outer: for (;;) {
    let toSubEnd = false;
    inner: while (cc.token && cc.token !== 125) {
      let kw = PrsKeyWord(cc);
      sw_cont: for (;;) {
        switch (kw) {
          case K.KW_END:
            toSubEnd = true; break inner;
          case K.KW_START: {
            if (Lex(cc) === 58) Lex(cc); else LexExcept(cc, "Expecting ':' at ");
            const tmpss = { lb_start: null, lb_break: COCMiscNew(cc, K.CMT_LABEL) };
            tmpss.lb_break.use_cnt++;
            head.push(tmpss);
            lb_fwd_case = COCMiscNew(cc, K.CMT_LABEL);
            tmpi_jmp = ICAdd(cc, K.IC_JMP, lb_fwd_case, null);
            tmpss.lb_start = COCMiscNew(cc, K.CMT_LABEL);
            tmpi_start = ICAdd(cc, K.IC_LABEL, tmpss.lb_start, null);
            while (cc.token && cc.token !== 125) {
              const kw2 = PrsKeyWord(cc);
              if (kw2 === K.KW_END) { OptFree(tmpi_jmp); toSubEnd = true; break inner; }
              if (kw2 === K.KW_START || kw2 === K.KW_CASE || kw2 === K.KW_DEFAULT) {
                if (cc.coc.head.last === tmpi_start) { OptFree(tmpi_jmp); tmpss.lb_start = null; }
                else {
                  ICAdd(cc, K.IC_RET, 0n, null);
                  ICAdd(cc, K.IC_LABEL, lb_fwd_case, null);
                  ICAdd(cc, K.IC_SUB_CALL, tmpss.lb_start, null);
                }
                kw = kw2;
                continue sw_cont;
              }
              PrsStmt(cc, try_cnt);
            }
            break sw_cont;
          }
          case K.KW_CASE: {
            if (head.length > 1) {
              lb_fwd_case = COCMiscNew(cc, K.CMT_LABEL);
              tmpi_jmp = ICAdd(cc, K.IC_JMP, lb_fwd_case, null);
            }
            Lex(cc);
            const lb_entry = COCMiscNew(cc, K.CMT_LABEL);
            ICAdd(cc, K.IC_LABEL, lb_entry, null);
            lb_entry.use_cnt++;
            if (head.length > 1) { subCalls(); ICAdd(cc, K.IC_LABEL, lb_fwd_case, null); }
            if (cc.token === 58) k_start = k_start === null ? 0n : k_start + 1n;
            else k_start = cc.env.LexExpressionI64(cc);
            if (lo === null || k_start < lo) lo = k_start;
            if (hi === null || k_start > hi) hi = k_start;
            if (cc.token === 58) {
              Lex(cc);
              header.push([k_start, lb_entry]);
            } else if (cc.token === K.TK_ELLIPSIS) {
              Lex(cc);
              k_end = cc.env.LexExpressionI64(cc);
              if (cc.token === 58) {
                Lex(cc);
                if (k_end < lo) lo = k_end;
                if (k_end > hi) hi = k_end;
                if (k_start > k_end) [k_start, k_end] = [k_end, k_start];
                for (let v = k_start; v <= k_end; v++) header.push([v, lb_entry]);
                k_start = k_end;
              } else LexExcept(cc, "Expecting ':' at ");
            } else LexExcept(cc, "Expecting ':' at ");
            break sw_cont;
          }
          case K.KW_DEFAULT:
            if (head.length > 1) {
              lb_fwd_case = COCMiscNew(cc, K.CMT_LABEL);
              tmpi_jmp = ICAdd(cc, K.IC_JMP, lb_fwd_case, null);
            }
            Lex(cc);
            ICAdd(cc, K.IC_LABEL, lb_dft, null);
            if (cc.token === 58) Lex(cc); else LexExcept(cc, "Expecting ':' at ");
            if (head.length > 1) { subCalls(); ICAdd(cc, K.IC_LABEL, lb_fwd_case, null); }
            dft_found = true;
            break sw_cont;
          default:
            PrsStmt(cc, try_cnt, head[head.length - 1].lb_break);
            break sw_cont;
        }
      }
    }
    // sw_sub_end:
    const tmpss = head[head.length - 1];
    ICAdd(cc, K.IC_LABEL, tmpss.lb_break, null);
    if (head.length === 1) {
      if (cc.token !== 125) LexExcept(cc, "Missing '}' at ");
      Lex(cc);
      break outer;
    }
    head.pop();
    if (PrsKeyWord(cc) !== K.KW_END) LexExcept(cc, "Missing 'end' at ");
    if (Lex(cc) === 58) Lex(cc); else LexExcept(cc, "Expecting ':' at ");
    void toSubEnd;
  }
  if (!dft_found) ICAdd(cc, K.IC_LABEL, lb_dft, null);
  if (lo === null) { lo = 0n; hi = -1n; }
  if (0n < lo && lo <= 16n) lo = 0n;
  const range = hi - lo + 1n;
  if (lo > hi || !(0n < range && range <= 0xFFFFn)) LexExcept(cc, 'switch range error at ');
  const jt = new Array(Number(range)).fill(lb_dft);
  tmpi_sub.data = lo;
  tmpi_cmp.data = range;
  for (const [val, lab] of header) {
    if (jt[Number(val - lo)] !== lb_dft) LexExcept(cc, 'Duplicate case at ');
    jt[Number(val - lo)] = lab;
  }
  mc_jt.dft = lb_dft;
  mc_jt.jmp_table = jt;
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

function PrsTryBlk(cc, try_cnt) {
  const tmpc = RT(cc, K.RT_PTR);
  const tmp_try = HashFind('SysTry', cc.htc.hash_table_lst, K.HTT_FUN);
  const tmp_untry = HashFind('SysUntry', cc.htc.hash_table_lst, K.HTT_FUN);
  if (!tmp_try || !tmp_untry) LexExcept(cc, 'Missing header for SysTry() and SysUntry() at ');
  cc.flags |= K.CCF_NO_REG_OPT;
  const lb_catch = COCMiscNew(cc, K.CMT_LABEL), lb_done = COCMiscNew(cc, K.CMT_LABEL), lb_untry = COCMiscNew(cc, K.CMT_LABEL);
  const callFun = (f, nargs) => {
    let c;
    if (f.flags & (1 << K.Cf_EXTERN)) c = ICAdd(cc, K.IC_CALL_INDIRECT2, cc.env.exeAddrRef(cc, f), tmpc);
    else c = ICAdd(cc, K.IC_CALL, f.exe_addr, tmpc);
    c.fun = f; c.argBytes = nargs * 8;
    return c;
  };
  ICAdd(cc, K.IC_CALL_START, 0n, null);
  ICAdd(cc, K.IC_GET_LABEL, lb_untry, tmpc, K.ICF_PUSH_RES);
  ICAdd(cc, K.IC_GET_LABEL, lb_catch, tmpc, K.ICF_PUSH_RES);
  callFun(tmp_try, 2);
  ICAdd(cc, K.IC_ADD_RSP, 16n, tmpc);
  ICAdd(cc, K.IC_CALL_END, 0n, tmpc);
  ICAdd(cc, K.IC_END_EXP, 0n, null, K.ICF_RES_NOT_USED);
  PrsStmt(cc, try_cnt + 1);
  ICAdd(cc, K.IC_LABEL, lb_untry, null);
  ICAdd(cc, K.IC_CALL_START, 0n, null);
  callFun(tmp_untry, 0);
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

function PrsAsmIns(cc) {
  // One-instruction asm statements used inside HolyC functions.
  const name = cc.cur_str;
  const tmpi = ICAdd(cc, K.IC_ASM, 0n, null);
  tmpi.asm = name;
  Lex(cc);
  // Skip operands to end of statement
  while (cc.token && cc.token !== 59 && cc.token !== 125 && cc.token !== 10) {
    const line = cc.lex_include_stk.line_num;
    tmpi.asmOperands = true;
    Lex(cc);
    if (cc.lex_include_stk.line_num !== line) break;
  }
}

export function PrsStmt(cc, try_cnt = 0, lb_break = null, cmp_flags = K.CMPF_PRS_SEMICOLON) {
  let fsp_flags = 0, tmpex, g_lb;
  for (;;) {
    while (cc.token === 44) Lex(cc);
    if (cc.token === 123) {
      Lex(cc);
      while (cc.token !== 125 && cc.token !== K.TK_EOF) PrsStmt(cc, try_cnt, lb_break);
      if (cc.lex_include_stk === cc.fun_lex_file) cc.max_line = cc.lex_include_stk.line_num;
      if (Lex(cc) !== 44) return fsp_flags & K.FSF_ASM;
      continue;
    }
    if (cc.token === 59) {
      if (cmp_flags & K.CMPF_PRS_SEMICOLON) Lex(cc);
      if (cc.token !== 44) return fsp_flags & K.FSF_ASM;
      continue;
    }
    let goSemicolon = false;
    if (cc.token === K.TK_IDENT) {
      if ((tmpex = cc.hash_entry)) {
        let notKw = !(tmpex.type & K.HTT_KEYWORD);
        if (!notKw) {
          const i = tmpex.user_data0;
          switch (i) {
            case K.KW_ASM:
              cc.env.asmBlock(cc);
              fsp_flags = K.FSF_ASM;
              if (cc.token !== 44) return fsp_flags & K.FSF_ASM;
              continue;
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
              if (cc.token !== 44) return fsp_flags & K.FSF_ASM;
              continue;
            case K.KW__EXTERN: case K.KW__IMPORT: case K.KW_EXTERN: case K.KW_IMPORT: case K.KW__INTERN: {
              if (cc.htc.fun) LexExcept(cc, 'Not allowed in fun');
              Lex(cc);
              let kw = i;
              if (kw === K.KW__EXTERN && optOn(cc, K.OPTf_EXTERNS_TO_IMPORTS)) kw = K.KW__IMPORT;
              if (kw === K.KW__EXTERN) {
                if (cc.token !== K.TK_IDENT) LexExcept(cc, 'Expecting system sym at ');
                tmpex = cc.env.externSym(cc, cc.cur_str);
                if (!tmpex) LexExcept(cc, 'Expecting system sym at ');
                if (cc.cur_str[0] === '_') fsp_flags |= K.FSF__;
                const val = tmpex;
                Lex(cc);
                if (cc.token !== K.TK_IDENT || !(tmpex = cc.hash_entry) || !(tmpex.type & (K.HTT_CLASS | K.HTT_INTERNAL_TYPE)))
                  LexExcept(cc, 'Expecting type at ');
                Lex(cc);
                PrsGlblVarLst(cc, K.PRS0__EXTERN | K.PRS1_NULL, tmpex, val, fsp_flags);
              } else if (kw === K.KW__IMPORT) {
                if (cc.token !== K.TK_IDENT) LexExcept(cc, 'Expecting system sym at ');
                if (cc.cur_str[0] === '_') fsp_flags |= K.FSF__;
                const import_name = cc.cur_str;
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
                  goSemicolon = true;
                  break;
                }
                if (!tmpex || !(tmpex.type & (K.HTT_CLASS | K.HTT_INTERNAL_TYPE))) LexExcept(cc, 'Expecting type at ');
                Lex(cc);
                PrsGlblVarLst(cc, (optOn(cc, K.OPTf_EXTERNS_TO_IMPORTS) ? K.PRS0_IMPORT : K.PRS0_EXTERN) | K.PRS1_NULL, tmpex, 0, fsp_flags);
              } else if (kw === K.KW_IMPORT) {
                if (cc.token !== K.TK_IDENT || !(tmpex = cc.hash_entry) || !(tmpex.type & (K.HTT_CLASS | K.HTT_INTERNAL_TYPE)))
                  LexExcept(cc, 'Expecting type at ');
                Lex(cc);
                PrsGlblVarLst(cc, K.PRS0_IMPORT | K.PRS1_NULL, tmpex, 0, fsp_flags);
              } else { // _intern
                const val = cc.env.LexExpressionI64(cc);
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
                  ICAdd(cc, K.IC_CALL_START, 0n, null);
                  const c = (tu.flags & (1 << K.Cf_EXTERN)) ?
                    ICAdd(cc, K.IC_CALL_INDIRECT2, cc.env.exeAddrRef(cc, tu), RT(cc, K.RT_PTR)) :
                    ICAdd(cc, K.IC_CALL, tu.exe_addr, RT(cc, K.RT_PTR));
                  c.fun = tu; c.argBytes = 0; c.untry = true;
                  ICAdd(cc, K.IC_CALL_END, 0n, RT(cc, K.RT_PTR));
                  ICAdd(cc, K.IC_END_EXP, 0n, null, K.ICF_RES_NOT_USED);
                }
              }
              if (Lex(cc) !== 59) {
                if (!cc.htc.fun.return_class.size) LexWarn(cc, 'Function should NOT return val ');
                if (!PrsExpression(cc, null, false)) throw new CompileError('Compiler', cc.lastError ? cc.lastError.message : '');
                ICAdd(cc, K.IC_RETURN_VAL, 0n, cc.htc.fun.return_class);
                cc.flags |= K.CCF_HAS_RETURN;
              } else if (cc.htc.fun.return_class.size) LexWarn(cc, 'Function should return val ');
              ICAdd(cc, K.IC_JMP, cc.lb_leave, null);
              goSemicolon = true;
              break;
            }
            case K.KW_GOTO:
              if (Lex(cc) !== K.TK_IDENT) LexExcept(cc, 'Expecting identifier at ');
              if (!(g_lb = COCGoToLabelFind(cc, cc.cur_str))) {
                g_lb = COCMiscNew(cc, K.CMT_GOTO_LABEL);
                g_lb.str = cc.cur_str;
              }
              g_lb.use_cnt++;
              ICAdd(cc, K.IC_JMP, g_lb, null);
              Lex(cc);
              goSemicolon = true;
              break;
            case K.KW_BREAK:
              Lex(cc);
              if (!lb_break) LexExcept(cc, "'break' not allowed\n");
              ICAdd(cc, K.IC_JMP, lb_break, null);
              goSemicolon = true;
              break;
            case K.KW_NO_WARN:
              Lex(cc);
              PrsNoWarn(cc);
              goSemicolon = true;
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
              goSemicolon = true;
              break;
            }
            default:
              notKw = true;
          }
        }
        if (notKw) {
          if (tmpex.type & (K.HTT_CLASS | K.HTT_INTERNAL_TYPE)) {
            if (cc.htc.fun) {
              PrsVarLst(cc, cc.htc.fun, K.PRS0_NULL | ((fsp_flags & K.FSF_STATIC) ? K.PRS1_STATIC_LOCAL_VAR : K.PRS1_LOCAL_VAR));
              if (cc.token === 125) return fsp_flags & K.FSF_ASM;
            } else {
              Lex(cc);
              PrsGlblVarLst(cc, K.PRS0_NULL | K.PRS1_NULL, tmpex, 0, fsp_flags);
            }
            fsp_flags &= K.FSF_ASM;
          } else if (tmpex.type & (K.HTT_OPCODE | K.HTT_ASM_KEYWORD)) {
            if (!cc.htc.fun) LexExcept(cc, 'Use Asm Blk at ');
            PrsAsmIns(cc);
            if (cc.token !== 44) return fsp_flags & K.FSF_ASM;
            fsp_flags &= K.FSF_ASM;
          } else {
            if (!PrsExpression(cc, null, true)) throw new CompileError('Compiler', cc.lastError ? cc.lastError.message : '');
            goSemicolon = true;
          }
        }
      } else {
        if (cc.local_var_entry) {
          if (!PrsExpression(cc, null, true)) throw new CompileError('Compiler', cc.lastError ? cc.lastError.message : '');
          goSemicolon = true;
        } else {
          if (!(g_lb = COCGoToLabelFind(cc, cc.cur_str))) {
            g_lb = COCMiscNew(cc, K.CMT_GOTO_LABEL);
            g_lb.str = cc.cur_str;
          } else if (g_lb.flags & K.CMF_DEFINED) LexExcept(cc, 'Duplicate goto label at ');
          g_lb.flags |= K.CMF_DEFINED;
          ICAdd(cc, K.IC_LABEL, g_lb, null);
          const nm = cc.cur_str;
          if (Lex(cc) === 58) Lex(cc);
          else LexExcept(cc, 'Undefined identifier at ' + nm + ' ');
          if (!cc.htc.fun) LexExcept(cc, 'No global labels at ');
          if (cc.token !== 44) return fsp_flags & K.FSF_ASM;
        }
      }
    } else if (cc.token === K.TK_STR || cc.token === K.TK_CHAR_CONST) {
      PrsFunCall(cc, null, false, null);
      goSemicolon = true;
    } else if (cc.token !== K.TK_EOF) {
      if (!PrsExpression(cc, null, true)) throw new CompileError('Compiler', cc.lastError ? cc.lastError.message : '');
      goSemicolon = true;
    } else return fsp_flags & K.FSF_ASM;
    if (goSemicolon) {
      if (cmp_flags & K.CMPF_PRS_SEMICOLON) {
        if (cc.token === 59) Lex(cc);
        else if (cc.token !== 44) LexExcept(cc, "Missing ';' at");
      }
      if (cc.token !== 44) return fsp_flags & K.FSF_ASM;
    }
  }
}
