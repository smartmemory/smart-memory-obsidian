import type { App, TFile } from 'obsidian';
import type { SmartMemorySettings } from '../types';
import { buildResource, parseResource } from './okf';
import { isPathExcluded } from '../util/exclusions';

export interface EnrichmentData {
	id: string;
	memoryType?: string;
	entities?: Array<{ name: string; type?: string }>;
	relations?: RelationInput[];
}

type RelationInput = {
	type?: string;
	target?: string;
	properties?: Record<string, unknown>;
	subject?: string;
	predicate?: string;
	object?: string;
} | string;

const LEGACY_KEYS = [
	'smartmemory_id',
	'smartmemory_type',
	'smartmemory_entities',
	'smartmemory_relations',
	'smartmemory_last_sync',
] as const;

/**
 * Write the OKF native envelope through Obsidian's YAML-preserving adapter.
 * Existing external keys and unknown SmartMemory extension keys are only
 * merged; they are never replaced wholesale.
 */
export async function writeSmartMemoryFrontmatter(
	app: App,
	file: TFile,
	data: EnrichmentData,
	settings: SmartMemorySettings,
): Promise<{ ok: true } | { ok: false; error: Error }> {
	if (isPathExcluded(file.path, settings, 'frontmatter-write')) return { ok: true };
	try {
		await app.fileManager.processFrontMatter(file, (fm) => {
			if (fm.smartmemory !== undefined && fm.smartmemory !== null && !isMapping(fm.smartmemory)) {
				console.warn('[smartmemory] Rejecting invalid OKF smartmemory extension: expected a mapping', fm.smartmemory);
				throw new Error('OKF smartmemory extension must be a mapping');
			}
			migrateLegacyFrontmatter(fm, settings.workspaceId);
			if (okfConformanceEnabled(settings)) {
				fm.resource = buildResource(settings.workspaceId, data.id);
				fm.type = data.memoryType || (typeof fm.type === 'string' && fm.type) || 'semantic';
			}
			if (smartMemoryExtensionEnabled(settings)) {
				const extension = ensureExtension(fm);
				if (data.entities) extension.entities = data.entities.map(formatEntity);
				if (data.relations) mergeEdges(extension, data.relations.map(formatEdge));
			}
		});
		return { ok: true };
	} catch (err) {
		console.warn('[smartmemory] OKF frontmatter write rejected', file.path, err);
		return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
	}
}

/** Resolve an item id from native OKF resource, with warned legacy fallback. */
export function readSmartMemoryId(app: App, file: TFile, workspaceId: string): string | null {
	const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
	if (!frontmatter) return null;
	if (typeof frontmatter.resource === 'string') {
		try {
			const [resourceWorkspace, itemId] = parseResource(frontmatter.resource);
			if (resourceWorkspace !== workspaceId) {
				console.warn(
					'[smartmemory] Ignoring cross-workspace OKF resource (foreign workspace); note treated as unmapped',
					{ resource: frontmatter.resource, resourceWorkspace, workspaceId, path: file.path },
				);
				return null;
			}
			return itemId;
		} catch (error) {
			console.warn('[smartmemory] Invalid OKF resource; checking legacy smartmemory_id fallback', error);
		}
	}
	if (typeof frontmatter.smartmemory_id === 'string' && frontmatter.smartmemory_id) {
		console.warn('[smartmemory] Read legacy smartmemory_id fallback during migration');
		try {
			const [resourceWorkspace, itemId] = parseResource(frontmatter.smartmemory_id);
			if (resourceWorkspace !== workspaceId) {
				console.warn(
					'[smartmemory] Ignoring cross-workspace OKF resource (foreign workspace); note treated as unmapped',
					{ resource: frontmatter.smartmemory_id, resourceWorkspace, workspaceId, path: file.path },
				);
				return null;
			}
			return itemId;
		} catch {
			return frontmatter.smartmemory_id;
		}
	}
	return null;
}

/**
 * Remove only the SmartMemory-owned identity/extension surfaces. Native OKF
 * type/tags/timestamp and every external producer key remain untouched.
 */
export async function clearSmartMemoryFrontmatter(
	app: App,
	file: TFile,
	settings: Pick<SmartMemorySettings, 'excludeFolders'>,
): Promise<{ ok: true } | { ok: false; error: Error }> {
	if (isPathExcluded(file.path, settings, 'purge-frontmatter-clear')) return { ok: true };
	try {
		await app.fileManager.processFrontMatter(file, (fm) => {
			delete fm.resource;
			delete fm.smartmemory;
			for (const key of LEGACY_KEYS) delete fm[key];
		});
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
	}
}

