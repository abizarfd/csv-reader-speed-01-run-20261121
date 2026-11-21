// Fast drop-in for csv-reader 1.0.0: readCsv's exact answers, much faster.
//
// Same reading policy as the reference (BOM drop, LF/CRLF record ends, empty
// lines are no record, stray CR dropped with stray_cr, quoted-field rules
// with doubled quotes / quote_junk / unterminated_quote re-read as unquoted,
// quotes inside unquoted fields literal, fields stay strings, header/rows
// padded or cut with short_row/long_row, errors {code, line, row} in order).
//
// Speed comes from letting the engine do the scanning: each unquoted field
// is found with two native indexOf calls (',' and '\n') plus one slice,
// instead of a per-character JavaScript loop with per-character string
// appends. The slow character paths only run where the input actually needs
// them: a field holding a stray CR, or a quoted field holding a doubled
// quote. Quoted fields likewise jump straight to the next '"' with indexOf
// and slice the content in one go when it holds no CR and no doubled quote
// (the common case). Field results travel in module-level slots instead of
// a fresh array per field.
//
// Pure: no clock, no randomness, no locale, nothing kept between calls.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's reading of {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recLine = 1;
  let recRow = null;

  // How the last field read ended, and how many characters readUnquoted kept
  // (the quote_junk test reads it right after its own readUnquoted call).
  let lastEnded = END;
  let lastAdded = 0;

  function err(code) {
    errors.push({ code, line: recLine, row: recRow });
  }

  // A span holding CRs, read as quoted content: each CRLF and each lone CR
  // becomes one LF. Returns [value, lineBreaks] (every CR and every LF not
  // part of a CRLF is one line break).
  function normalizeSpan(span) {
    const parts = [];
    const m = span.length;
    let s = 0;
    let i = 0;
    let breaks = 0;
    while (i < m) {
      let r = span.indexOf('\r', i);
      if (r === -1) r = m;
      let l = span.indexOf('\n', i);
      if (l === -1) l = m;
      if (r < l) {
        parts.push(span.slice(s, r));
        parts.push('\n');
        breaks += 1;
        i = r + (span.charCodeAt(r + 1) === 10 ? 2 : 1);
        s = i;
      } else if (l < m) {
        breaks += 1;
        i = l + 1;
      } else {
        break;
      }
    }
    parts.push(span.slice(s));
    return [parts.join(''), breaks];
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field
  // and sets lastEnded / lastAdded; `added` counts the characters kept here.
  function readUnquoted(value, added) {
    let ci = text.indexOf(',', pos);
    if (ci === -1) ci = n;
    let li = text.indexOf('\n', pos);
    if (li === -1) li = n;
    const end = ci < li ? ci : li;
    const v = end > pos ? text.slice(pos, end) : '';
    const ri = v.indexOf('\r');
    if (ri === -1) {
      if (end >= n) {
        pos = n;
        lastEnded = END;
        lastAdded = added + v.length;
        return value + v;
      }
      if (end === ci) {
        pos = end + 1;
        lastEnded = COMMA;
        lastAdded = added + v.length;
        return value + v;
      }
      pos = end + 1;
      line += 1;
      lastEnded = LINE_BREAK;
      lastAdded = added + v.length;
      return value + v;
    }
    if (end < n && end === li && ri === v.length - 1) {
      // The only CR is the trailing one of a CRLF line break.
      pos = end + 1;
      line += 1;
      lastEnded = LINE_BREAK;
      lastAdded = added + v.length - 1;
      return value + v.slice(0, -1);
    }
    // Slow path: v holds one or more stray CRs.
    let ending;
    let w = v;
    if (end >= n) {
      ending = END;
      pos = n;
    } else if (end === ci) {
      ending = COMMA;
      pos = end + 1;
    } else {
      // end === li: a CR at the very end of v is the CRLF line break itself.
      if (w.charCodeAt(w.length - 1) === 13) w = w.slice(0, -1);
      ending = LINE_BREAK;
      pos = end + 1;
      line += 1;
    }
    // Drop the lone CRs left in w, one stray_cr error each.
    let out = value;
    let s = 0;
    let r = w.indexOf('\r', s);
    while (r !== -1) {
      err('stray_cr');
      out += w.slice(s, r);
      added += r - s;
      s = r + 1;
      r = w.indexOf('\r', s);
    }
    out += w.slice(s);
    added += w.length - s;
    lastEnded = ending;
    lastAdded = added;
    return out;
  }

  // What follows a closed quoted field: comma, line break, end of text, or
  // junk appended as it stands (quote_junk when anything was appended).
  // `value` is the quoted content, `p` the position after the closing quote.
  function afterQuoted(value, p) {
    pos = p;
    if (pos >= n) {
      lastEnded = END;
      return value;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      lastEnded = COMMA;
      return value;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      lastEnded = LINE_BREAK;
      return value;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      lastEnded = LINE_BREAK;
      return value;
    }
    const junk = readUnquoted(value, 0);
    if (lastAdded > 0) err('quote_junk');
    return junk;
  }

  // Reads a quoted field whose opening quote is at pos, when its content
  // holds a doubled quote (or, via the fast path's fallback, a CR): segment
  // by segment, so doubled quotes collapse and CRs become LFs.
  function readQuotedSlow(open, openLine) {
    const parts = [];
    let seg = open + 1;
    let p = open + 1;
    let closed = false;
    while (p < n) {
      const c = text.charCodeAt(p);
      if (c === 34) {
        if (text.charCodeAt(p + 1) === 34) {
          parts.push(text.slice(seg, p));
          parts.push('"');
          p += 2;
          seg = p;
          continue;
        }
        parts.push(text.slice(seg, p));
        closed = true;
        p += 1;
        break;
      }
      if (c === 13) {
        parts.push(text.slice(seg, p));
        parts.push('\n');
        line += 1;
        p += text.charCodeAt(p + 1) === 10 ? 2 : 1;
        seg = p;
        continue;
      }
      if (c === 10) line += 1;
      p += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      err('unterminated_quote');
      return readUnquoted('"', 0);
    }
    return afterQuoted(parts.join(''), p);
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const p = pos + 1;
    const q = text.indexOf('"', p);
    if (q === -1) {
      // No quote at all after the opening one: it never closes.
      pos = open + 1;
      line = openLine;
      err('unterminated_quote');
      return readUnquoted('"', 0);
    }
    if (text.charCodeAt(q + 1) === 34) return readQuotedSlow(open, openLine);
    // q is the closing quote; the content is text[p..q).
    const span = text.slice(p, q);
    let value;
    if (span.indexOf('\r') === -1) {
      value = span;
      let i = span.indexOf('\n');
      while (i !== -1) {
        line += 1;
        i = span.indexOf('\n', i + 1);
      }
    } else {
      const norm = normalizeSpan(span);
      value = norm[0];
      line += norm[1];
    }
    return afterQuoted(value, q + 1);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recLine = line;
    recRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('', 0);
      fields.push(field);
    } while (lastEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
