import { afterEach, describe, expect, it, vi } from 'vitest';
import { exclusionVault } from './helpers/exclusion-vault';
import { hashContent } from '../src/services/ingest';
import { VaultEvents } from '../src/services/vault-events';
import { registerIngestCommands } from '../src/commands/ingest';
import { registerSearchCommands } from '../src/commands/search';
import { registerAutolinkCommand } from '../src/commands/autolink';
import { writeSmartMemoryFrontmatter, clearSmartMemoryFrontmatter } from '../src/bridge/frontmatter';
import { InlineSuggestions } from '../src/enrichers/suggestions';
import { ContradictionBanner } from '../src/enrichers/contradiction';
import { RecallModal } from '../src/views/recall-modal';
import { AutolinkModal } from '../src/views/autolink-modal';
import { LineageModal } from '../src/views/lineage-modal';
import { EntityView } from '../src/views/entity-view';
import { LineagePanel } from '../src/views/lineage-panel';
import { SupersessionsPanel } from '../src/views/supersessions-panel';
import { DecisionsPanel } from '../src/views/decisions-panel';

type Vault = Awaited<ReturnType<typeof exclusionVault>>;
const result = { itemId: 'item-2', title: 'Imported', content: 'Remote body', snippet: 'Remote body' } as any;
function modal<T extends object>(value: T, h: Vault): T {
	return Object.assign(value, { app: h.app, contentEl: document.createElement('div'), close() {} });
}
async function auto(h: Vault, event: string) {
	const events = new VaultEvents(h.plugin);
	const run = vi.spyOn(events as any, 'runAutoIngest'); // calls through to the real service
	events.register();
	h.handlers.get(event)!(h.file);
	await new Promise(r => setTimeout(r, 550));
	await Promise.all(run.mock.results.map(r => r.value));
}
async function recall(h: Vault, selection: boolean) {
	if (selection) h.view.editor.getSelection = () => 'Selected private text';
	vi.spyOn(RecallModal.prototype as any, 'open').mockImplementation(function (this: RecallModal) {
		modal(this, h);
		return this.onOpen();
	});
	registerSearchCommands(h.plugin);
	await h.commands.get('smartmemory-recall-current-note').callback();
	await h.flush();
}

