// Port of TempleOS Compiler/OptLib.HC and OptPass012.HC.
// Pass 0/1/2: constant folding, type determination via expression trees,
// short-circuit branch construction and HolyC's strength reductions.
import * as K from './consts.js';
import { OptClassFwd, csub, cadd } from './core.js';
import { I64, U64, f2b, b2f, f2i, bsf, bsr } from './util.js';
import { LexExcept, LexWarn } from './lex.js';

// [arg_cnt,res_cnt,type,fpop,not_const,name]
const T = (a, r, t, f, n, name) => ({ arg_cnt: a, res_cnt: r, type: t, fpop: f, not_const: n, name });
const N = K.IST_NULL, D = K.IST_DEREF, A = K.IST_ASSIGN, C = K.IST_CMP;
export const intermediate_code_table = [
  T(0, 0, N, 0, 0, 'END'), T(0, 0, N, 0, 0, 'NOP1'), T(1, 0, N, 0, 0, 'END_EXP'), T(0, 0, N, 0, 0, 'NOP2'),
  T(0, 0, N, 0, 0, 'LABEL'), T(0, 0, N, 0, 0, 'CALL_START'), T(0, 1, N, 0, 0, 'CALL_END'), T(0, 0, N, 0, 0, 'CALL_END2'),
  T(1, 0, N, 0, 0, 'RETURN_VAL'), T(0, 0, N, 0, 0, 'RETURN_VAL2'), T(0, 1, N, 0, 0, 'IMM_I64'), T(0, 1, N, 0, 0, 'IMM_F64'),
  T(0, 1, N, 0, 1, 'STR_CONST'), T(0, 1, N, 0, 1, 'ABS_ADDR'), T(0, 1, N, 0, 1, 'ADDR_IMPORT'), T(0, 1, N, 0, 1, 'HEAP_GLBL'),
  T(0, 1, N, 0, 0, 'SIZEOF'), T(0, 1, N, 0, 0, 'TYPE'), T(0, 1, N, 0, 1, 'GET_LABEL'), T(0, 1, N, 0, 1, 'RBP'),
  T(0, 1, N, 0, 1, 'REG'), T(0, 0, N, 0, 1, 'FS'), T(0, 1, N, 0, 1, 'MOV_FS'), T(0, 0, N, 0, 1, 'GS'),
  T(0, 1, N, 0, 1, 'MOV_GS'), T(0, 1, N, 0, 1, 'LEA'), T(0, 1, N, 0, 1, 'MOV'), T(1, 0, N, 0, 0, 'TO_I64'),
  T(1, 0, N, 0, 0, 'TO_F64'), T(1, 0, N, 0, 0, 'TO_BOOL'), T(1, 0, N, 0, 0, 'TOUPPER'), T(1, 1, N, 0, 0, 'HOLYC_TYPECAST'),
  T(1, 1, N, 0, 1, 'ADDR'), T(1, 1, N, 0, 0, 'COM'), T(1, 1, N, 0, 0, 'NOT'), T(1, 1, N, 0, 0, 'UNARY_MINUS'),
  T(1, 1, D, 0, 1, 'DEREF'), T(1, 1, D, 0, 1, 'DEREF_PP'), T(1, 1, D, 0, 1, 'DEREF_MM'), T(1, 1, D, 1, 1, '_PP'),
  T(1, 1, D, 1, 1, '_MM'), T(1, 1, D, 1, 1, 'PP_'), T(1, 1, D, 1, 1, 'MM_'), T(2, 1, N, 0, 0, 'SHL'),
  T(2, 1, N, 0, 0, 'SHR'), T(1, 1, A, 0, 0, 'SHL_CONST'), T(1, 1, A, 0, 0, 'SHR_CONST'), T(2, 1, N, 0, 0, 'POWER'),
  T(2, 1, N, 1, 0, 'MUL'), T(2, 1, N, 1, 0, 'DIV'), T(2, 1, N, 0, 0, 'MOD'), T(2, 1, N, 0, 0, 'AND'),
  T(2, 1, N, 0, 0, 'OR'), T(2, 1, N, 0, 0, 'XOR'), T(2, 1, N, 1, 0, 'ADD'), T(2, 1, N, 1, 0, 'SUB'),
  T(1, 1, A, 0, 0, 'ADD_CONST'), T(1, 1, A, 0, 0, 'SUB_CONST'), T(2, 1, C, 0, 0, 'EQU_EQU'), T(2, 1, C, 0, 0, 'NOT_EQU'),
  T(2, 1, C, 0, 0, 'LESS'), T(2, 1, C, 0, 0, 'GREATER_EQU'), T(2, 1, C, 0, 0, 'GREATER'), T(2, 1, C, 0, 0, 'LESS_EQU'),
  T(0, 1, N, 0, 0, 'PUSH_CMP'), T(2, 1, N, 0, 0, 'AND_AND'), T(2, 1, N, 0, 0, 'OR_OR'), T(2, 1, N, 0, 0, 'XOR_XOR'),
  T(2, 1, A, 0, 1, 'ASSIGN'), T(2, 1, A, 0, 1, 'ASSIGN_PP'), T(2, 1, A, 0, 1, 'ASSIGN_MM'), T(2, 1, A, 0, 1, 'SHL_EQU'),
  T(2, 1, A, 0, 1, 'SHR_EQU'), T(2, 1, A, 0, 1, 'MUL_EQU'), T(2, 1, A, 0, 1, 'DIV_EQU'), T(2, 1, A, 0, 1, 'MOD_EQU'),
  T(2, 1, A, 0, 1, 'AND_EQU'), T(2, 1, A, 0, 1, 'OR_EQU'), T(2, 1, A, 0, 1, 'XOR_EQU'), T(2, 1, A, 0, 1, 'ADD_EQU'),
  T(2, 1, A, 0, 1, 'SUB_EQU'), T(0, 0, N, 0, 0, 'JMP'), T(0, 0, N, 0, 0, 'SUB_CALL'), T(2, 0, N, 0, 0, 'SWITCH'),
  T(2, 0, N, 0, 0, 'NOBOUND_SWITCH'), T(3, 0, N, 0, 0, 'ADD_RSP'), T(3, 0, N, 0, 0, 'ADD_RSP1'), T(0, 0, N, 0, 0, 'ENTER'),
  T(0, 0, A, 0, 0, 'PUSH_REGS'), T(0, 0, A, 0, 0, 'POP_REGS'), T(0, 0, N, 0, 0, 'LEAVE'), T(0, 0, N, 0, 0, 'RET'),
  T(0, 0, N, 0, 1, 'CALL'), T(0, 0, N, 0, 1, 'CALL_INDIRECT'), T(0, 0, N, 0, 1, 'CALL_INDIRECT2'), T(0, 0, N, 0, 1, 'CALL_IMPORT'),
  T(0, 0, N, 0, 1, 'CALL_EXTERN'), T(0, 0, N, 0, 1, 'ASM'), T(1, 0, N, 0, 1, 'PUSH'), T(0, 0, N, 0, 1, 'POP'),
  T(1, 0, N, 0, 1, 'CLFLUSH'), T(1, 0, N, 0, 1, 'INVLPG'), T(1, 0, N, 0, 1, 'IN_U8'), T(1, 0, N, 0, 1, 'IN_U16'),
  T(1, 0, N, 0, 1, 'IN_U32'), T(2, 0, N, 0, 1, 'OUT_U8'), T(2, 0, N, 0, 1, 'OUT_U16'), T(2, 0, N, 0, 1, 'OUT_U32'),
  T(0, 0, N, 0, 1, 'GET_RFLAGS'), T(0, 0, N, 0, 1, 'CARRY'), T(1, 0, N, 0, 1, 'SET_RFLAGS'), T(0, 0, N, 0, 1, 'GET_RAX'),
  T(1, 0, N, 0, 1, 'SET_RAX'), T(0, 0, N, 0, 1, 'GET_RBP'), T(1, 0, N, 0, 1, 'SET_RBP'), T(0, 0, N, 0, 1, 'GET_RSP'),
  T(1, 0, N, 0, 1, 'SET_RSP'), T(0, 1, N, 0, 1, 'RIP'), T(0, 0, N, 0, 1, 'RDTSC'), T(2, 0, N, 0, 1, 'BT'),
  T(2, 0, N, 0, 1, 'BTS'), T(2, 0, N, 0, 1, 'BTR'), T(2, 0, N, 0, 1, 'BTC'), T(2, 0, N, 0, 1, 'LBTS'),
  T(2, 0, N, 0, 1, 'LBTR'), T(2, 0, N, 0, 1, 'LBTC'), T(1, 0, N, 0, 1, 'BSF'), T(1, 0, N, 0, 1, 'BSR'),
  T(1, 0, N, 0, 1, 'QUE_INIT'), T(2, 0, N, 0, 1, 'QUE_INS'), T(2, 0, N, 0, 1, 'QUE_INS_REV'), T(1, 0, N, 0, 1, 'QUE_REM'),
  T(1, 0, N, 0, 1, 'STRLEN'), T(1, 0, N, 0, 0, 'BR_ZERO'), T(1, 0, N, 0, 0, 'BR_NOT_ZERO'), T(0, 0, N, 0, 0, 'BR_CARRY'),
  T(0, 0, N, 0, 0, 'BR_NOT_CARRY'), T(2, 0, N, 0, 0, 'BR_EQU_EQU'), T(2, 0, N, 0, 0, 'BR_NOT_EQU'), T(2, 0, N, 0, 0, 'BR_LESS'),
  T(2, 0, N, 0, 0, 'BR_GREATER_EQU'), T(2, 0, N, 0, 0, 'BR_GREATER'), T(2, 0, N, 0, 0, 'BR_LESS_EQU'), T(2, 1, N, 0, 0, 'BR_2EQU_EQU'),
  T(2, 1, N, 0, 0, 'BR_2NOT_EQU'), T(2, 1, N, 0, 0, 'BR_2LESS'), T(2, 1, N, 0, 0, 'BR_2GREATER_EQU'), T(2, 1, N, 0, 0, 'BR_2GREATER'),
  T(2, 1, N, 0, 0, 'BR_2LESS_EQU'), T(2, 0, N, 0, 0, 'BR_AND_ZERO'), T(2, 0, N, 0, 0, 'BR_AND_NOT_ZERO'), T(1, 0, D, 0, 1, 'BR_MM_ZERO'),
  T(1, 0, D, 0, 1, 'BR_MM_NOT_ZERO'), T(2, 0, N, 0, 0, 'BR_AND_AND_ZERO'), T(2, 0, N, 0, 0, 'BR_AND_AND_NOT_ZERO'), T(2, 0, N, 0, 0, 'BR_OR_OR_ZERO'),
  T(2, 0, N, 0, 0, 'BR_OR_OR_NOT_ZERO'), T(2, 0, N, 0, 1, 'BR_BT'), T(2, 0, N, 0, 1, 'BR_BTS'), T(2, 0, N, 0, 1, 'BR_BTR'),
  T(2, 0, N, 0, 1, 'BR_BTC'), T(2, 0, N, 0, 1, 'BR_NOT_BT'), T(2, 0, N, 0, 1, 'BR_NOT_BTS'), T(2, 0, N, 0, 1, 'BR_NOT_BTR'),
  T(2, 0, N, 0, 1, 'BR_NOT_BTC'), T(2, 0, N, 0, 1, 'SWAP_U8'), T(2, 0, N, 0, 1, 'SWAP_U16'), T(2, 0, N, 0, 1, 'SWAP_U32'),
  T(2, 0, N, 0, 1, 'SWAP_U64'), T(1, 0, N, 0, 0, 'ABS_I64'), T(1, 0, N, 0, 0, 'SIGN_I64'), T(2, 0, N, 0, 0, 'I64_MIN'),
  T(2, 0, N, 0, 0, 'U64_MIN'), T(2, 0, N, 0, 0, 'I64_MAX'), T(2, 0, N, 0, 0, 'U64_MAX'), T(2, 0, N, 0, 0, 'MOD_U64'),
  T(1, 0, N, 0, 0, 'SQRI64'), T(1, 0, N, 0, 0, 'SQRU64'), T(1, 1, N, 1, 0, 'SQR'), T(1, 1, N, 1, 0, 'ABS'),
  T(1, 1, N, 1, 0, 'SQRT'), T(1, 1, N, 1, 0, 'SIN'), T(1, 1, N, 1, 0, 'COS'), T(1, 1, N, 1, 0, 'TAN'),
  T(1, 1, N, 1, 0, 'ATAN'),
];
for (const e of intermediate_code_table) if (e.arg_cnt === 3) e.arg_cnt = K.IS_V_ARG;
if (intermediate_code_table.length !== K.IC_ICS_NUM) throw new Error('IC table size ' + intermediate_code_table.length);

