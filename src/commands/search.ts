import { MarkdownView, Notice } from 'obsidian';
import type SmartMemoryPlugin from '../main';
import { SEARCH_VIEW_TYPE } from '../views/search-view';
import { ENTITY_VIEW_TYPE } from '../views/entity-view';
import { LINEAGE_PANEL_TYPE } from '../views/lineage-panel';
import { SUPERSESSIONS_PANEL_TYPE } from '../views/supersessions-panel';
import { DECISIONS_PANEL_TYPE } from '../views/decisions-panel';
import { RecallModal } from '../views/recall-modal';
import { isPathExcluded } from '../util/exclusions';

async function openInRightSidebar(plugin: SmartMemoryPlugin, viewType: string): Promise<void> {
	const { workspace } = plugin.app;
	let leaf = workspace.getLeavesOfType(viewType)[0];
	if (!leaf) {
		const right = workspace.getRightLeaf(false);
		if (!right) {
			new Notice('SmartMemory: cannot open right sidebar');
			return;
		}
		await right.setViewState({ type: viewType, active: true });
		leaf = workspace.getLeavesOfType(viewType)[0];
	}
	workspace.revealLeaf(leaf);
}

export function registerSearchCommands(plugin: SmartMemoryPlugin): void {
	plugin.addCommand({
		id: 'smartmemory-open-search',
		name: 'Open search sidebar',
		callback: () => openInRightSidebar(plugin, SEARCH_VIEW_TYPE),
	});

	plugin.addCommand({
		id: 'smartmemory-open-entities',
		name: 'Open entity backlinks sidebar',
		callback: () => openInRightSidebar(plugin, ENTITY_VIEW_TYPE),
	});

	plugin.addCommand({
		id: 'smartmemory-open-lineage-panel',
		name: 'Open lineage sidebar',
		callback: () => openInRightSidebar(plugin, LINEAGE_PANEL_TYPE),
	});

	plugin.addCommand({
		id: 'smartmemory-open-supersessions-panel',
		name: 'Open supersessions sidebar',
		callback: () => openInRightSidebar(plugin, SUPERSESSIONS_PANEL_TYPE),
	});

	plugin.addCommand({
		id: 'smartmemory-open-decisions-panel',
		name: 'Open decisions sidebar',
		callback: () => openInRightSidebar(plugin, DECISIONS_PANEL_TYPE),
	});

	plugin.addCommand({
		id: 'smartmemory-recall-current-note',
		name: 'Recall related memories for current note',
		hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'r' }],
		callback: async () => {
			// Prefer an active editor selection; fall back to the active file's
			// content. We deliberately do NOT require focus to be inside the
			// markdown editor — `getActiveViewOfType(MarkdownView)` returns
			// null when focus is in a plugin sidebar, which made the hotkey
			// feel broken whenever the user had just clicked a sidebar.
			const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			let source = view?.file ?? plugin.app.workspace.getActiveFile();
			let query = view?.editor.getSelection() ?? '';
			if (!query) {
				const file = plugin.app.workspace.getActiveFile();
				if (!file) {
					new Notice('SmartMemory: no active note');
					return;
				}
				source = file;
				if (isPathExcluded(file.path, plugin.settings, 'recall-query')) return;
				try {
					query = await plugin.app.vault.read(file);
				} catch {
					new Notice('SmartMemory: could not read active note');
					return;
				}
			}
			if (!query.trim()) {
				new Notice('SmartMemory: nothing to recall');
				return;
			}
			if (source && isPathExcluded(source.path, plugin.settings, 'recall-query')) return;
			new RecallModal(plugin.app, plugin, query, source ?? undefined).open();
		},
	});
}
