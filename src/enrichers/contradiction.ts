import { MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';
import type SmartMemoryPlugin from '../main';
import { readSmartMemoryId } from '../bridge/frontmatter';
import { LineageModal } from '../views/lineage-modal';
import { isPathExcluded } from '../util/exclusions';

const BANNER_CLASS = 'smartmemory-contradiction-banner';

/**
 * Watches active markdown view changes and displays a passive banner above
 * the editor when the current note has been superseded (or supersedes another).
 *
 * Uses GET /memory/{id}/neighbors and filters for SUPERSEDES/SUPERSEDED_BY
 * link_types — NOT the lineage endpoint, which walks derived_from instead.
 */
export class ContradictionBanner {
	private plugin: SmartMemoryPlugin;
	private checkSeq = 0;
	private sweepHandle: ReturnType<typeof setInterval> | null = null;

	constructor(plugin: SmartMemoryPlugin) {
		this.plugin = plugin;
	}

	start(): void {
		// Initial check
		void this.checkActive();

		// Re-check on active leaf change
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf?.view instanceof MarkdownView) void this.checkActive();
			})
		);

		// Periodic sweep for the active leaf — catches server-side supersession
		// events that the user wouldn't otherwise see until reopening the note.
		const intervalMs = Math.max(60_000, this.plugin.settings.contradictionSweepIntervalMin * 60_000);
		this.sweepHandle = setInterval(() => {
			void this.checkActive();
		}, intervalMs);
		this.plugin.register(() => {
			if (this.sweepHandle) {
				clearInterval(this.sweepHandle);
				this.sweepHandle = null;
			}
		});
	}

	private async checkActive(): Promise<void> {
		if (!this.plugin.settings.contradictionBannerEnabled) {
			this.clearAllBanners();
			return;
		}

		const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file) {
			this.clearAllBanners();
			return;
		}

		const file = view.file;
		if (isPathExcluded(file.path, this.plugin.settings, 'contradiction-banner')) {
			this.clearAllBanners();
			return;
		}
		const itemId =
			this.plugin.mappingStore.getMemoryId(file.path) ??
			readSmartMemoryId(this.plugin.app, file, this.plugin.settings.workspaceId);

		if (!itemId) {
			this.clearBannerOnLeaf(view.leaf);
			return;
		}

		const service = this.plugin.contradictionService;
		if (!service) return;

		const seq = ++this.checkSeq;
		const finding = await service.checkSupersession(itemId);
		if (seq !== this.checkSeq) return; // stale check

		// Re-fetch active view in case user switched notes during await
		const currentView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (!currentView || currentView.file !== file) {
			this.clearBannerOnLeaf(view.leaf);
			return;
		}

		if (!finding) {
			this.clearBannerOnLeaf(currentView.leaf);
			return;
		}

		this.renderBanner(currentView, file, itemId, finding);
	}

	private renderBanner(
		view: MarkdownView,
		_file: TFile,
		itemId: string,
		finding: { kind: 'superseded' | 'supersedes'; otherItemId: string; otherSnippet: string }
	): void {
		const container = view.containerEl;
		this.clearBannerOnLeaf(view.leaf);

		const banner = container.createDiv({ cls: BANNER_CLASS });
		banner.dataset.kind = finding.kind;
		banner.setAttribute('role', 'status');
		banner.setAttribute('aria-live', 'polite');

		const message = finding.kind === 'superseded'
			? '⚠ This note has been superseded by a newer memory.'
			: 'This note supersedes an older memory.';
		banner.createSpan({ cls: 'smartmemory-banner-text', text: message });

		const otherFile = this.plugin.mappingStore.getFilePath(finding.otherItemId);
		if (otherFile) {
			const link = banner.createEl('a', {
				cls: 'smartmemory-banner-link',
				text: otherFile.replace(/\.md$/, ''),
			});
			link.addEventListener('click', async () => {
				const f = this.plugin.app.vault.getAbstractFileByPath(otherFile);
				if (f instanceof TFile) {
					await this.plugin.app.workspace.getLeaf().openFile(f);
				}
			});
		}

		const lineageBtn = banner.createEl('button', {
			cls: 'smartmemory-banner-action',
			text: 'View derivation history',
		});
		lineageBtn.addEventListener('click', () => {
			new LineageModal(this.plugin.app, this.plugin, itemId).open();
		});

		const dismissBtn = banner.createEl('button', {
			cls: 'smartmemory-banner-dismiss',
			text: '×',
			attr: { 'aria-label': 'Dismiss banner' },
		});
		dismissBtn.addEventListener('click', () => banner.remove());

		// Insert at the top of the container, above the editor area
		container.prepend(banner);
	}

	private clearBannerOnLeaf(leaf: WorkspaceLeaf): void {
		const view = leaf.view;
		if (view instanceof MarkdownView) {
			view.containerEl.querySelectorAll('.' + BANNER_CLASS).forEach(el => el.remove());
		}
	}

	private clearAllBanners(): void {
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			this.clearBannerOnLeaf(leaf);
		});
	}
}
