// The data part of TempleOS's assembler (PrsAsmBlk/PrsAsmDefine/AsmStoreNum
// from Asm.HC).  Port files keep the kernel's asm{} blocks for what they
// define in the image -- labels, DU8..DU64, ALIGN, DUP, strings -- and the
// code is replaced by HolyC and builtins.  An opcode is an error (or, in
// lenient mode, the rest of its line is skipped).
import * as K from './consts.js';
import { CHashExport } from './core.js';
import { Lex, LexExcept } from './lex.js';
import { LexExpression2Bin, AOTStoreCodeU8 } from './parse.js';
import { I64 } from './util.js';

// AsmLexExpression(): evaluate one expression, no fwd refs or externs.
function asmExpr(cc) {
  cc.abs_cnts = { abs_addres: 0, c_addres: 0, externs: 0 };
  const mc = LexExpression2Bin(cc);
  if (!mc) LexExcept(cc, 'Expecting expression at ');
  if (cc.abs_cnts.externs) LexExcept(cc, 'Extern Not Allowed at ');
  return I64(cc.env.Call(cc, mc));
}

function storeNum(cc, v, cnt, n) {
  const aotc = cc.aotc;
  for (let k = 0; k < n; k++) {
    if (cc.abs_cnts.abs_addres & 1)
      aotc.abss.push({ type: [0, K.AAT_ADD_U8, K.AAT_ADD_U16, 0, K.AAT_ADD_U32, 0, 0, 0, K.AAT_ADD_U64][cnt], rip: aotc.rip });
    let x = BigInt.asUintN(64, v);
    for (let i = 0; i < cnt; i++) { AOTStoreCodeU8(cc, Number(x & 255n)); x >>= 8n; }
  }
}

function prsDefine(cc, cnt) {
  while (cc.token && cc.token !== 59) {
    if (cc.token === K.TK_STR) {
      const s = cc.cur_str;
      for (let i = 0; i < cc.cur_str_len - 1; i++) AOTStoreCodeU8(cc, s.charCodeAt(i));
      Lex(cc);
    } else {
      const v = asmExpr(cc);
      const abs = cc.abs_cnts;
      if (cc.token === K.TK_IDENT && cc.hash_entry && cc.hash_entry.type & K.HTT_ASM_KEYWORD &&
          cc.hash_entry.user_data0 === K.AKW_DUP) {
        if (Lex(cc) !== 40) LexExcept(cc, "Expecting '(' at ");
        Lex(cc);
        const dup = asmExpr(cc);
        if (cc.token !== 41) LexExcept(cc, "Expecting ')' at ");
        Lex(cc);
        storeNum(cc, dup, cnt, Number(v));
      } else {
        cc.abs_cnts = abs;
        storeNum(cc, v, cnt, 1);
      }
    }
    if (cc.token === 44) Lex(cc);
  }
  if (cc.token !== 59) LexExcept(cc, "Missing ';' at");
  Lex(cc);
}

// Lenient mode: skip an instruction (the rest of its source line).
function skipLine(cc) {
  const tokLine = () => cc.lex_include_stk.line_num - (cc.last_U16 === 10 ? 1 : 0);
  const ln = tokLine();
  while (Lex(cc) && tokLine() === ln && cc.token !== 125);
}