const RT = (cc, rt) => cc.cmp.internal_types[rt];

export function OptLabelFwd(lb) { let l; while ((l = lb.fwd)) lb = l; return lb; }
export function OptSetNOP1(t) { t.code = K.IC_NOP1; t.flags = 0; }
export function OptSetNOP2(t, d = 1) { t.code = K.IC_NOP2; t.data = BigInt(d); }
export function OptFree(t) { t.last.next = t.next; t.next.last = t.last; t.freed = true; return null; }
export function OptLag(t) {
  do { if (!t.code) return null; t = t.last; } while (t.code <= K.IC_END_EXP);
  return t;
}
export function OptLag1(t) {
  do { if (!t.code) return null; t = t.last; } while (t.code === K.IC_NOP1 || t.code === K.IC_NOP2);
  return t;
}
export function OptLead1(t) {
  do { t = t.next; if (!t.code) return null; } while (t.code === K.IC_NOP1 || t.code === K.IC_NOP2);
  return t;
}
const FBO1_NOT_CONST = 0, FBO1_INT = 1, FBO1_F64 = 2;

function OptFixupBinaryOp1(cc, tmpi, tmpi1, tmpi2, uo) {
  let tmpc1, tmpc2, tmpc;
  if (tmpi1.flags & K.ICF_RES_TO_INT) tmpc1 = RT(cc, K.RT_I64);
  else if (tmpi1.flags & K.ICF_RES_TO_F64) tmpc1 = RT(cc, K.RT_F64);
  else tmpc1 = OptClassFwd(tmpi1.cls);
  if (tmpi2.flags & K.ICF_RES_TO_INT) tmpc2 = RT(cc, K.RT_I64);
  else if (tmpi2.flags & K.ICF_RES_TO_F64) tmpc2 = RT(cc, K.RT_F64);
  else tmpc2 = OptClassFwd(tmpi2.cls);
  if (tmpc1.raw_type > tmpc2.raw_type) tmpc = tmpi.cls = tmpc1;
  else tmpc = tmpi.cls = tmpc2;
  if (tmpc.raw_type === K.RT_F64) {
    if (tmpi1.code === K.IC_IMM_I64) {
      tmpi1.data = f2b(Number(I64(tmpi1.data)));
      tmpi1.cls = RT(cc, K.RT_F64);
      tmpi1.code = K.IC_IMM_F64;
      tmpi1.flags &= ~K.ICF_RES_TO_F64;
    } else if (tmpc1.raw_type !== K.RT_F64) tmpi1.flags |= K.ICF_RES_TO_F64;
    if (tmpi2.code === K.IC_IMM_I64) {
      tmpi2.data = f2b(Number(I64(tmpi2.data)));
      tmpi2.cls = RT(cc, K.RT_F64);
      tmpi2.code = K.IC_IMM_F64;
      tmpi2.flags &= ~K.ICF_RES_TO_F64;
    } else if (tmpc2.raw_type !== K.RT_F64) tmpi2.flags |= K.ICF_RES_TO_F64;
    // (The original's float-compare-to-zero tweak uses '==' where it meant '='
    // and so has no effect except the fall-through below; we mirror that.)
    if (tmpi1.code === K.IC_IMM_F64 && tmpi2.code === K.IC_IMM_F64 && !(tmpi.flags & (K.ICF_PUSH_CMP | K.ICF_POP_CMP))) {
      tmpi.flags |= tmpi1.flags | tmpi2.flags;
      OptSetNOP1(tmpi1); OptSetNOP1(tmpi2);
      return FBO1_F64;
    }
    if (K.IC_LESS <= tmpi.code && tmpi.code <= K.IC_GREATER_EQU) {
      const ld = OptLead1(tmpi);
      if (ld && ld.code !== K.IC_PUSH_CMP && ld.code !== K.IC_AND_AND) {
        if (tmpi1.code === K.IC_IMM_F64 && !tmpi1.data && tmpi2.code === K.IC_DEREF && tmpc2 === RT(cc, K.RT_F64)) {
          tmpi1.flags &= ~K.ICF_RES_TO_F64;
          tmpi.cls = tmpi1.cls = tmpi2.cls = RT(cc, K.RT_I64);
          uo.v = false;
          return FBO1_NOT_CONST;
        } else if (tmpi2.code === K.IC_IMM_F64 && !tmpi2.data && tmpi1.code === K.IC_DEREF && tmpc1 === RT(cc, K.RT_F64)) {
          tmpi1.flags &= ~K.ICF_RES_TO_F64;
          tmpi.cls = tmpi1.cls = tmpi2.cls = RT(cc, K.RT_I64);
          uo.v = false;
          return FBO1_NOT_CONST;
        }
      }
    }
    return FBO1_NOT_CONST;
  }
  uo.v = !!(tmpc1.raw_type & K.RTF_UNSIGNED) || !!(tmpc2.raw_type & K.RTF_UNSIGNED);
  if (tmpi1.code === K.IC_IMM_I64 && tmpi2.code === K.IC_IMM_I64 && !(tmpi.flags & (K.ICF_PUSH_CMP | K.ICF_POP_CMP))) {
    tmpi.flags |= tmpi1.flags | tmpi2.flags;
    OptSetNOP1(tmpi1); OptSetNOP1(tmpi2);
    return FBO1_INT;
  }
  return FBO1_NOT_CONST;
}

