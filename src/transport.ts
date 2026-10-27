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

function isJsonBody(body: string): boolean {
	try {
		JSON.parse(body);
		return true;
	} catch {
		return false;
	}
}

const PLAIN_BODY_MAX = 200;

/** A declared text/plain, non-empty, non-HTML error body: what a real SmartMemory server sends (FastAPI "Internal Server Error"). */
function isPlainTextError(headers: Headers, body: string): boolean {
	const type = (headers.get('content-type') || '').toLowerCase();
	const text = body.trim();
	return type.startsWith('text/plain') && text !== '' && !text.startsWith('<');
}

function plainTextMessage(status: number, body: string): string {
	const text = body.trim();
	const short = text.length > PLAIN_BODY_MAX ? `${text.slice(0, PLAIN_BODY_MAX)}...` : text;
	return `HTTP ${status}: ${short}`;
}

function toFetchResponse(result: RequestUrlResponse, url: string): Response {
	const body = typeof result.text === 'string' ? result.text : '';
	const ok = result.status >= 200 && result.status < 300;
	const headers = new Headers(result.headers as Record<string, string>);
	// SDK BaseAPI._handleError reads text() for any non-JSON content type and
	// falls back to a bare "HTTP <status>" when a declared-JSON body fails to
	// parse. For a non-ok reply whose body is not JSON, present the clear
	// message as a plain-text body so both header cases reach the user intact.
	// A declared text/plain body is a genuine server reply (FastAPI answers a
	// crash with 500 text/plain "Internal Server Error"), so it keeps its own
	// text; only a foreign body (HTML, undeclared, declared-JSON that does not
	// parse, empty) gets the wrong-URL message.
	const nonJsonFailure = !ok && !isJsonBody(body);
	const plainFailure = nonJsonFailure && isPlainTextError(headers, body);
	const notJsonFailure = nonJsonFailure && !plainFailure;
	if (notJsonFailure) headers.set('content-type', 'text/plain');
	return {
		ok,
		status: result.status,
		statusText: '',
		headers,
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
		text: async () => {
			if (notJsonFailure) return notSmartMemoryMessage(url);
			if (plainFailure) return plainTextMessage(result.status, body);
			return body;
		},
	} as Response;
}