export function PrsAsmBlk(cc, { lenient = false } = {}) {
  const aotc = cc.aotc;
  const old = cc.flags & K.CCF_ASM_EXPRESSIONS;
  cc.flags |= K.CCF_ASM_EXPRESSIONS;
  if (cc.token !== 123) LexExcept(cc, "Expecting '{' at ");
  Lex(cc);
  while (cc.token && cc.token !== 125) {
    const h = cc.token === K.TK_IDENT ? cc.hash_entry : null;
    if (h && h.type & K.HTT_ASM_KEYWORD) {
      const kw = h.user_data0;
      Lex(cc);
      switch (kw) {
        case K.AKW_ALIGN: {
          if (cc.htc.local_var_lst) LexExcept(cc, 'ALIGN not allowed in fun asm blk ');
          const i = Number(asmExpr(cc));
          if (!i || (i & (i - 1))) LexExcept(cc, 'ALIGN must be power of two at ');
          const j = 31 - Math.clz32(i);
          if (j > aotc.max_align_bits) aotc.max_align_bits = j;
          const end = Math.ceil(aotc.rip / i) * i;
          if (cc.token !== 44) LexExcept(cc, "Expecting ',' at ");
          Lex(cc);
          const fill = Number(asmExpr(cc) & 255n);
          while (aotc.rip < end) AOTStoreCodeU8(cc, fill);
          break;
        }
        case K.AKW_DU8: prsDefine(cc, 1); break;
        case K.AKW_DU16: prsDefine(cc, 2); break;
        case K.AKW_DU32: prsDefine(cc, 4); break;
        case K.AKW_DU64: prsDefine(cc, 8); break;
        case K.AKW_USE16: case K.AKW_USE32: case K.AKW_USE64: case K.AKW_LIST: case K.AKW_NOLIST: break;
        case K.AKW_IMPORT:
          while (cc.token && cc.token !== 59) {
            if (cc.token !== K.TK_IDENT) LexExcept(cc, 'Expecting identifier at ');
            const ex = new CHashExport(cc.cur_str, K.HTT_EXPORT_SYS_SYM | K.HTF_UNRESOLVED | K.HTF_IMPORT);
            cc.htc.glbl_hash_table.add(ex);
            if (Lex(cc) === 44) Lex(cc);
          }
          if (cc.token !== 59) LexExcept(cc, "Missing ';' at");
          Lex(cc);
          break;
        default: LexExcept(cc, 'asm keyword not supported in the data-only assembler: ');
      }
    } else if (h && h.type & K.HTT_OPCODE) {
      if (!lenient) LexExcept(cc, `asm instruction ${cc.cur_str} must be replaced by port/ files: `);
      skipLine(cc);
    } else if (h && h.type & K.HTT_EXPORT_SYS_SYM && h.type & K.HTF_UNRESOLVED) {
      if (h.type & K.HTF_IMPORT) LexExcept(cc, 'attempt to define import at ');
      h.type &= ~K.HTF_UNRESOLVED;
      h.val = BigInt(aotc.rip);
      Lex(cc);
      if (cc.token !== 58 && cc.token !== K.TK_DBL_COLON) LexExcept(cc, "Expecting ':' at ");
      if (cc.token === K.TK_DBL_COLON) h.type |= K.HTF_EXPORT;
      Lex(cc);
    } else if (cc.token === K.TK_IDENT && !(h && h.type & K.HTT_EXPORT_SYS_SYM && h.table === cc.htc.glbl_hash_table)) {
      const ex = new CHashExport(cc.cur_str, K.HTT_EXPORT_SYS_SYM);
      ex.val = BigInt(aotc.rip);
      Lex(cc);
      if (cc.token !== 58 && cc.token !== K.TK_DBL_COLON) {
        if (lenient) { continue; }
        LexExcept(cc, "Expecting ':' at ");
      }
      if (ex.str.startsWith('@@')) {
        if (cc.token === K.TK_DBL_COLON) LexExcept(cc, 'No local glbl exports at ');
        cc.htc.local_hash_table.add(ex);
      } else cc.htc.glbl_hash_table.add(ex);
      if (cc.token === K.TK_DBL_COLON) ex.type |= K.HTF_EXPORT;
      Lex(cc);
    } else if (cc.token === K.TK_IDENT) {
      if (BigInt(h.val) !== BigInt(aotc.rip)) LexExcept(cc, 'Redefinition at ');
      Lex(cc);
      if (cc.token !== 58 && cc.token !== K.TK_DBL_COLON) LexExcept(cc, "Expecting ':' at ");
      Lex(cc);
    } else if (cc.token === 59) Lex(cc);
    else if (lenient) Lex(cc);
    else LexExcept(cc, 'Syntax error at ');
  }
  cc.flags = (cc.flags & ~K.CCF_ASM_EXPRESSIONS) | old;
  Lex(cc); // past '}' (the caller's PrsStmt expects that)
}
