/**
 * Regression tests for Codex review findings (DIST-OBSIDIAN-1 Phase 7).
 * Each test pins a specific bug fix so future refactors can't silently
 * reintroduce the original behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IngestService, IngestEvent } from '../src/services/ingest';
import { MappingStore } from '../src/bridge/mapping-store';
import { EMPTY_MAPPINGS, DEFAULT_SETTINGS } from '../src/types';

function createApp() {
	const frontmatters: Record<string, any> = {};
	return {
		fileManager: {
			processFrontMatter: vi.fn(async (file: any, fn: (fm: any) => void) => {
				const fm = frontmatters[file.path] ?? {};
				fn(fm);
				frontmatters[file.path] = fm;
			}),
		},
		metadataCache: {
			getFileCache: vi.fn((file: any) => ({ frontmatter: frontmatters[file.path] ?? {} })),
		},
		vault: { read: vi.fn(async (file: any) => file._content ?? '') },
		_frontmatters: frontmatters,
	};
}

describe('regression: ingest 5xx must not duplicate-ingest (Codex MUST-FIX #1)', () => {
	let service: IngestService;
	let client: any;
	let store: MappingStore;
	let events: IngestEvent[];

	beforeEach(() => {
		client = {
			memories: {
				ingest: vi.fn().mockResolvedValue({ item_id: 'item-1' }),
				update: vi.fn(),
				get: vi.fn(),
			},
		};
		store = new MappingStore({ ...EMPTY_MAPPINGS });
		events = [];
		service = new IngestService({
			client, app: createApp(), mappingStore: store,
			settings: { ...DEFAULT_SETTINGS, workspaceId: 'team-a' }, pollDelayMs: 0, pollMaxAttempts: 1,
			onEvent: (e) => events.push(e),
		});
	});

	it('transient 500 on the existence check re-throws instead of re-ingesting', async () => {
		const file = { path: 'a.md', _content: 'unchanged' };
		// First ingest: success
		await service.ingestFile(file as any);
		expect(client.memories.ingest).toHaveBeenCalledTimes(1);

		// Second pass — content unchanged but server returns 500 on get()
		client.memories.ingest.mockClear();
		const transient = Object.assign(new Error('upstream timeout'), { status: 500 });
		client.memories.get.mockRejectedValueOnce(transient);

		await expect(service.ingestFile(file as any)).rejects.toBe(transient);
		expect(client.memories.ingest).not.toHaveBeenCalled();
		// Mapping preserved — we did NOT delete it on a transient
		expect(store.getMemoryId('a.md')).toBe('item-1');
	});

	it('true 404 on the existence check, user-initiated: drops mapping and re-ingests', async () => {
		const file = { path: 'a.md', _content: 'unchanged' };
		await service.ingestFile(file as any);
		client.memories.ingest.mockClear();
		client.memories.ingest.mockResolvedValueOnce({ item_id: 'item-2' });
		client.memories.get.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }));

		const result = await service.ingestFile(file as any, { userInitiated: true });
		expect(result.itemId).toBe('item-2');
		expect(client.memories.ingest).toHaveBeenCalledTimes(1);
	});

	it('true 404 on the existence check, automatic save: uploads nothing and keeps the mapping (G136)', async () => {
		const file = { path: 'a.md', _content: 'unchanged' };
		await service.ingestFile(file as any);
		client.memories.ingest.mockClear();
		client.memories.get.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }));

		const result = await service.ingestFile(file as any);
		expect(result).toEqual({ itemId: '', skipped: 'unmatched' });
		expect(client.memories.ingest).not.toHaveBeenCalled();
		expect(store.getMemoryId('a.md')).toBe('item-1');
	});
});

describe('regression: empty-array enrichment completes (Codex MUST-FIX #2)', () => {
	it('extraction with zero entities is treated as completed, not pending', async () => {
		const client = {
			memories: {
				ingest: vi.fn().mockResolvedValue({ item_id: 'item-1' }),
				update: vi.fn(),
				get: vi.fn().mockResolvedValue({
					item_id: 'item-1',
					memory_type: 'semantic',
				}),
				// Pipeline completed with non-entity neighbors only (e.g.
				// chunk relations). Enrichment treats any neighbor list as a
				// terminal signal — `neighbors.length > 0` means the
				// pipeline ran, even if zero entities were extracted.
				getNeighbors: vi.fn().mockResolvedValue({
					item_id: 'item-1',
					neighbors: [
						{ item_id: 'v1', content: '', memory_type: 'version', link_type: 'HAS_VERSION' },
					],
				}),
			},
		};
		const events: IngestEvent[] = [];
		const service = new IngestService({
			client,
			app: createApp(),
			mappingStore: new MappingStore({ ...EMPTY_MAPPINGS }),
			settings: { ...DEFAULT_SETTINGS, workspaceId: 'team-a' },
			pollDelayMs: 0,
			pollMaxAttempts: 3,
			onEvent: (e) => events.push(e),
		});
		const file = { path: 'a.md', _content: 'no salient entities here' };

		await service.ingestFile(file as any, { skipEnrichment: true });
		await service.enrichFile(file as any);

		const kinds = events.map(e => e.type);
		expect(kinds).toContain('enrichment-complete');
		expect(kinds).not.toContain('enrichment-timeout');
		// First neighbors response was already terminal — no retry burn
		expect(client.memories.getNeighbors).toHaveBeenCalledTimes(1);
	});
});

describe('regression: parsed OKF body hashing (auto-ingest feedback loop fix)', () => {
	it('produces same hash regardless of OKF metadata churn', async () => {
		const { parseOkf } = await import('../src/bridge/okf');
		const { hashContent } = await import('../src/services/ingest');

		const before = '---\ntype: semantic\nresource: smartmemory://team-a/abc\ntimestamp: "2026-04-30T00:00:00Z"\n---\nThe rain in Spain.';
		const after = '---\ntype: semantic\nresource: smartmemory://team-a/def\ntimestamp: "2026-04-30T00:00:30Z"\n---\nThe rain in Spain.';
		expect(hashContent(parseOkf(before).body)).toBe(hashContent(parseOkf(after).body));
	});

	it('produces different hash when body changes', async () => {
		const { parseOkf } = await import('../src/bridge/okf');
		const { hashContent } = await import('../src/services/ingest');

		const v1 = '---\ntype: semantic\n---\nVersion one.';
		const v2 = '---\ntype: semantic\n---\nVersion two.';
		expect(hashContent(parseOkf(v1).body)).not.toBe(hashContent(parseOkf(v2).body));
	});

	it('rejects malformed fenced input rather than silently treating it as body', async () => {
		const { parseOkf, OkfParseError } = await import('../src/bridge/okf');
		expect(() => parseOkf('---\nbut not closed')).toThrow(OkfParseError);
	});
});

describe('regression: mapping store entity mappings (Codex SHOULD-FIX + Round 2 Medium)', () => {
	let store: MappingStore;
	beforeEach(() => {
		store = new MappingStore({ ...EMPTY_MAPPINGS });
	});

	it('handleRename re-points entity mappings that referenced the old path', () => {
		store.set('alice.md', 'item-1');
		store.setEntityFile('Alice', 'alice.md');
		store.handleRename('alice.md', 'people/alice.md');
		expect(store.getEntityFile('Alice')).toBe('people/alice.md');
	});

	it('handleDelete removes entity mappings that pointed at the deleted file', () => {
		store.set('alice.md', 'item-1');
		store.setEntityFile('Alice', 'alice.md');
		store.setEntityFile('Bob', 'bob.md');
		store.handleDelete('alice.md');
		expect(store.getEntityFile('Alice')).toBeNull();
		expect(store.getEntityFile('Bob')).toBe('bob.md'); // unrelated mapping preserved
	});

	it('replaceEntitiesForFile prunes stale entities owned by the file', () => {
		store.setEntityFile('Asimov', 'a.md');
		store.setEntityFile('Foundation', 'a.md');
		store.setEntityFile('Bob', 'b.md');

		// Re-enrichment finds only one entity now
		store.replaceEntitiesForFile('a.md', ['Asimov']);

		expect(store.getEntityFile('Asimov')).toBe('a.md');
		expect(store.getEntityFile('Foundation')).toBeNull();  // pruned
		expect(store.getEntityFile('Bob')).toBe('b.md');       // untouched
	});

	it('replaceEntitiesForFile with empty list clears all owned entities', () => {
		store.setEntityFile('Asimov', 'a.md');
		store.replaceEntitiesForFile('a.md', []);
		expect(store.getEntityFile('Asimov')).toBeNull();
	});
});
