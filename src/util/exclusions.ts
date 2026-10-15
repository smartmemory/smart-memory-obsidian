import { Notice } from 'obsidian';
import type { SmartMemorySettings } from '../types';

/** Vault-relative, case-insensitive path prefixes. Stored empty prefixes exclude all notes.
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
	notify = false,
): boolean {
	const candidate = normalize(path);
	const excluded = (settings.excludeFolders || []).some(folder => {
		const prefix = normalize(folder);
		// Preserve legacy sibling-prefix matches unless the entry ends in a separator.
		const legacyPrefix = !/[\\/]$/.test(folder.trim()) && candidate.startsWith(prefix);
		return (!!prefix && (candidate === prefix || candidate.startsWith(prefix + '/'))) || legacyPrefix;
	});
	if (excluded) {
		console.warn(`[smartmemory] excluded folder: skipped ${pathClass}`, path);
		if (notify) new Notice('SmartMemory: note is in an excluded folder');
	}
	return excluded;
}
