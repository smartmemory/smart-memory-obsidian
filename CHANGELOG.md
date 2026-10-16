# Changelog

All notable changes to the SmartMemory Obsidian plugin are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## Unreleased

### Fixed
- SDK snapshot skips tracked files deleted from the SDK working tree (with a warning) instead of failing the production build with ENOENT (PLUGIN-REPRO-BUILD-2).
- `tests/sdk-build.test.ts` skips with a warning when no sibling SDK checkout with `node_modules` exists, instead of failing in setup (PLUGIN-REPRO-BUILD-2).
- `.gitignore` ignores `node_modules` as a symlink too, so a worktree that links the main checkout's `node_modules` stays clean (PLUGIN-REPRO-BUILD-2).
- Tailwind scans the graph library through `node_modules/@smartmemory/graph` (sibling path as fallback, with a warning if neither exists), so a build from an isolated git worktree no longer shrinks `styles.css` (44,346 to 17,962 bytes before the fix; byte-identical after) (PLUGIN-REPRO-BUILD-2).

## [0.2.18] - 2026-10-15: Exclude-folders fix (OBSIDIAN-EXCLUDE-FOLDERS-1)

### Fixed
- Empty and frontmatter-only notes skip automatic ingest quietly with a path-specific console warning. Explicit note ingest explains that the note is empty, and folder summaries count it as skipped. Preserve literal exclusion prefixes across Unicode normalization and avoid excluding the whole vault for `.`, `..`, or `Private/..` entries (OBSIDIAN-EXCLUDE-FOLDERS-1 fix round 2).
- Preserve legacy exclusion path prefixes while adding normalized folder matching. Excluded commands and panels explain why they skip. Purge clears excluded mappings without editing their frontmatter, and link insertion filters excluded targets (OBSIDIAN-EXCLUDE-FOLDERS-1 fix round 1).
- Production builds now rebuild an isolated SDK source copy before bundling, fail on SDK setup or compilation errors, and record the SDK commit and dirty flag in `main.js` (PLUGIN-REPRO-BUILD-1).
- Legacy plugin and scoped graph-library SDK imports now share the freshly compiled SDK. Builds accept `SMARTMEMORY_SDK_PATH` and `SMARTMEMORY_BUILD_SCRATCH`, preserving the input checkout and ignoring its old dist.
- **Excluded folders apply throughout the plugin.** Excluded notes are skipped by manual and automatic ingest, folder batches, metadata updates, enrichment, recall queries, inline suggestions, note-specific panels, auto-link edits, imports, purge frontmatter cleanup, and legacy frontmatter migration. Skips log the operation and note path. Path prefixes ignore case and normalize separators. An entry without a trailing `/` also matches sibling names that start with it. Add `/` to match only that folder and its subfolders.

## [0.2.17] - 2026-10-15: Graph keyboard delete fix (GRAPH-KEY-DELETE-1)

### Fixed
- **Typing in a note could delete graph nodes.** The graph view listened for keys across the whole Obsidian window. With nodes selected in the graph, pressing Delete or Backspace anywhere, including while editing a note, deleted those memories and entities from SmartMemory with no confirmation. Graph shortcuts now act only when the graph itself has focus and never while you type in a text field or editor.
- **Keyboard delete is off in the Obsidian graph view.** The plugin's graph is read-first, so Delete and Backspace no longer remove anything from it.
- **Cmd+K / Ctrl+K** focuses the graph search only from inside the graph, so it no longer takes the shortcut away from Obsidian or from a note you are editing.

### Changed
- Repo references renamed `smartmemory-*` -> `smart-memory-*` in docs, scripts and config (INFRA-REPO-RENAME-1).

- Point user-facing links at https://www.smartmemory.ai (the web app had no app.smartmemory.ai DNS until 2026-10-08, and it now only redirects to www). Filed as PLAT-APP-SUBDOMAIN-1.

## [0.2.13] — 2026-06-06 — Lite/server parity + Codex review fixes (DIST-OBSIDIAN-LITE-PARITY-1)

Full lite-vs-server parity audit plus the backlog of independent-review bugs.
The trigger: the graph showed "Authentication required" because the plugin was
in **cloud mode pointed at a dead local server** while only the lite daemon was
running — not a bug, but it surfaced real parity and correctness gaps.

### Fixed — lite/server parity (DIST-OBSIDIAN-LITE-PARITY-1)
- **Lite mode now connects without an API key.** `initClient()` always built an
  `apiKey`-mode client and returned `null` when no key was set, so lite mode (where
  the daemon reports `auth:false` and the key field is hidden) was unreachable — a
  fresh lite user got a silent "disconnected" with no field to fix it. Connection
  gating is now a pure, tested `resolveClientConfig()`: cloud requires a key, lite
  connects keyless (no `Authorization` header), and cloud-only workspace
  auto-discovery is skipped in lite. The startup "no API key" blocker is mode-aware.
