// Port of TempleOS Compiler/Lex.HC + LexLib.HC (raw-text lexing path).
// The bootstrap compiler only lexes plain source buffers; DolDoc command
// entries ($LK...$ etc.) are skipped exactly as Lex() does for raw text.
import * as K from './consts.js';
import { CompileError, HashFind, CHashDefineStr, CMemberLst, MemberFind } from './core.js';
import { I64, U64, b2f, f2b } from './util.js';
import { docParse, dollarRender, DE_TEXT, DE_NEW_LINE, DE_TAB } from './doldoc.js';

export const isAlnum = (c, cc) => {
  if (c >= 128) return c < 256;
  if (c >= 48 && c <= 57) return true;
  if (c >= 65 && c <= 90) return true;
  if (c >= 97 && c <= 122) return true;
  if (c === 95) return true;
  if (c === 64) return !(cc && (cc.flags & K.CCF_KEEP_AT_SIGN));
  return false;
};
const isDec = (c) => c >= 48 && c <= 57;
const isHex = (c) => isDec(c) || (c >= 65 && c <= 70);
export const isNonEol = (c) => c !== 0 && c !== 10 && c !== 13;
const isNonEolWhite = (c) => c === 9 || c === 32 || c === 0x1F;
const toUpper = (c) => (c >= 97 && c <= 122 ? c - 32 : c);
const CH_CURSOR = 5, CH_SHIFT_SPACE = 0x1F;

export class CLexFile {
  constructor() {
    this.next = null; this.buf = ''; this.buf_ptr = 0; this.line_num = 1; this.flags = 0;
    this.full_name = ''; this.line_start = 0; this.depth = -1; this.last_U16 = 0;
    this.doc = null; this.cur_entry = -1;
  }
  clone() { const c = new CLexFile(); Object.assign(c, this); return c; }
}

export class CCmpCtrl {
  constructor(env, buf, flags, filename) {
    this.env = env; this.cmp = env.cmp;
    this.token = 0; this.flags = BigInt(flags || 0); this.cur_i64 = 0n; this.cur_f64 = 0;
    this.cur_str = null; this.cur_str_len = 0; this.class_dol_offset = 0;
    this.dollar_cnt = 0; this.dollar_buf = ''; this.cur_help_idx = '';
    this.last_U16 = 0; this.min_line = 0; this.max_line = 0; this.last_line_num = 0; this.lock_cnt = 0;
    this.htc = { next: null, old_flags: 0n, hash_mask: K.HTG_TYPE_MASK - K.HTT_IMPORT_SYS_SYM,
      local_var_lst: null, fun: null, hash_table_lst: env.hash_table, define_hash_table: env.hash_table,
      local_hash_table: env.hash_table, glbl_hash_table: env.hash_table };
    this.hash_entry = null; this.local_var_entry = null; this.lb_leave = null;
    this.cur_buf_ptr = 0;
    this.lex_include_stk = null; this.lex_prs_stk = null; this.fun_lex_file = null;
    this.stream_blks = [];
    this.pass = 0; this.opts = (1n << BigInt(K.OPTf_WARN_UNUSED_VAR)) | (1n << BigInt(K.OPTf_WARN_HEADER_MISMATCH));
    this.error_cnt = 0; this.warning_cnt = 0;
    this.coc = { coc_next: null, coc_head: null, misc: [] };
    this.ps = null; this.aot_depth = 0; this.pmt_line = 0;
    this.abs_cnts = { abs_addres: 0, c_addres: 0, externs: 0 };
    const f = LexFilePush(this);
    f.full_name = filename || 'Tmp';
    f.buf = buf || ''; f.buf_ptr = 0; f.line_start = 0; f.line_num = 1;
    this.cur_buf_ptr = 0;
  }
}

export function LexFilePush(cc) {
  const res = new CLexFile();
  if ((res.next = cc.lex_include_stk)) res.depth = res.next.depth + 1;
  else res.depth = -1;
  return (cc.lex_include_stk = res);
}
export function LexFilePop(cc) {
  const f = cc.lex_include_stk;
  if (f) cc.lex_include_stk = f.next;
  return cc.lex_include_stk;
}

