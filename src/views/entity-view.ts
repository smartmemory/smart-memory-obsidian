import { ItemView, WorkspaceLeaf, TFile, Notice } from 'obsidian';
import type SmartMemoryPlugin from '../main';
import { readSmartMemoryId } from '../bridge/frontmatter';
import { RECALL_EXCLUDE_ORIGIN_PREFIXES } from '../services/search';
import { entityNeighbors } from '../bridge/entity-edges';
import { isPathExcluded } from '../util/exclusions';

export const ENTITY_VIEW_TYPE = 'smartmemory-entities';

export class EntityView extends ItemView {
	private plugin: SmartMemoryPlugin;
	private rootEl: HTMLElement | null = null;
	private currentFile: TFile | null = null;
	/** Increments on every refresh; in-flight fetches whose seq doesn't match
	 *  are discarded to prevent stale renders from rapid leaf changes. */
	private refreshSeq = 0;

	constructor(leaf: WorkspaceLeaf, plugin: SmartMemoryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return ENTITY_VIEW_TYPE; }
	getDisplayText(): string { return 'SmartMemory entities'; }
	getIcon(): string { return 'tag'; }

	async onOpen(): Promise<void> {
		this.rootEl = this.containerEl.children[1] as HTMLElement;
		this.rootEl.empty();
		this.rootEl.addClass('smartmemory-entity-view');
		await this.refresh();
	}