- **Decisions panel degrades explicitly in lite mode** instead of 404'ing. Panels
  now gate on `/health` `capabilities`; `DecisionsPanel` shows "Decisions aren't
  available in local (lite) mode" when the daemon reports `decisions:false`.
- **Seamless cloud↔lite switching.** Changing mode in settings re-probes `/health`
  and refreshes open views (graph + panels) immediately, and a console warning
  fires when the chosen mode disagrees with what the endpoint actually reports.

### Fixed — Codex review (independent pass)
- **Extracted entities were silently missed** by autolink and the entity sidebar:
  both filtered `/neighbors` for `MENTIONS`/`MENTIONED_IN` only, dropping the
  canonical `CONTAINS_ENTITY` leg extraction actually writes. Centralized into
  `src/bridge/entity-edges.ts` (`isEntityEdge` + deduped `entityNeighbors`); all
  three call sites use it.
- **Recalled-memory notes silently de-linked on reload** — `RecallModal` created
  the note and set the in-memory mapping but never persisted it or wrote
  `smartmemory_id`. Now `await saveMappings()` + writes frontmatter.
- **Unhandled promise rejections** in `AutolinkModal` (apply handlers) and the
  settings tab's `hide()` flush — both now catch and surface a Notice.
- **Stale inline suggestions** lingered when the paragraph shrank below the query
  floor — the engine now clears them.
- **Status-bar document click listener leaked** past unload — added `dispose()`
  (cancels the arm timer + removes the listener), wired into `onunload`.
- **`diagnose` command** no longer rejects on a failed paginated list — wrapped
  with a controlled failure Notice.
- Corrected SDK type shims (`sdk-types.d.ts`) and the `lineage-modal` `getLineage`
  call to match the runtime SDK call shapes.

