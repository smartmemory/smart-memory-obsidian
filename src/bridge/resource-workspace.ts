/**
 * The workspace part of a note's OKF `resource` (`smartmemory://<workspace>/<item_id>`).
 *
 * Cloud: the configured or discovered workspace id (`settings.workspaceId`).
 * Lite (BUG-OBSIDIAN-LITE-SAVE-RECEIPT-1): when no workspace is set, the Lite install's OKF
 * namespace that its `/health` reports as `okf_namespace` (core `smartmemory.okf.lite_namespace`,
 * the same namespace Lite's own exporter, importer and vault writer use). It is kept in memory only
 * and never saved into `settings.workspaceId`, so switching the plugin to cloud cannot send it as a
 * team id.
 */
import type { SmartMemorySettings } from '../types';
import { probeHealth } from '../services/health';

type WorkspaceSettings = Pick<SmartMemorySettings, 'workspaceId' | 'mode'>;

let liteNamespace = '';
let pending: Promise<string> | null = null;

/** Record the namespace a Lite `/health` reported. Anything but a `local-` namespace is ignored. */
export function setLiteNamespace(namespace: unknown): void {
	if (typeof namespace === 'string' && namespace.startsWith('local-')) liteNamespace = namespace;
}

/** Forget the cached Lite namespace (the endpoint changed). */
export function resetLiteNamespace(): void {
	liteNamespace = '';
	pending = null;
}

/** The resource workspace known now: `settings.workspaceId`, else the cached Lite namespace in Lite mode, else ''. */
export function resourceWorkspace(settings: WorkspaceSettings): string {
	if (settings.workspaceId) return settings.workspaceId;
	return settings.mode === 'lite' ? liteNamespace : '';
}

/** Like `resourceWorkspace`, but in Lite mode with nothing cached it asks `/health` once first. */
export async function ensureResourceWorkspace(
	settings: Pick<SmartMemorySettings, 'workspaceId' | 'mode' | 'apiUrl'>,
): Promise<string> {
	const known = resourceWorkspace(settings);
	if (known || settings.mode !== 'lite') return known;
	pending ??= probeHealth(settings.apiUrl)
		.then((result) => {
			setLiteNamespace(result.okfNamespace);
			if (!liteNamespace) {
				console.warn('[smartmemory] Lite /health reported no okf_namespace; OKF resources cannot be written for Lite notes', settings.apiUrl);
			}
			return liteNamespace;
		})
		.finally(() => {
			pending = null;
		});
	return pending;
}
