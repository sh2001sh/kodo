# pager-kit workspace

This is the seeded workspace for the continuation fixture. It is a tiny pure-Node
ESM project: a pagination helper used by the terminal report renderer, an
acceptance script and a documentation tree.

## Layout

```text
verify.mjs          independent acceptance checks (protected)
src/pager.mjs       pagination helper (the file to fix)
src/legacy.js       frozen legacy constants (protected)
docs/               project documentation (protected)
```

## Acceptance

```text
node verify.mjs
```

Exit code 0 means accepted; exit code 1 prints one `FAIL:` line per failing
check. The seeded state is expected to fail. Do not modify `verify.mjs`,
anything under `docs/`, or `src/legacy.js`.
