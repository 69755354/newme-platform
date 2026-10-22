# Next ESLint glob dependency replacement

The prior lock contained development-only `@next/eslint-plugin-next` →
`fast-glob` → `micromatch` → `braces`. The only plugin call is `globSync` in
`dist/utils/get-root-dirs.js`, reading the trusted ESLint `settings.next.rootDir`.
The repository does not set that option, so its normal root is `context.cwd`.
No application runtime imports this chain. This limits observed exposure; it
does not dismiss [GHSA-vfj7-8cjw-p6xm](https://github.com/micromatch/braces/issues/70).
There is no published patched braces release at the time of this review.

An exact, parent-scoped npm override replaces only that plugin's `fast-glob`
with the already-used, official npm `tinyglobby@0.2.17` package. Its published
CommonJS API includes the required `globSync` and `onlyDirectories` option;
see the [upstream project](https://github.com/SuperchupuDev/tinyglobby) and
[npm overrides](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#overrides).
The vulnerable packages are actually removed from the dependency graph, rather
than renamed, ignored by the scanner or replaced with an unreviewed fork.

A raw alias is not fully compatible: tinyglobby defaults to relative paths and
trailing directory separators, including invalid cross-volume relative paths
on Windows, and literal directories expand recursively by default. The offline
root postinstall script adds two explicit options to the Next root helper:
`absolute: true` and `expandDirectories: false`. Its consumers join these directories
with `pages`, `src/pages`, `app` and `src/app`; absolute directory paths preserve
that behavior. It does not alter any Next rule or lint configuration.

The script checks the installed plugin version and alias identity, verifies
the full helper SHA256, applies the two-option change and checks the result.
Reapplication is idempotent. Unknown bytes or versions fail installation.
Runtime installs omitting dev tooling have no helper to patch. No network,
credentials or dependency lifecycle-script approval changes are involved.

Source reviewed from the official npm tarball:

- Package: `@next/eslint-plugin-next@16.3.8`.
- [Tarball](https://registry.npmjs.org/@next/eslint-plugin-next/-/eslint-plugin-next-16.3.8.tgz)
  SHA512 integrity: `sha512-eCR9RcLTZrVS+K3+VOhi0xMdUUGNuriCHHhU1ZoABC/QQ/Gp0OWbLKQxV2/9DkmihYdYRcQWFmZXW8M1AMUXYw==`.
- Original helper SHA256: `886677432990a735e5ebdfb345ff1cbd40e264f9947a8432eeeb254b3a926bde`.
- Patched helper SHA256: `1f503e07e1a7ca2889f8be8efbe5330f787f0febb7bd5ce024b7d7b103bf4470`.

The regression tests execute the actual helper in separate working directories,
including absolute/relative roots, arrays, exclusions, spaces, missing paths,
file filtering and Windows paths. They also run the real enabled Next link rule
against pages, src/pages and the app root route, checking errors remain errors, excluded
roots stay excluded, and valid Link/external navigation remains accepted.
An isolated comparison with the unmodified official 16.3.8 plugin and its
original fast-glob dependency passed 12 root cases and 8 real-rule cases on
Windows. In particular, the upstream rule does not flag the nested app fixture
`/reports`; the replacement has the same result. This change does not claim to
repair or extend that upstream rule's nested-route coverage. The checked-in
positive app assertion uses its supported root page.

Next, its ESLint config and analyzer are aligned at `16.3.8`. Other audited
patches update brace-expansion, fast-uri, sharp and source-map-js; fast-copy's
published fix removes the moderate finding. Existing supply-chain thresholds,
exception policy, registry/integrity checks and dependency script denials remain
in force. Future Next upgrades must review or retire this scoped override and
two-option patch together, and rerun the consumer behavior tests.

## Security refresh (2026-10-23)

Next, its ESLint configuration and analyzer are upgraded together to 16.4.1; Sentry Next.js is pinned to 10.75.2. Official advisories GHSA-2464-fhr4-w9xw, GHSA-p3m5-59mp-jv5r, GHSA-673q-mjm6-r5xr and GHSA-mchm-gjx6-7h55 required these fixes. The official 16.4.1 ESLint plugin tarball was checked against its npm SHA512 integrity; its original get-root-dirs helper has the identical reviewed SHA256 886677432990a735e5ebdfb345ff1cbd40e264f9947a8432eeeb254b3a926bde. The existing byte-checked compatibility transformation and refusal on unknown bytes remain unchanged. All locked third-party install scripts remain explicitly denied. Official npm audit returned zero high/critical findings before publication; full CI follows on the new head. No vulnerability exception is added.

## Security refresh (2026-10-23)

Next, its ESLint configuration and analyzer are upgraded together to 16.4.1; Sentry Next.js is pinned to 10.75.2. Official advisories GHSA-2464-fhr4-w9xw, GHSA-p3m5-59mp-jv5r, GHSA-673q-mjm6-r5xr and GHSA-mchm-gjx6-7h55 required these fixes. The official 16.4.1 ESLint plugin tarball was checked against its npm SHA512 integrity; its original get-root-dirs helper has the identical reviewed SHA256 886677432990a735e5ebdfb345ff1cbd40e264f9947a8432eeeb254b3a926bde. The existing byte-checked compatibility transformation and refusal on unknown bytes remain unchanged. All locked third-party install scripts remain explicitly denied. Official npm audit returned zero high/critical findings before publication; full CI follows on the new head. No vulnerability exception is added.
