import { MarkdownView } from 'obsidian';
import type SmartMemoryPlugin from '../main';
import type { SearchResult } from '../services/search';
import { SuggestionEngine } from '../services/suggestions';
import { toWikilinkTarget } from '../util/wikilink-path';
import { isPathExcluded } from '../util/exclusions';

const WIDGET_CLASS = 'smartmemory-suggestion-widget';

/**
 * Glue between the SuggestionEngine and the active editor:
 * - Listens for editor changes on active markdown views
 * - Extracts the current paragraph and feeds it to SuggestionEngine
 * - Renders results as a dismissable widget below the editor area
 *
 * Off by default (settings.inlineSuggestionsEnabled). Engine handles
 * debounce + stale-discard + threshold filtering; this layer is purely UI.
 */
export class InlineSuggestions {
	private plugin: SmartMemoryPlugin;
	private engine: SuggestionEngine | null = null;

	constructor(plugin: SmartMemoryPlugin) {
		this.plugin = plugin;
	}

	start(): void {
		this.engine = new SuggestionEngine({
			// Lazy getter — resolves the current SearchService each query so
			// settings-triggered client reinits don't leave us with a stale ref
			getSearch: () => this.plugin.searchService,
			settings: this.plugin.settings,
			onSuggestions: (results, query) => this.render(results, query),
		});

		this.plugin.registerEvent(
			this.plugin.app.workspace.on('editor-change', (_editor, info) => {
				if (!this.plugin.settings.inlineSuggestionsEnabled) return;
				if (!this.plugin.searchService) return;

				const view = info as MarkdownView;
				if (!view?.editor) return;
				const source = view.file;
				if (source && isPathExcluded(source.path, this.plugin.settings, 'inline-suggestions')) {
					this.engine?.cancel();
					this.clearWidget();
					return;
				}
				const paragraph = currentParagraph(view);
				this.engine?.queryDebounced(paragraph, () =>
					!source || !isPathExcluded(source.path, this.plugin.settings, 'inline-suggestions'));
			})
		);

		// Clear widget when leaving the active leaf to avoid stale floats
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('active-leaf-change', () => {
				this.clearWidget();
				this.engine?.cancel();
			})
		);
	}

	updateSettings(): void {
		this.engine?.updateSettings(this.plugin.settings);
		if (!this.plugin.settings.inlineSuggestionsEnabled) {
			this.clearWidget();
			this.engine?.cancel();
		}
	}

	stop(): void {
		this.clearWidget();
		this.engine?.cancel();
		this.engine = null;
	}

	private render(results: SearchResult[], _query: string): void {
		this.clearWidget();
		if (results.length === 0) return;

		const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		// Filter out the current note's own memory
		const currentItemId = view.file
			? this.plugin.mappingStore.getMemoryId(view.file.path)
			: null;
		const filtered = results.filter(r => r.itemId !== currentItemId);
		if (filtered.length === 0) return;

		const widget = view.containerEl.createDiv({ cls: WIDGET_CLASS });
		widget.createSpan({ cls: 'smartmemory-suggestion-label', text: 'Related: ' });

		filtered.forEach((result, idx) => {
			if (idx > 0) widget.createSpan({ text: ', ' });
			const filePath = this.plugin.mappingStore.getFilePath(result.itemId);
			const label = filePath ? filePath.replace(/\.md$/, '') : result.snippet.slice(0, 40);
			const link = widget.createEl('a', {
				cls: 'smartmemory-suggestion-link',
				text: `[[${label}]]`,
			});
			link.addEventListener('click', () => {
				if (!filePath) return;
				if (view.file && isPathExcluded(view.file.path, this.plugin.settings, 'suggestion-insert-link')) return;
				const target = toWikilinkTarget(filePath);
				view.editor.replaceSelection(`[[${target}]]`);
				this.clearWidget();
			});
		});

		const dismiss = widget.createEl('button', {
			cls: 'smartmemory-suggestion-dismiss',
			text: '×',
			attr: { 'aria-label': 'Dismiss suggestion' },
		});
		dismiss.addEventListener('click', () => this.clearWidget());
		// Widget already attached to view.containerEl via createDiv above
	}

	private clearWidget(): void {
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (view instanceof MarkdownView) {
				view.containerEl.querySelectorAll('.' + WIDGET_CLASS).forEach(el => el.remove());
			}
		});
	}
}

function currentParagraph(view: MarkdownView): string {
	const editor = view.editor;
	const cursor = editor.getCursor();
	const lines = editor.getValue().split('\n');

	// Walk up to find the paragraph start (blank line or doc start)
	let start = cursor.line;
	while (start > 0 && lines[start - 1].trim() !== '') start--;
	let end = cursor.line;
	while (end < lines.length - 1 && lines[end + 1].trim() !== '') end++;

	return lines.slice(start, end + 1).join('\n').trim();
}
