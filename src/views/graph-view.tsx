import { ItemView, WorkspaceLeaf, TFile, Notice } from 'obsidian';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GraphExplorer } from '@smartmemory/graph';
import { createSDKAdapter } from '@smartmemory/graph/src/adapters/sdkAdapter';
import type SmartMemoryPlugin from '../main';
import { readSmartMemoryId } from '../bridge/frontmatter';
import { resourceWorkspace } from '../bridge/resource-workspace';

export const GRAPH_VIEW_TYPE = 'smartmemory-graph';

/**
 * Obsidian ItemView shell that mounts the shared @smartmemory/graph
 * GraphExplorer React component.
 *
 * The plugin previously rolled its own Cytoscape integration (BFS, field
 * normalization, layout, styles, all custom). That duplicated the work
 * already shipped in @smartmemory/graph and used by the web/studio
 * frontends. The adoption uses the canonical adapter+component path so
 * future graph fixes (color contracts, structural-vs-extracted edge
 * styling, supersession overlays, contradiction highlighting) propagate
 * to all SmartMemory frontends from one source.
 */
export class GraphView extends ItemView {
	private plugin: SmartMemoryPlugin;
	private rootEl: HTMLElement | null = null;
	private reactRoot: Root | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: SmartMemoryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return GRAPH_VIEW_TYPE; }
	getDisplayText(): string { return 'SmartMemory graph'; }
	getIcon(): string { return 'git-branch'; }

	async onOpen(): Promise<void> {
		this.rootEl = this.containerEl.children[1] as HTMLElement;
		this.rootEl.empty();
		// Tailwind utilities ship under .smartmemory-graph-view; the wrapper
		// is required for the GraphExplorer subtree to pick them up.
		this.rootEl.addClass('smartmemory-graph-view');
		// Layout (flex column, definite size) comes from styles.css:
		// .smartmemory-graph-view and .smartmemory-graph-mount.
		const mount = this.rootEl.createDiv({ cls: 'smartmemory-graph-mount' });

		this.reactRoot = createRoot(mount);
		this.render();

		// Re-render on active-leaf-change so the focus node tracks the user.
		this.registerEvent(
			this.plugin.app.workspace.on('active-leaf-change', () => this.render()),
		);

		// Re-render when Obsidian's color scheme toggles. `css-change` fires
		// for both the Obsidian theme switcher and OS-level light/dark
		// changes that propagate through Obsidian — it's the canonical hook.
		this.registerEvent(
			this.plugin.app.workspace.on('css-change', () => this.render()),
		);
	}

	/**
	 * Build a theme object from Obsidian's live CSS variables.
	 *
	 * Node fill colors are deliberately NOT overridden — the per-type
	 * semantic palette (memory types, entity types, grounding) is what
	 * the legend in OriginLegend / FilterPanel reflects, and flattening
	 * it to a single Obsidian color would make the legend lie.
	 *
	 * Instead we theme the *chrome*: edge color/labels (--graph-line),
	 * node label text (--graph-text), the label outline (background so
	 * text reads cleanly on either canvas color), and the selection
	 * border (--interactive-accent so selection picks up the user's
	 * Obsidian accent). `getComputedStyle` resolves the cascade live,
	 * so a community-theme accent or user CSS snippet flows through.
	 *
	 * Other consumers of @smartmemory/graph (web/studio/insights) pass
	 * no `theme` prop and render with the original semantic palette.
	 */
	private resolveTheme(): {
		mode: 'dark' | 'light';
		palette: { edge: string; label: string; labelOutline: string; selectionBorder: string };
	} {
		const isDark = document.body.classList.contains('theme-dark');
		const cs = getComputedStyle(document.body);
		const cssVar = (name: string, fallback: string): string => {
			const v = cs.getPropertyValue(name).trim();
			return v || fallback;
		};
		return {
			mode: isDark ? 'dark' : 'light',
			palette: {
				edge: cssVar('--graph-line', cssVar('--background-modifier-border', '#666')),
				label: cssVar('--graph-text', cssVar('--text-normal', '#eee')),
				labelOutline: cssVar('--background-primary', isDark ? '#202020' : '#ffffff'),
				selectionBorder: cssVar('--interactive-accent', isDark ? '#a0a0a0' : '#202020'),
			},
		};
	}

	async onClose(): Promise<void> {
		this.reactRoot?.unmount();
		this.reactRoot = null;
	}

	/**
	 * Public re-render hook. Called after a connection/mode change so the
	 * graph re-fetches against the new client instead of showing stale state
	 * until the next active-leaf-change. DIST-OBSIDIAN-LITE-PARITY-1.
	 * render() rebuilds the SDK adapter, so GraphExplorer's useGraphData
	 * effect re-runs and refetches.
	 */
	refresh(): void {
		this.render();
	}

	private render(): void {
		if (!this.reactRoot) return;

		const client = this.plugin.client;
		if (!client) {
			this.reactRoot.render(
				createElement('div', { className: 'p-4 text-gray-400' },
					'Not connected. Configure API key in settings.'),
			);
			return;
		}

		// @smartmemory/graph carries its own SDK declaration copy; runtime
		// clients are compatible even though the duplicate nominal types drift.
		const adapter = createSDKAdapter(client as any);
		const focusId = this.resolveFocusId();

		this.reactRoot.render(
			createElement(GraphExplorer, {
				adapter,
				theme: this.resolveTheme(),
				// Hide the OriginLegend overlay in Obsidian — the panel
				// floats over the canvas and crowds the relatively narrow
				// pane Obsidian gives plugin views. Origin information is
				// still encoded as the node border color/style; users who
				// want the legend back can run /smartmemory diagnose or
				// view the graph in the web app.
				showOriginLegend: false,
				onNodeOpen: (node: any) => this.openVaultFileForNode(node),
				// Hide the selection toolbar (Move / Isolate / Delete) inside
				// Obsidian. The Delete action mutates SmartMemory across all
				// surfaces, which is the wrong destructive default for a
				// reader-first PKM context — users editing memories should
				// do so explicitly via plugin commands, not via a graph
				// click. Web and Studio still get the toolbar by default.
				hideSelectionToolbar: true,
				// Surface plugin-relevant streaming when SSE is wired in a
				// later iteration. For now the component falls back to plain
				// HTTP fetch via the adapter.
				className: 'h-full w-full',
				// Pass focusId via URL state would be ideal; for v1 we leave
				// it unset and let the user search/click into the graph.
				// (focusId integration tracked as a follow-up — see CHANGELOG.)
			} as any),
		);
		void focusId; // referenced for future hookup
	}

	private resolveFocusId(): string | null {
		const file = this.plugin.app.workspace.getActiveFile();
		if (!file) return null;
		return (
			this.plugin.mappingStore.getMemoryId(file.path)
			?? readSmartMemoryId(this.plugin.app, file, resourceWorkspace(this.plugin.settings))
		);
	}

	private async openVaultFileForNode(node: any): Promise<void> {
		const itemId: string | undefined = node?.id || node?.item_id;
		if (!itemId) {
			new Notice('SmartMemory: node has no id.');
			return;
		}
		const filePath = this.plugin.mappingStore.getFilePath(itemId);
		if (!filePath) {
			new Notice('SmartMemory: this node has no vault note.');
			return;
		}
		const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile) {
			await this.plugin.app.workspace.getLeaf().openFile(file);
		}
	}
}
