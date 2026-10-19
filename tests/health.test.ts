/**
 * Tests for DIST-OBSIDIAN-LITE-1 health probe + lite-mode detection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('obsidian', async () => {
	const actual = await vi.importActual<any>('obsidian');
	return {
		...actual,
		requestUrl: vi.fn(),
	};
});

import { requestUrl } from 'obsidian';
import { probeHealth, healthUrlFor } from '../src/services/health';

describe('healthUrlFor', () => {
	it('appends /health to a bare origin', () => {
		expect(healthUrlFor('http://127.0.0.1:9014')).toBe('http://127.0.0.1:9014/health');
	});
	it('strips trailing slashes', () => {
		expect(healthUrlFor('http://127.0.0.1:9014/')).toBe('http://127.0.0.1:9014/health');
	});
	it('strips a trailing /memory suffix when users paste it', () => {
		expect(healthUrlFor('http://127.0.0.1:9014/memory')).toBe('http://127.0.0.1:9014/health');
	});
	it('handles https origins', () => {
		expect(healthUrlFor('https://api.smartmemory.ai')).toBe('https://api.smartmemory.ai/health');
	});
});

describe('probeHealth', () => {
	beforeEach(() => {
		vi.mocked(requestUrl).mockReset();
	});

	it('returns isLite=true when /health says mode=lite', async () => {
		vi.mocked(requestUrl).mockResolvedValueOnce({
			status: 200,
			headers: {},
			text: '',
			arrayBuffer: new ArrayBuffer(0),
			json: { mode: 'lite', capabilities: { delete: true, patch: true, neighbors_direction: true, quota: false, auth: false } },
		} as any);
		const result = await probeHealth('http://127.0.0.1:9014');
		expect(result.probed).toBe(true);
		expect(result.isLite).toBe(true);
		expect(result.mode).toBe('lite');
		expect(result.capabilities?.delete).toBe(true);
	});

	it('returns isLite=false when /health says mode=cloud', async () => {
		vi.mocked(requestUrl).mockResolvedValueOnce({
			status: 200,
			headers: {},
			text: '',
			arrayBuffer: new ArrayBuffer(0),
			json: { mode: 'cloud' },
		} as any);
		const result = await probeHealth('https://api.smartmemory.ai');
		expect(result.probed).toBe(true);
		expect(result.isLite).toBe(false);
		expect(result.mode).toBe('cloud');
	});

	it('returns isLite=false when mode field is absent (defensive default)', async () => {
		vi.mocked(requestUrl).mockResolvedValueOnce({
			status: 200,
			headers: {},
			text: '',
			arrayBuffer: new ArrayBuffer(0),
			json: { service: 'smartmemory', status: 'ok' },
		} as any);
		const result = await probeHealth('https://api.smartmemory.ai');
		expect(result.probed).toBe(true);
		expect(result.isLite).toBe(false);
		expect(result.mode).toBe(null);
	});

	it('returns probed=false on network failure', async () => {
		vi.mocked(requestUrl).mockRejectedValueOnce(new Error('connection refused'));
		const result = await probeHealth('http://127.0.0.1:9014');
		expect(result.probed).toBe(false);
		expect(result.isLite).toBe(false);
	});

	it('returns probed=false on non-200 status', async () => {
		vi.mocked(requestUrl).mockResolvedValueOnce({
			status: 503,
			headers: {},
			text: '',
			arrayBuffer: new ArrayBuffer(0),
			json: null,
		} as any);
		const result = await probeHealth('http://127.0.0.1:9014');
		expect(result.probed).toBe(false);
		expect(result.isLite).toBe(false);
	});
});
