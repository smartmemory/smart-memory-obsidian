import type { VaultMappings } from '../types';

/**
 * Bidirectional store mapping vault file paths to SmartMemory item IDs.
 *
 * Maintains:
 * - fileToMemory / memoryToFile (bidirectional, kept in sync on every mutation)
 * - entityToFile (entity name → vault note that represents it, used for auto-linking)
 * - contentHashes (file path → hash, used to detect content changes for re-ingest path selection)
 */
export class MappingStore {
	private fileToMemory: Record<string, string>;
	private memoryToFile: Record<string, string>;
	private entityToFile: Record<string, string>;
	private contentHashes: Record<string, string>;
	private revisions: Record<string, number>;

	constructor(initial: VaultMappings) {
		this.fileToMemory = { ...initial.fileToMemory };
		this.memoryToFile = { ...initial.memoryToFile };
		this.entityToFile = { ...initial.entityToFile };
		this.contentHashes = { ...initial.contentHashes };
		this.revisions = { ...(initial.revisions ?? {}) };
	}

	set(filePath: string, itemId: string): void {
		// Clear stale reverse mapping if this file was previously mapped to a different itemId
		const oldItemId = this.fileToMemory[filePath];
		if (oldItemId && oldItemId !== itemId) {
			delete this.memoryToFile[oldItemId];
		}
		// Clear stale forward mapping if this itemId was previously mapped to a different file
		const oldFilePath = this.memoryToFile[itemId];
		if (oldFilePath && oldFilePath !== filePath) {
			delete this.fileToMemory[oldFilePath];
			delete this.contentHashes[oldFilePath];
		}
		this.fileToMemory[filePath] = itemId;
		this.memoryToFile[itemId] = filePath;
	}

	getMemoryId(filePath: string): string | null {
		return this.fileToMemory[filePath] ?? null;
	}

	getFilePath(itemId: string): string | null {
		return this.memoryToFile[itemId] ?? null;
	}

	handleRename(oldPath: string, newPath: string): void {
		const itemId = this.fileToMemory[oldPath];
		if (!itemId) return;

		// Clear any stale mapping for newPath before overwriting
		const displacedItemId = this.fileToMemory[newPath];
		if (displacedItemId && displacedItemId !== itemId) {
			delete this.memoryToFile[displacedItemId];
		}

		delete this.fileToMemory[oldPath];
		this.fileToMemory[newPath] = itemId;
		this.memoryToFile[itemId] = newPath;

		const hash = this.contentHashes[oldPath];
		if (hash !== undefined) {
			delete this.contentHashes[oldPath];
			this.contentHashes[newPath] = hash;
		}
		const rev = this.revisions[oldPath];
		if (rev !== undefined) {
			delete this.revisions[oldPath];
			this.revisions[newPath] = rev;
		}

		// Re-point any entity → file mappings that referenced the old path so
		// auto-link does not propose stale wikilinks.
		for (const [entity, path] of Object.entries(this.entityToFile)) {
			if (path === oldPath) {
				this.entityToFile[entity] = newPath;
			}
		}
	}

	handleDelete(filePath: string): void {
		const itemId = this.fileToMemory[filePath];
		if (itemId) {
			delete this.memoryToFile[itemId];
		}
		delete this.fileToMemory[filePath];
		delete this.contentHashes[filePath];
		delete this.revisions[filePath];

		// Drop entity → file mappings that pointed at the deleted note.
		for (const [entity, path] of Object.entries(this.entityToFile)) {
			if (path === filePath) {
				delete this.entityToFile[entity];
			}
		}
	}

	setContentHash(filePath: string, hash: string): void {
		this.contentHashes[filePath] = hash;
	}

	getContentHash(filePath: string): string | undefined {
		return this.contentHashes[filePath];
	}

	setRevision(filePath: string, revision: number | undefined): void {
		if (revision === undefined) delete this.revisions[filePath];
		else this.revisions[filePath] = revision;
	}

	getRevision(filePath: string): number | undefined {
		return this.revisions[filePath];
	}

	setEntityFile(entityName: string, filePath: string): void {
		this.entityToFile[entityName] = filePath;
	}

	getEntityFile(entityName: string): string | null {
		return this.entityToFile[entityName] ?? null;
	}

	/**
	 * Replace all entity → file mappings owned by `filePath` with `entityNames`.
	 * Drops any prior entity that pointed at this file but is no longer in the
	 * extracted set, so re-enrichment with shrunken/empty entities does not
	 * leave stale auto-link targets behind. Other files' mappings are
	 * untouched.
	 */
	replaceEntitiesForFile(filePath: string, entityNames: string[]): void {
		for (const [entity, path] of Object.entries(this.entityToFile)) {
			if (path === filePath) {
				delete this.entityToFile[entity];
			}
		}
		for (const name of entityNames) {
			if (name) this.entityToFile[name] = filePath;
		}
	}

	toJSON(): VaultMappings {
		return {
			fileToMemory: { ...this.fileToMemory },
			memoryToFile: { ...this.memoryToFile },
			entityToFile: { ...this.entityToFile },
			contentHashes: { ...this.contentHashes },
			revisions: { ...this.revisions },
			lastSyncTimestamp: new Date().toISOString(),
		};
	}
}
