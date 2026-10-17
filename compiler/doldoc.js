// Minimal DolDoc reader for the bootstrap lexer.
// TempleOS #includes source files as DolDoc documents (LexAttachDoc with
// DOCF_DBL_DOLLARS) and LexGetChar walks the document's entries.  This mirrors
// DocPutS()'s splitting rules closely enough for compiling source code:
//   - text runs end at NUL, CH_CURSOR, tab, CR, LF and '$'
//   - "$$" becomes a TEXT entry whose tag is "$$" (DBL_DOLLARS keeps it doubled)
//   - "$...$" becomes a command entry; $TX$ commands are TEXT entries whose tag
//     is the command's text argument, everything else is a non-text entry
//   - CR, LF, CRLF become NEW_LINE entries; tab becomes a TAB entry
export const DE_TEXT = 0, DE_NEW_LINE = 1, DE_TAB = 2, DE_CMD = 3;
const CH_CURSOR = 5;

function firstQuoted(s) {
  // Returns the unescaped contents of the first "..." in s, or null.
  const i = s.indexOf('"');
  if (i < 0) return null;
  let out = '';
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length) {
      const n = s[++j];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
    } else if (c === '"') return out;
    else out += c;
  }
  return out;
}

export function docParse(src) {
  const ents = [];
  let y = 0, p = 0;
  const n = src.length;
  while (p < n) {
    const start = p;
    let c;
    for (;;) {
      c = p < n ? src.charCodeAt(p) : 0;
      if (c === 0 || c === CH_CURSOR || c === 9 || c === 10 || c === 13 || c === 36) break;
      p++;
    }
    if (p > start) ents.push({ type: DE_TEXT, tag: src.slice(start, p), y });
    if (p >= n || c === 0) break;
    switch (c) {
      case CH_CURSOR: p++; break;
      case 9: ents.push({ type: DE_TAB, y }); p++; break;
      case 36: { // '$'
        p++;
        const q = src.indexOf('$', p);
        if (q < 0) { p = n; break; } // unterminated: DocPutS drops it
        const cmd = src.slice(p, q).replace(/\x05/g, '');
        if (!cmd.length) ents.push({ type: DE_TEXT, tag: '$$', y });
        else if (/^TX([,+-]|$)/.test(cmd)) {
          // Only TAG/DEFINE-style $TX$ entries occur in the sources we build,
          // so LexGetChar() lexes their tag both in and out of quotes.
          const tag = firstQuoted(cmd);
          ents.push({ type: DE_TEXT, tag: tag === null ? '' : tag, y });
        } else ents.push({ type: DE_CMD, cmd, y });
        p = q + 1;
        break;
      }
      default: // CR / LF
        ents.push({ type: DE_NEW_LINE, y });
        if (c === 13) { while (src.charCodeAt(p) === 13) p++; }
        if (src.charCodeAt(p) === 10) p++;
        while (src.charCodeAt(p) === 13) p++;
        y++;
    }
  }
  return ents;
}

// The "$%$Q$" rendering LexDollar() uses for a doc cmd that appears inside
// a string literal (Doc2PlainText approximated by the original cmd text).
export function dollarRender(cmd) {
  let q = '';
  for (const ch of cmd) {
    if (ch === '\\') q += '\\\\';
    else if (ch === '"') q += '\\"';
    else if (ch === '\n') q += '\\n';
    else if (ch === '\t') q += '\\t';
    else if (ch === '$') q += '$$';
    else q += ch;
  }
  return '$' + q + '$';
}
