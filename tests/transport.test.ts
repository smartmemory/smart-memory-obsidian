import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createObsidianFetch } from '../src/transport';

// Mock the obsidian module since vitest runs outside Obsidian
vi.mock('obsidian', () => ({
	requestUrl: vi.fn(),
}));

import { requestUrl } from 'obsidian';

// SM2-SAVE-1 save receipt (docs/features/SM2-SAVE-1/save-receipt-contract.json): what POST /memory/ingest answers.
const INGEST_RECEIPT = {
	schema_version: '1.1',
	subject: { kind: 'item_save', item_id: 'mem_123' },
	run_id: 'run_1',
	status_url: '/memory/status/run_1',
	processing_stage: 'received',
	execution_state: 'queued',
	outcome: null,
	terminal: false,
	result_availability: 'pending',
	status_version: 1,
};

describe('createObsidianFetch', () => {
	beforeEach(() => {
		vi.mocked(requestUrl).mockReset();
	});

	describe('success path', () => {
		it('returns ok Response for 2xx status', async () => {
			vi.mocked(requestUrl).mockResolvedValue({
				status: 200,
				headers: { 'content-type': 'application/json' },
				text: '{"data":"ok"}',
				json: { data: 'ok' },
				arrayBuffer: new ArrayBuffer(0),
			} as any);

			const fetchFn = createObsidianFetch();
			const res = await fetchFn('https://api.test/memory/list', {
				method: 'GET',
				headers: { Authorization: 'Bearer x' },
			});

			expect(res.ok).toBe(true);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ data: 'ok' });
		});

		it('forwards method, headers, and body to requestUrl', async () => {
			vi.mocked(requestUrl).mockResolvedValue({
				status: 202,
				headers: { 'content-type': 'application/json' },
				text: JSON.stringify(INGEST_RECEIPT),
				json: INGEST_RECEIPT,
				arrayBuffer: new ArrayBuffer(0),
			} as any);

			const fetchFn = createObsidianFetch();
			const res = await fetchFn('https://api.test/memory/ingest', {
				method: 'POST',
				headers: { 'X-Workspace-Id': 'ws1' },
				body: JSON.stringify({ content: 'hi' }),
			});
			expect(res.ok).toBe(true);
			expect(res.status).toBe(202);
			expect(await res.json()).toEqual(INGEST_RECEIPT);

			expect(requestUrl).toHaveBeenCalledWith({
				url: 'https://api.test/memory/ingest',
				method: 'POST',
				headers: { 'X-Workspace-Id': 'ws1' },
				body: '{"content":"hi"}',
			});
		});
	});

	describe('error path (4xx/5xx)', () => {
		it('returns synthetic non-ok Response for 404', async () => {
			// requestUrl throws on non-2xx — error has .status and .response
			const error: any = new Error('Not found');
			error.status = 404;
			error.headers = { 'content-type': 'application/json' };
			error.text = '{"detail":"Item not found"}';
			error.json = { detail: 'Item not found' };
			vi.mocked(requestUrl).mockRejectedValue(error);

			const fetchFn = createObsidianFetch();
			const res = await fetchFn('https://api.test/memory/missing', {
				method: 'GET',
			});

			expect(res.ok).toBe(false);
			expect(res.status).toBe(404);
			expect(await res.json()).toEqual({ detail: 'Item not found' });
		});

		it('returns synthetic non-ok Response for 429 rate limit', async () => {
			const error: any = new Error('Too many requests');
			error.status = 429;
			error.headers = {};
			error.text = '';
			vi.mocked(requestUrl).mockRejectedValue(error);

			const fetchFn = createObsidianFetch();
			const res = await fetchFn('https://api.test/memory/search');

			expect(res.ok).toBe(false);
			expect(res.status).toBe(429);
		});
	});

	describe('network failures', () => {
		it('throws TypeError when requestUrl rejects without status', async () => {
			vi.mocked(requestUrl).mockRejectedValue(new Error('ECONNREFUSED'));

			const fetchFn = createObsidianFetch();
			await expect(
				fetchFn('https://api.test/memory/list')
			).rejects.toThrow(TypeError);
		});
	});

	describe('headers handling', () => {
		it('exposes headers via .get() like fetch Response', async () => {
			vi.mocked(requestUrl).mockResolvedValue({
				status: 200,
				headers: { 'content-type': 'application/json', 'x-custom': 'v1' },
				text: '{}',
				json: {},
				arrayBuffer: new ArrayBuffer(0),
			} as any);

			const fetchFn = createObsidianFetch();
			const res = await fetchFn('https://api.test/memory/list');

			expect(res.headers.get('content-type')).toBe('application/json');
			expect(res.headers.get('x-custom')).toBe('v1');
		});
	});

	describe('abort signal', () => {
		it('refuses to start when signal is already aborted', async () => {
			const controller = new AbortController();
			controller.abort();

			const fetchFn = createObsidianFetch();
			await expect(
				fetchFn('https://api.test/memory/list', { signal: controller.signal })
			).rejects.toThrow();
			expect(requestUrl).not.toHaveBeenCalled();
		});

		it('discards response when aborted during in-flight request', async () => {
			const controller = new AbortController();
			vi.mocked(requestUrl).mockImplementation(async () => {
				controller.abort();
				return {
					status: 200,
					headers: {},
					text: '{}',
					json: {},
					arrayBuffer: new ArrayBuffer(0),
				} as any;
			});

			const fetchFn = createObsidianFetch();
			await expect(
				fetchFn('https://api.test/memory/list', { signal: controller.signal })
			).rejects.toThrow();
		});
	});

	describe('text() method', () => {
		it('returns response body as text', async () => {
			vi.mocked(requestUrl).mockResolvedValue({
				status: 200,
				headers: { 'content-type': 'text/plain' },
				text: 'plain response',
				json: undefined as any,
				arrayBuffer: new ArrayBuffer(0),
			} as any);

			const fetchFn = createObsidianFetch();
			const res = await fetchFn('https://api.test/memory/foo');

			expect(await res.text()).toBe('plain response');
		});
	});
});
