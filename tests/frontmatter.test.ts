import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	writeSmartMemoryFrontmatter,
	readSmartMemoryId,
	clearSmartMemoryFrontmatter,
	migrateLegacyFrontmatter,
} from '../src/bridge/frontmatter';
import { DEFAULT_SETTINGS } from '../src/types';

const SETTINGS = { ...DEFAULT_SETTINGS, workspaceId: 'team-a' };

describe('OKF frontmatter helpers', () => {
	let mockApp: any;
	let mockFile: any;
	let frontmatter: Record<string, any>;

	beforeEach(() => {
		frontmatter = {};
		mockFile = { path: 'test.md' };
		mockApp = {
			fileManager: {
				processFrontMatter: vi.fn(async (_file: any, fn: (fm: any) => void) => fn(frontmatter)),
			},
			metadataCache: { getFileCache: vi.fn(() => ({ frontmatter })) },
		};
	});

	describe('writeSmartMemoryFrontmatter', () => {
		it('writes native resource and type when OKF conformance is enabled', async () => {
			const result = await writeSmartMemoryFrontmatter(mockApp, mockFile, {
				id: 'item-abc', memoryType: 'decision',
			}, SETTINGS);

			expect(result.ok).toBe(true);
			expect(frontmatter.resource).toBe('smartmemory://team-a/item-abc');
			expect(frontmatter.type).toBe('decision');
			expect(frontmatter.smartmemory_id).toBeUndefined();
		});

		it('returns an error rather than writing an invalid resource without a workspace', async () => {
			const result = await writeSmartMemoryFrontmatter(mockApp, mockFile, { id: 'item-1' }, DEFAULT_SETTINGS);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.message).toContain('workspace');
		});

		it('returns error result on malformed YAML without throwing', async () => {
			mockApp.fileManager.processFrontMatter = vi.fn(async () => { throw new Error('YAML parse error'); });
			const result = await writeSmartMemoryFrontmatter(mockApp, mockFile, { id: 'item-1' }, SETTINGS);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.message).toContain('YAML parse error');
		});

		it('can disable native OKF writeback', async () => {
			await writeSmartMemoryFrontmatter(mockApp, mockFile, { id: 'item-abc' }, {
				...SETTINGS, okfConformance: false,
			});
			expect(frontmatter.resource).toBeUndefined();
		});

		it('writes optional annotations under smartmemory and preserves unknown extension keys', async () => {
			frontmatter.smartmemory = { producer_extension: { keep: true }, edges: [{ type: 'EXISTING', target: 'x' }] };
			await writeSmartMemoryFrontmatter(mockApp, mockFile, {
				id: 'item-1',
				entities: [{ name: 'Asimov', type: 'Person' }],
				relations: [{ predicate: 'authored', object: 'Foundation' }],
			}, { ...SETTINGS, writeSmartMemoryExtension: true });

			expect(frontmatter.smartmemory.entities).toEqual(['Asimov (Person)']);
			expect(frontmatter.smartmemory.edges).toEqual([
				{ type: 'EXISTING', target: 'x' },
				{ type: 'AUTHORED', target: 'Foundation' },
			]);
			expect(frontmatter.smartmemory.producer_extension).toEqual({ keep: true });
		});

		it('union-merges derived relations with existing typed edges without duplicates', async () => {
			frontmatter.smartmemory = { edges: [{ type: 'LINKS_TO', target: 'x' }] };
			await writeSmartMemoryFrontmatter(mockApp, mockFile, {
				id: 'item-1',
				relations: [
					{ type: 'LINKS_TO', target: 'x' },
					{ type: 'DERIVED_FROM', target: 'source' },
					{ type: 'DERIVED_FROM', target: 'source' },
				],
			}, { ...SETTINGS, writeSmartMemoryExtension: true });

			expect(frontmatter.smartmemory.edges).toEqual([
				{ type: 'LINKS_TO', target: 'x' },
				{ type: 'DERIVED_FROM', target: 'source' },
			]);
		});

		it('warns and rejects a non-array edges extension', async () => {
			frontmatter.smartmemory = { edges: { unexpected: true } };
			const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const result = await writeSmartMemoryFrontmatter(mockApp, mockFile, {
				id: 'item-1', relations: [{ type: 'LINKS_TO', target: 'x' }],
			}, { ...SETTINGS, writeSmartMemoryExtension: true });

			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.message).toContain('edges must be an array');
			expect(warning).toHaveBeenCalled();
			warning.mockRestore();
		});

		it('leaves optional extension absent when its control is off', async () => {
			await writeSmartMemoryFrontmatter(mockApp, mockFile, {
				id: 'item-1', entities: [{ name: 'Asimov' }],
			}, SETTINGS);
			expect(frontmatter.smartmemory).toBeUndefined();
		});

		it('never deletes external top-level keys', async () => {
			frontmatter.user_field = 'preserved';
			frontmatter.tags = ['existing'];
			await writeSmartMemoryFrontmatter(mockApp, mockFile, { id: 'item-1' }, SETTINGS);
			expect(frontmatter.user_field).toBe('preserved');
			expect(frontmatter.tags).toEqual(['existing']);
		});
	});

	describe('readSmartMemoryId', () => {
		it('parses the native OKF resource', () => {
			frontmatter.resource = 'smartmemory://team-a/item%2Fxyz';
			expect(readSmartMemoryId(mockApp, mockFile, 'team-a')).toBe('item/xyz');
		});

		it('warns and ignores a resource owned by another workspace', () => {
			frontmatter.resource = 'smartmemory://team-b/item-1';
			const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
			expect(readSmartMemoryId(mockApp, mockFile, 'team-a')).toBeNull();
			expect(warning).toHaveBeenCalledWith(
				'[smartmemory] Ignoring cross-workspace OKF resource (foreign workspace); note treated as unmapped',
				expect.anything(),
			);
			warning.mockRestore();
		});

		it('warns and falls back to legacy smartmemory_id', () => {
			frontmatter.smartmemory_id = 'item-legacy';
			const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
			expect(readSmartMemoryId(mockApp, mockFile, 'team-a')).toBe('item-legacy');
			expect(warning).toHaveBeenCalled();
			warning.mockRestore();
		});

		it('returns null when frontmatter is absent', () => {
			mockApp.metadataCache.getFileCache = vi.fn(() => null);
			expect(readSmartMemoryId(mockApp, mockFile, 'team-a')).toBeNull();
		});
	});

	describe('migration and clear', () => {
		it('migrates legacy keys without deleting unknown extension or producer keys', () => {
			Object.assign(frontmatter, {
				smartmemory_id: 'item-1',
				smartmemory_type: 'semantic',
				smartmemory_entities: ['Alice'],
				smartmemory_relations: [{ type: 'LINKS_TO', target: 'target' }],
				smartmemory: { custom: 7 },
				producer_key: 'keep',
			});
			const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
			migrateLegacyFrontmatter(frontmatter, 'team-a');
			expect(frontmatter.resource).toBe('smartmemory://team-a/item-1');
			expect(frontmatter.type).toBe('semantic');
			expect(frontmatter.smartmemory).toEqual({
				custom: 7,
				edges: [{ type: 'LINKS_TO', target: 'target' }],
				preserved: { legacy_entities: ['Alice'] },
			});
			expect(frontmatter.producer_key).toBe('keep');
			expect(frontmatter.smartmemory_id).toBeUndefined();
			warning.mockRestore();
		});

		it('retains a raw legacy id until workspace discovery makes migration lossless', () => {
			frontmatter.smartmemory_id = 'item-1';
			const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
			migrateLegacyFrontmatter(frontmatter, '');
			expect(frontmatter.smartmemory_id).toBe('item-1');
			expect(frontmatter.resource).toBeUndefined();

			migrateLegacyFrontmatter(frontmatter, 'team-a');
			expect(frontmatter.resource).toBe('smartmemory://team-a/item-1');
			expect(frontmatter.smartmemory_id).toBeUndefined();
			warning.mockRestore();
		});

		it.each([
			['a null resource', null],
			['an external resource', 'https://example.com/doc'],
		])('retains the recoverable legacy id when the note has %s', (_label, resource) => {
			Object.assign(frontmatter, { resource, smartmemory_id: 'item-1' });
			const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

			migrateLegacyFrontmatter(frontmatter, 'team-a');

			expect(frontmatter.smartmemory_id).toBe('item-1');
			expect(frontmatter.resource).toBe(resource);
			expect(warning).toHaveBeenCalledWith(
				'[smartmemory] Legacy smartmemory_id retained: no usable OKF resource to migrate to',
				expect.anything(),
			);
			warning.mockRestore();
		});

		it('drops the legacy id when a usable native resource already exists', () => {
			Object.assign(frontmatter, {
				resource: 'smartmemory://team-a/item-1', smartmemory_id: 'item-1',
			});
			const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
			migrateLegacyFrontmatter(frontmatter, 'team-a');
			expect(frontmatter.smartmemory_id).toBeUndefined();
			warning.mockRestore();
		});

		it('removes only resource, the extension, and legacy owned keys', async () => {
			Object.assign(frontmatter, {
				resource: 'smartmemory://team-a/item-1', type: 'semantic', tags: ['keep'],
				smartmemory: { edges: [] }, smartmemory_id: 'legacy', user_field: 'keep me',
			});
			await clearSmartMemoryFrontmatter(mockApp, mockFile, SETTINGS);
			expect(frontmatter).toEqual({ type: 'semantic', tags: ['keep'], user_field: 'keep me' });
		});
	});
});
