import { Plugin, Notice } from 'obsidian';

// Injected by esbuild's `define`; see esbuild.config.mjs.
declare const __SMARTMEMORY_VERSION__: string;
import { SmartMemoryClient } from 'smartmemory-sdk-js/core';
import { createObsidianFetch } from './transport';
import { resolveClientConfig } from './services/client-config';
import type { HealthCapabilities } from './services/health';
import { SmartMemorySettingTab } from './settings';
import { StatusBarController } from './status-bar';
import { MappingStore } from './bridge/mapping-store';
import { migrateLegacyFrontmatter, readSmartMemoryId } from './bridge/frontmatter';
import { IngestService } from './services/ingest';
import { SearchService } from './services/search';
import { ContradictionService } from './services/contradiction';
import { PerIdCache } from './services/per-id-cache';
import { registerIngestCommands } from './commands/ingest';
import { registerSearchCommands } from './commands/search';
import { registerAutolinkCommand } from './commands/autolink';
import { SearchView, SEARCH_VIEW_TYPE } from './views/search-view';
import { EntityView, ENTITY_VIEW_TYPE } from './views/entity-view';
import { GraphView, GRAPH_VIEW_TYPE } from './views/graph-view';
import { LineagePanel, LINEAGE_PANEL_TYPE } from './views/lineage-panel';
import { SupersessionsPanel, SUPERSESSIONS_PANEL_TYPE } from './views/supersessions-panel';
import { DecisionsPanel, DECISIONS_PANEL_TYPE } from './views/decisions-panel';
import { ContradictionBanner } from './enrichers/contradiction';
import { InlineSuggestions } from './enrichers/suggestions';
import { VaultEvents } from './services/vault-events';
import { OnboardingModal, showFirstIngestTour } from './views/onboarding-modal';
import { DEFAULT_SETTINGS, EMPTY_MAPPINGS, SmartMemorySettings, PluginData } from './types';
import { UPGRADE_URL } from './util/quota-errors';
import { isPathExcluded } from './util/exclusions';

export default class SmartMemoryPlugin extends Plugin {
	settings: SmartMemorySettings = DEFAULT_SETTINGS;
	client: SmartMemoryClient | null = null;
	statusBar: StatusBarController | null = null;
	mappingStore: MappingStore = new MappingStore({ ...EMPTY_MAPPINGS });
	ingestService: IngestService | null = null;
	searchService: SearchService | null = null;
	contradictionService: ContradictionService | null = null;
	contradictionBanner: ContradictionBanner | null = null;
	inlineSuggestions: InlineSuggestions | null = null;
	vaultEvents: VaultEvents | null = null;
	/** Shared per-id endpoint cache used by right-panel views to coordinate
	 *  fetches and avoid N round trips per active-leaf change. */
	panelCache: PerIdCache = new PerIdCache();
	/** DIST-OBSIDIAN-LITE-1: set by health probe on each (re)connection.
	 * Drives UI affordances — onboarding radio default, "Sync to cloud"
	 * affordance copy, hidden API key field, etc.
	 * Defaults to false (cloud assumption) until /health says otherwise. */
	isLite = false;
	/** DIST-OBSIDIAN-LITE-PARITY-1: capability map from the /health probe.
	 * null until the probe lands (or in cloud mode, where /health may not
	 * carry a capabilities block). Drives explicit panel degradation —
	 * see capabilityAvailable(). */
	capabilities: HealthCapabilities | null = null;
	/** Increments each time the client is reinitialized; used to discard stale async results. */
	private clientGeneration = 0;
	/** Tail of pending saveData() calls; new writes chain off it so we never
	 *  have two saveData() in flight against the same blob. */
	private writeTail: Promise<void> = Promise.resolve();

