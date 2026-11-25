/**
 * BUG-OBSIDIAN-LITE-SAVE-RECEIPT-1 F2: in Lite mode (no workspace id) a note's OKF resource uses the
 * Lite install's namespace from /health, and a Lite without one is a visible error, not a silent skip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('obsidian', async () => {
	const actual = await vi.importActual<any>('obsidian');
	return { ...actual, requestUrl: vi.fn() };
});

import { requestUrl } from 'obsidian';
import { writeSmartMemoryFrontmatter, readSmartMemoryId } from '../src/bridge/frontmatter';
import { resetLiteNamespace, resourceWorkspace, setLiteNamespace } from '../src/bridge/resource-workspace';
import { probeHealth } from '../src/services/health';
import { DEFAULT_SETTINGS } from '../src/types';

const LITE = { ...DEFAULT_SETTINGS, mode: 'lite' as const, apiUrl: 'http://127.0.0.1:9014', workspaceId: '' };

describe('Lite OKF resource workspace', () => {
	let app: any;
	let fm: Record<string, any>;

	beforeEach(() => {
		resetLiteNamespace();
		vi.mocked(requestUrl).mockReset();
		fm = {};
		app = {
			fileManager: { processFrontMatter: vi.fn(async (_f: any, fn: (o: any) => void) => fn(fm)) },
			metadataCache: { getFileCache: vi.fn(() => ({ frontmatter: fm })) },
		};
	});

	it('probeHealth reads okf_namespace', async () => {
		vi.mocked(requestUrl).mockResolvedValueOnce({ status: 200, json: { mode: 'lite', okf_namespace: 'local-abc' } } as any);
		const r = await probeHealth(LITE.apiUrl);
		expect(r.okfNamespace).toBe('local-abc');
	});

	it('writes the id under the Lite namespace, asking /health once, and reads it back', async () => {
		vi.mocked(requestUrl).mockResolvedValue({ status: 200, json: { mode: 'lite', okf_namespace: 'local-abc' } } as any);
		const first = await writeSmartMemoryFrontmatter(app, { path: 'a.md' } as any, { id: 'item-1' }, LITE);
		const second = await writeSmartMemoryFrontmatter(app, { path: 'a.md' } as any, {
			id: 'item-1', entities: [{ name: 'Porto', type: 'place' }],
		}, { ...LITE, writeSmartMemoryExtension: true }); // entity writeback is opt-in (types.ts DEFAULT_SETTINGS)
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(fm.resource).toBe('smartmemory://local-abc/item-1');
		expect(fm.smartmemory.entities).toHaveLength(1);
		expect(vi.mocked(requestUrl)).toHaveBeenCalledTimes(1);
		expect(readSmartMemoryId(app, { path: 'a.md' } as any, resourceWorkspace(LITE))).toBe('item-1');
	});

	it('a Lite that reports no namespace is an error naming the cause', async () => {
		vi.mocked(requestUrl).mockResolvedValue({ status: 200, json: { mode: 'lite' } } as any);
		const r = await writeSmartMemoryFrontmatter(app, { path: 'a.md' } as any, { id: 'item-1' }, LITE);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.message).toContain('okf_namespace');
		expect(fm.resource).toBeUndefined();
	});

	it('a configured workspace wins, and cloud never uses the Lite namespace', () => {
		setLiteNamespace('local-abc');
		expect(resourceWorkspace({ ...LITE, workspaceId: 'team-a' })).toBe('team-a');
		expect(resourceWorkspace({ ...LITE, mode: 'cloud' })).toBe('');
		expect(resourceWorkspace(LITE)).toBe('local-abc');
	});
});
