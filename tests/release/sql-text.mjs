// ============================================================================
// Executable SQL, without the prose around it
// ============================================================================
// Several contract tests in this directory ask "does any other statement do X?"
// over migration text. A plain `includes()` cannot tell a statement from a header
// comment, which makes those tests refuse a migration for documenting the very
// measurement it was asked to record — and the fix must not be "stop documenting
// it".
//
// Comments are removed; string literals and dollar-quoted bodies are kept
// verbatim, because a table name or a period inside one is still a use. A caller
// that needs the comments *inside* a function body removed extracts the body and
// strips that — the body's own `--` lines are top-level once it stands alone.
// Scanned
// character by character rather than string-replaced: a naive `--`-to-newline cut
// also removes everything after a `--` inside a literal, which is exactly where a
// real use would hide from the check.
//
// Not `scripts/split-sql-statements.mjs`. That module reproduces one specific
// external tool's statement splitter and is bound by a CLI-parity drill; this is a
// test-side reader with no contract to anything. Its own behaviour is pinned in
// tests/release/kpi-period-lock-gate-contract.test.mjs.

/** A `$tag$` opener at `i`, or null. Tags are unquoted identifiers, or empty. */
function dollarTag(sql, i) {
  if (sql[i] !== "$") return null;
  let j = i + 1;
  while (j < sql.length) {
    const ch = sql[j];
    if (ch === "$") return sql.slice(i, j + 1);
    if (!/[A-Za-z0-9_]/.test(ch) && ch.codePointAt(0) < 0x80) return null;
    if (j === i + 1 && /[0-9]/.test(ch)) return null;
    j += 1;
  }
  return null;
}

/** The same text with `--` and `/* *\/` comments removed. Pure. */
export function sqlWithoutComments(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];

    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i + 2);
      i = nl === -1 ? sql.length : nl;
      continue;
    }

    if (ch === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      out += ch;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            out += ch + ch;
            i += 2;
            continue;
          }
          out += ch;
          i += 1;
          break;
        }
        out += sql[i];
        i += 1;
      }
      continue;
    }

    const tag = dollarTag(sql, i);
    if (tag) {
      const close = sql.indexOf(tag, i + tag.length);
      const body = close === -1 ? sql.slice(i) : sql.slice(i, close + tag.length);
      out += body;
      i += body.length;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}
