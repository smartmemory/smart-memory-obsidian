# SmartMemory for Obsidian

Bring [SmartMemory](https://smartmemory.ai)'s entity extraction, knowledge graph, multi-hop search, and contradiction detection into your Obsidian vault.

> **Requires a SmartMemory account.** A free tier is available (1,000 notes, 200 searches/day). Paid tiers unlock higher quotas and team workspaces.

## Features

- **Vault ingest** — turn any note into a structured memory item with extracted entities and relations.
- **Search & Recall** — multi-hop semantic search across your whole vault from a sidebar pane or `Cmd+Shift+R` floating modal.
- **Entity backlinks** — auto-extracted entities become clickable chips that find every note referencing the same person, project, or concept.
- **Knowledge graph pane** — focused N-hop neighborhood graph centered on the active note.
- **Auto-link** — propose `[[wikilinks]]` for entity mentions; preview-and-accept never modifies code blocks, frontmatter, or existing links.
- **Inline suggestions** — debounced "Related: [[Note A]], [[Note B]]" widget while you type (opt-in).
- **Contradiction banner** — when a memory has been superseded server-side, you see it inline with a "View derivation history" button.

## Install

### Via BRAT (recommended while we are pre-directory)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin from the community directory.
2. Open BRAT settings → "Add Beta Plugin" → paste `smartmemory/smart-memory-obsidian` → Add.
3. Enable "SmartMemory" in Settings → Community plugins.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/smartmemory/smart-memory-obsidian/releases/latest).
2. Drop them into `<your-vault>/.obsidian/plugins/smartmemory/`.
3. Enable "SmartMemory" in Settings → Community plugins.

### Coming soon

Direct install from Obsidian's Community plugin directory (submission pending).

## Setup

1. Create a SmartMemory account at [www.smartmemory.ai](https://www.smartmemory.ai) and copy your API key from Settings → API Keys.
2. In Obsidian: Settings → SmartMemory → paste API key, set workspace ID, save.
3. Status-bar dot turns green once connected.

API key can also be supplied via the `SMARTMEMORY_API_KEY` environment variable, which takes precedence over the settings field.

## Privacy & data

- All network calls go to your configured SmartMemory API URL (default: `https://api.smartmemory.ai`).
- Note content sent on ingest, search, and recall is processed server-side for entity extraction and embedding. Your data lives in your SmartMemory workspace under your account.
- The plugin stores a local mapping (`<plugin-data>/data.json`) of vault path → SmartMemory item ID and a content hash for re-ingest detection. No vault content is logged anywhere outside Obsidian and your SmartMemory account.
- The plugin does not collect telemetry. The status-bar connection probe (a single `GET /memory/list?limit=1` on load) is the only background call.

## Quotas & free tier

- Free tier: **1,000 notes**, **200 searches/day**.
- Hitting the note cap: ingest returns 429; the plugin shows an upgrade modal.
- Hitting the daily search cap: search returns 429; a non-blocking notice surfaces.
- Both errors are non-destructive — the plugin never deletes vault content.

## Settings reference

| Setting | Purpose |
|---------|---------|
| API URL / API Key / Workspace ID | Connection |
| Auto-ingest on save / on create | Toggle automatic ingest of vault changes |
| Exclude folders | Comma-separated path prefixes (e.g. `templates/, .obsidian/`) — not glob patterns |
| Write entities / relations / memory_type / sync timestamp | Per-field toggles for what gets written back to frontmatter |
| Suggestion frequency (off / 5s / 2s / 1s) | Inline-suggestion debounce |
| Contradiction banner | Toggle the supersession warning + sweep interval |
| Graph max nodes / max hops | Knowledge-graph pane bounds |

## Compatibility

- Obsidian **1.5.0** and above.
- Desktop and mobile (the plugin sets `isDesktopOnly: false`; mobile is supported but the graph pane is bandwidth-heavier than the rest).

## Build from source

Use Node.js 22 or newer and npm. The default layout has this plugin,
`smart-memory-sdk-js`, and `smart-memory-graph` as sibling git checkouts.
Install dependencies in the SDK and graph first, then in this plugin:

```sh
(cd ../smart-memory-sdk-js && npm install --ignore-scripts --no-package-lock)
(cd ../smart-memory-graph && npm install --ignore-scripts --no-package-lock)
npm install --ignore-scripts --no-package-lock
npm run build
```

For an isolated plugin worktree, set `SMARTMEMORY_SDK_PATH` to the absolute
SDK checkout path. npm's local dependency installation also needs explicit paths
when the sibling checkouts are elsewhere:

```sh
export SMARTMEMORY_SDK_PATH=/absolute/path/to/smart-memory-sdk-js
export SMARTMEMORY_BUILD_SCRATCH=/absolute/path/to/task/scratch
npm install --ignore-scripts --no-package-lock --no-save \
  "smartmemory-sdk-js@$SMARTMEMORY_SDK_PATH" \
  "@smartmemory/graph@/absolute/path/to/smart-memory-graph"
npm run build
```

Every production build copies the SDK's tracked files and non-ignored untracked
files, plus its installed dependencies, to a disposable directory under
`SMARTMEMORY_BUILD_SCRATCH` (default: `.build/` in this plugin). It runs the SDK's
`npm run build` there before bundling. The input SDK checkout and its `dist/`
remain untouched. Existing SDK `dist/` is never copied or used. Both legacy
`smartmemory-sdk-js` imports and scoped `@smartmemory/sdk-js` imports use the
fresh build. The disposable copy is removed after success or failure.

Missing SDK checkout, git metadata, installed SDK dependencies, failed SDK
compilation, or missing SDK dist exports stop the build with a diagnostic.
The previous `main.js` is removed when a production build starts, so a failed
build cannot leave an older bundle to publish.

Before preparing a release, run the build and check its first line:

```sh
npm run build
head -n 1 main.js
# // SmartMemory SDK git=<full commit SHA> dirty=false
```

The header records the SDK commit and whether tracked edits or non-ignored
untracked files were present. Use a clean SDK checkout (`dirty=false`) for
release provenance. Retain this header in the release's `main.js`, alongside
`manifest.json` and `styles.css`. Building does not change the plugin version
or publish a release. Dependency versions and the graph checkout still need to
be held constant for byte-identical builds.

Run the focused build regression with the same environment variables:

```sh
npm test -- tests/sdk-build.test.ts
```

It uses the real SDK/compiler in scratch copies to check stale dist replacement,
clean and dirty provenance, missing checkout, and SDK compilation failure.
`npm run dev` retains the existing local dependency watch workflow. Production
SDK rebuilding and provenance apply to `npm run build`.

## Issues & feedback

[github.com/smartmemory/smart-memory-obsidian/issues](https://github.com/smartmemory/smart-memory-obsidian/issues)

## License

MIT — see [LICENSE](./LICENSE).
