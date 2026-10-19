import { requestUrl, RequestUrlResponse } from 'obsidian';

/**
 * Creates a fetch-compatible function backed by Obsidian's requestUrl.
 *
 * Key behaviors:
 * - requestUrl bypasses CORS and works in Obsidian's Electron environment
 * - requestUrl THROWS on non-2xx responses; we catch and return a synthetic
 *   non-ok Response so consumers (like SDK BaseAPI._handleError) can parse
 *   status codes and error bodies through the normal fetch contract
 * - Network-level failures (no status) throw TypeError to match fetch semantics
 */
export function createObsidianFetch(): typeof fetch {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === 'string' ? input : input.toString();

		// AbortSignal pre-flight check. Obsidian's requestUrl does not support
		// cancellation, so we can't interrupt an in-flight request, but we can
		// honor a signal that's already aborted by refusing to start.
		const signal = init?.signal;
		if (signal?.aborted) {
			throw abortError(signal);
		}

		try {
			const result = await requestUrl({
				url,
				method: init?.method || 'GET',
				headers: init?.headers as Record<string, string>,
				body: typeof init?.body === 'string' ? init.body : undefined,
			});
			// If signal aborted while in-flight, surface the abort to the caller
			// rather than returning the (now-undesired) response.
			if (signal?.aborted) {
				throw abortError(signal);
			}
			return toFetchResponse(result, url);
		} catch (err: any) {
			if (err?.name === 'AbortError') throw err;
			// requestUrl throws on non-2xx — convert to synthetic Response so
			// BaseAPI._handleError can parse status + body normally
			if (err && typeof err.status === 'number') {
				return toFetchResponse(err as RequestUrlResponse, url);
			}
			// Network-level failure (offline, DNS, ECONNREFUSED)
			throw new TypeError(`Network request failed: ${err?.message || err}`);
		}
	};
}

function abortError(signal: AbortSignal): Error {
	const reason = signal.reason instanceof Error
		? signal.reason
		: new DOMException('The operation was aborted.', 'AbortError');
	return reason;
}

/** One clear message when a reply is not JSON (wrong port, wrong URL, a non-SmartMemory server). */
export function notSmartMemoryMessage(url: string): string {
	let origin = url;
	try {
		origin = new URL(url).origin;
	} catch {
		// keep the raw string
	}
	return `Not a SmartMemory server at ${origin}. Check the API URL in settings.`;
}

function toFetchResponse(result: RequestUrlResponse, url: string): Response {
	const body = typeof result.text === 'string' ? result.text : '';
	return {
		ok: result.status >= 200 && result.status < 300,
		status: result.status,
		statusText: '',
		headers: new Headers(result.headers as Record<string, string>),
		json: async () => {
			// Obsidian's `result.json` is a lazy getter that itself throws on a
			// non-JSON body, so the read sits inside the same guard as the parse.
			try {
				if (result.json !== undefined && result.json !== null) {
					return result.json;
				}
				return JSON.parse(body);
			} catch (err) {
				if (err instanceof SyntaxError) {
					throw new Error(notSmartMemoryMessage(url));
				}
				throw err;
			}
		},
		text: async () => body,
	} as Response;
}
