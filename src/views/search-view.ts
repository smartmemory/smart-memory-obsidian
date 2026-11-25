import { ItemView, WorkspaceLeaf, Notice, TFile } from 'obsidian';
import type SmartMemoryPlugin from '../main';
import type { SearchResult } from '../services/search';
import { RECALL_EXCLUDE_ORIGIN_PREFIXES } from '../services/search';
import { handleQuotaError } from '../util/quota-errors';

export const SEARCH_VIEW_TYPE = 'smartmemory-search';

export class SearchView extends ItemView {
	private plugin: SmartMemoryPlugin;
	private inputEl: HTMLInputElement | null = null;
	private resultsEl: HTMLElement | null = null;
	private memoryTypeEl: HTMLSelectElement | null = null;
	private originEl: HTMLInputElement | null = null;
	private entityEl: HTMLInputElement | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private requestSeq = 0;

	constructor(leaf: WorkspaceLeaf, plugin: SmartMemoryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return SEARCH_VIEW_TYPE; }
	getDisplayText(): string { return 'SmartMemory search'; }
	getIcon(): string { return 'search'; }

	async onOpen(): Promise<void> {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass('smartmemory-search-view');

		const header = root.createDiv({ cls: 'smartmemory-search-header' });
		header.createEl('h3', { text: 'SmartMemory' });

		const inputWrap = root.createDiv({ cls: 'smartmemory-search-input-wrap' });
		this.inputEl = inputWrap.createEl('input', {
			type: 'text',
			placeholder: 'Search your memory...',
			cls: 'smartmemory-search-input',
		});
		this.inputEl.addEventListener('input', () => this.onQueryChange());

		const filtersEl = root.createDiv({ cls: 'smartmemory-search-filters' });

		this.memoryTypeEl = filtersEl.createEl('select', { cls: 'smartmemory-search-filter' });
		for (const opt of ['', 'semantic', 'episodic', 'procedural', 'pending', 'zettel', 'decision']) {
			this.memoryTypeEl.createEl('option', { value: opt, text: opt || 'All types' });
		}
		this.memoryTypeEl.addEventListener('change', () => this.onQueryChange());

		this.originEl = filtersEl.createEl('input', {
			type: 'text',
			placeholder: 'Origin prefix (clear to see derived/evolved)',
			cls: 'smartmemory-search-filter',
		});
		// Default to vault-notes-only. The SmartMemory pipeline graduates
		// evolved copies of memories under origin prefixes like
		// `evolver:episodic_to_semantic` and `mcp:memory_add`; both are tier-1
		// search-visible. Without a default origin filter, every vault note
		// would show up alongside its evolved twin and the user has no idea
		// why the same content appears twice. Clearing this input shows
		// everything.
		this.originEl.value = 'import:obsidian';
		this.originEl.addEventListener('input', () => this.onQueryChange());

		this.entityEl = filtersEl.createEl('input', {
			type: 'text',
			placeholder: 'Entity (added to query)',
			cls: 'smartmemory-search-filter',
		});
		this.entityEl.addEventListener('input', () => this.onQueryChange());

		this.resultsEl = root.createDiv({ cls: 'smartmemory-search-results' });
	}

	async onClose(): Promise<void> {
		if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
	}

	private onQueryChange(): void {
		if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			void this.runSearch();
		}, 300);
	}

	private async runSearch(): Promise<void> {
		const queryText = this.inputEl?.value?.trim() ?? '';
		const entityText = this.entityEl?.value?.trim() ?? '';
		// The entity field is a query hint, not a post-filter. The server's
		// /memory/search does not accept an entity parameter, and search
		// responses do not include populated `entities` arrays for graph-
		// extracted items, so the previous client-side post-filter never
		// matched anything. We instead fold the entity term into the query
		// text — entity-by-itself becomes a valid search, and entity+query
		// just searches for both terms.
		const effectiveQuery = [queryText, entityText].filter(Boolean).join(' ').trim();

		if (!effectiveQuery) {
			++this.requestSeq;
			this.renderResults([]);
			return;
		}

		const search = this.plugin.searchService;
		if (!search) {
			this.renderError('Not connected. Configure API key in settings.');
			return;
		}

		const seq = ++this.requestSeq;
		try {
			const results = await search.search({
				query: effectiveQuery,
				topK: 10,
				multiHop: true,
				memoryType: this.memoryTypeEl?.value || undefined,
				originPrefix: this.originEl?.value || undefined,
				// Hide tier 3/4 (speculative + system infra) from user-facing
				// search by default. The optional originPrefix filter above is
				// additive — even a user-typed prefix still respects the
				// exclude list (origin must satisfy both: starts with the
				// requested prefix AND is not in the exclude set).
				excludeOriginPrefixes: RECALL_EXCLUDE_ORIGIN_PREFIXES,
			});
			// Discard stale results
			if (seq !== this.requestSeq) return;
			// Drop empty-content rows. These are legacy ingests from before
			// `services/ingest.ts:121` started rejecting empty content (e.g.
			// YAML-only notes from 0.1.x). They still match by entity graph
			// or by their pre-strip embedding, but render as "(untitled)"
			// with a blank snippet — useless to the user. The
			// "purge-empty-memories" command cleans them up server-side.
			const visible = results.filter((r) => (r.content || '').trim().length > 0);
			this.renderResults(visible);
		} catch (err) {
			if (seq !== this.requestSeq) return;
			if (handleQuotaError(this.plugin.app, err, { isLite: this.plugin.isLite })) {
				this.renderError('Daily search limit reached. Upgrade to continue.');
				return;
			}
			this.renderError(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private renderResults(results: SearchResult[]): void {
		const el = this.resultsEl;
		if (!el) return;
		el.empty();

		if (results.length === 0) {
			el.createDiv({ cls: 'smartmemory-search-empty', text: 'No results' });
			return;
		}

		for (const result of results) {
			const card = el.createDiv({ cls: 'smartmemory-search-result' });

			const header = card.createDiv({ cls: 'smartmemory-search-result-header' });
			header.createSpan({ cls: 'smartmemory-search-type', text: result.memoryType });
			if (result.score !== null) {
				header.createSpan({
					cls: 'smartmemory-search-score',
					text: result.score.toFixed(2),
				});
			}
			// Surface origin per result so write-path bugs are visible at a glance.
			// An unknown origin is shown plainly like any other value (no flag, no warning
			// tooltip): UI-ORIGIN-UNKNOWN-NEUTRAL-1.
			const origin = result.origin || 'unknown';
			const originEl = header.createSpan({
				cls: 'smartmemory-search-origin',
				text: origin,
			});
			originEl.title = `Origin: ${origin}`;

			card.createDiv({ cls: 'smartmemory-search-title', text: result.title });
			card.createDiv({ cls: 'smartmemory-search-snippet', text: result.snippet });

			card.addEventListener('click', () => this.onResultClick(result));
		}
	}

	private renderError(msg: string): void {
		this.resultsEl?.empty();
		this.resultsEl?.createDiv({ cls: 'smartmemory-search-error', text: msg });
	}

	private async onResultClick(result: SearchResult): Promise<void> {
		const filePath = this.plugin.mappingStore.getFilePath(result.itemId);
		if (filePath) {
			const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) {
				await this.plugin.app.workspace.getLeaf().openFile(file);
				return;
			}
		}
		new Notice('SmartMemory: this memory has no vault note. Future feature: create one.');
	}
}
