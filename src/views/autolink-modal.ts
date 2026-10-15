import { App, Modal, TFile, Notice } from 'obsidian';
import type { LinkProposal } from '../bridge/wikilinks';
import { applyLinkInsertions, typedEdgesFromLinkProposals } from '../bridge/wikilinks';
import type SmartMemoryPlugin from '../main';
import { isPathExcluded } from '../util/exclusions';

export class AutolinkModal extends Modal {
	private file: TFile;
	private originalText: string;
	private proposals: LinkProposal[];
	private accepted: Set<number> = new Set();

	constructor(app: App, file: TFile, originalText: string, proposals: LinkProposal[], private plugin: SmartMemoryPlugin) {
		super(app);
		this.file = file;
		this.originalText = originalText;
		this.proposals = proposals;
		// Default: all selected
		for (let i = 0; i < proposals.length; i++) this.accepted.add(i);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('smartmemory-autolink-modal');

		contentEl.createEl('h2', {
			text: `Auto-link: ${this.proposals.length} proposed link${this.proposals.length === 1 ? '' : 's'}`,
		});

		if (this.proposals.length === 0) {
			contentEl.createDiv({ text: 'No new entity mentions found in this note.' });
			const closeBtn = contentEl.createEl('button', { text: 'Close' });
			closeBtn.addEventListener('click', () => this.close());
			return;
		}

		const list = contentEl.createDiv({ cls: 'smartmemory-autolink-list' });
		this.proposals.forEach((p, i) => this.renderProposal(list, p, i));

		const actions = contentEl.createDiv({ cls: 'smartmemory-autolink-actions' });

		const allBtn = actions.createEl('button', { text: 'Accept all' });
		allBtn.addEventListener('click', () => {
			this.accepted = new Set(this.proposals.map((_, i) => i));
			// applyAndClose handles its own errors; void the promise so a
			// rejection never escapes the click handler unhandled.
			void this.applyAndClose();
		});

		const selectedBtn = actions.createEl('button', { text: 'Apply selected', cls: 'mod-cta' });
		selectedBtn.addEventListener('click', () => void this.applyAndClose());

		const cancelBtn = actions.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderProposal(container: HTMLElement, p: LinkProposal, idx: number): void {
		const row = container.createDiv({ cls: 'smartmemory-autolink-row' });

		const checkbox = row.createEl('input', { type: 'checkbox' });
		checkbox.checked = true;
		checkbox.addEventListener('change', () => {
			if (checkbox.checked) this.accepted.add(idx);
			else this.accepted.delete(idx);
		});

		const preview = row.createDiv({ cls: 'smartmemory-autolink-preview' });

		const before = this.originalText.slice(Math.max(0, p.start - 30), p.start);
		const after = this.originalText.slice(p.end, p.end + 30);

		preview.createSpan({ cls: 'smartmemory-autolink-context', text: '…' + before });
		preview.createSpan({ cls: 'smartmemory-autolink-match', text: p.matchedText });
		preview.createSpan({ cls: 'smartmemory-autolink-arrow', text: ' → ' });
		preview.createSpan({ cls: 'smartmemory-autolink-target', text: `[${p.matchedText}](${p.target})` });
		preview.createSpan({ cls: 'smartmemory-autolink-context', text: after + '…' });
	}

	private async applyAndClose(): Promise<void> {
		if (isPathExcluded(this.file.path, this.plugin.settings, 'autolink-apply')) {
			this.close();
			return;
		}
		const accepted = this.proposals.filter((_, i) => this.accepted.has(i));
		if (accepted.length === 0) {
			this.close();
			return;
		}

		try {
			// Verify the note hasn't changed since the modal opened.
			// Offsets in `accepted` are relative to `originalText`; if the file
			// was edited externally (auto-ingest re-enriching frontmatter, user
			// typing, sync, etc.), applying our patch would clobber their edits.
			const current = await this.app.vault.read(this.file);
			if (current !== this.originalText) {
				new Notice('SmartMemory: note changed since auto-link preview. Aborted to prevent data loss.');
				this.close();
				return;
			}

			const newText = applyLinkInsertions(this.originalText, accepted);
			if (isPathExcluded(this.file.path, this.plugin.settings, 'autolink-apply')) return;
			await this.app.vault.modify(this.file, newText);
			if (isPathExcluded(this.file.path, this.plugin.settings, 'autolink-apply')) return;
			const newEdges = typedEdgesFromLinkProposals(accepted);
			try {
				await this.app.fileManager.processFrontMatter(this.file, (fm) => {
					if (fm.smartmemory === undefined) fm.smartmemory = {};
					if (typeof fm.smartmemory !== 'object' || fm.smartmemory === null || Array.isArray(fm.smartmemory)) {
						console.warn('[smartmemory] Rejecting invalid OKF smartmemory extension: expected a mapping', fm.smartmemory);
						throw new Error('OKF smartmemory extension must be a mapping');
					}
					if (fm.smartmemory.edges !== undefined && !Array.isArray(fm.smartmemory.edges)) {
						console.warn('[smartmemory] Rejecting invalid OKF smartmemory.edges: expected an array', fm.smartmemory.edges);
						throw new Error('OKF smartmemory.edges must be an array');
					}
					const existing = fm.smartmemory.edges ?? [];
					const seen = new Set(existing.map((edge: any) => `${edge?.type}\u0000${edge?.target}`));
					fm.smartmemory.edges = [...existing];
					for (const edge of newEdges) {
						const key = `${edge.type}\u0000${edge.target}`;
						if (!seen.has(key)) fm.smartmemory.edges.push(edge);
						seen.add(key);
					}
				});
			} catch (err) {
				console.warn(
					'[smartmemory] Auto-link edge writeback failed after inserting links; typed edges may be missing',
					err,
				);
				throw err;
			}
			new Notice(`SmartMemory: inserted ${accepted.length} link${accepted.length === 1 ? '' : 's'}`);
		} catch (err) {
			// Vault read/modify can fail (file deleted, permissions, sync lock).
			// Surface it rather than leaking an unhandled rejection.
			new Notice(`SmartMemory: auto-link failed — ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.close();
		}
	}
}