### Companion daemon change (smart-memory wrapper)
- The lite daemon now serves `GET /memory/{id}/lineage` and `GET /memory/{id}/links`
  (previously missing → lineage panel + graph link fallback 404'd in lite), and
  `/health` advertises `lineage`/`links`/`decisions` capabilities.

### Tests
- +`client-config` (7), +`entity-edges` (11), +decisions degradation (2),
  +suggestions clear-on-shrink (1). Suite: **190 passing** (was 169).

## [0.2.12] — 2026-06-05 — Tier 2 real-Obsidian Electron E2E harness (DIST-OBSIDIAN-E2E-2)

Built out the Tier 2 harness the 0.2.11 scaffold reserved — drives the **real Obsidian
binary** so the ~20% of behavior Tier 1's jsdom polyfill can't reach is now covered.

### Added (DIST-OBSIDIAN-E2E-2)
- **`tests/e2e-electron/` real-Obsidian harness**, run under Playwright via `npm run test:e2e-electron`:
  - **`obsidian-app.ts`** — Playwright fixture that boots the actual Obsidian app. Obsidian disables the `EnableNodeCliInspectArguments` Electron fuse, so Playwright's `_electron.launch` (which needs the Node inspector) can't attach; the fixture instead **spawns Obsidian with `--remote-debugging-port` and `chromium.connectOverCDP()`s to the renderer**, driving the window as a normal `Page`. Boots into a committed fixture vault via a seeded `<userData>/obsidian.json` registry with **`updateDisabled: true`** (pins the bundled app asar so Obsidian doesn't hot-update + relaunch and sever the CDP connection).
  - **`mock-backend.ts`** — ~40-line HTTP server, the only network dependency; canned decision/lineage/supersession payloads keyed by `provenance_memory_id`. No `api.smartmemory.ai`, no live stack.
  - **`install-plugin.ts` / `global-setup.ts`** — build the plugin and install `main.js`/`manifest.json`/`styles.css` into the fixture vault; runtime `data.json` (mock URL, onboarding pre-completed, background ingest/sweeps off) is injected per-run by the fixture.
  - **`fixture-vault/`** — committed test vault (notes with/without `smartmemory_id`, `.obsidian/` base config enabling the plugin). Generated plugin binaries are gitignored.
  - **`smoke.electron.spec.ts`** (2) + **`panels.electron.spec.ts`** (3): plugin loads with zero console errors, core commands registered in the palette, decisions panel reveals in the right sidebar, and — the keystone — the panel renders mock-backed rows for the active note and **re-queries with the new memory id when the active note changes**, proving the `active-leaf-change` refresh against the *real* Obsidian Workspace (the exact path that shipped broken for ~2 weeks under Tier 1's stub).
- Local developer gate only (`npm run test:e2e-electron`) — Obsidian has no headless mode, so this tier is not run in CI; Tier 1 (Vitest) remains the CI-friendly tier.

### Changed
- `vitest.config.ts` excludes `tests/e2e-electron/**` so the Playwright specs never get collected by Vitest.
- `package-lock.json` removed from version control (per repo policy; now gitignored).

### Coverage upshot
- Tier 1 (Vitest/jsdom): **169/169** across 18 files — unchanged.
- Tier 2 (Playwright/real Obsidian): **5/5** specs green locally against the system Obsidian binary.

## [0.2.11] — 2026-05-23 — Lineage panel fix (caught by harness) + backfill + Tier 2 scaffold

### Fixed
- **`LineagePanel` was silently no-op'ing in production since 0.2.6 (2026-05-07).** `src/views/lineage-panel.ts` called `(client.memories as any).lineage(memoryId)`, but the runtime SDK (smart-memory-sdk-js MemoryAPI.js) exposes only `getLineage(id)`. The `as any` cast bypassed TypeScript's name check; the runtime call returned `undefined`, awaited to `undefined`, and `Array.isArray(undefined?.lineage)` was always false, so the panel always rendered "No derivation history" regardless of what the server returned. Fixed: call `client.memories.getLineage(memoryId)` and dropped the `as any`. Caught by the DIST-OBSIDIAN-E2E-1 harness backfill — the very first sibling-panel test under the new harness surfaced it.
- **SDK shim corrected** at `src/sdk-types.d.ts` — `neighbors` / `lineage` declarations replaced with the real runtime names `getNeighbors` / `getLineage`. `SupersessionsPanel`'s `(client.memories as any).getNeighbors(memoryId)` happened to use the right name (lucky); `as any` dropped there too now that the shim is honest.

### Added (DIST-OBSIDIAN-E2E-1-BACKFILL — 2026-05-23)
- **`tests/lineage-panel-e2e.test.ts`** — 8 end-to-end rendering tests for `LineagePanel` (no-active-file, no-memory-id, SDK call shape, empty server response, multi-item render with memory_type / confidence / content / vault-link, error retry, refresh-on-leaf-change). All 8 green against the fixed implementation.
- **`tests/supersessions-panel-e2e.test.ts`** — 8 end-to-end rendering tests for `SupersessionsPanel` matching the same shape (no-active-file, no-memory-id, SDK call shape, no-supersession-edges empty state, supersedes+superseded directional row rendering, snippet truncation, error retry, refresh-on-leaf-change). All 8 green.

### Added (DIST-OBSIDIAN-E2E-2 — Tier 2 scaffold)
- **`tests/e2e-electron/`** — directory + README + Playwright config example for the future Tier 2 real-Obsidian-Electron harness. NOT WIRED — captures the design + deferral rationale + un-defer trigger conditions so a future implementer doesn't re-derive them. ~2-3 days of work to build out; deferred until Tier 1 misses a real-bug class or the plugin matures past Tier-1 coverage.

### Coverage upshot
- Plugin test suite: **169/169** across 18 files (was 144 across 16 in 0.2.10). Three panels (Decisions, Lineage, Supersessions) now fully covered by E2E rendering tests — DOM render correctness, SDK call shape, lifecycle handling, error paths, cache behavior, refresh-on-leaf-change.

## [0.2.10] — 2026-05-23 — Panel-rendering E2E harness (DIST-OBSIDIAN-E2E-1 Tier 1)

### Added
- **`tests/__mocks__/obsidian.ts` polyfilled with Obsidian-flavored DOM helpers** (`createDiv`, `createEl`, `createSpan`, `empty`, `addClass`, `setText`, `removeClass`, `toggleClass`) on `HTMLElement.prototype`. Idempotent, namespaced under `__sm_obsidian_polyfilled`. `ItemView` stub now constructs a real two-child `containerEl` matching the Obsidian runtime convention.
- **`tests/harness/panel-harness.ts`** — reusable `panelHarness({ decisions, memories, getMemoryId, settings })` factory + `fakeFile(path)` helper. Returns `{ plugin, mount, setActiveFile, setMemoryId }`. The fake plugin carries a real `PerIdCache` (cache behavior is part of what's verified) plus stubbable `client.decisions.list` / `client.memories.{neighbors,lineage}`. `mount(PanelClass)` constructs the panel, attaches its `containerEl` to a real DOM root, drives `onOpen()`, and returns hooks for `fireLeafChange()` and `refresh()`.
- **9 end-to-end rendering tests for `DecisionsPanel`** at `tests/decisions-panel-e2e.test.ts`:
  - empty active-file ⇒ "No active note." + zero API calls
  - active-file-without-memory-id ⇒ ingest hint + zero API calls
  - SDK call shape end-to-end (`provenance_memory_id` actually wired, `limit=50` actually passed)
  - empty server response ⇒ "No decisions derived from this note yet."
  - multi-decision render ⇒ status pills per status, content snippets, decision-id surface, domain + confidence meta
  - rejected fetch ⇒ error state with Retry button
  - active-leaf-change ⇒ re-fetch with new memory id
  - panelCache dedup ⇒ 3 renders → 1 network call
  - long content ⇒ truncated to ~120 chars with ellipsis

### Changed
- **`vitest.config.ts` environment switched from `node` → `jsdom`** so the polyfilled `HTMLElement.prototype` has a real DOM to attach to. Backwards-compatible: full plugin suite 153/153 green after the switch, including the 5 pure-helper `formatCreatedAt` tests and the 6 `extractSupersessionRows` tests.

### Notes
- Closes the verification gap on `DIST-OBSIDIAN-PANELS-1` Phase 5 (and on all earlier panels for which similar tests can be backfilled — same harness, ~15 min per panel).
- Tier 2 (Playwright/WebdriverIO against real Obsidian Electron with test vault + plugin installer + CI runners) is filed under `DIST-OBSIDIAN-E2E-1` plan but deferred — multi-day work, only justifiable once Tier 1 misses a real-bug class.

## [0.2.9] — 2026-05-23 — DecisionsPanel (DIST-OBSIDIAN-PANELS-1 Phase 5)

### Added
- **`SmartMemory decisions` right-sidebar panel** — lists active decisions whose provenance subgraph contains the current note's memory. Driven by the inverse-provenance query shipped in smart-memory-core 0.9.15 / smart-memory-service 0.4.16 (`GET /memory/decisions?provenance_memory_id=`, CORE-DECISION-PROVENANCE-LOOKUP-1). Server-side dual scope gate prevents cross-workspace leakage; unknown or out-of-scope memory ids return an empty list, never 404.
- New command **"Open decisions sidebar"** (`smartmemory-open-decisions-panel`).
- `DecisionAPI` shim added to `src/sdk-types.d.ts` for typed access to `client.decisions.list({ provenance_memory_id })`. The runtime SDK accepts arbitrary params via `URLSearchParams` pass-through, so the shim covers the keys we use without locking out future ones.

### Notes
- Semantics: "derived from" not "cites" — the underlying graph encodes provenance (the LLM-extraction / decision-creation chain), not authorial citation. The empty-state copy reflects that.
- Click-through to a decision viewer (web modal / inline panel) is a future enhancement; the panel ships read-only with the `decision_id` exposed as a stable handle.
- Transitive decision-chain provenance (`D2 CAUSED_BY D1 DERIVED_FROM M` returning both) is deferred to follow-up `CORE-DECISION-PROVENANCE-TRANSITIVE-1`; when that ships, this panel picks it up for free with no plugin changes.

## [0.2.8] — 2026-05-08 — Hide & purge legacy empty-content memories

### Fixed
- **Search and recall no longer render `(untitled)` rows.** Legacy ingests from before `services/ingest.ts:121` started rejecting empty content (e.g. YAML-only notes from 0.1.x) created server-side memories whose `content` field is empty after stripping. They still match search by entity graph or pre-strip embedding, but their rendered title is "(untitled)" with a blank snippet — useless. `SearchView` and `RecallModal` now filter these rows at render time.

### Added
- **Command: "Purge empty-content memories (legacy YAML-only ingests)".** Pages through `/memory/list`, finds items where `content.trim()` is empty, and deletes them server-side. Surgical alternative to "Danger: purge all Obsidian-origin memories" — only removes the dead orphans, keeps real notes.

## [0.2.7] — 2026-05-07 — DIST-OBSIDIAN-PANELS-1 Phase 4: Supersessions panel

### Added
- **`SupersessionsPanel`** (`src/views/supersessions-panel.ts`) — right-sidebar list of every supersession relationship for the active note's memory ("supersedes" / "is superseded by"). Builds on `/memory/{id}/neighbors` filtered for SUPERSEDES / SUPERSEDED_BY edges with direction. Adds value the existing contradiction banner doesn't expose: the banner returns only the FIRST finding via `checkSupersession()`; this panel lists all of them. Command: `SmartMemory: Open supersessions sidebar`.
- Pure helper `extractSupersessionRows()` extracted for unit testing — encodes the SUPERSEDES vs SUPERSEDED_BY × outgoing vs incoming asymmetry rules.

### Pivoted from plan
- The plan called for a "Contradictions panel" reading `/memory/{id}/contradictions`. That endpoint does not exist in the service — what the existing banner calls "contradictions" is supersession via `/neighbors`. Renamed to match reality.

### Tests
- 6 new `extractSupersessionRows` tests covering canonical SUPERSEDES, legacy SUPERSEDED_BY, missing-direction skip, unrelated link types, multiple-rows pass-through. 139/139 green.

### Deferred
- Phase 5 DecisionsPanel — needs service-side `/decisions?cites_memory_id=` filter first. Filed as DIST-OBSIDIAN-DECISIONS-PANEL-1 follow-up.

## [0.2.6] — 2026-05-07 — DIST-OBSIDIAN-PANELS-1 Phase 2 & 3: Lineage panel

### Added
- **`SmartMemoryPanelBase`** (`src/views/panel-base.ts`) — abstract `ItemView` capturing the shared shape every right-panel view needs: follow active leaf, read `smartmemory_id`, increment a `refreshSeq` so stale fetches drop, render error/empty/loading states uniformly. Subclasses implement only `render(root, memoryId, seq)`.
- **`PerIdCache`** (`src/services/per-id-cache.ts`) — keyed `(memoryId, endpoint)` cache with 30s TTL and concurrent-call de-duplication. Multiple panels open simultaneously make exactly one request per id+endpoint per refresh window. Mounted as `plugin.panelCache`. Failed fetches are dropped from the cache so retries work; resolved values reused.
- **`LineagePanel`** (`src/views/lineage-panel.ts`) — right-sidebar timeline of a memory's derivation chain (`/memory/{id}/lineage`). Follows the active note. Same data path as the existing `LineageModal`; the modal stays for deep-dive use, the panel is the ambient version. Command: `SmartMemory: Open lineage sidebar`.

### Tests
- 7 new `PerIdCache` tests covering concurrent de-dup, TTL, error retry, key isolation, and selective invalidation. 133/133 green.

## [0.2.5] — 2026-05-07 — DIST-OBSIDIAN-PANELS-1 Phase 1: frontmatter master toggle

### Changed
- **Replaced four enrichment toggles with one master switch.** `enrichEntities`, `enrichRelations`, `enrichMemoryType`, and `enrichSyncTimestamp` collapse into `writeFrontmatterEnrichment`. `writeFrontmatterId` stays separate — it's load-bearing for note ↔ memory linking, contradiction detection, mapping recovery on import, and every right-panel view. New default for the enrichment toggle: **OFF** (clean YAML for new installs).
- **Non-destructive migration on first load.** If saved settings carried any prior `enrich*: true`, that intent migrates to the master ON. Otherwise, scan vault frontmatter — if any note has `smartmemory_entities`, default ON to preserve existing Dataview/Bases dashboards. Fresh installs and clean opt-outs default OFF. Migration is one-shot, gated by `migratedFrontmatterToggle`.
- **Settings UI consolidated.** Two toggle rows under the new "Frontmatter" section instead of five. New copy explains the Dataview/Bases use case explicitly so users understand the trade-off.

### Tests
- 5 new migration decision-rule tests in `tests/frontmatter-migration.test.ts`.
- Updated existing frontmatter and ingest tests to use the master toggle. 126/126 green.

## [0.2.4] — 2026-05-07 — Hide OriginLegend in graph view

### Changed
- **Pass `showOriginLegend={false}` to `<GraphExplorer>`.** The legend overlay floats above the canvas and crowds the narrow pane Obsidian allocates to plugin views. Origin information is still encoded as the node border color/style (legacy = dashed, derived/system = colored borders), so the signal is preserved on the canvas itself. Web/Studio/Insights still show the legend by default. Existing prop on the shared component — no API change.

## [0.2.3] — 2026-05-07 — Quieter startup diagnostic

### Changed
- **Startup `Notice` only fires on hard blockers.** `surfaceLoadState()` previously toasted on every plugin load with a 10-second summary that mixed connection problems (no API key, no API URL) with user configuration choices (auto-ingest-on-save OFF, workspace auto-discovering). Mixing the two trained users to dismiss the toast, which then hid the genuine "no API key" case when it appeared. The toast now fires only when API key or API URL is missing — the user-fixable blockers — and points to the settings panel. Auto-ingest flags belong in the settings UI / status bar, not in a startup popup.
- **Console log retained.** `console.log('[smartmemory] load state', …)` still runs unconditionally so support can ask users to copy it verbatim. `/smartmemory diagnose` (`main.ts:544`) gives the same on-demand readout for users who can't open devtools. The console payload now includes the bundle version so support tickets always carry it.

## [0.2.2] — 2026-05-07 — Preserve per-type node colors when theming

### Fixed
- **Restore semantic node colors.** 0.2.1 collapsed memory/entity/grounding fills to a single `--graph-node` color, which made the legend (OriginLegend, FilterPanel) misleading — the swatches show per-type colors but the canvas painted everything grey. `resolveTheme()` no longer sets `palette.node`, so the per-type semantic palette is preserved. Edge color, label color, label outline, and selection border still come from Obsidian's CSS variables, so chrome continues to follow the active theme.

### Distribution
- Added `versions.json` entries for 0.2.1 and 0.2.2 so the Obsidian community plugin registry doesn't reject them as missing-version. Note: prior to this round, GitHub Releases were only cut up to 0.1.14 — 0.2.0 + 0.2.1 + 0.2.2 still need releases pushed manually (or via a future workflow) before community-registry users see them.

## [0.2.1] — 2026-05-07 — Obsidian-native graph theming

The embedded `@smartmemory/graph` viewer now matches whatever Obsidian theme the user has loaded — default dark/light, community themes (Minimal, Things, AnuPpuccin), or user CSS snippets.

### Changed
- **Graph canvas reads Obsidian's live CSS variables.** `GraphView.resolveTheme()` resolves `--graph-node`, `--graph-line`, `--graph-text`, `--background-primary`, and `--interactive-accent` via `getComputedStyle(document.body)` and passes them as a `palette` object to `<GraphExplorer theme={...}>` (new prop in `@smartmemory/graph` 0.2.3). This is the same data path Obsidian's own native graph view uses, so theme parity is automatic — no per-theme mapping needed. Plugin re-renders on the workspace `css-change` event, so theme switches and CSS-snippet edits propagate live. Other consumers of the shared package (web, studio, insights) pass no `theme` and are unaffected.
- **Graph chrome adopts Obsidian CSS variables.** New rules in `src/styles.base.css`, scoped under `.smartmemory-graph-view`, redirect Tailwind slate/gray utilities to `--background-primary`/`--background-secondary`/`--text-normal`/`--background-modifier-border` so toolbars, panels, and search controls follow the active Obsidian theme.

## [0.2.0] — 2026-04-30 — DIST-OBSIDIAN-LITE-1: zero-Docker install via smartmemory daemon

The plugin now works end-to-end against `smartmemory daemon` (DIST-DAEMON-1), so users can install with `pip install smartmemory && smartmemory daemon start` — no Docker, no FalkorDB+Redis+Mongo. See [`smart-memory-docs/docs/features/DIST-OBSIDIAN-LITE-1/`](https://github.com/smart-memory/smart-memory-docs/tree/main/docs/features/DIST-OBSIDIAN-LITE-1) for the full design + blueprint + report.

### Added
- **Lite-mode auto-detection.** After every successful connection the plugin probes `GET /health` and reads `mode` + `capabilities`. `runtime.isLite` flips UI affordances. Probe failure preserves last-known mode (a transient daemon hiccup must not flip a known-lite session back to cloud).
- **Cloud / Local radio in onboarding.** First-launch modal asks where data lives. Local path defaults `apiUrl` to `http://127.0.0.1:9014`, hides the API key field, and offers a "Connect to local daemon" button that persists settings before opening the settings tab.
- **Mode dropdown in settings.** Mirror of the onboarding radio. Switching modes rewrites `apiUrl` between hosted and daemon defaults (only when the URL was on the *other* mode's default — custom URLs survive). API key field hidden when lite is selected.
- **"Sync to cloud" affordance.** When `runtime.isLite === true`, the upgrade modal codepath swaps to a new `SyncToCloudModal` pitching backup + cross-device + teams instead of a quota upgrade. Primary action opens `https://app.smartmemory.ai/signup?ref=obsidian-lite`.
- New `src/services/health.ts` with `probeHealth()` + `HealthMode` union. Validates response `mode` against the known union literal so daemon evolutions don't propagate arbitrary strings as a typed `HealthMode`.
- 12 new tests: 9 health-probe tests (lite/cloud/missing-mode/network-failure/non-200/`/memory`-suffix stripping) + 3 quota-errors lite-reroute tests.

### Notes
- This release pairs with daemon changes shipping in the `smart-memory` repo simultaneously: `PATCH /{id}` (new), `DELETE /{id}` (lifted from 405 → 204/404 with vector-store cascade), `POST /ingest` and `POST /search` accept the SDK's contract shapes, `/neighbors` carries `direction` per neighbor, `/health` exposes `mode` + `capabilities`. Older daemons (pre-DIST-OBSIDIAN-LITE-1) report `mode: undefined` and the plugin defaults to cloud behavior — backward compatible.
- "Sync to cloud" only replaces the upgrade modal when the plugin has detected lite mode. If the daemon is unreachable on first connection, the plugin assumes cloud and shows the historical upgrade copy. Re-probe runs on every reconnection.

## [0.1.12] — 2026-04-30 — DIST-OBSIDIAN-1 Phase 7 close-out

### Fixed
- **Quota-error mapping aligned to actual server contract.** Server returns `429` (not `403`) with `detail: "Memory quota exceeded"` and `detail: "Daily query quota exceeded"` for the two cases. The previous handler matched only `status === 403` for memory quota — meaning a free-tier user hitting the ingest cap would have seen "daily limit reached" notice instead of the upgrade modal, silently breaking the distribution funnel. Disambiguates via `detail` string.
- **Re-ingest path no longer duplicates remote items on transient errors.** The existence-check on the unchanged-content path treated any `get()` failure as a 404, deleted the local mapping, and re-ingested — creating duplicate remote items on flaky networks. Now distinguishes 404 (re-ingest) from other statuses (re-throw).
- **Enrichment polling completes for notes with zero extracted entities.** `Array.isArray(entities)` is the terminal signal, not `entities.length > 0`. Notes that legitimately extract zero entities now write back memory_type and sync timestamp instead of timing out.
- **Cleared search query no longer repopulates with stale results.** `requestSeq` advances on the empty-query branch so any in-flight search resolves into the no-op path.
- **Mapping store rename/delete cleans up `entityToFile`.** Renaming or deleting a note used to leave stale entity → file pointers, causing auto-link to propose links to nonexistent or wrong files. Both rename and delete now re-point/prune the entity map.
- **Re-enrichment with shrunken entity sets prunes stale auto-link targets.** New `replaceEntitiesForFile()` operation atomically replaces all entities owned by a file. Without it, an entity that disappears from the extraction would linger forever as an auto-link target.
- **Contradiction banner now direction-aware.** The decision system writes only one canonical edge (`newer -[SUPERSEDES]-> older`); without direction info, opening a *superseded* note showed "This note supersedes another" — exactly inverted. Plugin now reads the new `direction` field on `/neighbors` responses and refuses to render rather than guess if the field is missing.

### Changed
- `Settings → Exclude folders` description now says "path prefixes" (matching the actual prefix-based matcher) instead of misleadingly claiming glob support.

### Added
- 21 new tests pinning the above fixes: `quota-errors.test.ts` (6), `regressions.test.ts` (7), 8 rewritten contradiction tests covering canonical / forward-compat / missing-direction guard. Total: **108 tests passing**, 10 test files.

## [0.1.7] — 2026-04-30

### Fixed
- **Graph pane renders edges again.** Two bugs were silently collapsing the layout into a row/grid arrangement:
  1. `GraphCache.fetch()` now normalizes server field names at the API boundary — server returns `item_id`/`source_id`/`target_id`/`edge_type`; SDK passes them through raw; plugin internals expect `id`/`source`/`target`/`type`. Without normalization every edge's `source`/`target` was `undefined`, BFS produced no adjacency, focus lookup missed, every render path silently degraded.
  2. `GraphView.refresh()` no-focus fallback branch hardcoded `edges: []`. With zero edges the `cose` force layout has no springs to relax against, so 13 nodes laid out top-down. The branch now keeps every edge whose endpoints survived the slice.
- 4 regression tests pin the field-name contract so a future SDK or server rename doesn't silently re-break the graph.

### Changed
- Switched graph pane layout from `cytoscape-cose-bilkent` (registration via `cytoscape.use()` was unreliable under Obsidian's bundled Electron renderer) to Cytoscape's built-in `cose`. No extension means no silent fallback to `grid`. Bundle dropped 600KB → 538KB as a side effect.
- Graph node styling: removed `as cytoscape.StylesheetCSS[]` cast (wrong type — that's for stringified rule sheets). Programmatic style objects now apply correctly: 14px node radius, 10px font, ellipsis label truncation at 120px, dashed edges for extracted relations, solid for `PART_OF`/`SUPERSEDES`.

### Added
- `[smartmemory-graph]` console diagnostics: full-graph response counts, BFS rendered counts, refresh trigger and focus-resolution outcomes. `console.log` (not `console.debug`, which DevTools' default level filter hides).

## [0.1.4] — 2026-04-30

### Added
- `scripts/bump-patch.mjs` + `.husky/pre-commit` — auto-bumps the patch in `package.json`, `manifest.json`, and `versions.json` whenever `src/`, `manifest.json`, or `package.json` is staged. Skip with `SKIP_BUMP=1`. Respects manual bumps (won't second-guess if version already changed). Does not touch `CHANGELOG.md` — that needs human prose.
- Husky added as devDependency; `npm run prepare` installs the hook on a fresh clone.

### Changed
- `SearchService` now dedupes results client-side by `item_id`. The server's RRF merge across hybrid / multi-hop channels can return the same item more than once when it scores in multiple channels; until the server enforces uniqueness, the plugin keeps the first occurrence and drops subsequent dupes.

## [0.1.3] — 2026-04-30

DIST-OBSIDIAN-1 Phase 7 hardening pass. Auto-ingest is now safe to leave on without creating duplicate server-side memories, and the search/entity/graph panes are reachable via the command palette.

### Added
- Command `SmartMemory: Open search pane` — opens the plugin's search view in the right sidebar (previously only registered, never reachable).
- Command `SmartMemory: Open entities pane` — opens the entity backlinks view in the right sidebar.
- Command `SmartMemory: Danger: purge all Obsidian-origin memories from this workspace` — recovery path for users hit by historical feedback loops; deletes every server item with `origin: "import:obsidian*"` and clears `smartmemory_*` frontmatter on every local note.
- Command `SmartMemory: Diagnose ingest loop` — prints memory counts and active-note mapping to console + notice for verifying loop health.
- Search view: result cards now show a title (first non-empty content line, truncated) above the snippet.
- Search view: `stripLeadingYaml()` defensively removes legacy frontmatter blocks from snippet text so historic items render cleanly.
- Frontmatter `smartmemory_relations` now populates from non-`CONTAINS_ENTITY` neighbor edges (`RELATES_TO`, `IS_A`, etc.); previously hard-coded to `[]`.

### Changed
- Entity-name search field is now a query hint (folded into the search query string) rather than a client-side post-filter on `item.entities`. The post-filter never matched in practice because `/memory/search` does not return populated `entities` arrays for graph-extracted items.
- Search view: clearing the query box now bumps the request sequence so any in-flight search resolves into the empty-results branch instead of repopulating the cleared pane.
- Quota error handler disambiguates server `429` responses by the `detail` string. Previously routed memory-quota responses (`"Memory quota exceeded"`) into the daily-rate-limit notice path; they now correctly open the upgrade modal.
- Settings: "Exclude folders" description now reads "path prefixes" (matches the actual matcher) instead of "glob patterns".
- `MappingStore.handleRename` / `handleDelete` now also update `entityToFile` so auto-link does not propose stale wikilinks after a rename or delete.
- `MappingStore.replaceEntitiesForFile()` (new) atomically replaces all entity mappings owned by a given file; used during enrichment to prune entities that disappeared on re-extraction.
- Enrichment poll now treats `Array.isArray(item.entities)` as the terminal signal, including empty arrays. Notes that legitimately extract zero entities now complete instead of polling to timeout.
- Re-ingest existence check distinguishes 404 (true not-found, drop mapping and re-ingest) from transient 5xx (re-throw to caller). Previously any error path treated the remote as gone and silently created a duplicate.

### Workaround
- On content-change ingest, the plugin now deletes the prior server memory before ingesting the new content. **This is a workaround for missing server-side ingest dedupe**; tracked as [`CORE-INGEST-DEDUPE-1`](../smart-memory-docs/docs/features/CORE-INGEST-DEDUPE-1/design.md). Once the server returns `status: unchanged | replaced` from `/memory/ingest`, this client-side dance should be removed.

### Fixed
- **Auto-ingest feedback loop:** an Obsidian save with auto-ingest on no longer creates a duplicate server memory each time. Loop signature: 124 server memories from a single note across a few hours of testing.
- Tests: 13 new regression tests pinning the Codex review fixes (transient-vs-404, empty-array enrichment, entity-mapping prune, etc.).

### Notes
- Bundle size: `main.js` is ~600KB, well above the original plan's 200KB target. Cytoscape + cose-bilkent dominate. Tracked for a future optimization pass.
- Phase 7 step 2 (E2E smoke test in Obsidian dev vault) found four bugs that the unit-test suite missed entirely. Worth a golden-flow harness as a follow-up.

## [0.1.2] — 2026-04-29
Pre-DIST-OBSIDIAN-1-Phase-7. Initial 12-task implementation; details predate this changelog.

## [0.1.1] — 2026-04-29
Initial public scaffold and SDK integration.

## [0.1.0] — 2026-04-29
Project scaffolded.
