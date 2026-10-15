import { Notice } from 'obsidian';
import type SmartMemoryPlugin from '../main';
import { findEntityMentions, EntityCandidate } from '../bridge/wikilinks';
import { AutolinkModal } from '../views/autolink-modal';
import { readSmartMemoryId } from '../bridge/frontmatter';
import { toMarkdownLinkTarget } from '../util/wikilink-path';
import { entityNeighbors } from '../bridge/entity-edges';
import { isPathExcluded } from '../util/exclusions';

export function registerAutolinkCommand(plugin: SmartMemoryPlugin): void {
	plugin.addCommand({
		id: 'smartmemory-autolink-current-note',
		name: 'Auto-link entities in current note',
		callback: async () => {
			const file = plugin.app.workspace.getActiveFile();
			if (!file) {
				new Notice('SmartMemory: no active note');
				return;
			}
			if (isPathExcluded(file.path, plugin.settings, 'autolink-command')) return;
			const client = plugin.client;
			if (!client) {
				new Notice('SmartMemory: not connected');
				return;
			}

			const itemId =
				plugin.mappingStore.getMemoryId(file.path) ??
				readSmartMemoryId(plugin.app, file, plugin.settings.workspaceId);
			if (!itemId) {
				new Notice('SmartMemory: this note has not been ingested yet');
				return;
			}

			// `item.entities` is only populated transiently in the immediate
			// post-ingest GET response. After the graph is rebuilt, entities
			// live as separate nodes connected via MENTIONS/MENTIONED_IN edges
			// and `item.entities` returns null. Fall back to /neighbors —
			// same pattern the entity sidebar uses (see views/entity-view.ts).
			let entities: Array<{ name: string; type?: string }> = [];
			try {
				const item: any = await client.memories.get(itemId);
				entities = (item?.entities || [])
					.map((e: any) => ({ name: e?.name, type: e?.type }))
					.filter((e: any) => e.name);

				if (entities.length === 0) {
					if (isPathExcluded(file.path, plugin.settings, 'autolink-command')) return;
					const neighborsResp: any = await (client.memories as any).getNeighbors(itemId);
					entities = entityNeighbors(neighborsResp?.neighbors || [])
						.map(n => ({
							name: typeof n.content === 'string' ? n.content : String(n.item_id ?? ''),
							type: n.memory_type,
						}))
						.filter(e => e.name);
				}
			} catch (err) {
				new Notice(`SmartMemory: failed to fetch entities — ${err instanceof Error ? err.message : err}`);
				return;
			}

			if (entities.length === 0) {
				new Notice('SmartMemory: no entities extracted for this note');
				return;
			}

			// Build a case-insensitive basename → path index of the vault so
			// we can resolve entities to notes whose title matches the entity
			// name, even when entityToFile hasn't been warmed yet (e.g. the
			// hub note's enrichment poll missed the post-ingest entities
			// window). Mirrors Obsidian's own wikilink resolution.
			const basenameIndex = new Map<string, string>();
			for (const f of plugin.app.vault.getMarkdownFiles()) {
				basenameIndex.set(f.basename.toLowerCase(), f.path);
			}

			// Basename match is the primary resolution path: an entity's hub
			// note is the file whose title matches the entity name (same model
			// Obsidian uses for native wikilinks). The mappingStore.entityToFile
			// cache is intentionally NOT consulted here — enrichment populates
			// it as "every entity this note mentions → this note", which
			// conflates mentions with representation and routinely points
			// "Asimov" at the note doing the mentioning rather than the
			// Asimov hub. Trusting that cache filtered every candidate out.
			const candidates: EntityCandidate[] = [];
			for (const entity of entities) {
				if (!entity?.name) continue;
				const target = basenameIndex.get(entity.name.toLowerCase()) ?? null;
				if (!target) continue;
				// Don't propose linking to the same note we're editing
				if (target === file.path) continue;
				candidates.push({ name: entity.name, target: toMarkdownLinkTarget(target, file.path) });
			}

			if (candidates.length === 0) {
				const names = entities.map(e => e.name).join(', ') || '(none)';
				const basenames = Array.from(basenameIndex.keys()).slice(0, 8).join(', ');
				new Notice(
					`SmartMemory autolink: ${entities.length} entities (${names}); ` +
					`vault has ${basenameIndex.size} notes (e.g. ${basenames}); ` +
					`0 mapped to existing notes`,
					12000,
				);
				console.warn('[smartmemory autolink] no candidates', { entities, vaultBasenames: Array.from(basenameIndex.keys()) });
				return;
			}

			const text = await plugin.app.vault.read(file);
			const proposals = findEntityMentions(text, candidates);

			if (proposals.length === 0) {
				const cnames = candidates.map(c => c.name).join(', ');
				new Notice(
					`SmartMemory autolink: ${candidates.length} candidates (${cnames}) ` +
					`but 0 word-boundary mentions in note body`,
					12000,
				);
				console.warn('[smartmemory autolink] no mentions found', { candidates, textPreview: text.slice(0, 200) });
				return;
			}

			new AutolinkModal(plugin.app, file, text, proposals, plugin).open();
		},
	});
}
