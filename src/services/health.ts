/**
 * DIST-OBSIDIAN-LITE-1: lite-mode detection.
 *
 * Probes the daemon (or hosted service) /health endpoint to determine which
 * UI affordances apply: lite mode hides API-key fields and repurposes the
 * upgrade modal as a Sync-to-cloud affordance, etc.
 *
 * Uses Obsidian's requestUrl directly (not the SDK) — /health is unauthenticated
 * and the SDK's BaseAPI hard-wires bearer auth into every call.
 */
import { requestUrl } from 'obsidian';

export interface HealthCapabilities {
	delete: boolean;
	patch: boolean;
	neighbors_direction: boolean;
	quota: boolean;
	auth: boolean;
}

export type HealthMode = 'lite' | 'cloud' | 'remote';

export interface HealthResponse {
	mode: HealthMode;
	capabilities?: HealthCapabilities;
	[k: string]: unknown;
}

export interface HealthProbeResult {
	isLite: boolean;
	mode: HealthMode | null;
	capabilities: HealthCapabilities | null;
	/** Lite only: the install's OKF namespace (`okf_namespace`), the workspace of its `smartmemory://` resources. */
	okfNamespace: string | null;
	probed: boolean; // false if probe failed
}

/**
 * Resolve the /health endpoint URL from a baseUrl.
 *
 * The daemon mounts /memory as a sub-app, so the plugin's `apiUrl` typically
 * points at the daemon origin. The /health route lives on the root app at
 * viewer_server.py:68 (DIST-OBSIDIAN-LITE-1).
 */
export function healthUrlFor(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, '');
	// If user pasted a /memory-suffixed URL, strip it
	const root = trimmed.endsWith('/memory') ? trimmed.slice(0, -'/memory'.length) : trimmed;
	return `${root}/health`;
}

/**
 * Probe /health and decide whether we're in lite mode.
 *
 * Failure (network, timeout, non-2xx, missing fields) defaults to cloud
 * assumption — the plugin should fall back to its existing cloud behaviors
 * rather than guess. `probed: false` tells the caller the probe didn't land.
 */
export async function probeHealth(baseUrl: string): Promise<HealthProbeResult> {
	const url = healthUrlFor(baseUrl);
	try {
		const resp = await requestUrl({ url, method: 'GET' });
		if (resp.status !== 200) {
			return { isLite: false, mode: null, capabilities: null, okfNamespace: null, probed: false };
		}
		const body = (resp.json || {}) as Partial<HealthResponse>;
		// Validate mode against the known union — daemon evolutions could
		// add new values; we don't want to propagate an unknown string as
		// a typed HealthMode.
		const rawMode = body.mode;
		const mode: HealthMode | null =
			rawMode === 'lite' || rawMode === 'cloud' || rawMode === 'remote'
				? rawMode
				: null;
		const caps = (body.capabilities as HealthCapabilities | undefined) ?? null;
		const okfNamespace = typeof body.okf_namespace === 'string' && body.okf_namespace ? body.okf_namespace : null;
		return {
			isLite: mode === 'lite',
			mode,
			capabilities: caps,
			okfNamespace,
			probed: true,
		};
	} catch {
		// Network failure, requestUrl threw on non-2xx, etc.
		return { isLite: false, mode: null, capabilities: null, okfNamespace: null, probed: false };
	}
}