export function LexExcept(cc, str = '') {
  let where = '';
  for (let f = cc.lex_include_stk; f; f = f.next) {
    if (where) where += ' <- ';
    where += `${f.full_name}:${f.line_num}`;
    if (f.flags & K.LFSF_DEFINE) where += ` [define ${JSON.stringify(f.buf.slice(0, 60))}]`;
  }
  where += ` (token ${cc.token}${cc.cur_str ? ' ' + JSON.stringify(String(cc.cur_str).slice(0, 40)) : ''})`;
  cc.error_cnt++;
  throw new CompileError((str || 'Compiler error').trim(), where);
}
export function LexWarn(cc, str = '') {
  const f = cc.lex_include_stk;
  cc.warning_cnt++;
  if (cc.env.warn) cc.env.warn(`${(str || 'Warning').trim()} ${f ? f.full_name + ':' + f.line_num : ''}`);
}

// LexDollar(): a doc cmd inside a string literal is lexed as its "$..$" text.
function LexDollar(cc, e) {
  if (cc.flags & K.CCF_IN_QUOTES) {
    cc.dollar_buf = dollarRender(e.cmd || '');
    cc.dollar_cnt = 2;
    return true;
  }
  return false;
}

export function LexGetChar(cc) {
  if (cc.flags & K.CCF_USE_LAST_U16) {
    cc.flags &= ~K.CCF_USE_LAST_U16;
    return cc.last_U16;
  }
  lgc_start1: for (;;) {
    let f = cc.lex_include_stk;
    if (LEX_TRACE && ++lexCnt % (LEX_TRACE * 10) === 0)
      process.stderr.write(`[getc ${lexCnt}] ${f.full_name}:${f.line_num} doc=${!!(f.flags & K.LFSF_DOC)} ent=${f.cur_entry} p=${cc.cur_buf_ptr}/${f.buf.length}
`);
    const p = cc.cur_buf_ptr++;
    const ch = p < f.buf.length ? f.buf.charCodeAt(p) : 0;
    cc.last_U16 = ch;
    if (ch === 0) {
      // lgc_here:
      if (f.flags & K.LFSF_DOC) {
        const doc = f.doc;
        let i = f.cur_entry + 1;
        for (; i < doc.length; i++) {
          const e = doc[i];
          f.cur_entry = i;
          if (e.type === DE_TEXT) {
            if (e.tag.length) { f.buf = e.tag; f.buf_ptr = cc.cur_buf_ptr = 0; break; }
          } else if (e.type === DE_NEW_LINE) {
            f.buf = ''; f.buf_ptr = cc.cur_buf_ptr = 0;
            f.line_start = i + 1;
            f.line_num = e.y + 2;
            cc.cmp.compiled_lines++;
            cc.last_U16 = 10;
            return 10;
          } else if (e.type === DE_TAB) {
            f.buf = ''; f.buf_ptr = cc.cur_buf_ptr = 0;
            f.line_num = e.y + 1;
            cc.last_U16 = 9;
            return 9;
          } else if (LexDollar(cc, e) && cc.dollar_buf.length) {
            f.line_num = e.y + 1;
            f.buf = cc.dollar_buf; f.buf_ptr = cc.cur_buf_ptr = 0;
            break;
          }
        }
        if (i < doc.length) continue lgc_start1;
        f.cur_entry = doc.length - 1; // When take next, will still be end.
      }
      f = cc.lex_include_stk;
      if (f.next) {
        const t = LexFilePop(cc);
        cc.cur_buf_ptr = t.buf_ptr;
        cc.flags &= ~K.CCF_USE_LAST_U16;
        if (!(cc.last_U16 = t.last_U16)) continue lgc_start1;
      } else {
        if (cc.flags & K.CCF_PMT && cc.env.prompt) {
          const s = cc.env.prompt(cc);
          if (s) { f.buf = s; f.buf_ptr = f.line_start = cc.cur_buf_ptr = 0; continue lgc_start1; }
        }
        cc.cur_buf_ptr = p;
        cc.last_U16 = K.TK_EOF;
      }
    } else if (ch === CH_CURSOR) {
      continue lgc_start1;
    } else if (ch === 10) {
      if (!(f.flags & K.LFSF_DOC)) {
        f.line_num++;
        cc.cmp.compiled_lines++;
        f.line_start = cc.cur_buf_ptr;
      }
    }
    break;
  }
  if (cc.last_U16 === CH_SHIFT_SPACE) cc.last_U16 = 32;
  return cc.last_U16;
}

