/**
 * Split a migration file into the statements the Supabase CLI records for it.
 *
 * Round-4 finding C4: the remote-history gate fingerprinted only what production
 * had recorded and then compared later production state to that capture. That
 * proves production has not changed since the capture. It does not prove the
 * recorded statements are the migration files in this release — which is the
 * question "did production run this SQL?" actually asks. Answering it needs the
 * local side of the comparison, and the local side is a file while the remote
 * side is `text[]`. Something has to turn one into the other, and it has to do it
 * the way the tool that wrote the array did.
 *
 * `supabase db push` (and `supabase migration up`, and `db reset`) reads the file,
 * splits it into statements, executes them, and records the split array in
 * supabase_migrations.schema_migrations.statements. So the array's shape is a
 * property of the CLI's splitter, not of the SQL. This module reproduces that
 * splitter:
 *
 *   * statements are separated by a top-level `;`, and the separator is NOT part of
 *     the statement: the recorded text stops before it
 *   * `--` runs to end of line; `/* *\/` nests; both are skipped for the purpose
 *     of finding separators and kept in the statement text
 *   * `'...'` doubles its quote to escape it and never treats a backslash as an
 *     escape — not even inside `E'...'`, where PostgreSQL's own lexer would. That
 *     one is a measured difference from the server, not an oversight; see the
 *     comment at the quote handling below
 *   * `"..."` doubles its quote to escape it
 *   * `$tag$ ... $tag$` is opaque, tags may be empty (`$$`) and must match exactly
 *   * each statement is whitespace-trimmed, and an empty one is dropped — so
 *     trailing whitespace, a stray `;;` and a blank line between statements do not
 *     produce array elements
 *
 * WHAT IS ASSERTED AND WHAT IS MEASURED. Nothing here is a claim about the CLI's
 * Go source, which this repository does not vendor and cannot read. The claim is
 * checked instead: scripts/verify-cli-statement-parity.mjs pushes an adversarial
 * corpus with the pinned CLI, reads back the array the CLI recorded, and requires
 * this module to have produced it byte for byte. The `.github/workflows/ci.yml`
 * job `local-database` runs that drill with CLI 2.113.0. Until that drill is
 * green for a CLI version, this module's output is not evidence about a database
 * that version wrote, and the gate that consumes it reports a difference rather
 * than a match — which is a refusal, not a pass.
 *
 * Text handling: statement text stays inside this process. The gate that calls
 * this module turns statements into a count and a hash immediately and never
 * prints, logs or writes the text. Migration SQL is not a secret, but the same
 * rule that keeps production's recorded statements off the wire is cheaper to
 * apply everywhere than to apply selectively.
 */

/** A `$tag$` opener at `i`, or null. Tags are unquoted identifiers, or empty. */
function dollarTag(sql, i) {
  if (sql[i] !== "$") return null;
  let j = i + 1;
  while (j < sql.length) {
    const ch = sql[j];
    if (ch === "$") return sql.slice(i, j + 1);
    // A tag follows identifier rules — ASCII letters, digits, underscores, or any
    // non-ASCII character — and may not start with a digit, because `$1` is a
    // parameter placeholder rather than a quote.
    if (!/[A-Za-z0-9_]/.test(ch) && ch.codePointAt(0) < 0x80) return null;
    if (j === i + 1 && /[0-9]/.test(ch)) return null;
    j += 1;
  }
  return null;
}

/**
 * The statements of one migration file, in order.
 *
 * Pure: no filesystem, no state. Returns [] for a file with nothing executable
 * in it — which is itself a fact the caller must handle, because a migration that
 * splits into zero statements is a migration whose recorded history could not
 * have contained anything either.
 */
export function splitSqlStatements(sql) {
  const statements = [];
  let start = 0;
  let i = 0;

  const push = (end) => {
    const trimmed = sql.slice(start, end).trim();
    if (trimmed !== "") statements.push(trimmed);
    start = end;
  };

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i + 2);
      i = nl === -1 ? sql.length : nl + 1;
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

    if (ch === "'") {
      // A single-quoted string ends at the next quote that is not doubled, and a
      // backslash is an ordinary character — including inside E'...', where
      // PostgreSQL's own lexer would treat it as an escape. That asymmetry is not
      // an assumption: scripts/verify-cli-statement-parity.mjs measured it. An
      // earlier version of this module honoured E-string escapes, and the drill
      // caught the CLI splitting `select E'a\';b';` after `select E'a\'` — which
      // the server then rejects as an unterminated string, so a migration of that
      // shape can never reach applied history at all. Where the mis-split still
      // executes, the CLI records the pieces it made, and those pieces are what
      // this module has to reproduce. Matching PostgreSQL instead of the CLI would
      // make the gate report content drift for a file production applied exactly.
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === '"') {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    const tag = dollarTag(sql, i);
    if (tag) {
      const close = sql.indexOf(tag, i + tag.length);
      // An unterminated dollar quote runs to the end of the file. The CLI would
      // hand that to the server and the server would reject it; producing one
      // unsplit statement is the honest representation of what was sent.
      i = close === -1 ? sql.length : close + tag.length;
      continue;
    }

    if (ch === ";") {
      // The separator is not part of the statement. Measured, not assumed: the CLI
      // records `select 1;\nselect 2;` as ["select 1", "select 2"], and a `;` that
      // survives inside a recorded statement is one that was never a separator —
      // inside a comment, a string, or a trailing piece the file never terminated.
      push(i);
      i += 1;
      start = i;
      continue;
    }

    i += 1;
  }

  push(sql.length);
  return statements;
}