// Each entry is a census path. Removing its exclusion guard must fail its
// excluded row. Allowed rows prove the guard does not disable the feature.
const paths: Array<{ name: string; api: boolean; rewrite: boolean; run: (h: Vault) => Promise<unknown> }> = [
	{ name: 'manual-ingest', api: true, rewrite: true, run: async h => {
		registerIngestCommands(h.plugin);
		await h.commands.get('smartmemory-ingest-current-note').callback();
		await h.flush();
	} },
	{ name: 'folder-ingest', api: true, rewrite: true, run: async h => {
		registerIngestCommands(h.plugin);
		await h.commands.get('smartmemory-ingest-folder').callback();
	} },
	{ name: 'auto-modify', api: true, rewrite: true, run: h => auto(h, 'modify') },
	{ name: 'auto-create', api: true, rewrite: true, run: h => auto(h, 'create') },
	{ name: 'metadata-update', api: true, rewrite: true, run: h => h.service.ingestFile(h.file, { metadataOnly: true, skipEnrichment: true }) },
	{ name: 'unchanged-check', api: true, rewrite: false, run: async h => {
		h.plugin.mappingStore.setContentHash(h.file.path, hashContent('Target is mentioned in this private paragraph.\n'));
		await h.service.ingestFile(h.file, { skipEnrichment: true });
	} },
	{ name: 'missing-reingest', api: true, rewrite: true, run: async h => {
		h.plugin.mappingStore.setContentHash(h.file.path, hashContent('Target is mentioned in this private paragraph.\n'));
		h.missing();
		await h.service.ingestFile(h.file, { skipEnrichment: true });
	} },
	{ name: 'changed-reingest', api: true, rewrite: true, run: async h => {
		h.map(); h.plugin.mappingStore.setContentHash(h.file.path, 'previous-content');
		await h.service.ingestFile(h.file, { skipEnrichment: true });
	} },
	{ name: 'enrichment', api: true, rewrite: true, run: async h => {
		registerIngestCommands(h.plugin);
		await h.commands.get('smartmemory-enrich-current-note').callback();
	} },
	{ name: 'startup-migration', api: false, rewrite: true, run: h => h.plugin.initializeOkfFrontmatter() },
	{ name: 'frontmatter-write', api: false, rewrite: true, run: h => writeSmartMemoryFrontmatter(h.app, h.file, { id: 'item-1' }, h.settings) },
	{ name: 'purge-frontmatter-clear', api: false, rewrite: true, run: h => clearSmartMemoryFrontmatter(h.app, h.file, h.settings) },
	{ name: 'recall-selection', api: true, rewrite: false, run: h => recall(h, true) },
	{ name: 'recall-whole-note', api: true, rewrite: false, run: h => recall(h, false) },
	{ name: 'inline-suggestions', api: true, rewrite: false, run: async h => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const inline = new InlineSuggestions(h.plugin);
		inline.start();
		h.handlers.get('editor-change')!(h.view.editor, h.view);
		await vi.advanceTimersByTimeAsync(2000);
		vi.useRealTimers();
		await h.flush();
		inline.stop();
	} },
	{ name: 'autolink-command', api: true, rewrite: false, run: async h => {
		registerAutolinkCommand(h.plugin);
		await h.commands.get('smartmemory-autolink-current-note').callback();
	} },
	{ name: 'autolink-apply', api: false, rewrite: true, run: async h => {
		// The callback stays live if exclusions change while a preview is open.
		const preview = modal(new AutolinkModal(h.app, h.file, h.initial, [{
			start: h.initial.indexOf('Target'), end: h.initial.indexOf('Target') + 6,
			matchedText: 'Target', target: 'Target.md', entityName: 'Target',
		}] as any, h.plugin), h);
		await (preview as any).applyAndClose();
	} },
	{ name: 'recall-insert-link', api: false, rewrite: true, run: async h => {
		await (modal(new RecallModal(h.app, h.plugin, 'query'), h) as any).insertLink(result);
	} },
	{ name: 'recall-import-note', api: false, rewrite: true, run: async h => {
		if (h.settings.excludeFolders.length) h.settings.excludeFolders.push('SmartMemory Imports/');
		await (modal(new RecallModal(h.app, h.plugin, 'query'), h) as any).createNoteFromResult(result);
	} },
	{ name: 'suggestion-insert-link', api: false, rewrite: true, run: async h => {
		h.plugin.mappingStore.set('Public/target.md', 'item-2');
		const inline = new InlineSuggestions(h.plugin);
		(inline as any).render([result], 'query');
		h.view.containerEl.querySelector('a')?.click();
	} },
	{ name: 'entity-sidebar', api: true, rewrite: false, run: async h => {
		const panel = new EntityView({} as any, h.plugin);
		await panel.onOpen();
	} },
	{ name: 'entity-lookup-graph', api: true, rewrite: false, run: async h => {
		const panel = new EntityView({} as any, h.plugin);
		(panel as any).currentFile = h.file;
		await (panel as any).showCrossNoteResults({ name: 'Target', entityId: 'entity-1' }, 'item-1', document.createElement('div'));
	} },
	{ name: 'entity-lookup-search', api: true, rewrite: false, run: async h => {
		const panel = new EntityView({} as any, h.plugin);
		(panel as any).currentFile = h.file;
		await (panel as any).showCrossNoteResults({ name: 'Target' }, 'item-1', document.createElement('div'));
	} },
	{ name: 'lineage-sidebar', api: true, rewrite: false, run: h => new LineagePanel({} as any, h.plugin).onOpen() },
	{ name: 'supersessions-sidebar', api: true, rewrite: false, run: h => new SupersessionsPanel({} as any, h.plugin).onOpen() },
	{ name: 'decisions-sidebar', api: true, rewrite: false, run: h => new DecisionsPanel({} as any, h.plugin).onOpen() },
	{ name: 'contradiction-banner', api: true, rewrite: false, run: h => (new ContradictionBanner(h.plugin) as any).checkActive() },
	{ name: 'lineage-modal', api: true, rewrite: false, run: async h => {
		h.map();
		await modal(new LineageModal(h.app, h.plugin, 'item-1'), h).onOpen();
	} },
];

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren(); });

describe('folder exclusion census', () => {
	it.each(paths.flatMap(path => [
		{ ...path, excluded: true }, { ...path, excluded: false },
	]))('$name excluded=$excluded', async ({ name, api, rewrite, run, excluded }) => {
		const h = await exclusionVault(excluded);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			await run(h);
			await h.flush();
			if (excluded) {
				expect.soft(h.apiCalls, `${name}: no outbound API call`).toBe(0);
				expect.soft(h.requests, `${name}: no received API request`).toEqual([]);
				expect.soft(h.writes, `${name}: no file rewrite`).toBe(0);
				expect.soft(h.read(h.file), `${name}: disk bytes unchanged`).toBe(h.initial);
				const pathClass = ['metadata-update', 'unchanged-check', 'missing-reingest', 'changed-reingest'].includes(name)
					? 'ingest-file' : name.startsWith('recall-') && ['recall-selection', 'recall-whole-note'].includes(name)
						? 'recall-query' : name;
				expect(warn.mock.calls.some(args => args.join(' ').includes('excluded') && args.join(' ').includes(pathClass))).toBe(true);
			} else {
				expect(h.apiCalls > 0, `${name}: allowed API behavior`).toBe(api);
				expect(h.writes > 0, `${name}: allowed rewrite behavior`).toBe(rewrite);
			}
		} finally { await h.close(); }
	});
});
