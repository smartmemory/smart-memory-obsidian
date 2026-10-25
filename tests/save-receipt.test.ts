/**
 * REL-CALLERS-FIRSTPARTY-1: Obsidian reads the 2.0 save receipt and adopts by item id (G136).
 * Receipts follow docs/features/SM2-SAVE-1/save-receipt-contract.json. The client is a fake that
 * resolves to the receipt shape the JS SDK build `rel-callers-jssdk-1` (f37df78) returns:
 * wire fields plus an `item_id` accessor onto `subject.item_id`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IngestService, hashContent } from '../src/services/ingest';
import { readSaveReceipt, SaveReceiptError } from '../src/services/save-receipt';
import { MappingStore } from '../src/bridge/mapping-store';
import { EMPTY_MAPPINGS, DEFAULT_SETTINGS } from '../src/types';

function receipt(itemId: string, revision = 1, runId = 'run_1') {
	const wire: any = {
		schema_version: '1.1',
		subject: { kind: 'item_save', item_id: itemId },
		run_id: runId,
		status_url: `/memory/status/${runId}`,
		processing_stage: 'received',
		execution_state: 'queued',
		outcome: null,
		terminal: false,
		result_availability: 'pending',
		status_version: 1,
		revision,
	};
	Object.defineProperty(wire, 'item_id', { get: () => wire.subject.item_id, enumerable: false });
	return wire;
}

function createApp(frontmatters: Record<string, any> = {}) {
	return {
		fileManager: {
			processFrontMatter: vi.fn(async (file: any, fn: (fm: any) => void) => {
				const fm = frontmatters[file.path] ?? {};
				fn(fm);
				frontmatters[file.path] = fm;
			}),
		},
		metadataCache: { getFileCache: vi.fn((file: any) => ({ frontmatter: frontmatters[file.path] ?? {} })) },
		vault: { read: vi.fn(async (file: any) => file._content ?? '') },
		_frontmatters: frontmatters,
	};
}

const notFound = () => Object.assign(new Error('not found'), { status: 404 });

describe('readSaveReceipt', () => {
	const ROWS: { name: string; input: any; ok?: { itemId: string; revision?: number }; code?: string }[] = [
		{ name: 'SDK receipt (item_id accessor)', input: receipt('mem_123', 3), ok: { itemId: 'mem_123', revision: 3 } },
		{ name: 'wire receipt with subject only', input: { ...receipt('mem_9'), revision: undefined, result: { revision: 4 } }, ok: { itemId: 'mem_9', revision: 4 } },
		{ name: 'bare item_id (pre-receipt fake)', input: { item_id: 'legacy_1' }, ok: { itemId: 'legacy_1', revision: undefined } },
		{ name: 'admission error', input: { run_id: 'run_2', admission_error: { code: 'idempotency_conflict', message: 'conflict' } }, code: 'admission_error' },
		{ name: 'receipt naming no item', input: { ...receipt(''), subject: { kind: 'item_save' } }, code: 'no_item_id' },
		{ name: 'empty body', input: {}, code: 'no_item_id' },
		{ name: 'null body', input: null, code: 'no_item_id' },
	];
	for (const row of ROWS) {
		it(row.name, () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			if (row.ok) {
				const got = readSaveReceipt(row.input, 'n.md');
				expect(got.itemId).toBe(row.ok.itemId);
				expect(got.revision).toBe(row.ok.revision);
				expect(warn).not.toHaveBeenCalled();
			} else {
				try {
					readSaveReceipt(row.input, 'n.md');
					throw new Error('expected a SaveReceiptError');
				} catch (e) {
					expect(e).toBeInstanceOf(SaveReceiptError);
					expect((e as SaveReceiptError).code).toBe(row.code);
				}
				expect(warn).toHaveBeenCalledTimes(1);
			}
			warn.mockRestore();
		});
	}

	it('keeps the run handle on a refusal', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			readSaveReceipt({ run_id: 'run_2', status_url: '/memory/status/run_2', admission_error: { code: 'revision_conflict', message: 'x' } }, 'n.md');
		} catch (e) {
			expect((e as SaveReceiptError).runId).toBe('run_2');
			expect((e as SaveReceiptError).statusUrl).toBe('/memory/status/run_2');
		}
		vi.restoreAllMocks();
	});
});

describe('IngestService adopts by receipt item id (G136)', () => {
	let client: any;
	let store: MappingStore;
	let app: any;
	let service: IngestService;

	const make = (frontmatters: Record<string, any> = {}) => {
		client = {
			memories: {
				ingest: vi.fn().mockResolvedValue(receipt('mem_new', 1, 'run_new')),
				delete: vi.fn().mockResolvedValue(undefined),
				update: vi.fn(),
				get: vi.fn().mockResolvedValue({ item_id: 'mem_old', revision: 7 }),
				getNeighbors: vi.fn().mockResolvedValue({ neighbors: [] }),
			},
		};
		app = createApp(frontmatters);
		store = new MappingStore({ ...EMPTY_MAPPINGS });
		service = new IngestService({
			client, app, mappingStore: store,
			settings: { ...DEFAULT_SETTINGS, workspaceId: 'team-a', writeSmartMemoryExtension: true },
			pollDelayMs: 0, pollMaxAttempts: 1,
		});
	};

	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	it('first save maps the receipt item id and keeps its revision', async () => {
		make();
		const file = { path: 'a.md', _content: 'body' };
		const out = await service.ingestFile(file as any, { skipEnrichment: true });
		expect(out.itemId).toBe('mem_new');
		expect(store.getMemoryId('a.md')).toBe('mem_new');
		expect(store.getRevision('a.md')).toBe(1);
		expect(client.memories.ingest).toHaveBeenCalledTimes(1);
	});

	it('probe 4a: a note already adopted (its receipt item id matches) makes zero ingest calls', async () => {
		make({ 'a.md': { smartmemory_id: 'mem_old' } });
		const file = { path: 'a.md', _content: 'body' };
		const out = await service.ingestFile(file as any, { skipEnrichment: true });
		expect(out).toEqual({ itemId: 'mem_old', adopted: true });
		expect(client.memories.ingest).not.toHaveBeenCalled();
		expect(client.memories.delete).not.toHaveBeenCalled();
		expect(store.getMemoryId('a.md')).toBe('mem_old');
		expect(store.getContentHash('a.md')).toBe(hashContent('body'));
		expect(store.getRevision('a.md')).toBe(7);
	});

	it('probe 4b: an unmatched note makes zero ingest calls until the user acts', async () => {
		make({ 'a.md': { smartmemory_id: 'mem_gone' } });
		client.memories.get.mockRejectedValue(notFound());
		const file = { path: 'a.md', _content: 'body' };

		const auto = await service.ingestFile(file as any, { skipEnrichment: true });
		expect(auto).toEqual({ itemId: '', skipped: 'unmatched' });
		expect(client.memories.ingest).not.toHaveBeenCalled();
		expect(store.getMemoryId('a.md')).toBeNull();

		const user = await service.ingestFile(file as any, { skipEnrichment: true, userInitiated: true });
		expect(user.itemId).toBe('mem_new');
		expect(client.memories.ingest).toHaveBeenCalledTimes(1);
	});

	it('an edit of a matched note replaces it (delete then one save) and stores the new revision', async () => {
		make();
		const file = { path: 'a.md', _content: 'v1' };
		await service.ingestFile(file as any, { skipEnrichment: true });
		client.memories.ingest.mockResolvedValueOnce(receipt('mem_new2', 2, 'run_2'));
		(file as any)._content = 'v2';
		const out = await service.ingestFile(file as any, { skipEnrichment: true });
		expect(client.memories.delete).toHaveBeenCalledWith('mem_new');
		expect(out.itemId).toBe('mem_new2');
		expect(store.getRevision('a.md')).toBe(2);
	});

	it('an edit whose old item is gone (delete 404), automatic: uploads nothing', async () => {
		make();
		const file = { path: 'a.md', _content: 'v1' };
		await service.ingestFile(file as any, { skipEnrichment: true });
		client.memories.ingest.mockClear();
		client.memories.delete.mockRejectedValueOnce(notFound());
		(file as any)._content = 'v2';
		const out = await service.ingestFile(file as any, { skipEnrichment: true });
		expect(out).toEqual({ itemId: '', skipped: 'unmatched' });
		expect(client.memories.ingest).not.toHaveBeenCalled();
		expect(store.getMemoryId('a.md')).toBe('mem_new');
	});

	it('a receipt that names no item is a typed refusal: nothing is mapped', async () => {
		make();
		client.memories.ingest.mockResolvedValue({ ...receipt('x'), subject: { kind: 'item_save' }, item_id: undefined });
		const file = { path: 'a.md', _content: 'body' };
		await expect(service.ingestFile(file as any, { skipEnrichment: true })).rejects.toBeInstanceOf(SaveReceiptError);
		expect(store.getMemoryId('a.md')).toBeNull();
	});

	it('an admission error receipt is a typed refusal: nothing is mapped', async () => {
		make();
		client.memories.ingest.mockResolvedValue({ run_id: 'run_9', admission_error: { code: 'idempotency_conflict', message: 'c' } });
		const file = { path: 'a.md', _content: 'body' };
		await expect(service.ingestFile(file as any, { skipEnrichment: true })).rejects.toMatchObject({ code: 'admission_error', runId: 'run_9' });
		expect(store.getMemoryId('a.md')).toBeNull();
	});

	it('a transient failure while matching rethrows and uploads nothing', async () => {
		make({ 'a.md': { smartmemory_id: 'mem_old' } });
		const transient = Object.assign(new Error('upstream timeout'), { status: 503 });
		client.memories.get.mockRejectedValue(transient);
		await expect(service.ingestFile({ path: 'a.md', _content: 'body' } as any, { skipEnrichment: true })).rejects.toBe(transient);
		expect(client.memories.ingest).not.toHaveBeenCalled();
	});
});

describe('MappingStore revisions', () => {
	it('moves with a rename, goes with a delete, and round-trips through toJSON (older data has none)', () => {
		const store = new MappingStore({ ...EMPTY_MAPPINGS });
		store.set('a.md', 'mem_1');
		store.setRevision('a.md', 5);
		store.handleRename('a.md', 'b.md');
		expect(store.getRevision('a.md')).toBeUndefined();
		expect(store.getRevision('b.md')).toBe(5);
		const again = new MappingStore(store.toJSON());
		expect(again.getRevision('b.md')).toBe(5);
		again.handleDelete('b.md');
		expect(again.getRevision('b.md')).toBeUndefined();
		expect(new MappingStore({ ...EMPTY_MAPPINGS }).getRevision('x.md')).toBeUndefined();
	});
});
