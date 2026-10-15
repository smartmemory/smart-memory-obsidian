import { TAbstractFile, TFile, Notice } from 'obsidian';
import type SmartMemoryPlugin from '../main';
import { KeyedDebouncer } from '../util/debouncer';
import { isPathExcluded } from '../util/exclusions';

/**
 * Wires Obsidian vault lifecycle events to plugin state:
 *
 *  - rename: update mapping store; preserves SmartMemory mapping under new path
 *  - delete: drop mapping (does NOT delete remote memory — local removal only)
 *  - modify: if auto-ingest-on-save, schedule debounced re-ingest
 *  - create: if auto-ingest-on-create, schedule a fresh ingest
 *
 * Auto-ingest paths skip files when an in-progress folder batch is running
 * (ingestService.batchInProgress) to avoid feedback loops with the
 * frontmatter writeback that follows every ingest.
 */
export class VaultEvents {
	private plugin: SmartMemoryPlugin;
	private modifyDebouncer: KeyedDebouncer<string>;
	private createDebouncer: KeyedDebouncer<string>;

	constructor(plugin: SmartMemoryPlugin) {
		this.plugin = plugin;
		const delay = Math.max(500, plugin.settings.ingestDebounceMs);
		this.modifyDebouncer = new KeyedDebouncer<string>(delay);
		this.createDebouncer = new KeyedDebouncer<string>(delay);
	}

	updateSettings(): void {
		const delay = Math.max(500, this.plugin.settings.ingestDebounceMs);
		this.modifyDebouncer.setDelay(delay);
		this.createDebouncer.setDelay(delay);
	}

	register(): void {
		const { app } = this.plugin;

		this.plugin.registerEvent(
			app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
				if (!(file instanceof TFile)) return;
				this.plugin.mappingStore.handleRename(oldPath, file.path);
				this.modifyDebouncer.cancel(oldPath);
				void this.plugin.saveMappings();
			})
		);

		this.plugin.registerEvent(
			app.vault.on('delete', (file: TAbstractFile) => {
				if (!(file instanceof TFile)) return;
				this.plugin.mappingStore.handleDelete(file.path);
				this.modifyDebouncer.cancel(file.path);
				this.createDebouncer.cancel(file.path);
				void this.plugin.saveMappings();
			})
		);

		this.plugin.registerEvent(
			app.vault.on('modify', (file: TAbstractFile) => {
				if (!(file instanceof TFile) || file.extension !== 'md') return;
				if (!this.plugin.settings.autoIngestOnSave) return;
				if (isPathExcluded(file.path, this.plugin.settings, 'auto-modify')) return;
				if (this.plugin.ingestService?.batchInProgress) return;
				// Skip modify events fired by our own frontmatter writes.
				// Without this, every successful ingest still burns a 5s
				// debounce window and re-runs runAutoIngest (which then
				// short-circuits via hash, but at the cost of a redundant
				// vault read + log noise).
				if (this.plugin.ingestService?.isSelfWrite(file.path)) {
					console.debug('[smartmemory] modify event ignored — self-write', file.path);
					return;
				}

				console.debug('[smartmemory] modify event scheduled', file.path);
				this.modifyDebouncer.schedule(file.path, () => {
					void this.runAutoIngest(file, 'auto-modify');
				});
			})
		);

		this.plugin.registerEvent(
			app.vault.on('create', (file: TAbstractFile) => {
				if (!(file instanceof TFile) || file.extension !== 'md') return;
				if (!this.plugin.settings.autoIngestOnCreate) return;
				if (isPathExcluded(file.path, this.plugin.settings, 'auto-create')) return;
				if (this.plugin.ingestService?.batchInProgress) return;

				console.debug('[smartmemory] create event scheduled', file.path);
				this.createDebouncer.schedule(file.path, () => {
					void this.runAutoIngest(file, 'auto-create');
				});
			})
		);

		// Cleanup on plugin unload
		this.plugin.register(() => {
			this.modifyDebouncer.cancelAll();
			this.createDebouncer.cancelAll();
		});
	}

	private async runAutoIngest(file: TFile, pathClass: string): Promise<void> {
		if (isPathExcluded(file.path, this.plugin.settings, pathClass)) return;
		const service = this.plugin.ingestService;
		if (!service) {
			console.warn('[smartmemory] auto-ingest skipped — no ingestService', file.path);
			return;
		}
		if (service.batchInProgress) {
			console.debug('[smartmemory] auto-ingest skipped — batch in progress', file.path);
			return;
		}
		console.log('[smartmemory] auto-ingest firing', file.path);
		try {
			const result = await service.ingestFile(file);
			if (!result.itemId) return;
			console.log('[smartmemory] auto-ingest succeeded', file.path);
		} catch (err) {
			// Surface failures so users notice them; previous silent catch hid
			// real bugs (HTTP 422, auth issues, contract drift) for entire test
			// rounds while every ingest looked like a no-op.
			console.error('[smartmemory] auto-ingest failed', file.path, err);
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`SmartMemory: auto-ingest failed — ${msg}`, 8000);
		}
	}
}
