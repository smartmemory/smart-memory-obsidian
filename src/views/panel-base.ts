/**
 * Right-panel base class (DIST-OBSIDIAN-PANELS-1).
 *
 * Abstract `ItemView` capturing the shape every SmartMemory right-panel
 * view shares: follow the active leaf, read `smartmemory_id`, increment
 * a refresh sequence so stale fetches drop, render error/empty/loading
 * states uniformly. Subclasses implement `render(rootEl, memoryId, seq)`.
 *
 * Design constraints:
 *   - Subclasses MUST not stash render output in instance state — they
 *     receive a fresh `rootEl` on every refresh and write into it. The
 *     base owns container lifecycle.
 *   - Subclasses MUST check `seq !== this.refreshSeq` after every await
 *     and bail. Without this, a leaf change during a slow fetch leaves
 *     the wrong note's data on screen.
 *   - The base auto-registers an `active-leaf-change` listener and
 *     re-renders. Subclasses don't need to wire that up.
 */
import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import type SmartMemoryPlugin from '../main';
import { readSmartMemoryId } from '../bridge/frontmatter';
import { isPathExcluded } from '../util/exclusions';

export abstract class SmartMemoryPanelBase extends ItemView {
	protected plugin: SmartMemoryPlugin;
	protected rootEl: HTMLElement | null = null;
	protected currentFile: TFile | null = null;
	/** Increments on every refresh; stale fetches drop by comparing. */
	protected refreshSeq = 0;

	constructor(leaf: WorkspaceLeaf, plugin: SmartMemoryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	abstract getViewType(): string;
	abstract getDisplayText(): string;
	abstract getIcon(): string;

	/** CSS class added to the root element. Override per panel for styling. */
	protected abstract rootClass(): string;

	/** Implement the per-panel rendering. The root has been emptied. */
	protected abstract render(root: HTMLElement, memoryId: string, seq: number): Promise<void>;

	/**
	 * If non-null, this panel requires the named /health capability. When the
	 * connected backend reports it unavailable (e.g. the lite daemon does not
	 * implement decisions), the panel renders `unavailableText()` instead of
	 * calling render() — explicit degradation, not a silent 404.
	 * DIST-OBSIDIAN-LITE-PARITY-1. Default null = always render.
	 */
	protected requiredCapability(): string | null { return null; }

	/** Message shown when requiredCapability() is unavailable. Override per panel. */
	protected unavailableText(): string {
		return 'Not available for the connected backend.';
	}

	async onOpen(): Promise<void> {
		this.rootEl = this.containerEl.children[1] as HTMLElement;
		this.rootEl.empty();
		this.rootEl.addClass(this.rootClass());

		this.registerEvent(
			this.plugin.app.workspace.on('active-leaf-change', () => void this.refresh()),
		);

		await this.refresh();
	}

	/** Force a re-render. Optionally pass a specific file (defaults to active). */
	async refresh(file?: TFile | null): Promise<void> {
		const root = this.rootEl;
		if (!root) return;
		const seq = ++this.refreshSeq;
		root.empty();

		const target = file ?? this.plugin.app.workspace.getActiveFile();
		this.currentFile = target ?? null;

		root.createEl('h3', { text: this.getDisplayText() });

		if (!target) {
			this.renderInfo(root, 'No active note.');
			return;
		}

		if (isPathExcluded(target.path, this.plugin.settings, `${this.getViewType()}-sidebar`)) {
			this.renderInfo(root, 'This note is in an excluded folder.');
			return;
		}
		const itemId =
			this.plugin.mappingStore.getMemoryId(target.path) ??
			readSmartMemoryId(this.plugin.app, target, this.plugin.settings.workspaceId);

		if (!itemId) {
			this.renderInfo(
				root,
				'This note has not been ingested yet. Run "SmartMemory: Ingest current note".',
			);
			return;
		}

		const client = this.plugin.client;
		if (!client) {
			this.renderInfo(root, 'Not connected.');
			return;
		}

		const cap = this.requiredCapability();
		if (cap && !this.plugin.capabilityAvailable(cap as never)) {
			this.renderInfo(root, this.unavailableText());
			return;
		}

		try {
			await this.render(root, itemId, seq);
		} catch (err) {
			if (seq !== this.refreshSeq) return;
			this.renderError(root, err);
		}
	}

	/** Shared info/empty state renderer. */
	protected renderInfo(root: HTMLElement, text: string): void {
		root.createDiv({ cls: 'smartmemory-panel-empty', text });
	}

	/** Shared error renderer with retry button. */
	protected renderError(root: HTMLElement, err: unknown): void {
		const msg = err instanceof Error ? err.message : String(err);
		const wrap = root.createDiv({ cls: 'smartmemory-panel-error' });
		wrap.createDiv({ text: `Error: ${msg}` });
		const btn = wrap.createEl('button', { text: 'Retry' });
		btn.addEventListener('click', () => void this.refresh());
	}
}
