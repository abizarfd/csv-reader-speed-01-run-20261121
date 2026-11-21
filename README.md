# csv-reader-speed-01 — fast csv-reader 1.0.0

A faster drop-in for csv-reader 1.0.0: `solve.js` returns exactly what the
reference returns for `{text, header}` → `{columns, rows, errors}`, reading
each text once, left to right, by the reference's own broken-row policy
(BOM drop, LF/CRLF record ends, empty lines are no record, stray CRs
dropped with `stray_cr`, quoted-field rules with doubled quotes,
`quote_junk` and `unterminated_quote` re-read as unquoted, fields staying
strings, rows padded or cut with `short_row` / `long_row`).

Speed comes from letting the engine do the scanning: each unquoted field is
found with two native `indexOf` calls and one slice instead of a
per-character JavaScript loop, and quoted fields jump straight to the next
`"` and slice their content in one go. The slower character paths only run
where the input actually needs them (a field holding a CR, or a quoted
field holding a doubled quote).

## Layout

- `solve.js` — the reader (`run(input)`), dependency-free ES module.
- `main.ts` — the driver: reads `/input/cases.json`, answers each case with
  `run`, writes `/output/answers.json`.
- `LICENSE` — MIT.

## License

MIT — see `LICENSE`.
