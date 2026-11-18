import type { App, TFile } from 'obsidian';
import type { SmartMemoryClient } from 'smartmemory-sdk-js/core';
import type { MappingStore } from '../bridge/mapping-store';
import type { SmartMemorySettings } from '../types';
import { writeSmartMemoryFrontmatter, readSmartMemoryId } from '../bridge/frontmatter';
import { parseOkf, type OkfDocument } from '../bridge/okf';
import { isPathExcluded } from '../util/exclusions';
import { readSaveReceipt, type SavedItem } from './save-receipt';

export type IngestEvent =
	| { type: 'ingest-start'; path: string }
	| { type: 'ingest-complete'; path: string; itemId: string }
	| { type: 'ingest-error'; path: string; error: string }
	| { type: 'enrichment-start'; path: string; itemId: string }
	| { type: 'enrichment-complete'; path: string; itemId: string }
	| { type: 'enrichment-timeout'; path: string; itemId: string }
	| { type: 'batch-progress'; processed: number; total: number };

export interface IngestServiceConfig {
	client: SmartMemoryClient;
	app: App;
	mappingStore: MappingStore;
	settings: SmartMemorySettings;
	/** Delay between enrichment poll attempts (ms). Default 3000. */
	pollDelayMs?: number;
	/** Max enrichment poll attempts before timeout. Default 4 (~12s total). */
	pollMaxAttempts?: number;
	/** Max concurrent ingests during folder batch. Default 3. */
	concurrency?: number;
	onEvent?: (event: IngestEvent) => void;
	/** Invoked after each successful mapping mutation so the host plugin can
	 *  persist `mappingStore.toJSON()` to plugin data. Without this hook,
	 *  mappings live only in memory and `memory→file` lookups silently fail
	 *  on the next plugin reload. */
	onMappingsChanged?: () => void | Promise<void>;
}

export interface BatchResult {
	succeeded: number;
	failed: number;
	skipped: number;
}

export interface IngestFileOptions {
	/** Force PUT update path even if content changed. */
	metadataOnly?: boolean;
	/** Skip auto-enrichment poll after ingest. */
	skipEnrichment?: boolean;
	/**
	 * The user asked for this ingest (command, folder batch). Only then may a
	 * note whose item id matches no server item be uploaded; automatic saves
	 * never upload an unmatched note (G136).
	 */
	userInitiated?: boolean;
}

export interface IngestFileResult {
	itemId: string;
	skipped?: 'excluded' | 'empty' | 'unmatched';
	/** The note's own item id matched a server item, so it was adopted without a save. */
	adopted?: boolean;
}

/**
 * djb2 hash — fast, deterministic, sufficient for content-change detection.
 * Not cryptographic; we only need to know if a file's content has changed.
 */