// LexAttachDoc(): start lexing a DolDoc source file.
export function LexAttachDoc(cc, abs_filename, src) {
  const doc = docParse(src);
  LexBackupLastChar(cc);
  const f = LexFilePush(cc);
  f.full_name = abs_filename;
  f.doc = doc;
  let i = 0;
  while (i < doc.length && doc[i].type !== DE_TEXT && doc[i].type !== DE_TAB) i++;
  if (i < doc.length) {
    f.line_start = i;
    f.line_num = doc[i].y + 1;
    if (doc[i].type === DE_TEXT) { f.cur_entry = i; f.buf = doc[i].tag; }
    else { f.cur_entry = i - 1; f.buf = ''; }
    f.flags = K.LFSF_DOC;
  } else {
    f.buf = ''; f.line_start = 0; f.line_num = 1; f.flags = 0;
  }
  f.buf_ptr = cc.cur_buf_ptr = 0;
  f.last_U16 = 0;
}

export function LexSkipEol(cc) {
  let ch;
  do ch = LexGetChar(cc); while (isNonEol(ch));
}

export function LexBackupLastChar(cc) {
  const f = cc.lex_include_stk;
  f.buf_ptr = cc.cur_buf_ptr;
  if (cc.flags & K.CCF_USE_LAST_U16) {
    f.last_U16 = cc.last_U16;
    cc.flags &= ~K.CCF_USE_LAST_U16;
  } else f.last_U16 = 0;
}

export function LexIncludeStr(cc, abs_filename, src, actual_file) {
  LexBackupLastChar(cc);
  const f = LexFilePush(cc);
  f.full_name = actual_file ? abs_filename : 'Tmp';
  f.line_num = 1;
  f.buf = src; f.buf_ptr = 0; f.line_start = 0;
  cc.cur_buf_ptr = 0;
}

export function LexPush(cc) {
  LexBackupLastChar(cc);
  if (cc.lex_include_stk.last_U16) cc.flags |= K.CCF_USE_LAST_U16;
  const t = cc.lex_include_stk.clone();
  t.saved_for = cc.lex_include_stk;
  t.nextPrs = cc.lex_prs_stk;
  cc.lex_prs_stk = t;
}
export function LexPopRestore(cc) {
  const t = cc.lex_prs_stk;
  cc.cur_buf_ptr = t.buf_ptr;
  if ((cc.last_U16 = t.last_U16)) cc.flags |= K.CCF_USE_LAST_U16;
  else cc.flags &= ~K.CCF_USE_LAST_U16;
  const f = cc.lex_include_stk;
  // MemCpy everything but ->next
  for (const k of ['buf', 'buf_ptr', 'line_num', 'flags', 'full_name', 'line_start', 'depth', 'last_U16', 'doc', 'cur_entry'])
    f[k] = t[k];
  cc.lex_prs_stk = t.nextPrs;
}
export function LexPopNoRestore(cc) {
  cc.lex_prs_stk = cc.lex_prs_stk.nextPrs;
}

function LexInStr(cc, out) {
  // Appends chars of a "..." string to out (array of char codes).
  for (;;) {
    let ch = LexGetChar(cc);
    if (!ch || ch === 34) { out.push(0); return; }
    if (ch === 92) {
      switch ((ch = LexGetChar(cc))) {
        case 48: out.push(0); break; // \0
        case 39: out.push(39); break;
        case 96: out.push(96); break;
        case 92: out.push(92); break;
        case 34: out.push(34); break;
        case 100: out.push(36); break; // \d -> $
        case 110: out.push(10); break;
        case 114: out.push(13); break;
        case 116: out.push(9); break;
        case 120: case 88: {
          let j = 0;
          for (let k = 0; k < 2; k++) {
            ch = toUpper(LexGetChar(cc));
            if (isHex(ch)) j = (j << 4) + (ch <= 57 ? ch - 48 : ch - 65 + 10);
            else { cc.flags |= K.CCF_USE_LAST_U16; break; }
          }
          out.push(j & 255);
          break;
        }
        default:
          cc.flags |= K.CCF_USE_LAST_U16;
          out.push(92);
      }
    } else if (ch === 36) {
      out.push(36);
      if (cc.dollar_cnt) cc.dollar_cnt--;
      else if (LexGetChar(cc) !== 36) {
        cc.dollar_cnt = 1;
        cc.flags |= K.CCF_USE_LAST_U16;
      }
    } else out.push(ch);
  }
}