function OptFixupUnaryOp(cc, tmpi, tmpi1, uo) {
  const tmpc1 = OptClassFwd(tmpi1.cls);
  tmpi.cls = tmpc1;
  if (tmpc1.raw_type === K.RT_F64) {
    if (tmpi1.code === K.IC_IMM_I64) {
      tmpi1.data = f2b(Number(I64(tmpi1.data)));
      tmpi1.cls = RT(cc, K.RT_F64);
      tmpi1.code = K.IC_IMM_F64;
      tmpi1.flags &= ~K.ICF_RES_TO_F64;
    } else if (tmpc1.raw_type !== K.RT_F64) tmpi1.flags |= K.ICF_RES_TO_F64;
    if (tmpi1.code === K.IC_IMM_F64) {
      tmpi.flags |= tmpi1.flags;
      OptSetNOP1(tmpi1);
      return FBO1_F64;
    }
    return FBO1_NOT_CONST;
  }
  uo.v = !!(tmpc1.raw_type & K.RTF_UNSIGNED);
  if (tmpi1.code === K.IC_IMM_I64) {
    tmpi.flags |= tmpi1.flags;
    OptSetNOP1(tmpi1);
    return FBO1_INT;
  }
  return FBO1_NOT_CONST;
}

function copyTree(dst, src) {
  dst.t.arg1_class = src.t.arg1_class; dst.t.arg2_class = src.t.arg2_class;
  dst.t.arg1_tree = src.t.arg1_tree; dst.t.arg2_tree = src.t.arg2_tree;
}
function brCallEnd(tmpi, tmpii, notZero) {
  const tmpii2 = OptLag(tmpii);
  let code = null;
  switch (tmpii2.code) {
    case K.IC_CARRY: code = notZero ? K.IC_BR_CARRY : K.IC_BR_NOT_CARRY; break;
    case K.IC_BT: code = notZero ? K.IC_BR_BT : K.IC_BR_NOT_BT; break;
    case K.IC_LBTS: tmpii2.flags |= K.ICF_LOCK; // fallthrough
    case K.IC_BTS: code = notZero ? K.IC_BR_BTS : K.IC_BR_NOT_BTS; break;
    case K.IC_LBTR: tmpii2.flags |= K.ICF_LOCK; // fallthrough
    case K.IC_BTR: code = notZero ? K.IC_BR_BTR : K.IC_BR_NOT_BTR; break;
    case K.IC_LBTC: tmpii2.flags |= K.ICF_LOCK; // fallthrough
    case K.IC_BTC: code = notZero ? K.IC_BR_BTC : K.IC_BR_NOT_BTC; break;
  }
  if (code === null) return null;
  tmpii2.code = code;
  tmpii2.data = tmpi.data;
  tmpii.code = K.IC_CALL_END2;
  OptSetNOP1(tmpi);
  return tmpii;
}

export function OptBrZero(cc, tmpi) {
  let tmpii = OptLag(tmpi);
  switch (tmpii.code) {
    case K.IC_NOT:
      tmpi.code = K.IC_BR_NOT_ZERO;
      tmpi.cls = tmpii.cls;
      tmpi.flags |= tmpii.flags;
      tmpi.t.arg1_class = tmpii.t.arg1_class;
      tmpi.t.arg1_tree = tmpii.t.arg1_tree;
      OptFree(tmpii);
      return OptBrNotZero(cc, tmpi);
    case K.IC_EQU_EQU: case K.IC_NOT_EQU: case K.IC_LESS: case K.IC_GREATER_EQU: case K.IC_GREATER: case K.IC_LESS_EQU:
      tmpi.code = ((tmpii.code - K.IC_EQU_EQU) ^ 1) + K.IC_BR_EQU_EQU;
      break;
    case K.IC_OR_OR: tmpi.code = K.IC_BR_OR_OR_ZERO; break;
    case K.IC_AND_AND: tmpi.code = K.IC_BR_AND_AND_ZERO; break;
    case K.IC_AND: tmpi.code = K.IC_BR_AND_ZERO; break;
    case K.IC_MM_:
      if (cc.pass === 2 && !(tmpii.flags & K.ICF_RES_TO_F64) && tmpii.cls.raw_type !== K.RT_F64)
        tmpi.code = K.IC_BR_MM_ZERO;
      break;
    case K.IC_CALL_END: {
      const r = brCallEnd(tmpi, tmpii, false);
      if (r) return r;
      break;
    }
  }
  if (tmpi.code !== K.IC_BR_ZERO) {
    tmpi.cls = tmpii.cls;
    tmpi.flags |= tmpii.flags;
    copyTree(tmpi, tmpii);
    OptFree(tmpii);
    if (tmpi.flags & K.ICF_PUSH_CMP && K.IC_BR_NOT_EQU <= tmpi.code && tmpi.code <= K.IC_BR_LESS_EQU && !(tmpi.flags & K.ICF_USE_F64)) {
      tmpi.code += K.IC_BR_EQU_EQU2 - K.IC_BR_EQU_EQU;
      tmpi.flags &= ~K.ICF_PUSH_CMP;
      tmpii = tmpi.next;
      while (tmpii.code !== K.IC_PUSH_CMP) tmpii = tmpii.next;
      tmpii.t.arg1_tree = tmpi;
      OptSetNOP1(tmpii);
    }
    const lb_true = tmpi.data;
    if (tmpi.code === K.IC_BR_AND_AND_ZERO) {
      tmpii = tmpi.t.arg1_tree.next;
      tmpii.data = lb_true;
      tmpii.t.arg1_tree = tmpi.t.arg1_tree;
      tmpii.t.arg1_class = tmpi.t.arg1_class;
      tmpii.code = K.IC_BR_ZERO;
      OptBrZero(cc, tmpii);
      tmpii = tmpi.t.arg2_tree.next;
      tmpii.t.arg1_tree = tmpi.t.arg2_tree;
      tmpii.t.arg1_class = tmpi.t.arg2_class;
      tmpii.data = lb_true;
      tmpii.code = K.IC_BR_ZERO;
      tmpii = OptBrZero(cc, tmpii);
      OptSetNOP1(tmpi);
    } else if (tmpi.code === K.IC_BR_OR_OR_ZERO) {
      const lb_false = newLabel(cc);
      tmpi.code = K.IC_LABEL;
      tmpi.flags = 0;
      tmpi.data = lb_false;
      tmpii = tmpi.t.arg1_tree.next;
      tmpii.t.arg1_tree = tmpi.t.arg1_tree;
      tmpii.t.arg1_class = tmpi.t.arg1_class;
      tmpii.data = lb_false;
      tmpii.code = K.IC_BR_NOT_ZERO;
      OptBrNotZero(cc, tmpii);
      tmpii = tmpi.t.arg2_tree.next;
      tmpii.t.arg1_tree = tmpi.t.arg2_tree;
      tmpii.t.arg1_class = tmpi.t.arg2_class;
      tmpii.data = lb_true;
      tmpii.code = K.IC_BR_ZERO;
      tmpii = OptBrZero(cc, tmpii);
    } else tmpii = tmpi;
    if (tmpi.flags & K.ICF_POP_CMP && tmpi.t.arg1_tree.code === K.IC_NOP1) {
      tmpi.t.arg1_tree = tmpi.t.arg1_tree.t.arg1_tree;
      tmpi.flags &= ~K.ICF_POP_CMP;
    }
    return tmpii;
  }
  return tmpi;
}

