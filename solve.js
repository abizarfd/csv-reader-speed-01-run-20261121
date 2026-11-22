// Fast drop-in for csv-reader 1.0.0: readCsv's exact answers, much faster.
//
// Same reading policy as the reference (BOM drop, LF/CRLF record ends, empty
// lines are no record, stray CR dropped with stray_cr, quoted-field rules
// with doubled quotes / quote_junk / unterminated_quote re-read as unquoted,
// quotes inside unquoted fields literal, fields stay strings, header/rows
// padded or cut with short_row/long_row, errors {code, line, row} in order).
//
// Speed: one flat loop over the fields, all state in locals, no function
// call per field. The LF ending the current record is found once and cached
// (recEnd); an unquoted field then needs only one indexOf (',') plus one
// slice. A quoted field jumps from quote to quote with indexOf (doubled
// quotes collapse with one native replace) instead of a per-character loop.

/** csv-reader 1.0.0's reading of {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = typeof input.text === 'string' ? input.text : String(input.text);
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

  // How the last field read ended: 0 comma, 1 line break, 2 end of text.
  let lastEnded = 2;
  // Position of the LF ending the current record, or -1 when unknown. A
  // quoted field holding an LF invalidates it (the LF sat inside quotes).
  let recEnd = -1;

  function err(code) {
    errors.push({ code, line: recLine, row: recRow });
  }

  // A span holding CRs, read as quoted content: each CRLF and each lone CR
  // becomes one LF. Returns [value, lineBreaks].
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

  // Rare path: an unquoted span holding stray CRs. `v` is the span, `end`
  // where it stopped, `ci`/`li` the comma/LF positions found. Drops the
  // lone CRs (one stray_cr error each) and sets lastEnded; returns the kept
  // characters (without any base value).
  function slowUnquoted(v, end, ci, li) {
    let ending;
    let w = v;
    if (end >= n) {
      ending = 2;
      pos = n;
    } else if (end === ci) {
      ending = 0;
      pos = end + 1;
    } else {
      if (w.charCodeAt(w.length - 1) === 13) w = w.slice(0, -1);
      ending = 1;
      pos = end + 1;
      line += 1;
    }
    let out = '';
    let s = 0;
    let r = w.indexOf('\r', s);
    while (r !== -1) {
      err('stray_cr');
      out += w.slice(s, r);
      s = r + 1;
      r = w.indexOf('\r', s);
    }
    out += w.slice(s);
    lastEnded = ending;
    return out;
  }

  // Reads one unquoted field starting at pos, onto `base`. Sets lastEnded.
  function readUnquotedBase(base) {
    let ci = text.indexOf(',', pos);
    if (ci === -1) ci = n;
    let li = text.indexOf('\n', pos);
    if (li === -1) li = n;
    const end = ci < li ? ci : li;
    const v = end > pos ? text.slice(pos, end) : '';
    const ri = v.indexOf('\r');
    if (ri === -1) {
      if (end >= n) { pos = n; lastEnded = 2; }
      else if (end === ci) { pos = end + 1; lastEnded = 0; }
      else { pos = end + 1; line += 1; lastEnded = 1; }
      return base + v;
    }
    if (end < n && end === li && ri === v.length - 1) {
      pos = end + 1;
      line += 1;
      lastEnded = 1;
      return base + v.slice(0, -1);
    }
    return base + slowUnquoted(v, end, ci, li);
  }

  // Rare path: junk after a closed quoted field. `value` is the quoted
  // content, `p` the position after the closing quote.
  function junkQuoted(value, p) {
    pos = p;
    const out = readUnquotedBase(value);
    if (out.length > value.length) err('quote_junk');
    return out;
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
    recEnd = -1;
    const fields = [];
    let field;
    let quoted;
    do {
      if (text.charCodeAt(pos) === 34) {
        // Quoted field: jump from quote to quote. A quote followed by
        // another quote is a doubled quote, not the close.
        quoted = true;
        const open = pos;
        const openLine = line;
        let q = text.indexOf('"', pos + 1);
        let hasDoubled = false;
        while (q !== -1 && text.charCodeAt(q + 1) === 34) {
          hasDoubled = true;
          q = text.indexOf('"', q + 2);
        }
        if (q === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          pos = open + 1;
          line = openLine;
          err('unterminated_quote');
          field = readUnquotedBase('"');
        } else {
          // q is the closing quote; the content is text[pos+1..q).
          let value = text.slice(pos + 1, q);
          let breaks = 0;
          if (hasDoubled) value = value.replace(/""/g, '"');
          if (value.indexOf('\r') !== -1) {
            const norm = normalizeSpan(value);
            value = norm[0];
            breaks = norm[1];
          } else {
            let i = value.indexOf('\n');
            while (i !== -1) {
              breaks += 1;
              i = value.indexOf('\n', i + 1);
            }
          }
          line += breaks;
          if (breaks > 0) recEnd = -1;
          // What follows the closing quote: comma, line break, end of
          // text, or junk appended as it stands.
          pos = q + 1;
          if (pos >= n) {
            lastEnded = 2;
            field = value;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              lastEnded = 0;
              field = value;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              lastEnded = 1;
              field = value;
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              lastEnded = 1;
              field = value;
            } else {
              field = junkQuoted(value, pos);
            }
          }
        }
      } else {
        // Unquoted field: one indexOf (',') plus one slice; the LF ending
        // this record is cached in recEnd once found.
        quoted = false;
        let ci = text.indexOf(',', pos);
        if (ci === -1) ci = n;
        let li;
        if (recEnd !== -1) {
          li = recEnd;
        } else {
          li = text.indexOf('\n', pos);
          if (li === -1) li = n;
          recEnd = li;
        }
        const end = ci < li ? ci : li;
        const v = end > pos ? text.slice(pos, end) : '';
        const ri = v.indexOf('\r');
        if (ri === -1) {
          field = v;
          if (end >= n) {
            pos = n;
            lastEnded = 2;
          } else if (end === ci) {
            pos = end + 1;
            lastEnded = 0;
          } else {
            pos = end + 1;
            line += 1;
            lastEnded = 1;
          }
        } else if (end < n && end === li && ri === v.length - 1) {
          // The only CR is the trailing one of a CRLF line break.
          field = v.slice(0, -1);
          pos = end + 1;
          line += 1;
          lastEnded = 1;
        } else {
          field = slowUnquoted(v, end, ci, li);
        }
      }
      fields.push(field);
    } while (lastEnded === 0);

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
