import type { SmartMemorySettings } from '../types';

/** Vault-relative, case-insensitive folder boundaries. Ignore empty entries.
 * Use the same canonical form for both the configured folder and the note. */
function normalize(path: string): string {
	const parts: string[] = [];
	for (const part of path.trim().normalize('NFC').replace(/\\/g, '/').toLowerCase().split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') parts.pop();
		else parts.push(part);
	}
	return parts.join('/');
}

/** Every excluded hit is observable and names the operation being skipped. */
export function isPathExcluded(
	path: string,
	settings: Pick<SmartMemorySettings, 'excludeFolders'>,
	pathClass: string,
): boolean {
	const candidate = normalize(path);
	const excluded = (settings.excludeFolders || []).some(folder => {
		const prefix = normalize(folder);
		return !!prefix && (candidate === prefix || candidate.startsWith(prefix + '/'));
	});
	if (excluded) console.warn(`[smartmemory] excluded folder: skipped ${pathClass}`, path);
	return excluded;
}