	async refresh(file?: TFile | null): Promise<void> {
		const root = this.rootEl;
		if (!root) return;
		const seq = ++this.refreshSeq;
		root.empty();

		const target = file ?? this.plugin.app.workspace.getActiveFile();
		this.currentFile = target ?? null;

		root.createEl('h3', { text: 'Entities in this note' });

		if (!target) {
			root.createDiv({ cls: 'smartmemory-entity-empty', text: 'No active note.' });
			return;
		}

		if (isPathExcluded(target.path, this.plugin.settings, 'entity-sidebar')) return;
		const itemId =
			this.plugin.mappingStore.getMemoryId(target.path) ??
			readSmartMemoryId(this.plugin.app, target, this.plugin.settings.workspaceId);

		if (!itemId) {
			root.createDiv({
				cls: 'smartmemory-entity-empty',
				text: 'This note has not been ingested. Run "SmartMemory: Ingest current note".',
			});
			return;
		}

		const client = this.plugin.client;
		if (!client) {
			root.createDiv({ cls: 'smartmemory-entity-empty', text: 'Not connected.' });
			return;
		}

		try {
			const item: any = await client.memories.get(itemId);
			// Discard if a newer refresh has started during the await
			if (seq !== this.refreshSeq) return;

			let entities: Array<{ name: string; type?: string; entityId?: string }> = (item?.entities || [])
				.map((e: any) => ({ name: e?.name, type: e?.type, entityId: e?.item_id }));

			// `item.entities` is only populated transiently in the immediate
			// post-ingest GET response. After the graph is rebuilt, entities
			// live as separate nodes connected via MENTIONS/MENTIONED_IN edges
			// and `item.entities` returns null. Fall back to /neighbors so the
			// sidebar keeps working past the post-ingest window.
			if (entities.length === 0) {
				if (isPathExcluded(target.path, this.plugin.settings, 'entity-sidebar')) return;
				const neighborsResp: any = await (client.memories as any).getNeighbors(itemId);
				if (seq !== this.refreshSeq) return;
				entities = entityNeighbors(neighborsResp?.neighbors || [])
					.map(n => ({
						name: typeof n.content === 'string' ? n.content : String(n.item_id ?? ''),
						type: n.memory_type,
						entityId: n.item_id,
					}))
					.filter(e => e.name);
			}

			if (entities.length === 0) {
				root.createDiv({
					cls: 'smartmemory-entity-empty',
					text: 'No entities extracted yet. Run "SmartMemory: Enrich current note".',
				});
				return;
			}

			const chips = root.createDiv({ cls: 'smartmemory-entity-chips' });
			for (const entity of entities) {
				if (!entity?.name) continue;
				const chip = chips.createDiv({ cls: 'smartmemory-entity-chip' });
				chip.createSpan({ cls: 'smartmemory-entity-name', text: entity.name });
				if (entity.type) {
					chip.createSpan({ cls: 'smartmemory-entity-type', text: entity.type });
				}
				chip.addEventListener('click', () => this.showCrossNoteResults(entity, itemId, root));
			}
		} catch (err) {
			if (seq !== this.refreshSeq) return;
			root.createDiv({
				cls: 'smartmemory-entity-empty',
				text: `Failed to load entities: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	private async showCrossNoteResults(
		entity: { name: string; entityId?: string },
		currentNoteItemId: string,
		root: HTMLElement,
	): Promise<void> {
		if (this.currentFile && isPathExcluded(
			this.currentFile.path, this.plugin.settings, entity.entityId ? 'entity-lookup-graph' : 'entity-lookup-search',
		)) return;
		// Remove any previous cross-note results section
		root.querySelectorAll('.smartmemory-entity-cross-results').forEach(el => el.remove());

		const section = root.createDiv({ cls: 'smartmemory-entity-cross-results' });
		section.createEl('h4', { text: `Notes mentioning "${entity.name}"` });

		const client = this.plugin.client;
		if (!client) {
			section.createDiv({ text: 'Not connected.' });
			return;
		}

		// Graph-traversal path: ask the entity node "who mentions you?" via
		// /memory/{entity_id}/neighbors. This is the precise answer that lives
		// in the graph, not an approximate vector-search match. Falls back to
		// keyword search only if the entity item_id is unknown (legacy item
		// shape from older servers).
		const renderRows = (rows: Array<{ itemId: string; label: string }>) => {
			if (rows.length === 0) {
				section.createDiv({ text: 'No other notes mention this entity.' });
				return;
			}
			for (const r of rows) {
				const row = section.createDiv({ cls: 'smartmemory-entity-cross-result' });
				const link = row.createEl('a', { text: r.label });
				link.addEventListener('click', async () => {
					const filePath = this.plugin.mappingStore.getFilePath(r.itemId);
					if (filePath) {
						const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
						if (file instanceof TFile) {
							await this.plugin.app.workspace.getLeaf().openFile(file);
							return;
						}
					}
					new Notice('SmartMemory: this memory has no vault note.');
				});
			}
		};

		try {
			if (entity.entityId) {
				const resp: any = await (client.memories as any).getNeighbors(entity.entityId);
				const neighbors: any[] = resp?.neighbors || [];
				// entityNeighbors accepts CONTAINS_ENTITY/MENTIONED_IN/MENTIONS and
				// dedups by item_id; entity-to-entity edges are dropped by the
				// item_id filter below (note id != entity id).
				const rows = entityNeighbors(neighbors)
					.filter(n => n?.item_id && n.item_id !== currentNoteItemId)
					.map(n => {
						const filePath = this.plugin.mappingStore.getFilePath(n.item_id);
						const fallbackLabel =
							typeof n.content === 'string' && n.content.trim().length > 0
								? n.content.trim().slice(0, 60)
								: n.item_id;
						return { itemId: n.item_id, label: filePath || fallbackLabel };
					});
				renderRows(rows);
				return;
			}

			// Fallback: no entity item_id available. Search by keyword and
			// post-filter against the entity name, but warn — this is the
			// imprecise path.
			const search = this.plugin.searchService;
			if (!search) {
				section.createDiv({ text: 'Not connected.' });
				return;
			}
			const results = await search.search({
				query: entity.name,
				topK: 10,
				excludeOriginPrefixes: RECALL_EXCLUDE_ORIGIN_PREFIXES,
			});
			const re = new RegExp(`\\b${entity.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
			const rows = results
				.filter(r => r.itemId !== currentNoteItemId)
				.filter(r => re.test(r.content || ''))
				.map(r => {
					const filePath = this.plugin.mappingStore.getFilePath(r.itemId);
					return { itemId: r.itemId, label: filePath || r.snippet.slice(0, 60) };
				});
			renderRows(rows);
		} catch (err) {
			section.createDiv({ text: `Lookup failed: ${err instanceof Error ? err.message : String(err)}` });
		}
	}
}