	async onload(): Promise<void> {
		await this.loadSettings();

		const statusEl = this.addStatusBarItem();
		this.statusBar = new StatusBarController(statusEl);
		this.statusBar.setActions({
			onIngest: () => this.runCommand('smartmemory-ingest-current-note'),
			onSearch: () => this.runCommand('smartmemory-open-search'),
			onSettings: () => (this.app as any).setting?.open?.(),
			onUpgrade: () => window.open(UPGRADE_URL, '_blank'),
		});

		this.addSettingTab(new SmartMemorySettingTab(this.app, this));

		this.initClient();
		registerIngestCommands(this);
		registerSearchCommands(this);
		registerAutolinkCommand(this);

		this.contradictionBanner = new ContradictionBanner(this);
		this.contradictionBanner.start();

		this.inlineSuggestions = new InlineSuggestions(this);
		this.inlineSuggestions.start();

		this.vaultEvents = new VaultEvents(this);
		this.vaultEvents.register();

		// First-launch onboarding (deferred so workspace is ready)
		if (!this.settings.hasCompletedOnboarding) {
			this.app.workspace.onLayoutReady(() => {
				new OnboardingModal(this.app, this).open();
			});
		}

		// Backfill memory→file mappings from vault frontmatter on every load.
		// Without this, items ingested before mapping persistence shipped (or
		// from an earlier vault, or any path that wrote `smartmemory_id` to
		// frontmatter without persisting the store) appear unmapped to recall
		// and trigger the "create new note" branch on Open. Cheap to run —
		// metadataCache is already warm by onLayoutReady.
		this.app.workspace.onLayoutReady(() => {
			void this.initializeOkfFrontmatter();
		});

		this.registerView(SEARCH_VIEW_TYPE, (leaf) => new SearchView(leaf, this));
		this.registerView(ENTITY_VIEW_TYPE, (leaf) => new EntityView(leaf, this));
		this.registerView(GRAPH_VIEW_TYPE, (leaf) => new GraphView(leaf, this));
		this.registerView(LINEAGE_PANEL_TYPE, (leaf) => new LineagePanel(leaf, this));
		this.registerView(SUPERSESSIONS_PANEL_TYPE, (leaf) => new SupersessionsPanel(leaf, this));
		this.registerView(DECISIONS_PANEL_TYPE, (leaf) => new DecisionsPanel(leaf, this));

		this.addCommand({
			id: 'smartmemory-open-graph',
			name: 'Open knowledge graph pane',
			callback: async () => {
				const leaf = this.app.workspace.getLeaf();
				await leaf.setViewState({ type: GRAPH_VIEW_TYPE, active: true });
				this.app.workspace.revealLeaf(leaf);
			},
		});

		// "Open search sidebar" + "Open entity backlinks sidebar" + recall hotkey
		// are registered in registerSearchCommands(this) above. Don't re-add
		// the same ids here — Obsidian silently shadows the prior registration
		// when an id collides.

		this.addCommand({
			id: 'smartmemory-purge-obsidian-origin',
			name: 'Danger: purge all Obsidian-origin memories from this workspace',
			callback: async () => {
				await this.purgeObsidianOriginMemories();
			},
		});

		this.addCommand({
			id: 'smartmemory-purge-empty-memories',
			name: 'Purge empty-content memories (legacy YAML-only ingests)',
			callback: async () => {
				await this.purgeEmptyContentMemories();
			},
		});

		this.addCommand({
			id: 'smartmemory-diagnose-loop',
			name: 'Diagnose ingest loop (counts memories, prints to console)',
			callback: async () => {
				await this.diagnoseLoop();
			},
		});

		// Refresh side views when active note changes
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				for (const leaf of this.app.workspace.getLeavesOfType(ENTITY_VIEW_TYPE)) {
					const view = leaf.view;
					if (view instanceof EntityView) void view.refresh();
				}
				for (const leaf of this.app.workspace.getLeavesOfType(GRAPH_VIEW_TYPE)) {
					const view = leaf.view;
					if (view instanceof GraphView) {
					// GraphExplorer subscribes to its own focus state — the
					// view re-renders on active-leaf-change internally.
				}
				}
			})
		);

		// Connection test on load (non-blocking)
		this.testConnection().catch(() => {
			// Failure already reflected in status bar
		});

		// Diagnostic: surface plugin state on load so users (and the smoke
		// test) can confirm at a glance what's wired vs missing. The notice
		// lingers ~10s; set NODE_ENV=production builds keep it for parity.
		this.surfaceLoadState();
	}

	private surfaceLoadState(): void {
		const cfg = this.settings;
		const hasKey = !!this.resolveApiKey();
		// Build-time version, injected by esbuild via `define` from
		// package.json. Always in sync with manifest.json + versions.json
		// because the husky pre-commit hook bumps all three together.
		const BUNDLE_TAG = __SMARTMEMORY_VERSION__;

		// Hard blockers only — these prevent the plugin from doing anything
		// useful, so a startup Notice is appropriate. User-configurable flags
		// (auto-ingest on save/create, workspace auto-discovery) are choices,
		// not diagnostics, and live in the settings panel + status bar.
		const blockers: string[] = [];
		// An API key is only a blocker in cloud mode — the lite daemon has no auth.
		if (!hasKey && cfg.mode !== 'lite') blockers.push('no API key');
		if (!cfg.apiUrl) blockers.push('no API URL');

		if (blockers.length > 0) {
			new Notice(
				`SmartMemory [${BUNDLE_TAG}]: ${blockers.join(', ')} — open settings to fix.`,
				10000,
			);
		}

		// Always log full state so support can ask the user to copy the
		// console line verbatim. /smartmemory diagnose offers the same
		// readout on demand for users who can't open devtools.
		console.log('[smartmemory] load state', {
			version: BUNDLE_TAG,
			apiUrl: cfg.apiUrl,
			hasApiKey: hasKey,
			workspaceId: cfg.workspaceId || '(auto)',
			autoIngestOnSave: cfg.autoIngestOnSave,
			autoIngestOnCreate: cfg.autoIngestOnCreate,
			ingestDebounceMs: cfg.ingestDebounceMs,
		});
	}

	onunload(): void {
		this.client = null;
		// Tear down the status bar's document-level menu listener before
		// dropping the reference, or it leaks past unload.
		this.statusBar?.dispose();
		this.statusBar = null;
		this.ingestService = null;
		this.searchService = null;
		this.contradictionService = null;
		this.contradictionBanner = null;
		this.inlineSuggestions?.stop();
		this.inlineSuggestions = null;
		this.vaultEvents = null;
	}

	private initClient(): void {
		this.clientGeneration += 1;
		// Cloud requires an API key; lite connects keyless (the daemon reports
		// auth:false). See resolveClientConfig — DIST-OBSIDIAN-LITE-PARITY-1.
		const decision = resolveClientConfig({
			mode: this.settings.mode,
			apiUrl: this.settings.apiUrl,
			apiKey: this.resolveApiKey(),
		});
		if (!decision.connect) {
			this.client = null;
			this.ingestService = null;
			this.searchService = null;
			this.contradictionService = null;
			this.statusBar?.setStatus('disconnected');
			return;
		}

		this.client = new SmartMemoryClient({
			// Keyless in lite mode: omitting mode+apiKey makes the SDK send no
			// Authorization header (AuthCore only sets it when a token exists).
			...(decision.auth === 'apiKey' ? { mode: 'apiKey', apiKey: decision.apiKey } : {}),
			apiBaseUrl: this.settings.apiUrl,
			fetchFn: createObsidianFetch(),
		});

		if (this.settings.workspaceId) {
			this.client.setTeamId(this.settings.workspaceId);
		} else if (decision.discoverWorkspace) {
			// Auto-discover from /auth/me — the API key already binds a tenant
			// and the user has a default workspace. Cache the result back into
			// settings so we don't re-fetch on every reconnect. Skipped in lite
			// mode: the daemon is single-tenant and exposes no /auth/me.
			void this.discoverWorkspace(this.clientGeneration);
		}

		this.searchService = new SearchService(this.client);
		this.contradictionService = new ContradictionService(this.client);

		this.maybeStartIngestService();
	}

	private async discoverWorkspace(generation: number): Promise<void> {
		const client = this.client;
		if (!client) return;
		try {
			const me: any = await (client as any).authAPI.getCurrentUser();
			// Stale: settings or client changed while we were waiting
			if (generation !== this.clientGeneration) return;
			const teamId = me?.default_team_id || me?.user?.default_team_id;
			if (teamId && !this.settings.workspaceId) {
				this.client?.setTeamId(teamId);
				this.settings.workspaceId = teamId;
				void this.saveSettings();
				void this.migrateLegacyVaultFrontmatter().then(() => this.backfillMappingsFromVault());
			}
		} catch {
			// Discovery is best-effort; manual entry is still available.
		}
	}

	private maybeStartIngestService(): void {
		if (!this.client) return;
		this.ingestService = new IngestService({
			client: this.client,
			app: this.app,
			mappingStore: this.mappingStore,
			settings: this.settings,
			onMappingsChanged: () => this.saveMappings(),
			onEvent: (event) => {
				if (event.type === 'batch-progress') {
					this.statusBar?.setStatus('syncing');
				} else if (event.type === 'ingest-complete') {
					this.statusBar?.setLastSync(new Date());
					showFirstIngestTour(this);
				} else if (event.type === 'enrichment-complete') {
					this.statusBar?.setLastSync(new Date());
				} else if (event.type === 'enrichment-timeout') {
					this.surfaceEnrichmentTimeout(event.path);
				}
			},
		});
	}

	/**
	 * Surface enrichment timeouts with a clickable Retry action. Long
	 * extractions (LLM rate-limit, queue) outrun the 12s poll budget; the
	 * retry path re-runs only the enrichment poll, not full ingest.
	 */
	private surfaceEnrichmentTimeout(path: string): void {
		const fragment = document.createDocumentFragment();
		const text = document.createElement('span');
		text.textContent = `SmartMemory: enrichment is still running for "${path}". `;
		fragment.appendChild(text);
		const retry = document.createElement('a');
		retry.textContent = 'Retry';
		retry.style.cursor = 'pointer';
		retry.style.textDecoration = 'underline';
		retry.addEventListener('click', () => {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file && this.ingestService) {
				void this.ingestService.enrichFile(file as any).catch((err) => {
					console.error('[smartmemory] retry enrich failed', err);
				});
				new Notice(`Retrying enrichment for ${path}…`, 3000);
			}
		});
		fragment.appendChild(retry);
		new Notice(fragment, 12000);
	}

	/**
	 * Resolve API key with env var override.
	 * SMARTMEMORY_API_KEY > settings.apiKey
	 */
	private resolveApiKey(): string {
		const envKey = (typeof process !== 'undefined' && process.env?.SMARTMEMORY_API_KEY) || '';
		return envKey || this.settings.apiKey;
	}

	async testConnection(): Promise<boolean> {
		const generation = this.clientGeneration;
		const client = this.client;
		if (!client) {
			this.statusBar?.setStatus('disconnected');
			return false;
		}
		try {
			this.statusBar?.setStatus('syncing');
			const result = await client.memories.list({ limit: 1 });
			// Discard if a settings change reinitialized the client during the await
			if (generation !== this.clientGeneration) return false;
			this.statusBar?.setStatus('connected');
			this.statusBar?.setCount(result.total || 0);
			this.statusBar?.setLastSync(new Date());
			// DIST-OBSIDIAN-LITE-1: probe /health to learn whether we're talking
			// to a lite daemon or the hosted service. Failure defaults to cloud
			// assumption — never block the connection on the capability probe.
			void this.refreshLiteMode();
			return true;
		} catch (err) {
			if (generation !== this.clientGeneration) return false;
			this.statusBar?.setStatus('disconnected');
			return false;
		}
	}

	/** DIST-OBSIDIAN-LITE-1: probe /health and update isLite. */
	private async refreshLiteMode(): Promise<void> {
		const generation = this.clientGeneration;
		try {
			const { probeHealth } = await import('./services/health');
			const result = await probeHealth(this.settings.apiUrl);
			// Discard if settings changed during the await
			if (generation !== this.clientGeneration) return;
			// Only update isLite when the probe actually landed. A transient
			// network failure on a known-lite daemon must not flip UI back to
			// cloud (would briefly surface API-key field, billing modal, etc.).
			if (result.probed) {
				this.isLite = result.isLite;
				// Capture the capability map so panels can degrade explicitly
				// (DIST-OBSIDIAN-LITE-PARITY-1). Refresh open panels if the
				// availability picture changed, so a panel that opened before
				// the probe landed swaps its error state for the right message.
				const changed = JSON.stringify(this.capabilities) !== JSON.stringify(result.capabilities);
				this.capabilities = result.capabilities;
				if (changed) this.refreshOpenViews();
				// Drift diagnostic: the user's chosen mode disagrees with what
				// the endpoint actually is (e.g. mode=cloud but apiUrl points at
				// a live lite daemon, or vice-versa). Surface it — this is the
				// exact confusion behind "graph asks for auth in lite mode".
				const endpointMode = result.mode === 'remote' ? 'cloud' : result.mode;
				if (endpointMode && endpointMode !== this.settings.mode) {
					console.warn(
						`[smartmemory] mode drift: settings say "${this.settings.mode}" but ${this.settings.apiUrl} reports "${result.mode}". ` +
						`The plugin will behave per the live endpoint; align the Mode setting to remove this warning.`,
					);
				}
			}
		} catch {
			// Health module shouldn't throw, but if it does, preserve last-known.
		}
	}

	/**
	 * Is a /health capability available on the connected backend?
	 *
	 * Default-true: unknown capabilities (cloud, or before the probe lands)
	 * are assumed available so we never hide a working feature. Only an
	 * explicit `false` from the daemon degrades a panel. DIST-OBSIDIAN-LITE-PARITY-1.
	 */
	capabilityAvailable(name: keyof HealthCapabilities): boolean {
		const caps = this.capabilities as Record<string, boolean> | null;
		return !caps || caps[name as string] !== false;
	}

	/** Re-render every open SmartMemory view (right-panels + graph). Used after
	 *  a connection/mode change so switching cloud↔lite is seamless rather than
	 *  showing stale state until the next active-leaf-change.
	 *  DIST-OBSIDIAN-LITE-PARITY-1. */
	refreshOpenViews(): void {
		const types = [
			LINEAGE_PANEL_TYPE,
			SUPERSESSIONS_PANEL_TYPE,
			DECISIONS_PANEL_TYPE,
			GRAPH_VIEW_TYPE,
		];
		for (const type of types) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				const view = leaf.view as { refresh?: () => void } | undefined;
				view?.refresh?.();
			}
		}
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as PluginData | null;
		const savedSettings = (data?.settings || {}) as SmartMemorySettings & Record<string, unknown>;
		this.settings = { ...DEFAULT_SETTINGS, ...savedSettings };
		this.mappingStore = new MappingStore(data?.mappings || EMPTY_MAPPINGS);

		// This migration must finish before VaultEvents are registered. Otherwise
		// the merged OKF defaults can write resource/type during startup even when
		// a legacy install explicitly persisted writeFrontmatterId=false.
		if (!this.settings.migratedOkfSettings) {
			if (!Object.prototype.hasOwnProperty.call(savedSettings, 'okfConformance')) {
				this.settings.okfConformance = savedSettings.writeFrontmatterId !== false;
			}
			if (!Object.prototype.hasOwnProperty.call(savedSettings, 'writeSmartMemoryExtension')) {
				this.settings.writeSmartMemoryExtension =
					savedSettings.writeFrontmatterEnrichment === true ||
					savedSettings.enrichEntities === true ||
					savedSettings.enrichRelations === true ||
					savedSettings.enrichMemoryType === true ||
					savedSettings.enrichSyncTimestamp === true;
			}
			this.settings.migratedOkfSettings = true;
			await this.serializedSave();
			console.log(
				`[smartmemory] migrated OKF settings: okfConformance=${this.settings.okfConformance}, ` +
				`writeSmartMemoryExtension=${this.settings.writeSmartMemoryExtension}`,
			);
		}

		// Pre-onboarding migration: until a user completes onboarding, honor the
		// current defaults for seamless ingest rather than whatever was persisted
		// during earlier development versions. Without this, users who installed
		// before the seamless flip stay on the old false/false defaults silently.
		if (!this.settings.hasCompletedOnboarding) {
			this.settings.autoIngestOnSave = DEFAULT_SETTINGS.autoIngestOnSave;
			this.settings.autoIngestOnCreate = DEFAULT_SETTINGS.autoIngestOnCreate;
		}
	}

	async saveSettings(): Promise<void> {
		await this.serializedSave();
		// Reinitialize client when settings change (auth, URL, workspace)
		this.initClient();
		// Forward to runtime singletons
		this.ingestService?.updateSettings?.(this.settings);
		this.inlineSuggestions?.updateSettings();
		this.vaultEvents?.updateSettings();
		// DIST-OBSIDIAN-LITE-PARITY-1: a settings change may have switched
		// cloud↔lite (different endpoint, auth, capabilities). Re-probe so
		// isLite/capabilities track the new backend, and re-render open views
		// against the fresh client — testConnection() refreshes panels+graph
		// via refreshOpenViews() once the capability picture is known, and we
		// refresh immediately too so the new client takes effect without
		// waiting on the probe round-trip.
		this.refreshOpenViews();
		void this.testConnection();
	}

	async saveMappings(): Promise<void> {
		await this.serializedSave();
	}

	/**
	 * Walk every markdown file's cached frontmatter and re-seed the mapping
	 * store from native OKF resources (with warned legacy fallback). Idempotent; only writes when
	 * the in-memory mapping is missing or stale relative to frontmatter.
	 * Persists once at the end if any change was made.
	 */
	private async backfillMappingsFromVault(): Promise<void> {
		const files = this.app.vault.getMarkdownFiles();
		let changed = 0;
		for (const file of files) {
			if (isPathExcluded(file.path, this.settings, 'mapping-backfill')) continue;
			const id = readSmartMemoryId(this.app, file, this.settings.workspaceId);
			if (!id) continue;
			const known = this.mappingStore.getMemoryId(file.path);
			if (known === id) continue;
			this.mappingStore.set(file.path, id);
			changed++;
		}
		if (changed > 0) {
			console.log(`[smartmemory] backfilled ${changed} mapping(s) from vault frontmatter`);
			await this.saveMappings();
		}
	}

	private async initializeOkfFrontmatter(): Promise<void> {
		await this.migrateLegacyVaultFrontmatter();
		await this.backfillMappingsFromVault();
	}

	private async migrateLegacyVaultFrontmatter(): Promise<void> {
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (isPathExcluded(file.path, this.settings, 'startup-migration')) continue;
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm || ![
				'smartmemory_id',
				'smartmemory_type',
				'smartmemory_entities',
				'smartmemory_relations',
				'smartmemory_last_sync',
			].some(key => Object.prototype.hasOwnProperty.call(fm, key))) continue;
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				migrateLegacyFrontmatter(fm, this.settings.workspaceId);
			});
		}
	}

	/** All persistence goes through this serialized chain so concurrent calls
	 *  (e.g. settings save while a rename event fires) can't clobber each other. */
	private serializedSave(): Promise<void> {
		const next = this.writeTail.then(() => this.persistOnce());
		// Don't propagate failures forward — each save's caller awaits its own promise
		this.writeTail = next.catch(() => {});
		return next;
	}

	private async persistOnce(): Promise<void> {
		const data: PluginData = {
			settings: this.settings,
			mappings: this.mappingStore.toJSON(),
		};
		await this.saveData(data);
	}

	/**
	 * Open a registered ItemView in the right sidebar (creating the leaf if
	 * needed) and reveal it. Used by the search and entity panes which the
	 * plan pins to the right pane; the graph pane gets a center leaf instead.
	 */
	/**
	 * Walk every memory in the workspace, find ones whose origin starts with
	 * `import:obsidian`, delete them server-side, clear all `smartmemory_*`
	 * frontmatter on local notes, and reset the mapping store. Confirms via a
	 * Notice with the count before acting.
	 *
	 * Use this to recover from auto-ingest feedback loops that left duplicate
	 * server-side memories. Local note bodies are not touched; only the YAML
	 * frontmatter our plugin owns.
	 */
	private async purgeObsidianOriginMemories(): Promise<void> {
		const client = this.client;
		if (!client) {
			new Notice('SmartMemory: not connected — set API key first.');
			return;
		}
		new Notice('SmartMemory: scanning memories for purge…', 5000);

		const toDelete: string[] = [];
		let offset = 0;
		const pageSize = 200;
		// Page through /memory/list. Stop when the page returns < pageSize.
		while (true) {
			let page: any;
			try {
				page = await (client as any).memories.list({ limit: pageSize, offset });
			} catch (err) {
				console.error('[smartmemory] purge list failed', err);
				new Notice('SmartMemory: purge aborted — list failed (see console).');
				return;
			}
			const items: any[] = Array.isArray(page) ? page : (page?.items || []);
			for (const item of items) {
				const origin = item.origin || item.metadata?.origin || '';
				if (typeof origin === 'string' && origin.startsWith('import:obsidian')) {
					toDelete.push(item.item_id);
				}
			}
			if (items.length < pageSize) break;
			offset += items.length;
		}

		if (toDelete.length === 0) {
			new Notice('SmartMemory: no Obsidian-origin memories found.');
			return;
		}

		console.log('[smartmemory] purging', toDelete.length, 'Obsidian-origin memories');
		let succeeded = 0;
		let failed = 0;
		for (const id of toDelete) {
			try {
				await (client as any).memories.delete(id);
				succeeded++;
			} catch (err) {
				failed++;
				console.warn('[smartmemory] delete failed', id, err);
			}
		}

		// Clear mapping store and frontmatter on every local note that had a smartmemory_id.
		const files = this.app.vault.getMarkdownFiles();
		const { clearSmartMemoryFrontmatter } = await import('./bridge/frontmatter');
		for (const f of files) {
			const id = this.mappingStore.getMemoryId(f.path);
			if (id) this.mappingStore.handleDelete(f.path);
			if (isPathExcluded(f.path, this.settings, 'purge-frontmatter-clear')) continue;
			await clearSmartMemoryFrontmatter(this.app, f, this.settings);
		}
		await this.saveMappings();

		new Notice(
			`SmartMemory purge complete: deleted ${succeeded}/${toDelete.length} server memories${failed ? ` (${failed} failed)` : ''}; cleared local frontmatter.`,
			10000,
		);
	}

	/**
	 * Find and delete server-side memories whose `content` is empty after
	 * trimming. These are legacy ingests from before `services/ingest.ts:121`
	 * began rejecting empty content (e.g. YAML-only notes from 0.1.x).
	 *
	 * They surface in search/recall as "(untitled)" rows because the entity
	 * graph and embeddings still link to them, but the rendered content is
	 * blank — useless to the user. Render-time filtering hides them; this
	 * command removes them so the workspace stops carrying dead weight.
	 *
	 * Local note frontmatter is NOT touched — empty server items have no
	 * mapped local note in the typical case (their source was lost when
	 * the YAML-only file was edited or deleted).
	 */
	private async purgeEmptyContentMemories(): Promise<void> {
		const client = this.client;
		if (!client) {
			new Notice('SmartMemory: not connected — set API key first.');
			return;
		}
		new Notice('SmartMemory: scanning for empty-content memories…', 5000);

		const toDelete: string[] = [];
		let offset = 0;
		const pageSize = 200;
		while (true) {
			let page: any;
			try {
				page = await (client as any).memories.list({ limit: pageSize, offset });
			} catch (err) {
				console.error('[smartmemory] empty-purge list failed', err);
				new Notice('SmartMemory: empty-purge aborted — list failed (see console).');
				return;
			}
			const items: any[] = Array.isArray(page) ? page : (page?.items || []);
			for (const item of items) {
				const content: string = typeof item.content === 'string' ? item.content : '';
				if (content.trim().length === 0) {
					toDelete.push(item.item_id);
				}
			}
			if (items.length < pageSize) break;
			offset += items.length;
		}

		if (toDelete.length === 0) {
			new Notice('SmartMemory: no empty-content memories found.');
			return;
		}

		console.log('[smartmemory] purging', toDelete.length, 'empty-content memories');
		let succeeded = 0;
		let failed = 0;
		for (const id of toDelete) {
			try {
				await (client as any).memories.delete(id);
				succeeded++;
				// Drop any local mapping so search/recall caches don't stall on it.
				const filePath = this.mappingStore.getFilePath(id);
				if (filePath) this.mappingStore.handleDelete(filePath);
			} catch (err) {
				failed++;
				console.warn('[smartmemory] empty-purge delete failed', id, err);
			}
		}
		await this.saveMappings();

		new Notice(
			`SmartMemory: deleted ${succeeded}/${toDelete.length} empty-content memories${failed ? ` (${failed} failed)` : ''}.`,
			10000,
		);
	}

	/**
	 * Diagnostic: counts current Obsidian-origin memories on the server vs
	 * mappings the plugin tracks locally. Logs both, plus the active note's
	 * mapped item_id (if any), so a user can tell at a glance whether a
	 * subsequent save creates a new memory (loop active) or reuses the
	 * existing one (loop fixed).
	 */
	private async diagnoseLoop(): Promise<void> {
		const client = this.client;
		if (!client) {
			new Notice('SmartMemory: not connected.');
			return;
		}
		let total = 0;
		const byOriginPrefix: Record<string, number> = {};
		let offset = 0;
		const pageSize = 200;
		try {
			while (true) {
				const page: any = await (client as any).memories.list({ limit: pageSize, offset });
				const items: any[] = Array.isArray(page) ? page : (page?.items || []);
				total += items.length;
				for (const item of items) {
					const origin = String(item.origin || 'unknown');
					// Group by `prefix:` so `evolver:episodic_to_semantic` and
					// `evolver:opinion_synthesis` collapse, while `import:obsidian`
					// stays distinct from `import:other`.
					const colon = origin.indexOf(':');
					const prefix = colon > 0 ? origin.slice(0, colon + 1) + (origin.slice(colon + 1).split(/[/_]/)[0] || '') : origin;
					byOriginPrefix[prefix] = (byOriginPrefix[prefix] || 0) + 1;
				}
				if (items.length < pageSize) break;
				offset += items.length;
			}
		} catch (err) {
			// Paginated list can fail mid-walk (network/auth/timeout). Surface a
			// controlled notice instead of rejecting the command callback.
			console.error('[smartmemory] diagnose-loop failed', err);
			new Notice(`SmartMemory diagnose failed: ${err instanceof Error ? err.message : String(err)}`, 10000);
			return;
		}
		const active = this.app.workspace.getActiveFile();
		const mappedId = active ? this.mappingStore.getMemoryId(active.path) : null;
		const breakdown = Object.entries(byOriginPrefix)
			.sort((a, b) => b[1] - a[1])
			.map(([k, v]) => `${k}=${v}`)
			.join(', ');
		const summary = `total=${total} | ${breakdown} | active-note-mapped-id=${mappedId ?? '(none)'}`;
		console.log('[smartmemory] diagnose-loop', { total, byOriginPrefix, mappedId });
		new Notice(`SmartMemory diagnose: ${summary}`, 15000);
	}

	private async activateRightLeafView(viewType: string): Promise<void> {
		const ws = this.app.workspace;
		const existing = ws.getLeavesOfType(viewType);
		if (existing.length > 0) {
			ws.revealLeaf(existing[0]);
			return;
		}
		const leaf = ws.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: viewType, active: true });
		ws.revealLeaf(leaf);
	}

	private runCommand(commandId: string): void {
		// Obsidian's commands API is on app.commands; community-plugin pattern.
		// Note: registered commands are stored as `${manifest.id}:${commandId}`,
		// so the prefixed form is the canonical lookup.
		const prefixed = `${this.manifest.id}:${commandId}`;
		(this.app as any).commands?.executeCommandById?.(prefixed);
	}
}