export function OptBrNotZero(cc, tmpi) {
  let tmpii = OptLag(tmpi);
  switch (tmpii.code) {
    case K.IC_NOT:
      tmpi.code = K.IC_BR_ZERO;
      tmpi.cls = tmpii.cls;
      tmpi.flags |= tmpii.flags;
      tmpi.t.arg1_class = tmpii.t.arg1_class;
      tmpi.t.arg1_tree = tmpii.t.arg1_tree;
      OptFree(tmpii);
      return OptBrZero(cc, tmpi);
    case K.IC_EQU_EQU: case K.IC_NOT_EQU: case K.IC_LESS: case K.IC_GREATER_EQU: case K.IC_GREATER: case K.IC_LESS_EQU:
      tmpi.code = tmpii.code + K.IC_BR_EQU_EQU - K.IC_EQU_EQU;
      break;
    case K.IC_OR_OR: tmpi.code = K.IC_BR_OR_OR_NOT_ZERO; break;
    case K.IC_AND_AND: tmpi.code = K.IC_BR_AND_AND_NOT_ZERO; break;
    case K.IC_AND: tmpi.code = K.IC_BR_AND_NOT_ZERO; break;
    case K.IC_MM_:
      if (cc.pass === 2 && !(tmpii.flags & K.ICF_RES_TO_F64) && tmpii.cls.raw_type !== K.RT_F64)
        tmpi.code = K.IC_BR_MM_NOT_ZERO;
      break;
    case K.IC_CALL_END: {
      const r = brCallEnd(tmpi, tmpii, true);
      if (r) return r;
      break;
    }
  }
  if (tmpi.code !== K.IC_BR_NOT_ZERO) {
    tmpi.cls = tmpii.cls;
    tmpi.flags |= tmpii.flags;
    copyTree(tmpi, tmpii);
    OptFree(tmpii);
    if (tmpi.flags & K.ICF_PUSH_CMP && K.IC_BR_NOT_EQU <= tmpi.code && tmpi.code <= K.IC_BR_LESS_EQU && !(tmpi.flags & K.ICF_USE_F64)) {
      tmpi.code += K.IC_BR_EQU_EQU2 - K.IC_BR_EQU_EQU;
      tmpi.flags &= ~K.ICF_PUSH_CMP;
      tmpii = tmpi.next;
      while (tmpii.code !== K.IC_PUSH_CMP) tmpii = tmpii.next;
      tmpii.t.arg1_tree = tmpi;
      OptSetNOP1(tmpii);
    }
    const lb_true = tmpi.data;
    if (tmpi.code === K.IC_BR_OR_OR_NOT_ZERO) {
      tmpii = tmpi.t.arg1_tree.next;
      tmpii.t.arg1_tree = tmpi.t.arg1_tree;
      tmpii.t.arg1_class = tmpi.t.arg1_class;
      tmpii.data = lb_true;
      tmpii.code = K.IC_BR_NOT_ZERO;
      OptBrNotZero(cc, tmpii);
      tmpii = tmpi.t.arg2_tree.next;
      tmpii.t.arg1_tree = tmpi.t.arg2_tree;
      tmpii.t.arg1_class = tmpi.t.arg2_class;
      tmpii.data = lb_true;
      tmpii.code = K.IC_BR_NOT_ZERO;
      tmpii = OptBrNotZero(cc, tmpii);
      OptSetNOP1(tmpi);
    } else if (tmpi.code === K.IC_BR_AND_AND_NOT_ZERO) {
      const lb_false = newLabel(cc);
      tmpi.code = K.IC_LABEL;
      tmpi.flags = 0;
      tmpi.data = lb_false;
      tmpii = tmpi.t.arg1_tree.next;
      tmpii.t.arg1_tree = tmpi.t.arg1_tree;
      tmpii.t.arg1_class = tmpi.t.arg1_class;
      tmpii.data = lb_false;
      tmpii.code = K.IC_BR_ZERO;
      OptBrZero(cc, tmpii);
      tmpii = tmpi.t.arg2_tree.next;
      tmpii.t.arg1_tree = tmpi.t.arg2_tree;
      tmpii.t.arg1_class = tmpi.t.arg2_class;
      tmpii.data = lb_true;
      tmpii.code = K.IC_BR_NOT_ZERO;
      tmpii = OptBrNotZero(cc, tmpii);
    } else tmpii = tmpi;
    if (tmpi.flags & K.ICF_POP_CMP && tmpi.t.arg1_tree.code === K.IC_NOP1) {
      tmpi.t.arg1_tree = tmpi.t.arg1_tree.t.arg1_tree;
      tmpi.flags &= ~K.ICF_POP_CMP;
    }
    return tmpii;
  }
  return tmpi;
}

let labelSerial = 0;
function newLabel(cc) {
  const m = { type: K.CMT_LABEL, flags: 0, str: null, use_cnt: 0, addr: -1, fwd: null, id: 'L' + (++labelSerial) };
  cc.coc.misc.push(m);
  return m;
}

function OptFixSizeOf(cc, tmpi1, tmpi_push, tmpcc) {
  if (tmpi1.code === K.IC_MUL && tmpi1.t.arg2_tree.code === K.IC_SIZEOF) {
    tmpi1.t.arg2_tree.code = K.IC_IMM_I64;
    tmpi1.t.arg2_tree.cls = tmpcc;
    tmpi_push.cls = tmpcc;
    if (tmpcc.ptr_stars_cnt) {
      tmpcc = csub(tmpcc);
      if (tmpcc.size !== 1) { tmpi1.t.arg2_tree.data = BigInt(tmpcc.size); return; }
    }
    if (tmpi_push === tmpi1) tmpi1.t.arg2_tree.data = 1n;
    else { OptSetNOP1(tmpi1.t.arg2_tree); OptSetNOP1(tmpi1); }
  }
}

const isPow2 = (i) => i !== 0n && bsf(i) === bsr(i);
const findBack = (t, code) => { while (t.code !== code) t = t.last; return t; };
const findFwd = (t, code) => { while (t.code !== code) t = t.next; return t; };

// Constant folding on ints is done with 64-bit wrap-around.
const sx = (x) => I64(x);

