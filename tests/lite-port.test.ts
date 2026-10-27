import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createObsidianFetch } from '../src/transport';
import { LITE_DAEMON_URL, LITE_API_URL_DESC, EMPTY_MAPPINGS } from '../src/types';
import SmartMemoryPlugin from '../src/main';
import { SmartMemoryClient } from 'smartmemory-sdk-js/core';

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
			// A non-ok non-JSON body is replaced by the clear message in text() (the SDK error path reads it).
			expect(await res.text()).toBe(row.status >= 400 ? CLEAR : row.text);
		} else {
			expect(await res.json()).toEqual(row.value);
		}
	});

	// The real SDK consumer: BaseAPI._handleError reads text() or json() depending on the declared content type.
	it.each([
		{ name: 'HTML 502 declared text/html', type: 'text/html', status: 502, text: '<html>Bad Gateway</html>', want: CLEAR },
		{ name: 'HTML 502 falsely declared JSON', type: 'application/json', status: 502, text: '<html>Bad Gateway</html>', want: CLEAR },
		{ name: 'empty 500 declared JSON', type: 'application/json', status: 500, text: '', want: CLEAR },
		{ name: 'plain-text 500 from a SmartMemory server keeps its text', type: 'text/plain; charset=utf-8', status: 500, text: 'Internal Server Error', want: 'HTTP 500: Internal Server Error' },
		{ name: 'JSON 404 detail kept', type: 'application/json', status: 404, text: '{"detail":"not found"}', want: 'not found' },
		{ name: 'JSON 401 auth kept', type: 'application/json', status: 401, text: '{"detail":"no key"}', want: 'Authentication required' },
	])('SDK client error message: $name', async ({ type, status, text, want }) => {
		const result = obsidianResult(status, text);
		result.headers = { 'content-type': type };
		vi.mocked(requestUrl).mockRejectedValue(result);
		const client = new SmartMemoryClient({ apiBaseUrl: 'http://127.0.0.1:9014', fetchFn: createObsidianFetch() });
		await expect(client.memories.list({ limit: 1 })).rejects.toThrow(want);
	});

	it('SDK client still returns a successful JSON reply', async () => {
		const result = obsidianResult(200, '{"items":[],"total":0}');
		result.headers = { 'content-type': 'application/json' };
		vi.mocked(requestUrl).mockResolvedValue(result);
		const client = new SmartMemoryClient({ apiBaseUrl: 'http://127.0.0.1:9014', fetchFn: createObsidianFetch() });
		await expect(client.memories.list({ limit: 1 })).resolves.toBeDefined();
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