export function hashContent(s: string): string {
	let hash = 5381;
	for (let i = 0; i < s.length; i++) {
		hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

export class IngestService {
	private client: SmartMemoryClient;
	private app: App;
	private store: MappingStore;
	private settings: SmartMemorySettings;
	private pollDelayMs: number;
	private pollMaxAttempts: number;
	private concurrency: number;
	private onEvent?: (event: IngestEvent) => void;
	private onMappingsChanged?: () => void | Promise<void>;
	/** When true, file modify events are suppressed (set during folder batch
	 *  to prevent feedback loops with auto-ingest-on-save). */
	public batchInProgress = false;
	/** Per-path self-write suppression. When the plugin writes frontmatter,
	 *  Obsidian fires a `modify` event for our own write. Without this guard
	 *  the event handler still burns a debounce timer (and would re-ingest
	 *  if the body hash differed). The mapping path → expiry-timestamp lets
	 *  vault-events skip events fired within the suppression window. */
	private selfWrites = new Map<string, number>();
	public isSelfWrite(path: string): boolean {
		const expiry = this.selfWrites.get(path);
		if (expiry === undefined) return false;
		if (Date.now() > expiry) {
			this.selfWrites.delete(path);
			return false;
		}
		return true;
	}
	private markSelfWrite(path: string, windowMs = 2000): void {
		this.selfWrites.set(path, Date.now() + windowMs);
	}

	constructor(cfg: IngestServiceConfig) {
		this.client = cfg.client;
		this.app = cfg.app;
		this.store = cfg.mappingStore;
		this.settings = cfg.settings;
		this.pollDelayMs = cfg.pollDelayMs ?? 3000;
		this.pollMaxAttempts = cfg.pollMaxAttempts ?? 4;
		this.concurrency = cfg.concurrency ?? 3;
		this.onEvent = cfg.onEvent;
		this.onMappingsChanged = cfg.onMappingsChanged;
	}

	private notifyMappingsChanged(): void {
		// Fire-and-forget — persistence errors should not break ingest. The
		// host's `serializedSave` queue already swallows its own write
		// failures so they don't cascade.
		void Promise.resolve(this.onMappingsChanged?.()).catch(() => {});
	}

	/** The server item for `id`, or null when it is gone (404, or a 200 naming no item). Other failures rethrow so the caller can retry. */
	private async remoteItem(id: string): Promise<any | null> {
		try {
			const remote: any = await this.client.memories.get(id);
			return remote?.item_id ? remote : null;
		} catch (err) {
			if ((err as any)?.status === 404) return null;
			throw err;
		}
	}

	private async saveContent(content: string, path: string, okf: OkfDocument | null): Promise<SavedItem> {
		const receipt = await this.client.memories.ingest(content, { context: ingestContext(path, okf) });
		return readSaveReceipt(receipt, path);
	}

	/** A note whose item id matches no server item: nothing is uploaded; the user decides. */
	private unmatched(path: string, id: string): IngestFileResult {
		console.warn('[smartmemory] note carries an item id no server item matches; not uploading it until you ingest it yourself', path, id);
		this.emit({ type: 'ingest-error', path, error: `unmatched: item ${id} not found on the server; run "Ingest current note" to upload it` });
		return { itemId: '', skipped: 'unmatched' };
	}

	async ingestFile(file: TFile, options: IngestFileOptions = {}): Promise<IngestFileResult> {
		const excluded = () => isPathExcluded(file.path, this.settings, 'ingest-file');
		if (excluded()) return { itemId: '', skipped: 'excluded' };
		this.emit({ type: 'ingest-start', path: file.path });

		try {
			const raw = await this.app.vault.read(file);
			if (excluded()) return { itemId: '', skipped: 'excluded' };
			// Parse OKF rather than discarding frontmatter wholesale. The body is
			// still the ingest text, while native fields, extension data, and
			// preserved producer keys travel in structured context.
			let okf: OkfDocument | null = null;
			if (raw.startsWith('---')) {
				try {
					okf = parseOkf(raw);
				} catch (err) {
					console.warn(
						'[smartmemory] Note frontmatter is not valid OKF; ingesting as an unconverted note',
						file.path,
						err,
					);
				}
			}
			const content = okf?.body ?? stripLeadingFrontmatter(raw);
			if (!content.trim()) {
				console.warn('[smartmemory] ingest skipped: note is empty', file.path);
				return { itemId: '', skipped: 'empty' };
			}
			const newHash = hashContent(content);
			const oldHash = this.store.getContentHash(file.path);
			const existingId = this.store.getMemoryId(file.path) ?? readSmartMemoryId(this.app, file, this.settings.workspaceId);

			let itemId: string;
			let saved: SavedItem | undefined;
			let adopted = false;
			if (options.metadataOnly && existingId) {
				// Metadata-only: PUT update, skip pipeline re-extraction.
				// MemoriesAPI.update accepts { metadata } directly (deep-merged).
				await this.client.memories.update(existingId, {
					metadata: { source_path: file.path },
				});
				itemId = existingId;
			} else if (existingId && oldHash === newHash) {
				// Content unchanged — verify the remote memory still exists before
				// short-circuiting. Only re-ingest on a true 404; on transient
				// failures (5xx, network) we re-throw so the caller can retry,
				// rather than silently creating a duplicate remote memory.
				const remote = await this.remoteItem(existingId);
				if (excluded()) return { itemId: '', skipped: 'excluded' };
				if (remote) {
					this.emit({ type: 'ingest-complete', path: file.path, itemId: existingId });
					return { itemId: existingId };
				}
				// The note's item is gone from the server. Uploading it again is a
				// new save of an unmatched note: only when the user asked.
				if (!options.userInitiated) return this.unmatched(file.path, existingId);
				this.store.handleDelete(file.path);
				saved = await this.saveContent(content, file.path, okf);
				itemId = saved.itemId;
			} else if (existingId && oldHash === undefined) {
				// Adoption (G136). The note already carries an item id (frontmatter
				// or a restored mapping) but this device never synced it. When the
				// server holds that item, adopt it by id: record the mapping, the
				// content baseline and the revision, and make NO ingest call. When
				// nothing matches, it is an unmatched note and is not uploaded
				// unless the user asked.
				const remote = await this.remoteItem(existingId);
				if (excluded()) return { itemId: '', skipped: 'excluded' };
				if (remote) {
					itemId = existingId;
					adopted = true;
					if (typeof remote.revision === 'number') saved = { itemId, revision: remote.revision };
				} else {
					if (!options.userInitiated) return this.unmatched(file.path, existingId);
					this.store.handleDelete(file.path);
					saved = await this.saveContent(content, file.path, okf);
					itemId = saved.itemId;
				}
			} else {
				// First time OR content changed.
				//
				// An edit of a note whose item is on the server replaces that item:
				// delete it, then save the new content. The server-side source-path
				// dedupe (CORE-INGEST-DEDUPE-1, COMPLETE 2026-06-08) is scoped to
				// `import:*` and `code:index` origins, so this client-side
				// delete-then-save stays for the Obsidian origin (unverified for
				// the 2.0 receipt path, no live producer yet).
				let unmatchedId: string | null = null;
				if (existingId) {
					try {
						await (this.client as any).memories.delete(existingId);
					} catch (err) {
						// 404 = the item is already gone: this note no longer matches a
						// server item. Other errors: log and proceed, orphaning is
						// preferable to refusing to save the user's edited content.
						const status = (err as any)?.status;
						if (status === 404) {
							unmatchedId = existingId;
						} else {
							console.warn('[smartmemory] pre-ingest delete failed', existingId, err);
						}
					}
					if (unmatchedId && !options.userInitiated) return this.unmatched(file.path, unmatchedId);
					this.store.handleDelete(file.path);
				}
				if (excluded()) return { itemId: '', skipped: 'excluded' };
				saved = await this.saveContent(content, file.path, okf);
				itemId = saved.itemId;
			}

			if (excluded()) return { itemId: '', skipped: 'excluded' };
			this.store.set(file.path, itemId);
			this.store.setContentHash(file.path, newHash);
			if (saved) this.store.setRevision(file.path, saved.revision);
			this.notifyMappingsChanged();

			// Mark before writing so the modify event fired by our own write
			// is suppressed at the vault-events layer.
			this.markSelfWrite(file.path);
			// Always write the ID + sync timestamp; entities/relations come from enrichFile()
			const writeResult = await writeSmartMemoryFrontmatter(this.app, file, { id: itemId }, this.settings);
			if (!writeResult.ok) {
				// Frontmatter write failed (malformed YAML in the note) — surface
				// to caller. Mapping is still updated so re-running enrichment
				// can recover when the file is fixed.
				this.emit({
					type: 'ingest-error',
					path: file.path,
					error: `frontmatter write failed: ${writeResult.error.message}`,
				});
			}

			this.emit({ type: 'ingest-complete', path: file.path, itemId });

			if (!options.skipEnrichment) {
				console.log('[smartmemory] kicking off enrichment poll for', file.path, itemId);
				// Fire-and-forget enrichment poll — don't block ingest completion
				void this.enrichFile(file).catch((err) => {
					console.error('[smartmemory] enrichFile threw', err);
				});
			} else {
				console.log('[smartmemory] enrichment skipped (skipEnrichment=true) for', file.path);
			}

			return adopted ? { itemId, adopted } : { itemId };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.emit({ type: 'ingest-error', path: file.path, error: message });
			throw err;
		}
	}

	/**
	 * Two-step enrichment: poll GET /memory/{itemId} until extracted entities
	 * are available, then write them to the note's frontmatter. Times out
	 * after pollMaxAttempts attempts.
	 *
	 * Guards against duplicate-ingest races: before writing frontmatter we
	 * check that the file is still mapped to the same itemId. If a newer
	 * ingest has remapped the file to a different itemId, this enrichment
	 * is stale and we skip the write.
	 */
	async enrichFile(file: TFile): Promise<void> {
		const excluded = () => isPathExcluded(file.path, this.settings, 'enrichment');
		if (excluded()) return;
		const itemId = this.store.getMemoryId(file.path) ?? readSmartMemoryId(this.app, file, this.settings.workspaceId);
		if (!itemId) {
			console.warn('[smartmemory] enrichFile skipped — no itemId for', file.path);
			return;
		}

		this.emit({ type: 'enrichment-start', path: file.path, itemId });
		console.log('[smartmemory] enrichment polling start', file.path, itemId);

		// Extracted entities live as graph neighbors (link_type=CONTAINS_ENTITY,
		// memory_type=entity), NOT as item.entities. The MemoryItem.entities
		// field is always null for graph-extracted items. We poll
		// /memory/{id}/neighbors and synthesize the entity list from the
		// CONTAINS_ENTITY edges. We also fetch the item once for memory_type.
		let memoryType: string | undefined;
		let itemRelations: any[] = [];
		try {
			const item: any = await this.client.memories.get(itemId);
			memoryType = item?.memory_type;
			// MemoryItem.relations is sometimes populated directly by the
			// pipeline (LLM extractor path). When present, prefer it over
			// the synthesized form. Otherwise we fall back to deriving
			// relations from non-CONTAINS_ENTITY neighbor edges below.
			if (Array.isArray(item?.relations)) {
				itemRelations = item.relations;
			}
		} catch {
			// non-fatal — memory_type is optional in the writeback
		}

		for (let attempt = 0; attempt < this.pollMaxAttempts; attempt++) {
			if (this.pollDelayMs > 0) {
				await sleep(this.pollDelayMs);
			}
			if (excluded()) return;

			let neighbors: any[] = [];
			try {
				const resp: any = await (this.client.memories as any).getNeighbors(itemId);
				neighbors = Array.isArray(resp?.neighbors) ? resp.neighbors : [];
			} catch (err) {
				console.warn('[smartmemory] enrichment neighbors error (will retry)', err);
				continue;
			}

			const entityNeighbors = neighbors.filter(
				(n: any) => String(n?.link_type || '').toUpperCase() === 'CONTAINS_ENTITY',
			);

			console.log('[smartmemory] enrichment poll attempt', attempt + 1, {
				itemId,
				totalNeighbors: neighbors.length,
				entityCount: entityNeighbors.length,
				memoryType,
			});

			// Pipeline reports done when at least one entity is linked OR when
			// neighbors are present at all (server may have completed with
			// zero entities). We treat the first non-empty neighbors response
			// as terminal; otherwise keep polling.
			if (neighbors.length > 0) {
				if (excluded()) return;
				// Stale check: did a newer ingest replace our mapping?
				const currentMapping = this.store.getMemoryId(file.path);
				if (currentMapping && currentMapping !== itemId) {
					return;
				}

				const entities = entityNeighbors.map((n: any) => ({
					name: String(n.content || '').trim(),
					type: undefined as string | undefined,
				})).filter(e => e.name.length > 0);

				// Derive relations from non-CONTAINS_ENTITY, non-infrastructure
				// edges among the returned neighbors. The /neighbors endpoint
				// already filters out infra edges server-side, so anything
				// surviving here that isn't CONTAINS_ENTITY is a real semantic
				// link the user cares about (RELATES_TO, IS_A, WORKS_FOR, etc.).
				const relationNeighbors = neighbors.filter(
					(n: any) => String(n?.link_type || '').toUpperCase() !== 'CONTAINS_ENTITY',
				);
				const derivedRelations = relationNeighbors.map((n: any) => ({
					subject: file.basename || file.name,
					predicate: String(n.link_type || 'RELATES_TO').toLowerCase(),
					object: String(n.content || n.item_id || '').trim(),
				})).filter(r => !!r.object);
				const relations = itemRelations.length > 0 ? itemRelations : derivedRelations;

				this.markSelfWrite(file.path);
				const writeResult = await writeSmartMemoryFrontmatter(this.app, file, {
					id: itemId,
					memoryType,
					entities,
					relations,
				}, this.settings);
				if (!writeResult.ok) {
					this.emit({
						type: 'ingest-error',
						path: file.path,
						error: `enrichment write failed: ${writeResult.error.message}`,
					});
					return;
				}

				const entityNames = entities.map(e => e.name);
				this.store.replaceEntitiesForFile(file.path, entityNames);
				this.notifyMappingsChanged();

				this.emit({ type: 'enrichment-complete', path: file.path, itemId });
				console.log('[smartmemory] enrichment complete', file.path, `${entities.length} entities`);
				return;
			}
		}

		this.emit({ type: 'enrichment-timeout', path: file.path, itemId });
		console.warn('[smartmemory] enrichment timed out — no neighbors returned for', itemId);
	}

	async ingestFolder(files: TFile[]): Promise<BatchResult> {
		this.batchInProgress = true;
		try {
			const queue = files.filter(f => !isPathExcluded(f.path, this.settings, 'folder-ingest'));
			let skipped = files.length - queue.length;
			let succeeded = 0;
			let failed = 0;
			let processed = 0;
			const total = queue.length;

			// Bounded concurrency via worker pool pattern
			const workers: Promise<void>[] = [];
			let nextIndex = 0;

			const runWorker = async (): Promise<void> => {
				while (nextIndex < queue.length) {
					const idx = nextIndex++;
					const file = queue[idx];
					try {
						const result = await this.ingestFile(file, { skipEnrichment: true, userInitiated: true });
						if (result.skipped) skipped++;
						else succeeded++;
					} catch {
						failed++;
					}
					processed++;
					this.emit({ type: 'batch-progress', processed, total });
				}
			};

			for (let i = 0; i < Math.min(this.concurrency, queue.length); i++) {
				workers.push(runWorker());
			}
			await Promise.all(workers);

			return { succeeded, failed, skipped };
		} finally {
			this.batchInProgress = false;
		}
	}

	updateSettings(settings: SmartMemorySettings): void {
		this.settings = settings;
	}

	private emit(event: IngestEvent): void {
		this.onEvent?.(event);
	}
}

function ingestContext(path: string, okf: OkfDocument | null): Record<string, any> {
	const context: Record<string, any> = { origin: 'import:obsidian', source_path: path };
	if (okf) {
		context.okf = {
			type: okf.type,
			title: okf.title,
			description: okf.description,
			resource: okf.resource,
			tags: okf.tags,
			timestamp: okf.timestamp,
			smartmemory: okf.smartmemory,
			preserved_unknown: okf.preserved_unknown,
			okf_version: okf.okf_version,
		};
	}
	return context;
}

/** Match the pre-OKF adapter: YAML metadata is excluded from body ingestion. */
function stripLeadingFrontmatter(raw: string): string {
	if (!raw.startsWith('---')) return raw;
	const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
	return match ? raw.slice(match[0].length) : raw;
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