export function OptPass012(cc) {
  let code, tmpc, tmpc1, tmpc2, tmpi, tmpi1, tmpi2, tmpi3, tmpi_push, last_with_class = null, i;
  const uo = { v: false };
  let ps = cc.ps;
  if (!ps) ps = cc.ps = { ptr: 0, stk: [] };
  ps.ptr = 0;
  const push = (v) => { ps.stk[++ps.ptr] = v; };
  const pop = () => ps.stk[ps.ptr--];
  tmpi = cc.coc.head.next;
  while ((code = tmpi.code)) {
    tmpc = tmpi.cls;
    tmpi.cls2 = tmpc;
    tmpi_push = tmpi;
    tmpi.arg1_type_pointed_to = 0;
    const ent = intermediate_code_table[code];
    if (!ent) LexExcept(cc, 'Bad IC ' + code);
    tmpi1 = tmpi2 = null; tmpc1 = tmpc2 = null;
    switch (ent.arg_cnt) {
      case K.IS_V_ARG: ps.ptr -= Number(tmpi.data) >> 2; break;
      case K.IS_2_ARG:
        tmpi2 = pop(); tmpc2 = tmpi2.cls;
        tmpi.t.arg2_tree = tmpi2;
        tmpi.t.arg2_class = pop();
      // fallthrough
      case K.IS_1_ARG:
        tmpi1 = pop(); tmpc1 = tmpi1.cls;
        tmpi.t.arg1_tree = tmpi1;
        tmpi.t.arg1_class = pop();
        break;
    }
    if (ent.not_const) cc.flags |= K.CCF_NOT_CONST;
    let groupEnd = 0; // which "end:" tail to run
    switch (code) {
      case K.IC_IMM_F64:
        tmpi.flags &= ~K.ICF_RES_TO_F64;
        if (cc.pass === 2 && tmpi.flags & K.ICF_RES_TO_INT) {
          tmpi.data = f2i(b2f(tmpi.data));
          tmpi.flags &= ~K.ICF_RES_TO_INT;
          tmpi.code = K.IC_IMM_I64;
          tmpi.cls = RT(cc, K.RT_I64);
        }
        break;
      case K.IC_IMM_I64:
        tmpi.flags &= ~K.ICF_RES_TO_INT;
        if (cc.pass === 2 && tmpi.flags & K.ICF_RES_TO_F64) {
          tmpi.data = f2b(Number(I64(tmpi.data)));
          tmpi.flags &= ~K.ICF_RES_TO_F64;
          tmpi.code = K.IC_IMM_F64;
          tmpi.cls = RT(cc, K.RT_F64);
        }
        break;
      case K.IC_HOLYC_TYPECAST:
        if (tmpi1.code === K.IC_IMM_I64 || tmpi1.code === K.IC_IMM_F64) {
          tmpi1.code = tmpi.cls.raw_type === K.RT_F64 ? K.IC_IMM_F64 : K.IC_IMM_I64;
          tmpi1.cls = tmpi.cls;
          tmpi1.flags |= tmpi.flags;
          tmpi_push = tmpi1;
          OptSetNOP1(tmpi);
        } else if (tmpi.data) {
          if (!tmpi_push.cls.ptr_stars_cnt)
            tmpi_push.cls2 = tmpi_push.cls.raw_type === K.RT_F64 ? RT(cc, K.RT_F64) : RT(cc, K.RT_I64);
        } else {
          tmpi1.cls = tmpi.cls;
          tmpi1.flags |= tmpi.flags;
          tmpi_push = tmpi1;
          OptSetNOP1(tmpi);
        }
        break;
      case K.IC_FS: case K.IC_GS:
        tmpi1 = tmpi.next.next; tmpi2 = tmpi1.next; tmpi3 = tmpi2.next;
        if (tmpi1.code === K.IC_IMM_I64 && tmpi2.code === K.IC_ADD && tmpi3.code === K.IC_DEREF &&
          !(tmpi3.flags & ~K.ICG_NO_CVT_MASK)) {
          tmpi.flags |= tmpi1.flags | tmpi2.flags | tmpi3.flags;
          tmpi.code = tmpi.code === K.IC_FS ? K.IC_MOV_FS : K.IC_MOV_GS;
          tmpi.data = tmpi1.data;
          tmpi.cls = tmpi3.cls;
          tmpi.cls2 = tmpi3.cls2;
          OptSetNOP1(tmpi1); OptSetNOP1(tmpi2); OptSetNOP1(tmpi3);
          tmpi1 = tmpi.last; tmpi2 = tmpi.next;
          tmpi.flags |= tmpi1.flags | tmpi2.flags;
          OptSetNOP1(tmpi1); OptSetNOP1(tmpi2);
        }
        break;
      case K.IC_PUSH_CMP:
        if ((tmpi1 = OptLag(tmpi))) {
          if (tmpi1.code === K.IC_AND_AND) tmpi1 = OptLag(tmpi1);
          if (tmpi1) tmpi.cls = tmpi1.cls;
        }
        tmpi.cls2 = tmpi.cls;
        tmpi.data = 0n;
        if (tmpi.cls.raw_type === K.RT_F64) tmpi.flags |= K.ICF_USE_F64;
        break;
      case K.IC_COM:
        if (tmpi1.code === K.IC_IMM_I64) {
          tmpi.data = sx(~tmpi1.data);
          tmpi.code = K.IC_IMM_I64;
          tmpi.flags |= tmpi1.flags;
          OptSetNOP1(tmpi1);
        }
        tmpi_push.cls2 = RT(cc, K.RT_I64);
        break;
      case K.IC_NOT:
        if (tmpc.raw_type === K.RT_F64) {
          if (tmpi1.code === K.IC_IMM_F64) {
            tmpi.data = f2b(b2f(tmpi1.data) ? 0 : 1);
            tmpi.code = K.IC_IMM_F64;
            tmpi.flags |= tmpi1.flags;
            OptSetNOP1(tmpi1);
          }
        } else if (tmpi1.code === K.IC_IMM_I64) {
          tmpi.data = tmpi1.data ? 0n : 1n;
          tmpi.code = K.IC_IMM_I64;
          tmpi.flags |= tmpi1.flags;
          OptSetNOP1(tmpi1);
        }
        groupEnd = 1;
        break;
      case K.IC_UNARY_MINUS:
        if ((i = OptFixupUnaryOp(cc, tmpi, tmpi1, uo))) {
          if (i === FBO1_INT) { tmpi.data = sx(-tmpi1.data); tmpi.code = K.IC_IMM_I64; }
          else { tmpi.data = f2b(-b2f(tmpi1.data)); tmpi.code = K.IC_IMM_F64; }
        }
        if (tmpc1.type & K.HTT_INTERNAL_TYPE && tmpc1.raw_type & K.RTF_UNSIGNED)
          tmpi.cls = cc.cmp.internal_types[tmpc1.raw_type - 1];
        groupEnd = 1;
        break;
      case K.IC_SHL_CONST: case K.IC_SHR_CONST:
        if ((i = OptFixupUnaryOp(cc, tmpi, tmpi1, uo))) {
          const sh = BigInt(Number(tmpi.data) & 63);
          if (i === FBO1_INT) {
            if (code === K.IC_SHL_CONST) tmpi.data = sx(tmpi1.data << sh);
            else tmpi.data = uo.v ? sx(U64(tmpi1.data) >> sh) : sx(sx(tmpi1.data) >> sh);
            tmpi.code = K.IC_IMM_I64;
          } else {
            tmpi.data = f2b(b2f(tmpi1.data) * Math.pow(2, code === K.IC_SHL_CONST ? Number(tmpi.data) : -Number(tmpi.data)));
            tmpi.code = K.IC_IMM_F64;
          }
        } else if (tmpi1.code === code) {
          tmpi.flags |= tmpi1.flags;
          tmpi.data += tmpi1.data;
          OptSetNOP1(tmpi1);
        }
        groupEnd = 1;
        break;
      case K.IC_SHL: case K.IC_SHR:
        if ((i = OptFixupBinaryOp1(cc, tmpi, tmpi1, tmpi2, uo))) {
          if (i === FBO1_INT) {
            const sh = U64(tmpi2.data) & 63n;
            if (code === K.IC_SHL) tmpi.data = sx(tmpi1.data << sh);
            else tmpi.data = uo.v ? sx(U64(tmpi1.data) >> sh) : sx(sx(tmpi1.data) >> sh);
            tmpi.code = K.IC_IMM_I64;
          } else {
            tmpi.data = f2b(b2f(tmpi1.data) * Math.pow(2, (code === K.IC_SHL ? 1 : -1) * b2f(tmpi2.data)));
            tmpi.code = K.IC_IMM_F64;
          }
        } else if (tmpi2.code === K.IC_IMM_I64) {
          tmpi.flags |= tmpi2.flags;
          tmpi.data = tmpi2.data;
          tmpi.code = code === K.IC_SHL ? K.IC_SHL_CONST : K.IC_SHR_CONST;
          OptSetNOP1(tmpi2);
        }
        groupEnd = 1;
        break;
      case K.IC_DEREF:
        if (cc.pass === 2) {
          if (!tmpc.size) LexWarn(cc, 'Dereference U0 ');
          if (tmpi1.cls.raw_type !== K.RT_F64) {
            if (tmpi1.code === K.IC__PP) {
              tmpi.code = K.IC_DEREF_PP; tmpi.flags |= tmpi1.flags; OptSetNOP1(tmpi1);
            } else if (tmpi1.code === K.IC__MM) {
              tmpi.code = K.IC_DEREF_MM; tmpi.flags |= tmpi1.flags; OptSetNOP1(tmpi1);
            }
          }
        }
        break;
      case K.IC__PP: case K.IC__MM: case K.IC_PP_: case K.IC_MM_:
        if (cc.pass === 2 && !tmpc.size) LexWarn(cc, 'Dereference U0 ');
        break;
      case K.IC_POWER:
        tmpc = tmpi.cls = RT(cc, K.RT_F64);
        if (tmpc1.raw_type !== K.RT_F64) tmpi1.flags |= K.ICF_RES_TO_F64;
        if (tmpc2.raw_type !== K.RT_F64) tmpi2.flags |= K.ICF_RES_TO_F64;
        tmpi_push.cls2 = RT(cc, K.RT_F64);
        break;
      case K.IC_MUL:
        if ((i = OptFixupBinaryOp1(cc, tmpi, tmpi1, tmpi2, uo))) {
          if (i === FBO1_INT) { tmpi.data = sx(tmpi1.data * tmpi2.data); tmpi.code = K.IC_IMM_I64; }
          else { tmpi.data = f2b(b2f(tmpi1.data) * b2f(tmpi2.data)); tmpi.code = K.IC_IMM_F64; }
        } else if (tmpi1.code === K.IC_IMM_I64 && cc.pass === 2) {
          const v = tmpi1.data;
          if (v === 1n) {
            tmpi2.flags |= tmpi.flags | tmpi1.flags; tmpi2.cls2 = tmpi.cls2; tmpi_push = tmpi2;
            OptSetNOP1(tmpi1); OptSetNOP1(tmpi);
          } else if (v !== 0n && isPow2(v)) {
            tmpi.flags |= tmpi1.flags;
            tmpi.t.arg1_class = tmpi.t.arg2_class;
            tmpi.t.arg1_tree = tmpi.t.arg2_tree;
            tmpi.data = BigInt(bsf(v));
            tmpi.code = K.IC_SHL_CONST;
            OptSetNOP1(tmpi1);
          }
        } else if (tmpi2.code === K.IC_IMM_I64) {
          const v = tmpi2.data;
          if (v === 1n) {
            tmpi1.flags |= tmpi.flags | tmpi2.flags; tmpi1.cls2 = tmpi.cls2; tmpi_push = tmpi1;
            OptSetNOP1(tmpi2); OptSetNOP1(tmpi);
          } else if (v !== 0n) {
            if (isPow2(v)) {
              tmpi.flags |= tmpi2.flags;
              tmpi.data = BigInt(bsf(v));
              tmpi.code = K.IC_SHL_CONST;
              OptSetNOP1(tmpi2);
            } else if (tmpi1.code === K.IC_MUL && cc.pass === 2) {
              if (tmpi1.t.arg1_tree.code === K.IC_IMM_I64) {
                tmpi1.flags |= tmpi.flags; tmpi1.t.arg1_tree.data = sx(tmpi1.t.arg1_tree.data * v);
                tmpi1.cls2 = tmpi.cls2; tmpi_push = tmpi1; OptSetNOP1(tmpi2); OptSetNOP1(tmpi);
              } else if (tmpi1.t.arg2_tree.code === K.IC_IMM_I64) {
                tmpi1.flags |= tmpi.flags; tmpi1.t.arg2_tree.data = sx(tmpi1.t.arg2_tree.data * v);
                tmpi1.cls2 = tmpi.cls2; tmpi_push = tmpi1; OptSetNOP1(tmpi2); OptSetNOP1(tmpi);
              }
            }
          }
        } else if (tmpi2.code === K.IC_IMM_F64 && cc.pass === 2) {
          if (b2f(tmpi2.data) === 1.0) {
            tmpi1.flags |= tmpi.flags | tmpi2.flags; tmpi1.cls2 = tmpi.cls2; tmpi_push = tmpi1;
            OptSetNOP1(tmpi2); OptSetNOP1(tmpi);
          } else if (tmpi1.code === K.IC_MUL) {
            if (tmpi1.t.arg1_tree.code === K.IC_IMM_F64) {
              tmpi1.flags |= tmpi.flags | tmpi2.flags;
              tmpi1.t.arg1_tree.data = f2b(b2f(tmpi1.t.arg1_tree.data) * b2f(tmpi2.data));
              tmpi1.cls2 = tmpi.cls2; tmpi_push = tmpi1; OptSetNOP1(tmpi2); OptSetNOP1(tmpi);
            } else if (tmpi1.t.arg2_tree.code === K.IC_IMM_F64) {
              tmpi1.flags |= tmpi.flags | tmpi2.flags;
              tmpi1.t.arg2_tree.data = f2b(b2f(tmpi1.t.arg2_tree.data) * b2f(tmpi2.data));
              tmpi1.cls2 = tmpi.cls2; tmpi_push = tmpi1; OptSetNOP1(tmpi2); OptSetNOP1(tmpi);
            }
          }
        }
        groupEnd = 2;
        break;
      case K.IC_DIV:
        if ((tmpi2.data || (tmpi2.code !== K.IC_IMM_I64 && tmpi2.code !== K.IC_IMM_F64)) &&
          (i = OptFixupBinaryOp1(cc, tmpi, tmpi1, tmpi2, uo))) {
          if (i === FBO1_INT) {
            tmpi.data = uo.v ? sx(U64(tmpi1.data) / U64(tmpi2.data)) : sx(sx(tmpi1.data) / sx(tmpi2.data));
            tmpi.code = K.IC_IMM_I64;
          } else { tmpi.data = f2b(b2f(tmpi1.data) / b2f(tmpi2.data)); tmpi.code = K.IC_IMM_F64; }
        } else if (tmpi2.code === K.IC_IMM_I64 && tmpi2.data) {
          const v = tmpi2.data;
          if (v === 1n) {
            tmpi1.flags |= tmpi2.flags | tmpi.flags; tmpi1.cls2 = tmpi.cls2; tmpi_push = tmpi1;
            OptSetNOP1(tmpi2); OptSetNOP1(tmpi);
          } else if (isPow2(v)) {
            tmpi.flags |= tmpi2.flags;
            tmpi.data = BigInt(bsf(v));
            tmpi.code = K.IC_SHR_CONST;
            OptSetNOP1(tmpi2);
          }
        }
        groupEnd = 2;
        break;
      case K.IC_MOD:
        if ((tmpi2.data || (tmpi2.code !== K.IC_IMM_I64 && tmpi2.code !== K.IC_IMM_F64)) &&
          (i = OptFixupBinaryOp1(cc, tmpi, tmpi1, tmpi2, uo))) {
          if (i === FBO1_INT) {
            tmpi.data = uo.v ? sx(U64(tmpi1.data) % U64(tmpi2.data)) : sx(sx(tmpi1.data) % sx(tmpi2.data));
            tmpi.code = K.IC_IMM_I64;
          } else { tmpi.data = f2b(b2f(tmpi1.data) % b2f(tmpi2.data)); tmpi.code = K.IC_IMM_F64; }
        } else if (cc.pass === 2 && tmpi2.code === K.IC_IMM_I64 && tmpi2.data && isPow2(tmpi2.data) &&
          tmpi_push.cls.raw_type !== K.RT_F64 && tmpi_push.cls.raw_type & K.RTF_UNSIGNED) {
          tmpi2.data = tmpi2.data - 1n;
          tmpi.code = K.IC_AND;
        }
        groupEnd = 2;
        break;
      case K.IC_AND: case K.IC_OR: case K.IC_XOR:
        if ((i = OptFixupBinaryOp1(cc, tmpi, tmpi1, tmpi2, uo))) {
          if (code === K.IC_AND) tmpi.data = sx(tmpi1.data & tmpi2.data);
          else if (code === K.IC_OR) tmpi.data = sx(tmpi1.data | tmpi2.data);
          else tmpi.data = sx(tmpi1.data ^ tmpi2.data);
          tmpi.code = i === FBO1_INT ? K.IC_IMM_I64 : K.IC_IMM_F64;
        }
        groupEnd = 2;
        break;
      case K.IC_ADD: case K.IC_SUB:
        if ((i = OptFixupBinaryOp1(cc, tmpi, tmpi1, tmpi2, uo))) {
          if (i === FBO1_INT) {
            tmpi.data = code === K.IC_ADD ? sx(tmpi1.data + tmpi2.data) : sx(tmpi1.data - tmpi2.data);
            tmpi.code = K.IC_IMM_I64;
          } else {
            tmpi.data = f2b(code === K.IC_ADD ? b2f(tmpi1.data) + b2f(tmpi2.data) : b2f(tmpi1.data) - b2f(tmpi2.data));
            tmpi.code = K.IC_IMM_F64;
          }
        } else if (code === K.IC_ADD) addFold(cc, tmpi, tmpi1, tmpi2, (p) => { tmpi_push = p; });
        else subFold(cc, tmpi, tmpi1, tmpi2, (p) => { tmpi_push = p; });
        groupEnd = 2;
        break;
      case K.IC_AND_AND: case K.IC_OR_OR: case K.IC_XOR_XOR:
        if (OptFixupBinaryOp1(cc, tmpi, tmpi1, tmpi2, uo)) {
          const a = !!tmpi1.data, b = !!tmpi2.data;
          tmpi.data = (code === K.IC_AND_AND ? a && b : code === K.IC_OR_OR ? a || b : a !== b) ? 1n : 0n;
          tmpi.code = K.IC_IMM_I64;
        }
        tmpi.cls = RT(cc, K.RT_I64);
        groupEnd = 2;
        break;
      case K.IC_EQU_EQU: case K.IC_NOT_EQU: case K.IC_LESS: case K.IC_GREATER_EQU: case K.IC_GREATER: case K.IC_LESS_EQU:
        if ((i = OptFixupBinaryOp1(cc, tmpi, tmpi1, tmpi2, uo))) {
          let r;
          if (i === FBO1_INT) {
            const a = uo.v ? U64(tmpi1.data) : sx(tmpi1.data), b = uo.v ? U64(tmpi2.data) : sx(tmpi2.data);
            r = cmpOp(code, a, b);
          } else r = cmpOp(code, b2f(tmpi1.data), b2f(tmpi2.data));
          if (code === K.IC_EQU_EQU || code === K.IC_NOT_EQU) // == compares raw bits
            r = code === K.IC_EQU_EQU ? sx(tmpi1.data) === sx(tmpi2.data) : sx(tmpi1.data) !== sx(tmpi2.data);
          tmpi.data = r ? 1n : 0n;
          tmpi.code = K.IC_IMM_I64;
        } else {
          if (uo.v && code !== K.IC_EQU_EQU && code !== K.IC_NOT_EQU) tmpi.flags |= K.ICF_USE_UNSIGNED;
          if (tmpi.cls.raw_type === K.RT_F64) tmpi.flags |= K.ICF_USE_F64;
        }
        groupEnd = 3;
        break;
      case K.IC_MUL_EQU: case K.IC_DIV_EQU: case K.IC_MOD_EQU: case K.IC_ADD_EQU: case K.IC_SUB_EQU:
        if (cc.pass === 2 && (!tmpc.size || !tmpc2.size)) LexWarn(cc, 'Assign U0 ');
        if (code === K.IC_MUL_EQU) {
          if (tmpi2.code === K.IC_IMM_I64 && tmpc.raw_type !== K.RT_F64 && tmpc2.raw_type !== K.RT_F64) {
            if ((i = tmpi2.data) && isPow2(i)) { tmpi2.data = BigInt(bsf(i)); tmpi.code = K.IC_SHL_EQU; }
          }
        } else if (code === K.IC_DIV_EQU) {
          if (tmpi2.code === K.IC_IMM_I64 && tmpc.raw_type !== K.RT_F64 && tmpc2.raw_type !== K.RT_F64 &&
            (i = tmpi2.data) && isPow2(i)) { tmpi2.data = BigInt(bsf(i)); tmpi.code = K.IC_SHR_EQU; }
        } else if (code === K.IC_MOD_EQU) {
          if (tmpi2.code === K.IC_IMM_I64 && tmpc.raw_type !== K.RT_F64 && tmpc2.raw_type !== K.RT_F64 &&
            (i = tmpi2.data) && isPow2(i)) { tmpi2.data = i - 1n; tmpi.code = K.IC_AND_EQU; }
        }
        if (tmpi2.cls.raw_type === K.RT_F64) tmpi.flags |= K.ICF_USE_F64;
        if (tmpc.raw_type === K.RT_F64 && tmpc2.raw_type !== K.RT_F64) tmpi2.flags |= K.ICF_RES_TO_F64;
        break;
      case K.IC_ASSIGN:
        if (cc.pass === 2 && (!tmpc.size || !tmpc2.size)) LexWarn(cc, 'Assign U0 ');
        if (tmpc.raw_type === K.RT_F64) { if (tmpc2.raw_type !== K.RT_F64) tmpi2.flags |= K.ICF_RES_TO_F64; }
        else if (tmpc2.raw_type === K.RT_F64) tmpi2.flags |= K.ICF_RES_TO_INT;
        if (cc.pass === 2 && tmpi1.cls.raw_type !== K.RT_F64) {
          if (tmpi1.code === K.IC__PP) {
            tmpi.code = K.IC_ASSIGN_PP; tmpi.flags |= tmpi1.flags; tmpi.t.class2 = tmpi1.cls; OptSetNOP1(tmpi1);
          } else if (tmpi1.code === K.IC__MM) {
            tmpi.code = K.IC_ASSIGN_MM; tmpi.flags |= tmpi1.flags; tmpi.t.class2 = tmpi1.cls; OptSetNOP1(tmpi1);
          }
        }
        break;
      case K.IC_SHL_EQU: case K.IC_SHR_EQU: case K.IC_AND_EQU: case K.IC_OR_EQU: case K.IC_XOR_EQU:
        if (cc.pass === 2 && (!tmpc.size || !tmpc2.size)) LexWarn(cc, 'Assign U0 ');
        if (tmpc2.raw_type === K.RT_F64) tmpi2.flags |= K.ICF_RES_TO_INT;
        break;
      case K.IC_ENTER: case K.IC_LEAVE:
        tmpi.data = BigInt(-cc.htc.fun.size);
        break;
      case K.IC_ADD_RSP:
        if ((tmpi1 = OptLag(tmpi)) && tmpi1.code === K.IC_ADD_RSP) {
          tmpi.data += tmpi1.data;
          tmpi.flags |= tmpi1.flags;
          OptSetNOP1(tmpi1);
        }
        break;
      case K.IC_ADD_RSP1: break;
      case K.IC_BSF: case K.IC_BSR:
        if (tmpi1.code === K.IC_IMM_I64) {
          tmpi1.data = BigInt(code === K.IC_BSF ? bsf(tmpi1.data) : bsr(tmpi1.data));
          tmpi_push = tmpi1;
          OptSetNOP1(OptLag(tmpi1));
          tmpi2 = OptLead1(tmpi);
          tmpi1.flags |= tmpi.flags | tmpi2.flags;
          OptSetNOP1(tmpi2);
          OptSetNOP1(tmpi);
        }
        break;
      case K.IC_LBTS: case K.IC_LBTR: case K.IC_LBTC:
        tmpi.flags |= K.ICF_LOCK;
        break;
      case K.IC_TO_I64: case K.IC_TO_F64: case K.IC_TO_BOOL:
        toConv(cc, code, tmpi, tmpi1, (p) => { tmpi_push = p; });
        break;
      case K.IC_BR_ZERO: tmpi_push = OptBrZero(cc, tmpi); break;
      case K.IC_BR_NOT_ZERO: tmpi_push = OptBrNotZero(cc, tmpi); break;
      case K.IC_NOP1:
        if (tmpi.flags & K.ICF_PUSH_RES) {
          tmpi1 = tmpi;
          do tmpi1 = tmpi1.last; while (tmpi1.code === K.IC_NOP1);
          tmpi1.flags |= K.ICF_PUSH_RES;
          tmpi.flags &= ~K.ICF_PUSH_RES;
        }
        break;
      case K.IC_NOP2:
        ps.ptr += Number(tmpi.data) << 1;
        break;
      case K.IC_LABEL: {
        const lb = OptLabelFwd(tmpi.data);
        let lb1 = tmpi.data, lb2;
        while ((lb2 = lb1.fwd)) { lb1.fwd = lb; lb1 = lb2; }
        if ((tmpi1 = OptLag(tmpi))) {
          if (tmpi1.code === K.IC_JMP) {
            if (OptLabelFwd(tmpi1.data) === lb) { tmpi.flags |= tmpi1.flags; OptSetNOP1(tmpi1); }
          } else if (tmpi1.code === K.IC_LABEL) {
            lb1 = tmpi1.data;
            if (!lb1.fwd && lb1 !== lb) lb1.fwd = lb;
            if ((tmpi1 = OptLag(tmpi1)) && tmpi1.code === K.IC_JMP) {
              if (OptLabelFwd(tmpi1.data) === lb) { tmpi.flags |= tmpi1.flags; OptSetNOP1(tmpi1); }
            }
          }
        }
        break;
      }
      case K.IC_JMP:
        if ((tmpi1 = OptLag(tmpi)) && tmpi1.code === K.IC_LABEL) {
          const lb = OptLabelFwd(tmpi.data), lb1 = OptLabelFwd(tmpi1.data);
          if (lb !== lb1) lb1.fwd = lb;
        }
        break;
      default:
        if (!passThrough.has(code) && code < K.IC_ICS_NUM) {
          LexExcept(cc, `Compiler Optimization Error (pass ${cc.pass}, IC ${intermediate_code_table[code].name}) at `);
        }
    }
    if (groupEnd === 1) {
      if (!tmpi_push.cls.ptr_stars_cnt)
        tmpi_push.cls2 = tmpi_push.cls.raw_type === K.RT_F64 ? RT(cc, K.RT_F64) : RT(cc, K.RT_I64);
    } else if (groupEnd === 2) {
      if (!tmpi_push.cls.ptr_stars_cnt) {
        if (tmpi_push.cls.raw_type === K.RT_F64) tmpi_push.cls2 = RT(cc, K.RT_F64);
        else if (uo.v) tmpi_push.cls2 = RT(cc, K.RT_U64);
        else tmpi_push.cls2 = RT(cc, K.RT_I64);
      }
    } else if (groupEnd === 3) {
      tmpi.flags &= ~K.ICF_RES_TO_INT;
      if (!tmpi_push.cls.ptr_stars_cnt) {
        if (tmpi_push.cls.raw_type === K.RT_F64) tmpi_push.cls2 = RT(cc, K.RT_F64);
        else if (uo.v) tmpi_push.cls2 = RT(cc, K.RT_U64);
        else tmpi_push.cls2 = RT(cc, K.RT_I64);
      }
      if (tmpi_push.flags & K.ICF_PUSH_CMP) tmpi.cls = tmpi.cls2;
      else tmpi.cls = RT(cc, K.RT_I64);
    }
    uo.v = groupEnd ? uo.v : uo.v;
    if (ent.arg_cnt === K.IS_2_ARG && tmpi1 && tmpi2) {
      if (((tmpi_push.prec & ~K.ASSOC_MASK) === K.PREC_ASSIGN))
        OptFixSizeOf(cc, tmpi2, tmpi_push, csub(tmpi1.cls));
      else {
        OptFixSizeOf(cc, tmpi1, tmpi_push, tmpi2.cls);
        OptFixSizeOf(cc, tmpi2, tmpi_push, tmpi1.cls);
      }
    }
    if (intermediate_code_table[tmpi_push.code] && intermediate_code_table[tmpi_push.code].res_cnt) {
      push(tmpi.cls2);
      push(tmpi_push);
    }
    if (tmpi.cls) {
      if (tmpi.cls.raw_type === K.RT_F64) tmpi.flags &= ~K.ICF_RES_TO_F64;
      else tmpi.flags &= ~K.ICF_RES_TO_INT;
      if (code > K.IC_END_EXP) last_with_class = tmpi;
    }
    uo.v = false;
    tmpi = tmpi.next;
  }
  if (ps.ptr > 2) LexExcept(cc, `Compiler Optimization Error (pass ${cc.pass} stk ${ps.ptr}) at `);
  return last_with_class;
}

