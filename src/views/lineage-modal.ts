import { App, Modal, TFile, Notice } from 'obsidian';
import type SmartMemoryPlugin from '../main';
import { isPathExcluded } from '../util/exclusions';

export class LineageModal extends Modal {
	private plugin: SmartMemoryPlugin;
	private itemId: string;

	constructor(app: App, plugin: SmartMemoryPlugin, itemId: string) {
		super(app);
		this.plugin = plugin;
		this.itemId = itemId;
	}

	async onOpen(): Promise<void> {
		const path = this.plugin.mappingStore.getFilePath(this.itemId);
		if (path && isPathExcluded(path, this.plugin.settings, 'lineage-modal')) return;
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('smartmemory-lineage-modal');
		contentEl.createEl('h2', { text: 'Memory derivation history' });

		const body = contentEl.createDiv({ cls: 'smartmemory-lineage-body' });
		body.setText('Loading...');

		const client = this.plugin.client;
		if (!client) {
			body.setText('Not connected.');
			return;
		}

		try {
			const result: any = await client.memories.getLineage(this.itemId);
			const chain: any[] = Array.isArray(result?.lineage) ? result.lineage : [];
			body.empty();

			if (chain.length === 0) {
				body.setText('No derivation history.');
				return;
			}

			body.createEl('p', {
				cls: 'smartmemory-lineage-info',
				text: `${chain.length} item${chain.length === 1 ? '' : 's'} in derivation chain (depth ${result.depth ?? chain.length}).`,
			});

			const list = body.createEl('ol', { cls: 'smartmemory-lineage-list' });
			for (const item of chain) {
				const li = list.createEl('li');
				const meta = li.createDiv({ cls: 'smartmemory-lineage-meta' });
				meta.createSpan({ cls: 'smartmemory-search-type', text: item.memory_type || 'unknown' });
				if (typeof item.confidence === 'number') {
					meta.createSpan({
						cls: 'smartmemory-lineage-confidence',
						text: `confidence ${item.confidence.toFixed(2)}`,
					});
				}
				li.createDiv({ cls: 'smartmemory-search-snippet', text: item.content || '' });

				const filePath = this.plugin.mappingStore.getFilePath(item.item_id);
				if (filePath) {
					const link = li.createEl('a', { text: 'Open vault note' });
					link.addEventListener('click', async () => {
						const file = this.app.vault.getAbstractFileByPath(filePath);
						if (file instanceof TFile) {
							await this.app.workspace.getLeaf().openFile(file);
							this.close();
						} else {
							new Notice('SmartMemory: vault note no longer exists');
						}
					});
				}
			}
		} catch (err) {
			body.setText(`Failed to load lineage: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