function pow10(n) { return Math.pow(10, n); }

// The binary-operator and dual-char token tables from CInit.HC.
const dual1 = {}, dual2 = {}, dual3 = {};
dual1[33] = [61, K.TK_NOT_EQU];          // !=
dual1[38] = [38, K.TK_AND_AND];          // &&
dual1[42] = [61, K.TK_MUL_EQU];          // *=
dual1[43] = [43, K.TK_PLUS_PLUS];        // ++
dual1[45] = [62, K.TK_DEREFERENCE];      // ->
dual1[47] = [42, 0];                     // /*
dual1[58] = [58, K.TK_DBL_COLON];        // ::
dual1[60] = [61, K.TK_LESS_EQU];         // <=
dual1[61] = [61, K.TK_EQU_EQU];          // ==
dual1[62] = [61, K.TK_GREATER_EQU];      // >=
dual1[94] = [61, K.TK_XOR_EQU];          // ^=
dual1[124] = [124, K.TK_OR_OR];          // ||
dual1[37] = [61, K.TK_MOD_EQU];          // %=
dual2[38] = [61, K.TK_AND_EQU];
dual2[43] = [61, K.TK_ADD_EQU];
dual2[45] = [45, K.TK_MINUS_MINUS];
dual2[47] = [47, 0];                     // //
dual2[60] = [60, K.TK_SHL];
dual2[62] = [62, K.TK_SHR];
dual2[94] = [94, K.TK_XOR_XOR];
dual2[124] = [61, K.TK_OR_EQU];
dual3[45] = [61, K.TK_SUB_EQU];
dual3[47] = [61, K.TK_DIV_EQU];

export function PrsKeyWord(cc) {
  const h = cc.hash_entry;
  if (cc.token === K.TK_IDENT && h && (h.type & K.HTT_KEYWORD)) return h.user_data0;
  return -1;
}

function skipIfBlock(cc, j, stopAtElse) {
  // Skips chars until matching #endif (or #else when stopAtElse && depth 1).
  // Returns false at EOF.
  do {
    const ch = LexGetChar(cc);
    if (!ch) { cc.token = K.TK_EOF; return false; }
    if (ch === 35) { // '#'
      if (!Lex(cc)) return false;
      const i = PrsKeyWord(cc);
      if (i === K.KW_IF || i === K.KW_IFDEF || i === K.KW_IFNDEF || i === K.KW_IFAOT || i === K.KW_IFJIT) j++;
      else if (i === K.KW_ENDIF) j--;
      else if (stopAtElse && i === K.KW_ELSE && j === 1) break;
    }
  } while (j);
  return true;
}