function cmpOp(code, a, b) {
  switch (code) {
    case K.IC_LESS: return a < b;
    case K.IC_GREATER_EQU: return a >= b;
    case K.IC_GREATER: return a > b;
    case K.IC_LESS_EQU: return a <= b;
  }
  return false;
}

function addFold(cc, tmpi, tmpi1, tmpi2, setPush) {
  if (tmpi1.code === K.IC_ABS_ADDR && tmpi2.code === K.IC_IMM_I64) {
    tmpi.flags |= tmpi1.flags | tmpi2.flags;
    tmpi.data = tmpi1.data + tmpi2.data;
    tmpi.code = K.IC_ABS_ADDR;
    OptSetNOP1(tmpi1); OptSetNOP1(tmpi2);
    return;
  }
  if (cc.pass !== 2) return;
  const fold = (imm, other, isF) => {
    // imm is the constant operand; other is the non-constant operand
    if (sx(imm.data) === 0n) {
      other.flags |= imm.flags | tmpi.flags; other.cls2 = tmpi.cls2; setPush(other);
      OptSetNOP1(imm); OptSetNOP1(tmpi);
      return true;
    }
    if (other.code === K.IC_ADD || other.code === K.IC_SUB) {
      const c = isF ? K.IC_IMM_F64 : K.IC_IMM_I64;
      if (other.t.arg1_tree.code === c) {
        other.flags |= tmpi.flags;
        other.t.arg1_tree.data = isF ? f2b(b2f(other.t.arg1_tree.data) + b2f(imm.data)) : sx(other.t.arg1_tree.data + imm.data);
        other.cls2 = tmpi.cls2; setPush(other); OptSetNOP1(imm); OptSetNOP1(tmpi);
        return true;
      } else if (other.t.arg2_tree.code === c) {
        other.flags |= tmpi.flags;
        const a = other.t.arg2_tree;
        if (other.code === K.IC_ADD) a.data = isF ? f2b(b2f(a.data) + b2f(imm.data)) : sx(a.data + imm.data);
        else a.data = isF ? f2b(b2f(a.data) - b2f(imm.data)) : sx(a.data - imm.data);
        other.cls2 = tmpi.cls2; setPush(other); OptSetNOP1(imm); OptSetNOP1(tmpi);
        return true;
      }
    }
    return false;
  };
  if (tmpi1.code === K.IC_IMM_I64) fold(tmpi1, tmpi2, false);
  else if (tmpi2.code === K.IC_IMM_I64) fold(tmpi2, tmpi1, false);
  else if (tmpi1.code === K.IC_IMM_F64) fold(tmpi1, tmpi2, true);
  else if (tmpi2.code === K.IC_IMM_F64) fold(tmpi2, tmpi1, true);
}