/** Migrate legacy proprietary keys in-place without replacing nested extensions. */
export function migrateLegacyFrontmatter(fm: Record<string, any>, workspace: string): boolean {
	const legacy = LEGACY_KEYS.filter(key => Object.prototype.hasOwnProperty.call(fm, key));
	if (legacy.length === 0) return false;
	console.warn(`[smartmemory] Migrating legacy OKF frontmatter keys: ${legacy.sort().join(', ')}`);

	const hadNoResource = fm.resource === undefined;
	let hasUsableResource = false;
	if (typeof fm.resource === 'string') {
		try {
			parseResource(fm.resource);
			hasUsableResource = true;
		} catch {
			// Warned below if a legacy id needs this unusable resource for recovery.
		}
	}

	if (!hasUsableResource && hadNoResource && typeof fm.smartmemory_id === 'string' && fm.smartmemory_id) {
		try {
			parseResource(fm.smartmemory_id);
			fm.resource = fm.smartmemory_id;
			hasUsableResource = true;
		} catch {
			if (workspace) {
				fm.resource = buildResource(workspace, fm.smartmemory_id);
				hasUsableResource = true;
			} else {
				console.warn('[smartmemory] Cannot migrate smartmemory_id to resource without a workspace id');
			}
		}
	}
	if (typeof fm.smartmemory_id === 'string' && fm.smartmemory_id && !hasUsableResource) {
		console.warn(
			'[smartmemory] Legacy smartmemory_id retained: no usable OKF resource to migrate to',
			{ resource: fm.resource, smartmemory_id: fm.smartmemory_id },
		);
	}
	if (fm.type === undefined && typeof fm.smartmemory_type === 'string') fm.type = fm.smartmemory_type;
	if (fm.smartmemory_relations !== undefined || fm.smartmemory_entities !== undefined) {
		const extension = ensureExtension(fm);
		if (fm.smartmemory_relations !== undefined && extension.edges === undefined) {
			extension.edges = fm.smartmemory_relations;
		}
		if (fm.smartmemory_entities !== undefined) {
			const preserved = extension.preserved === undefined ? {} : extension.preserved;
			if (!isMapping(preserved)) {
				console.warn('[smartmemory] Rejecting invalid OKF smartmemory.preserved: expected a mapping', preserved);
				throw new Error('OKF smartmemory.preserved must be a mapping');
			}
			if (preserved.legacy_entities === undefined) preserved.legacy_entities = fm.smartmemory_entities;
			extension.preserved = preserved;
		}
	}

	for (const key of LEGACY_KEYS) {
		if (key === 'smartmemory_id' && !hasUsableResource) continue;
		delete fm[key];
	}
	return true;
}

function okfConformanceEnabled(settings: SmartMemorySettings): boolean {
	return settings.okfConformance ?? settings.writeFrontmatterId ?? true;
}

function smartMemoryExtensionEnabled(settings: SmartMemorySettings): boolean {
	return settings.writeSmartMemoryExtension ?? settings.writeFrontmatterEnrichment ?? false;
}

function ensureExtension(fm: Record<string, any>): Record<string, any> {
	if (fm.smartmemory === undefined || fm.smartmemory === null) fm.smartmemory = {};
	if (!isMapping(fm.smartmemory)) {
		console.warn('[smartmemory] Rejecting invalid OKF smartmemory extension: expected a mapping', fm.smartmemory);
		throw new Error('OKF smartmemory extension must be a mapping');
	}
	return fm.smartmemory;
}

function mergeEdges(extension: Record<string, any>, additions: Array<Record<string, unknown>>): void {
	if (extension.edges !== undefined && !Array.isArray(extension.edges)) {
		console.warn('[smartmemory] Rejecting invalid OKF smartmemory.edges: expected an array', extension.edges);
		throw new Error('OKF smartmemory.edges must be an array');
	}
	const edges = extension.edges === undefined ? [] : [...extension.edges];
	const seen = new Set(edges.map((edge: any) => `${edge?.type}\u0000${edge?.target}`));
	for (const edge of additions) {
		const key = `${edge.type}\u0000${edge.target}`;
		if (seen.has(key)) continue;
		edges.push(edge);
		seen.add(key);
	}
	extension.edges = edges;
}

function isMapping(value: unknown): value is Record<string, any> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatEntity(entity: { name: string; type?: string }): string {
	return entity.type ? `${entity.name} (${entity.type})` : entity.name;
}

function formatEdge(rel: RelationInput): Record<string, unknown> {
	if (typeof rel === 'string') return { type: 'RELATES_TO', target: rel };
	const type = rel.type || rel.predicate?.toUpperCase().replace(/[^A-Z0-9]+/g, '_') || 'RELATES_TO';
	const target = rel.target || rel.object || '';
	const edge: Record<string, unknown> = { type, target };
	const properties = { ...(rel.properties || {}) };
	if (rel.subject) properties.subject = rel.subject;
	if (Object.keys(properties).length > 0) edge.properties = properties;
	return edge;
}