const LEX_TRACE = typeof process !== 'undefined' && process.env && process.env.HCC_TRACE ? Number(process.env.HCC_TRACE) : 0;
let lexCnt = 0;
export function Lex(cc) {
  cc.last_line_num = cc.lex_include_stk.line_num;
  if (LEX_TRACE && ++lexCnt % LEX_TRACE === 0)
    process.stderr.write(`[lex ${lexCnt}] ${cc.lex_include_stk.full_name}:${cc.lex_include_stk.line_num} tok=${cc.token} ${cc.cur_str}
`);
  let ch, i, j, k;
  lexloop: for (;;) {
    ch = LexGetChar(cc);
    switch (true) {
      case ch === 0:
        return (cc.token = K.TK_EOF);
      case (ch === 64 && !!(cc.flags & K.CCF_KEEP_AT_SIGN)):
        cc.token = ch; break lexloop;
      case (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95 || ch === 64 || ch >= 128: {
        let s = String.fromCharCode(ch);
        for (;;) {
          if (s.length >= K.STR_LEN) LexExcept(cc, 'Ident limited to STR_LEN chars at ');
          ch = LexGetChar(cc);
          if (!ch) break;
          if (isAlnum(ch, cc)) s += String.fromCharCode(ch);
          else { cc.flags |= K.CCF_USE_LAST_U16; break; }
        }
        let tmph = null;
        cc.local_var_entry = cc.htc.local_var_lst ? MemberFind(s, cc.htc.local_var_lst) : null;
        if (!cc.local_var_entry && cc.htc.hash_table_lst)
          tmph = HashFind(s, cc.htc.hash_table_lst, cc.htc.hash_mask);
        if (tmph && (tmph.type & K.HTT_DEFINE_STR) && !(cc.flags & K.CCF_NO_DEFINES)) {
          LexIncludeStr(cc, tmph.str, tmph.data, false);
          cc.lex_include_stk.flags |= K.LFSF_DEFINE;
          continue lexloop;
        }
        cc.hash_entry = tmph;
        cc.cur_str = s; cc.cur_str_len = s.length + 1;
        cc.token = K.TK_IDENT;
        break lexloop;
      }
      case isDec(ch): {
        let v = BigInt(ch - 48);
        ch = toUpper(LexGetChar(cc));
        if (ch === 88) { // X
          for (;;) {
            ch = toUpper(LexGetChar(cc));
            if (isHex(ch)) v = I64((v << 4n) + BigInt(ch <= 57 ? ch - 48 : ch - 65 + 10));
            else { cc.cur_i64 = v; cc.flags |= K.CCF_USE_LAST_U16; cc.token = K.TK_I64; break lexloop; }
          }
        } else if (ch === 66) { // B
          for (;;) {
            ch = LexGetChar(cc);
            if (ch === 48) v = I64(v << 1n);
            else if (ch === 49) v = I64((v << 1n) + 1n);
            else { cc.cur_i64 = v; cc.flags |= K.CCF_USE_LAST_U16; cc.token = K.TK_I64; break lexloop; }
          }
        }
        for (;;) {
          if (isDec(ch)) v = I64(v * 10n + BigInt(ch - 48));
          else {
            if (ch === 46 || ch === 101 || ch === 69) break;
            cc.cur_i64 = v; cc.flags |= K.CCF_USE_LAST_U16; cc.token = K.TK_I64; break lexloop;
          }
          ch = LexGetChar(cc);
        }
        if (ch === 46) {
          ch = LexGetChar(cc);
          if (ch === 46) {
            cc.flags |= K.CCF_LAST_WAS_DOT;
            cc.cur_i64 = v; cc.flags |= K.CCF_USE_LAST_U16; cc.token = K.TK_I64; break lexloop;
          }
        }
        lexFloat(cc, v, ch);
        break lexloop;
      }
      case ch === 34: { // "
        cc.flags |= K.CCF_IN_QUOTES;
        const out = [];
        LexInStr(cc, out);
        cc.cur_str = String.fromCharCode.apply(null, out);
        cc.cur_str_len = out.length;
        cc.flags &= ~K.CCF_IN_QUOTES;
        cc.token = K.TK_STR;
        break lexloop;
      }
      case ch === 39: { // '
        if (cc.flags & K.CCF_NO_CHAR_CONST) continue lexloop;
        let kv = 0n;
        for (j = 0; j < 8; j++) {
          if (!(ch = LexGetChar(cc)) || ch === 39) break;
          let b;
          if (ch === 92) {
            switch ((ch = LexGetChar(cc))) {
              case 48: b = 0; break;
              case 39: b = 39; break;
              case 96: b = 96; break;
              case 34: b = 34; break;
              case 92: b = 92; break;
              case 100: b = 36; break;
              case 110: b = 10; break;
              case 114: b = 13; break;
              case 116: b = 9; break;
              case 120: case 88: {
                i = 0;
                for (let l = 0; l < 2; l++) {
                  ch = toUpper(LexGetChar(cc));
                  if (isHex(ch)) i = (i << 4) + (ch <= 57 ? ch - 48 : ch - 65 + 10);
                  else { cc.flags |= K.CCF_USE_LAST_U16; break; }
                }
                b = i & 255; break;
              }
              default: b = 92; cc.flags |= K.CCF_USE_LAST_U16;
            }
          } else if (ch === 36) {
            ch = LexGetChar(cc);
            b = 36;
            if (ch !== 36) cc.flags |= K.CCF_USE_LAST_U16;
          } else b = ch;
          kv |= BigInt(b) << BigInt(8 * j);
        }
        if (ch !== 39 && (ch = LexGetChar(cc)) && ch !== 39)
          LexExcept(cc, 'Char const limited to 8 chars at ');
        cc.cur_i64 = I64(kv);
        cc.token = K.TK_CHAR_CONST;
        break lexloop;
      }
      case ch === 35: { // #
        if (cc.flags & K.CCF_KEEP_SIGN_NUM) { cc.token = ch; break lexloop; }
        if (Lex(cc) !== K.TK_IDENT) break lexloop;
        const tmph = cc.hash_entry;
        if (!tmph || !(tmph.type & K.HTT_KEYWORD)) break lexloop;
        switch ((i = tmph.user_data0)) {
          case K.KW_INCLUDE: {
            if (Lex(cc) !== K.TK_STR) break lexloop;
            const r = cc.env.includeFile(cc, cc.cur_str);
            if (r.raw) LexIncludeStr(cc, r.name, r.text, true);
            else LexAttachDoc(cc, r.name, r.text);
            continue lexloop;
          }
          case K.KW_DEFINE: {
            cc.flags |= K.CCF_NO_DEFINES;
            if (Lex(cc) === K.TK_IDENT) {
              const d = new CHashDefineStr(cc.cur_str);
              d.src_link = srcLink(cc);
              do ch = LexGetChar(cc); while (isNonEolWhite(ch));
              let buf = [];
              if (ch) {
                let in_str = false;
                do {
                  if (ch === 92) {
                    if ((ch = LexGetChar(cc))) {
                      if (ch !== 13 && ch !== 10) { buf.push(92, ch); }
                      else if (ch === 13 && LexGetChar(cc) !== 10) cc.flags |= K.CCF_USE_LAST_U16;
                    } else { buf.push(92); break; }
                  } else if (ch !== 10) {
                    if (ch === 34) in_str = !in_str;
                    buf.push(ch);
                  } else break;
                  while ((ch = LexGetChar(cc))) {
                    if (ch === 47) {
                      ch = LexGetChar(cc);
                      if (ch === 47 && !in_str) {
                        do ch = LexGetChar(cc); while (isNonEol(ch));
                        break;
                      } else {
                        buf.push(47);
                        cc.flags |= K.CCF_USE_LAST_U16;
                      }
                    } else if (ch === 92) {
                      if ((ch = LexGetChar(cc))) {
                        if (ch === 34) buf.push(92, ch);
                        else { cc.flags |= K.CCF_USE_LAST_U16; ch = 92; break; }
                      }
                    } else if (isNonEol(ch)) {
                      if (ch === 34) in_str = !in_str;
                      buf.push(ch);
                    } else break;
                  }
                } while (ch === 92);
              }
              d.data = String.fromCharCode.apply(null, buf);
              cc.htc.define_hash_table.add(d);
            }
            cc.flags &= ~K.CCF_NO_DEFINES;
            continue lexloop;
          }
          case K.KW_ELSE:
            if (cc.flags & K.CCF_IN_IF) { cc.token = K.TK_ELSE; break lexloop; }
            if (!skipIfBlock(cc, 1, false)) break lexloop;
            continue lexloop;
          case K.KW_IF: {
            if (cc.flags & K.CCF_IN_IF) { cc.token = K.TK_IF; break lexloop; }
            let r = lexIf(cc);
            if (r === 'end') break lexloop;
            continue lexloop;
          }
          case K.KW_IFDEF: case K.KW_IFNDEF: {
            if (cc.flags & K.CCF_IN_IF) { cc.token = i === K.KW_IFDEF ? K.TK_IFDEF : K.TK_IFNDEF; break lexloop; }
            const r = lexIfdef(cc, i === K.KW_IFDEF);
            if (r === 'end') break lexloop;
            continue lexloop;
          }
          case K.KW_IFAOT: case K.KW_IFJIT: {
            if (cc.flags & K.CCF_IN_IF) { cc.token = K.TK_IFAOT; break lexloop; }
            const aot = !!(cc.flags & K.CCF_AOT_COMPILE) || cc.env.aotMode;
            if ((i === K.KW_IFAOT) === aot) continue lexloop;
            if (!skipIfBlock(cc, 1, true)) break lexloop;
            continue lexloop;
          }
          case K.KW_ENDIF:
            if (cc.flags & K.CCF_IN_IF) { cc.token = K.TK_ENDIF; break lexloop; }
            continue lexloop;
          case K.KW_ASSERT:
            if (!Lex(cc)) break lexloop;
            if (!cc.env.LexExpression(cc)) LexWarn(cc, 'Assert Failed ');
            break lexloop;
          case K.KW_EXE:
            if (!Lex(cc)) break lexloop;
            cc.env.PrsStreamBlk(cc);
            break lexloop;
          case K.KW_HELP_INDEX:
            if (Lex(cc) !== K.TK_STR) break lexloop;
            cc.cur_help_idx = LexExtStr(cc, null, false);
            continue lexloop;
          case K.KW_HELP_FILE:
            if (Lex(cc) !== K.TK_STR) break lexloop;
            continue lexloop;
        }
        continue lexloop;
      }
      case ch === 10:
        if (!(cc.flags & K.CCF_KEEP_NEW_LINES)) continue lexloop;
        cc.token = ch; break lexloop;
      case ch === K.TK_INS_BIN || ch === K.TK_INS_BIN_SIZE:
        cc.token = ch; break lexloop;
      case ch === 46: { // .
        if (cc.flags & K.CCF_KEEP_DOT) { cc.token = ch; break lexloop; }
        let dotdot = false;
        if (cc.flags & K.CCF_LAST_WAS_DOT) { cc.flags &= ~K.CCF_LAST_WAS_DOT; dotdot = true; }
        else {
          ch = LexGetChar(cc);
          if (isDec(ch)) { lexFloat2(cc, 0n, ch); break lexloop; }
          if (ch === 46) dotdot = true;
        }
        if (dotdot) {
          cc.token = K.TK_DOT_DOT;
          if (LexGetChar(cc) === 46) cc.token = K.TK_ELLIPSIS;
          else cc.flags |= K.CCF_USE_LAST_U16;
          break lexloop;
        }
        cc.flags |= K.CCF_USE_LAST_U16;
        cc.token = 46;
        break lexloop;
      }
      case ch === 33 || (ch >= 36 && ch <= 38) || (ch >= 40 && ch <= 45) || ch === 47 ||
           (ch >= 58 && ch <= 63) || ch === 91 || (ch >= 93 && ch <= 94) || (ch >= 123 && ch <= 126) || ch === 96: {
        const d1 = dual1[ch];
        if (!d1) {
          if (ch === 36) { // $
            ch = LexGetChar(cc);
            if (ch === 36) { cc.token = 36; break lexloop; }
            if (ch) {
              do ch = LexGetChar(cc); while (ch && ch !== 36);
              if (!ch) { cc.token = K.TK_EOF; break lexloop; }
              continue lexloop;
            }
            cc.flags |= K.CCF_USE_LAST_U16;
            cc.token = 36;
            break lexloop;
          }
          cc.token = ch; break lexloop;
        }
        j = LexGetChar(cc);
        if (d1[0] === j) {
          if (!d1[1]) { // /* nested comment
            let depth = 1;
            do {
              if (!(ch = LexGetChar(cc))) return (cc.token = K.TK_EOF);
              for (;;) {
                if (ch === 42) {
                  if (!(ch = LexGetChar(cc))) return (cc.token = K.TK_EOF);
                  if (ch === 47) { depth--; break; }
                  continue;
                } else if (ch === 47) {
                  if (!(ch = LexGetChar(cc))) return (cc.token = K.TK_EOF);
                  if (ch === 42) { depth++; break; }
                  continue;
                }
                break;
              }
            } while (depth);
            continue lexloop;
          }
          cc.token = d1[1]; break lexloop;
        }
        const d2 = dual2[ch];
        if (d2) {
          if (d2[0] === j) {
            if (!d2[1]) { // //
              LexSkipEol(cc);
              if (cc.flags & K.CCF_KEEP_NEW_LINES) { cc.token = 10; break lexloop; }
              continue lexloop;
            }
            let t = d2[1];
            if (t === K.TK_SHL || t === K.TK_SHR) {
              j = LexGetChar(cc);
              if (j === 61) t = t === K.TK_SHL ? K.TK_SHL_EQU : K.TK_SHR_EQU;
              else cc.flags |= K.CCF_USE_LAST_U16;
            }
            cc.token = t; break lexloop;
          }
          const d3 = dual3[ch];
          if (d3 && d3[0] === j) { cc.token = d3[1]; break lexloop; }
        }
        cc.flags |= K.CCF_USE_LAST_U16;
        cc.token = ch;
        break lexloop;
      }
      default:
        continue lexloop; // whitespace and other control chars
    }
  }
  LexGetChar(cc);
  cc.flags |= K.CCF_USE_LAST_U16;
  return cc.token;
}

function lexFloat(cc, v, ch) {
  // Entered after integer digits; ch is the char after them ('.', 'e' or a digit after '.')
  lexFloat2(cc, v, ch);
}
function lexFloat2(cc, i, ch) {
  let k = 0;
  for (;;) {
    if (isDec(ch)) { i = I64(i * 10n + BigInt(ch - 48)); k++; }
    else {
      if (ch === 101 || ch === 69) break;
      cc.cur_f64 = Number(i) * pow10(-k);
      cc.flags |= K.CCF_USE_LAST_U16;
      cc.token = K.TK_F64;
      return;
    }
    ch = LexGetChar(cc);
  }
  ch = LexGetChar(cc);
  let neg = false;
  if (ch === 45) { neg = true; ch = LexGetChar(cc); }
  let j = 0;
  for (;;) {
    if (isDec(ch)) j = j * 10 + ch - 48;
    else {
      cc.cur_f64 = Number(i) * pow10(neg ? -j - k : j - k);
      cc.flags |= K.CCF_USE_LAST_U16;
      cc.token = K.TK_F64;
      return;
    }
    ch = LexGetChar(cc);
  }
}

function lexIf(cc) {
  // #if expr
  for (;;) {
    cc.flags |= K.CCF_IN_IF;
    if (!Lex(cc)) { cc.flags &= ~K.CCF_IN_IF; return 'end'; }
    const v = cc.env.LexExpression(cc);
    cc.flags &= ~K.CCF_IN_IF;
    if (v) {
      switch (cc.token) {
        case K.TK_IF: continue;
        case K.TK_IFDEF: return lexIfdef(cc, true, true);
        case K.TK_IFNDEF: return lexIfdef(cc, false, true);
        case K.TK_IFAOT: // (#ifjit also lexes as TK_IFAOT inside #if, as in the original)
          if (cc.flags & K.CCF_AOT_COMPILE || cc.env.aotMode) return 'cont';
          return skipIfBlock(cc, 1, true) ? 'cont' : 'end';
        case K.TK_ELSE: return skipIfBlock(cc, 1, false) ? 'cont' : 'end';
        case K.TK_ENDIF: return 'cont';
        default: return 'end';
      }
    }
    if (cc.token !== K.TK_ENDIF && cc.token !== K.TK_ELSE) {
      let j = (cc.token === K.TK_IF || cc.token === K.TK_IFDEF || cc.token === K.TK_IFNDEF ||
        cc.token === K.TK_IFAOT || cc.token === K.TK_IFJIT) ? 2 : 1;
      if (!skipIfBlock(cc, j, true)) return 'end';
    }
    return 'cont';
  }
}
function lexIfdef(cc, want, already) {
  cc.flags |= K.CCF_NO_DEFINES;
  if (!Lex(cc)) { cc.flags &= ~K.CCF_NO_DEFINES; return 'end'; }
  cc.flags &= ~K.CCF_NO_DEFINES;
  if (cc.token !== K.TK_IDENT) return 'end';
  const has = !!cc.hash_entry;
  if (has === want) return 'cont';
  if (!skipIfBlock(cc, 1, true)) return 'end';
  return 'cont';
}

export function srcLink(cc) {
  const f = cc.lex_include_stk;
  return f ? `${f.full_name},${f.line_num}` : null;
}

export function LexExtStr(cc, sizeOut, lex_next = true) {
  let st = cc.cur_str;
  cc.cur_str = null;
  while (cc.token === K.TK_STR) {
    if (!lex_next && LexGetChar(cc) !== 92) { cc.flags |= K.CCF_USE_LAST_U16; break; }
    if (Lex(cc) === K.TK_STR) {
      // strip terminator of st and append next
      st = st.slice(0, -1) + cc.cur_str;
      cc.cur_str = null;
    }
  }
  if (sizeOut) sizeOut.v = st.length;
  return st;
}

export function LexPutPos(cc) {
  const f = cc.lex_include_stk;
  return f ? `${f.full_name}:${f.line_num}` : '';
}
