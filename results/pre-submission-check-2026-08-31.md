# Pre-submission gate evidence — 2026-08-31 (late evening)

Fresh run of the gate commands on the recording-eve tree (working tree at/after `d25f3f0`;
no application source files changed by the evening's prose/demo work — the diffs touched
documentation files only).

## `npm run check`

Exit code **0** — typecheck (server + web), full server suite, both production builds.
Final stage output (server `tsc -p tsconfig.json`) completed clean.

## Server test suite (same evening, explicit count capture)

```
Test Files  27 passed (27)
     Tests  233 passed (233)
```

## `npm audit --omit=dev`

```
found 0 vulnerabilities
```

## Cross-checks

- An independent re-run of the same gate earlier tonight reported identical results
  (27/27 files, 233/233 tests, both builds, 0 vulnerabilities).
- The previous tracked gate artifact `results/p3-final-check.md` (215 tests / 25 files at
  `292d865`) remains valid as the **Phase-3-exit** snapshot; this file is the **pre-submission**
  snapshot the slides and README cite for current counts.
