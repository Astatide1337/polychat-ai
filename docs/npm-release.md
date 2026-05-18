# npm release

Polychat publishes one npm package that bundles `polychat-server` for these targets:

- `linux-x64`
- `linux-arm64`
- `darwin-x64`
- `darwin-arm64`
- `win32-x64`

## Local package checks

```bash
npm run build
node --test test/**/*.test.mjs
cd rust && cargo test --bin polychat-server
npm run stage:binary
npm run verify:package
npm pack --dry-run
```

Local `stage:binary` and `verify:package` default to the current platform.

## Full publish path

GitHub Actions handles the real multi-platform publish flow:

1. build `polychat-server` on Linux x64, Linux arm64, macOS x64, macOS arm64, and Windows x64
2. upload each binary as a workflow artifact
3. download all artifacts into `artifacts/<target>/`
4. run `npm run stage:binary:all`
5. run `npm run verify:package:all`
6. run build/tests/package checks
7. `npm publish --provenance --access public`

## Manual all-target verification

If you already have all binaries under `artifacts/<target>/`, run:

```bash
npm run stage:binary:all
npm run verify:package:all
```