function subFold(cc, tmpi, tmpi1, tmpi2, setPush) {
  if (cc.pass !== 2) return;
  const isF = tmpi2.code === K.IC_IMM_F64;
  if (tmpi2.code !== K.IC_IMM_I64 && !isF) return;
  if (sx(tmpi2.data) === 0n) {
    tmpi1.flags |= tmpi2.flags | tmpi.flags; tmpi1.cls2 = tmpi.cls2; setPush(tmpi1);
    OptSetNOP1(tmpi2); OptSetNOP1(tmpi);
    return;
  }
  if (tmpi1.code === K.IC_ADD || tmpi1.code === K.IC_SUB) {
    const c = isF ? K.IC_IMM_F64 : K.IC_IMM_I64;
    const sub = (a, b) => (isF ? f2b(b2f(a) - b2f(b)) : sx(a - b));
    const add = (a, b) => (isF ? f2b(b2f(a) + b2f(b)) : sx(a + b));
    if (tmpi1.t.arg1_tree.code === c) {
      tmpi1.flags |= tmpi.flags | (isF ? tmpi2.flags : 0);
      tmpi1.t.arg1_tree.data = sub(tmpi1.t.arg1_tree.data, tmpi2.data);
      tmpi1.cls2 = tmpi.cls2; setPush(tmpi1); OptSetNOP1(tmpi2); OptSetNOP1(tmpi);
    } else if (tmpi1.t.arg2_tree.code === c) {
      tmpi1.flags |= tmpi.flags | (isF ? tmpi2.flags : 0);
      const a = tmpi1.t.arg2_tree;
      a.data = tmpi1.code === K.IC_ADD ? sub(a.data, tmpi2.data) : add(a.data, tmpi2.data);
      tmpi1.cls2 = tmpi.cls2; setPush(tmpi1); OptSetNOP1(tmpi2); OptSetNOP1(tmpi);
    }
  }
}

