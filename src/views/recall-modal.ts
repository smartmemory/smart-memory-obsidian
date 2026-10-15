import { App, Modal, MarkdownView, Notice, TFile } from 'obsidian';
import type SmartMemoryPlugin from '../main';
import type { SearchResult } from '../services/search';
import { RECALL_EXCLUDE_ORIGIN_PREFIXES } from '../services/search';
import { toWikilinkTarget } from '../util/wikilink-path';
import { writeSmartMemoryFrontmatter } from '../bridge/frontmatter';
import { isPathExcluded } from '../util/exclusions';

export class RecallModal extends Modal {
	private plugin: SmartMemoryPlugin;
	private query: string;

	constructor(app: App, plugin: SmartMemoryPlugin, query: string, private sourceFile?: TFile) {
		super(app);
		this.plugin = plugin;
		this.query = query;
	}

	async onOpen(): Promise<void> {
		if (this.sourceFile && isPathExcluded(this.sourceFile.path, this.plugin.settings, 'recall-query', true)) return;
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('smartmemory-recall-modal');

		contentEl.createEl('h2', { text: 'Recall related memories' });
		const queryPreview = this.query.length > 100 ? this.query.slice(0, 100) + '…' : this.query;
		contentEl.createEl('p', { cls: 'smartmemory-recall-query', text: `Query: ${queryPreview}` });

		const resultsEl = contentEl.createDiv({ cls: 'smartmemory-recall-results' });
		resultsEl.setText('Searching...');

		const search = this.plugin.searchService;
		if (!search) {
			resultsEl.empty();
			resultsEl.setText('SmartMemory not connected.');
			return;
		}

		try {
			const results = await search.search({
				query: this.query,
				topK: 5,
				multiHop: true,
				excludeOriginPrefixes: RECALL_EXCLUDE_ORIGIN_PREFIXES,
				dedupeContent: true,
			});
			// Filter empty-content legacy items — see search-view.ts.
			const visible = results.filter((r) => (r.content || '').trim().length > 0 && !this.targetExcluded(r));
			this.renderResults(resultsEl, visible);
		} catch (err) {
			resultsEl.empty();
			resultsEl.setText(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderResults(container: HTMLElement, results: SearchResult[]): void {
		container.empty();
		if (results.length === 0) {
			container.setText('No related memories found.');
			return;
		}

		for (const result of results) {
			const row = container.createDiv({ cls: 'smartmemory-recall-result' });

			const main = row.createDiv({ cls: 'smartmemory-recall-result-main' });
			main.createDiv({ cls: 'smartmemory-recall-result-title', text: result.title });
			const meta = main.createDiv({ cls: 'smartmemory-recall-result-meta' });
			meta.createSpan({ cls: 'smartmemory-search-type', text: result.memoryType });
			if (result.score !== null) {
				meta.createSpan({
					cls: 'smartmemory-search-score',
					text: result.score.toFixed(2),
				});
			}
			// Short item_id suffix lets the user tell apart two results with
			// identical titles/snippets (real server returns distinct memories
			// that may surface as visual dupes).
			meta.createSpan({
				cls: 'smartmemory-search-id',
				text: `#${result.itemId.slice(-6)}`,
			});
			main.createDiv({ cls: 'smartmemory-search-snippet', text: result.snippet });

			const actions = row.createDiv({ cls: 'smartmemory-recall-result-actions' });
			const insertBtn = actions.createEl('button', { text: 'Insert link' });
			insertBtn.addEventListener('click', () => {
				this.insertLink(result);
				this.close();
			});

			const openBtn = actions.createEl('button', { text: 'Open' });
			openBtn.addEventListener('click', () => {
				void this.openResult(result);
				this.close();
			});
		}
	}

	/**
	 * Resolve a SearchResult to a wikilink target. If the memory was ingested
	 * from this vault, link to the actual file. Otherwise fall back to the
	 * memory's title — Obsidian renders that as an unresolved link the user
	 * can later create. Either way, "Insert link" never silently fails.
	 */
	private wikilinkTarget(result: SearchResult): string {
		const filePath = this.plugin.mappingStore.getFilePath(result.itemId);
		if (filePath) return toWikilinkTarget(filePath);
		return (result.title || 'untitled').replace(/[\[\]|]/g, '');
	}

	private targetExcluded(result: SearchResult, notify = false): boolean {
		const mapped = this.plugin.mappingStore.getFilePath(result.itemId);
		// An unresolved title can still resolve to an excluded local note.
		const paths = mapped ? [mapped] : this.app.vault.getMarkdownFiles()
			.filter(f => f.basename === result.title || f.path === result.title || f.path.replace(/\.md$/, '') === result.title)
			.map(f => f.path);
		return paths.some(path => isPathExcluded(path, this.plugin.settings, 'recall-link-target', notify));
	}

	private insertLink(result: SearchResult): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice('SmartMemory: open a note first to insert links');
			return;
		}
		if (view.file && isPathExcluded(view.file.path, this.plugin.settings, 'recall-insert-link', true)) return;
		if (this.targetExcluded(result, true)) return;
		view.editor.replaceSelection(`[[${this.wikilinkTarget(result)}]]`);
	}

	private async openResult(result: SearchResult): Promise<void> {
		const filePath = this.plugin.mappingStore.getFilePath(result.itemId);
		if (filePath) {
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) {
				await this.app.workspace.getLeaf().openFile(file);
				return;
			}
		}
		// No vault file mapped — create one from the memory's content so the
		// user can keep working with it inside Obsidian.
		await this.createNoteFromResult(result);
	}

	private async createNoteFromResult(result: SearchResult): Promise<void> {
		const safeTitle = (result.title || 'Recalled memory').replace(/[\\/:*?"<>|]/g, '-');
		const basePath = `SmartMemory Imports/${safeTitle}.md`;
		// Avoid clobbering an existing file: append a counter if needed.
		let path = basePath;
		let i = 2;
		while (this.app.vault.getAbstractFileByPath(path)) {
			path = `SmartMemory Imports/${safeTitle} (${i}).md`;
			i++;
		}
		if (isPathExcluded(path, this.plugin.settings, 'recall-import-note', true)) return;
		try {
			const folder = 'SmartMemory Imports';
			if (!this.app.vault.getAbstractFileByPath(folder)) {
				await this.app.vault.createFolder(folder);
			}
			if (isPathExcluded(path, this.plugin.settings, 'recall-import-note', true)) return;
			const file = await this.app.vault.create(path, result.content);
			// Persist the note↔memory link so it survives a reload. The mapping
			// store alone is in-memory until saveMappings() flushes it to
			// data.json; we also stamp the smartmemory_id frontmatter (honoring
			// the user's writeFrontmatterId setting) so the link is recoverable
			// even if the mapping cache is ever lost. Without this the created
			// note silently de-links on the next Obsidian restart.
			this.plugin.mappingStore.set(file.path, result.itemId);
			await this.plugin.saveMappings();
			await writeSmartMemoryFrontmatter(this.app, file, { id: result.itemId }, this.plugin.settings);
			await this.app.workspace.getLeaf().openFile(file);
		} catch (err) {
			new Notice(
				`SmartMemory: could not create note: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}
