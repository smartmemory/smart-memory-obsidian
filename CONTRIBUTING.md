# Contributing

## Versioning

The plugin version equals the SmartMemory core release it ships with. Do not bump it per commit. At a release cut:

```bash
node scripts/set-version.mjs 2.0.7   # manifest.json, package.json, versions.json
```

## Hook behavior

`npm install` activates the husky pre-commit hook (`.husky/pre-commit`). It runs `node scripts/set-version.mjs --check`, which refuses a commit when `manifest.json`, `package.json` and `versions.json` disagree. It never changes the version. The legacy `.githooks/pre-commit` (`git config core.hooksPath .githooks`) runs the same check.

## Tests

```bash
npm test          # vitest run, all suites
npm run test:watch
npm run build     # esbuild → main.js
```

## Bundle tag

`src/main.ts` carries a `BUNDLE_TAG` constant surfaced as a load-time Notice. Update it whenever shipping a behavior change so the running bundle is identifiable from the Obsidian console.