function nopCallStart(t) {
  let i = 0, t2 = t.last;
  for (;;) {
    if (t2.code === K.IC_CALL_START) { if (!i) break; i--; }
    else if (t2.code === K.IC_CALL_END) i++;
    t2 = t2.last;
  }
  OptSetNOP1(t2);
}
function toConv(cc, code, tmpi, tmpi1, setPush) {
  const RTI = RT(cc, K.RT_I64), RTF = RT(cc, K.RT_F64);
  const fold = (resCode, val, cls, clrFlag) => {
    OptSetNOP1(findBack(tmpi1.last, K.IC_CALL_START));
    const ce = findFwd(tmpi.next, K.IC_CALL_END);
    tmpi.flags |= (tmpi1.flags & ~clrFlag) | ce.flags;
    OptSetNOP1(ce);
    tmpi.code = resCode; tmpi.data = val; tmpi.cls = cls; tmpi.cls2 = cls;
    OptSetNOP1(tmpi1);
  };
  if (code === K.IC_TO_I64) {
    if (tmpi1.code === K.IC_IMM_F64) fold(K.IC_IMM_I64, f2i(b2f(tmpi1.data)), RTI, K.ICF_RES_TO_INT);
    else if (tmpi1.code === K.IC_IMM_I64) fold(K.IC_IMM_I64, tmpi1.data, RTI, K.ICF_RES_TO_F64);
    if (tmpi1.flags & K.ICF_RES_TO_F64) {
      nopCallStart(tmpi1);
      const ce = findFwd(tmpi1.next, K.IC_CALL_END);
      tmpi1.flags = tmpi.flags | (tmpi1.flags & ~(K.ICF_RES_TO_F64 | K.ICF_PUSH_RES)) | ce.flags;
      OptSetNOP1(ce);
      tmpi1.cls = RTI; tmpi1.cls2 = RTI;
      setPush(tmpi1);
      OptSetNOP1(tmpi);
    }
  } else if (code === K.IC_TO_F64) {
    if (tmpi1.code === K.IC_IMM_I64) fold(K.IC_IMM_F64, f2b(Number(I64(tmpi1.data))), RTF, K.ICF_RES_TO_F64);
    else if (tmpi1.code === K.IC_IMM_F64) fold(K.IC_IMM_F64, tmpi1.data, RTF, K.ICF_RES_TO_INT);
    if (tmpi1.flags & K.ICF_RES_TO_INT) {
      nopCallStart(tmpi1);
      const ce = findFwd(tmpi1.next, K.IC_CALL_END);
      tmpi1.flags = tmpi.flags | (tmpi1.flags & ~(K.ICF_RES_TO_INT | K.ICF_PUSH_RES)) | ce.flags;
      OptSetNOP1(ce);
      tmpi1.cls = RTF; tmpi1.cls2 = RTF;
      setPush(tmpi1);
      OptSetNOP1(tmpi);
    }
  } else { // TO_BOOL
    if (tmpi1.code === K.IC_IMM_I64 || tmpi1.code === K.IC_IMM_F64)
      fold(K.IC_IMM_I64, tmpi1.data ? 1n : 0n, RTI, K.ICF_RES_TO_F64);
  }
}

const passThrough = new Set([
  K.IC_STR_CONST, K.IC_RBP, K.IC_MOV_FS, K.IC_MOV_GS, K.IC_RIP, K.IC_SIZEOF, K.IC_SQR, K.IC_ABS, K.IC_SQRT,
  K.IC_SIN, K.IC_COS, K.IC_TAN, K.IC_ATAN, K.IC_BR_CARRY, K.IC_BR_NOT_CARRY, K.IC_BR_OR_OR_NOT_ZERO,
  K.IC_BR_OR_OR_ZERO, K.IC_BR_AND_AND_NOT_ZERO, K.IC_BR_AND_AND_ZERO, K.IC_BR_AND_NOT_ZERO, K.IC_BR_AND_ZERO,
  K.IC_BR_MM_NOT_ZERO, K.IC_BR_MM_ZERO, K.IC_BR_BT, K.IC_BR_BTS, K.IC_BR_BTR, K.IC_BR_BTC, K.IC_BR_NOT_BT,
  K.IC_BR_NOT_BTS, K.IC_BR_NOT_BTR, K.IC_BR_NOT_BTC, K.IC_END, K.IC_ADDR, K.IC_RET, K.IC_END_EXP,
  K.IC_CALL_START, K.IC_CALL_END, K.IC_CALL_END2, K.IC_PUSH_REGS, K.IC_POP_REGS, K.IC_SUB_CALL, K.IC_CALL,
  K.IC_CALL_INDIRECT, K.IC_CALL_INDIRECT2, K.IC_CALL_EXTERN, K.IC_CALL_IMPORT, K.IC_PUSH, K.IC_POP,
  K.IC_INVLPG, K.IC_CLFLUSH, K.IC_GET_RFLAGS, K.IC_CARRY, K.IC_GET_RBP, K.IC_GET_RSP, K.IC_GET_RAX,
  K.IC_RETURN_VAL, K.IC_RETURN_VAL2, K.IC_ABS_ADDR, K.IC_HEAP_GLBL, K.IC_ADDR_IMPORT, K.IC_GET_LABEL,
  K.IC_TYPE, K.IC_RDTSC, K.IC_SET_RFLAGS, K.IC_SET_RBP, K.IC_SET_RSP, K.IC_SET_RAX, K.IC_SIGN_I64,
  K.IC_TOUPPER, K.IC_ABS_I64, K.IC_MIN_I64, K.IC_MAX_I64, K.IC_MIN_U64, K.IC_MAX_U64, K.IC_MOD_U64,
  K.IC_SQR_I64, K.IC_SQR_U64, K.IC_SWAP_U8, K.IC_SWAP_U16, K.IC_SWAP_U32, K.IC_SWAP_I64, K.IC_IN_U32,
  K.IC_IN_U16, K.IC_IN_U8, K.IC_STRLEN, K.IC_BT, K.IC_BTS, K.IC_BTR, K.IC_BTC, K.IC_QUE_INIT, K.IC_QUE_REM,
  K.IC_QUE_INS, K.IC_QUE_INS_REV, K.IC_OUT_U32, K.IC_OUT_U16, K.IC_OUT_U8, K.IC_NOBOUND_SWITCH, K.IC_SWITCH,
  K.IC_ASM, K.IC_BR_EQU_EQU, K.IC_BR_NOT_EQU, K.IC_BR_LESS, K.IC_BR_GREATER_EQU, K.IC_BR_GREATER, K.IC_BR_LESS_EQU,
  K.IC_BR_EQU_EQU2, K.IC_BR_NOT_EQU2, K.IC_BR_LESS2, K.IC_BR_GREATER_EQU2, K.IC_BR_GREATER2, K.IC_BR_LESS_EQU2,
]);
