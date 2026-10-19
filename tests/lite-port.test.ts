import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createObsidianFetch } from '../src/transport';
import { LITE_DAEMON_URL, LITE_API_URL_DESC, EMPTY_MAPPINGS } from '../src/types';
import SmartMemoryPlugin from '../src/main';

vi.mock('obsidian', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	requestUrl: vi.fn(),
}));

import { requestUrl } from 'obsidian';

const MONGO_TEXT = 'It looks like you are trying to access MongoDB over HTTP on the native driver port.';
const CLEAR = 'Not a SmartMemory server at http://127.0.0.1:9014. Check the API URL in settings.';

/** Mimics Obsidian's requestUrl result, where `json` is a lazy getter that throws on non-JSON text. */
function obsidianResult(status: number, text: string) {
	return {
		status,
		headers: {},
		text,
		get json() {
			return JSON.parse(text);
		},
		arrayBuffer: new ArrayBuffer(0),
	} as any;
}

// One row per class member. Row 1 is red on 0.2.18 (raw "Unexpected token 'I'" error).
const rows: Array<{ name: string; status: number; text: string; expect: 'ok' | 'clear'; value?: unknown }> = [
	{ name: 'Mongo plain-text reply on 200', status: 200, text: MONGO_TEXT, expect: 'clear' },
	{ name: 'HTML page on 200', status: 200, text: '<html><body>hi</body></html>', expect: 'clear' },
	{ name: 'empty body on 200', status: 200, text: '', expect: 'clear' },
	{ name: 'non-JSON body on a 502', status: 502, text: 'Bad Gateway', expect: 'clear' },
	{ name: 'JSON object on 200', status: 200, text: '{"nodes":[],"edges":[]}', expect: 'ok', value: { nodes: [], edges: [] } },
	{ name: 'JSON error body on 401', status: 401, text: '{"detail":"no key"}', expect: 'ok', value: { detail: 'no key' } },
];

describe('PLUGIN-LITE-PORT-9014-1 / PLUGIN-LITE-DEFAULT-9014-1', () => {
	beforeEach(() => {
		vi.mocked(requestUrl).mockReset();
	});

	it.each(rows)('transport json(): $name', async (row) => {
		const mock = vi.mocked(requestUrl);
		if (row.status >= 200 && row.status < 300) {
			mock.mockResolvedValue(obsidianResult(row.status, row.text));
		} else {
			mock.mockRejectedValue(obsidianResult(row.status, row.text));
		}
		const res = await createObsidianFetch()('http://127.0.0.1:9014/memory/graph/full?limit=5');
		if (row.expect === 'clear') {
			await expect(res.json()).rejects.toThrow(CLEAR);
			expect(await res.text()).toBe(row.text);
		} else {
			expect(await res.json()).toEqual(row.value);
		}
	});

	it('message names the origin only, not the path or query', async () => {
		vi.mocked(requestUrl).mockResolvedValue(obsidianResult(200, MONGO_TEXT));
		const res = await createObsidianFetch()('https://example.test:8443/memory/list?x=1');
		await expect(res.json()).rejects.toThrow('Not a SmartMemory server at https://example.test:8443. Check the API URL in settings.');
	});

	it('user-facing message has no em dash or semicolon', () => {
		expect(CLEAR).not.toMatch(/[—;]/);
	});

	it('lite default URL is the daemon stock port 9014', () => {
		expect(LITE_DAEMON_URL).toBe('http://127.0.0.1:9014');
		expect(LITE_DAEMON_URL).not.toContain(':9114');
	});

	it('settings description names the stock port and where the daemon shows its own', () => {
		expect(LITE_API_URL_DESC).toContain('http://127.0.0.1:9014');
		expect(LITE_API_URL_DESC).toContain('sm config');
		expect(LITE_API_URL_DESC).toContain('daemon_port');
		expect(LITE_API_URL_DESC).not.toMatch(/[—;]/);
	});

	// A saved apiUrl is the user's setting: loading must never replace it with the default.
	it.each([
		{ name: 'saved 9114 (demo vault)', saved: { mode: 'lite', apiUrl: 'http://127.0.0.1:9114' }, want: 'http://127.0.0.1:9114' },
		{ name: 'saved cloud URL', saved: { mode: 'cloud', apiUrl: 'https://api.smartmemory.ai' }, want: 'https://api.smartmemory.ai' },
		{ name: 'no saved apiUrl', saved: { mode: 'lite' }, want: undefined },
	])('loadSettings keeps a saved apiUrl: $name', async ({ saved, want }) => {
		const plugin = Object.create(SmartMemoryPlugin.prototype) as any;
		plugin.writeTail = Promise.resolve();
		plugin.saveData = vi.fn().mockResolvedValue(undefined);
		plugin.loadData = vi.fn().mockResolvedValue({ settings: { ...saved, hasCompletedOnboarding: true }, mappings: EMPTY_MAPPINGS });
		await plugin.loadSettings();
		if (want) expect(plugin.settings.apiUrl).toBe(want);
	});
});
