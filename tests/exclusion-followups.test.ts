import { afterEach, expect, it, vi } from 'vitest';
import { Notice, TFile } from 'obsidian';
import { tmpdir } from 'node:os';
import { existsSync, realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { exclusionVault } from './helpers/exclusion-vault';
import { registerIngestCommands } from '../src/commands/ingest';
import { registerSearchCommands } from '../src/commands/search';
import { registerAutolinkCommand } from '../src/commands/autolink';
import { RecallModal } from '../src/views/recall-modal';
import { AutolinkModal } from '../src/views/autolink-modal';
import { InlineSuggestions } from '../src/enrichers/suggestions';
import { EntityView } from '../src/views/entity-view';
import { LineagePanel } from '../src/views/lineage-panel';
import { SupersessionsPanel } from '../src/views/supersessions-panel';
import { DecisionsPanel } from '../src/views/decisions-panel';
import { VaultEvents } from '../src/services/vault-events';

afterEach(() => { vi.restoreAllMocks(); Notice.lastMessage = null; document.body.replaceChildren(); });

// Missing command guards must produce a visible explanation, with no send/write.
it.each(['ingest', 'enrich', 'autolink', 'recall', 'import'])('explains excluded %s commands', async action => {
	const h = await exclusionVault(true);
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		registerIngestCommands(h.plugin);
		registerAutolinkCommand(h.plugin);
		registerSearchCommands(h.plugin);
		if (action === 'import') {
			h.settings.excludeFolders.push('SmartMemory Imports/');
			await (new RecallModal(h.app, h.plugin, '') as any).createNoteFromResult({ title: 'Imported', content: 'body' });
		} else {
			const id = action === 'ingest' ? 'smartmemory-ingest-current-note' : action === 'enrich'
				? 'smartmemory-enrich-current-note' : action === 'autolink'
					? 'smartmemory-autolink-current-note' : 'smartmemory-recall-current-note';
			await h.commands.get(id).callback();
		}
		expect(Notice.lastMessage ?? '').toMatch(/excluded/i);
		expect(h.apiCalls).toBe(0);
		expect(h.writes).toBe(0);
	} finally { await h.close(); }
});

it.each([
	{ name: 'entities', Panel: EntityView }, { name: 'lineage', Panel: LineagePanel },
	{ name: 'supersessions', Panel: SupersessionsPanel }, { name: 'decisions', Panel: DecisionsPanel },
])('explains an excluded note in $name', async ({ Panel }) => {
	const h = await exclusionVault(true);
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		const panel = new Panel({} as any, h.plugin);
		await panel.onOpen();
		expect(panel.containerEl.textContent).toMatch(/excluded/i);
		expect(h.apiCalls).toBe(0);
	} finally { await h.close(); }
});

it('returns a distinct exclusion skip reason', async () => {
	const h = await exclusionVault(true);
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		expect(await h.service.ingestFile(h.file)).toEqual({ itemId: '', skipped: 'excluded' });
	} finally { await h.close(); }
});

type Vault = Awaited<ReturnType<typeof exclusionVault>>;
const frontmatterOnly = '---\nsmartmemory_id: item-1\n---\n  \n';
// One row per ingest caller/entry path. Throwing on empty content breaks the
// automatic rows, swallowing the result breaks explicit feedback and batch counts.
const emptyCallers: Array<{
	name: string; body: string; feedback: 'quiet' | 'note' | 'batch';
	run: (h: Vault) => Promise<unknown>;
}> = [
	{ name: 'service boundary (background)', body: '  \n', feedback: 'quiet', run: async h => {
		expect(await h.service.ingestFile(h.file)).toEqual({ itemId: '', skipped: 'empty' });
	} },
	{ name: 'current-note command (explicit)', body: '', feedback: 'note', run: async h => {
		registerIngestCommands(h.plugin);
		await h.commands.get('smartmemory-ingest-current-note').callback();
	} },
	{ name: 'current-note command, frontmatter only (explicit)', body: frontmatterOnly, feedback: 'note', run: async h => {
		registerIngestCommands(h.plugin);
		await h.commands.get('smartmemory-ingest-current-note').callback();
	} },
	{ name: 'folder worker (automatic per note)', body: frontmatterOnly, feedback: 'quiet', run: async h => {
		expect(await h.service.ingestFolder([h.file])).toEqual({ succeeded: 0, failed: 0, skipped: 1 });
	} },
	{ name: 'folder command (explicit summary)', body: '', feedback: 'batch', run: async h => {
		registerIngestCommands(h.plugin);
		await h.commands.get('smartmemory-ingest-folder').callback();
	} },
	{ name: 'shared auto-ingest handler (automatic)', body: frontmatterOnly, feedback: 'quiet', run: async h => {
		await (new VaultEvents(h.plugin) as any).runAutoIngest(h.file, 'auto-modify');
	} },
	// Reproduce review-scratch-r2/probe-empty-create.test.ts through the registered event and real debounce.
	{ name: 'reviewer probe-empty-create event (automatic)', body: '', feedback: 'quiet', run: async h => {
		new VaultEvents(h.plugin).register();
		h.handlers.get('create')!(h.file);
		await new Promise(r => setTimeout(r, 700));
	} },
	{ name: 'modify event (automatic)', body: frontmatterOnly, feedback: 'quiet', run: async h => {
		new VaultEvents(h.plugin).register();
		h.handlers.get('modify')!(h.file);
		await new Promise(r => setTimeout(r, 700));
	} },
];

it.each(emptyCallers)('handles empty notes via $name', async ({ body, feedback, run }) => {
	const h = await exclusionVault(false, 'Notes/Untitled.md');
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		await h.app.vault.modify(h.file, body);
		const writes = h.writes;
		h.map();
		// toJSON stamps serialization time. Snapshot only persisted mapping state.
		const { lastSyncTimestamp: beforeTimestamp, ...mappings } = h.plugin.mappingStore.toJSON();
		Notice.lastMessage = null;
		await run(h);
		if (feedback === 'quiet') expect(Notice.lastMessage).toBeNull();
		else if (feedback === 'note') expect(Notice.lastMessage).toMatch(/note is empty/i);
		else expect(Notice.lastMessage).toMatch(/0 ingested, 0 failed, 1 skipped.*empty/i);
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/skip.*empty/i), h.file.path);
		expect(h.apiCalls).toBe(0);
		expect(h.writes).toBe(writes);
		expect(h.read(h.file)).toBe(body);
		const { lastSyncTimestamp: afterTimestamp, ...afterMappings } = h.plugin.mappingStore.toJSON();
		expect(afterMappings).toEqual(mappings);
	} finally { await h.close(); }
});

it('purges an excluded mapping while preserving its frontmatter bytes', async () => {
	const h = await exclusionVault(true);
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		h.map();
		h.response.items = [{ item_id: 'item-1', origin: 'import:obsidian' }];
		await h.plugin.purgeObsidianOriginMemories();
		expect(h.requests.some(r => r.method === 'DELETE' && r.url === '/memory/item-1')).toBe(true);
		expect(h.plugin.mappingStore.getMemoryId(h.file.path)).toBeNull();
		expect(h.plugin.mappingStore.getFilePath('item-1')).toBeNull();
		expect(h.writes).toBe(0);
		expect(h.read(h.file)).toBe(h.initial);
	} finally { await h.close(); }
});

const result = { itemId: 'target-1', title: 'Target', content: 'body', snippet: 'body' } as any;
// Each insertion surface must refuse an excluded target, including an open preview/widget.
it.each(['autolink candidates', 'autolink preview', 'recall', 'recall unmapped title', 'suggestion results', 'suggestion click'])('filters excluded link targets from %s', async surface => {
	const h = await exclusionVault(false, 'Public/note.md');
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		h.plugin.mappingStore.set('Private/Target.md', result.itemId);
		(h.app.vault.getMarkdownFiles() as TFile[]).push(Object.assign(new TFile(), { path: 'Private/Target.md', basename: 'Target' }));
		if (surface !== 'suggestion click') h.settings.excludeFolders = ['Private/'];
		if (surface === 'autolink candidates') {
			const opened = vi.spyOn(AutolinkModal.prototype, 'open');
			registerAutolinkCommand(h.plugin);
			await h.commands.get('smartmemory-autolink-current-note').callback();
			expect(opened).not.toHaveBeenCalled();
		} else if (surface === 'autolink preview') {
			const preview = new AutolinkModal(h.app, h.file, h.initial, [{
				start: h.initial.indexOf('Target'), end: h.initial.indexOf('Target') + 6,
				matchedText: 'Target', target: '../Private/Target.md', entityName: 'Target',
			}], h.plugin);
			await (preview as any).applyAndClose();
		} else if (surface.startsWith('recall')) {
			if (surface === 'recall unmapped title') h.plugin.mappingStore.handleDelete('Private/Target.md');
			(new RecallModal(h.app, h.plugin, '') as any).insertLink(result);
			expect(Notice.lastMessage ?? '').toMatch(/excluded/i);
		} else {
			const inline = new InlineSuggestions(h.plugin);
			(inline as any).render([result], 'query');
			if (surface === 'suggestion results') expect(h.view.containerEl.querySelector('a')).toBeNull();
			else {
				expect(h.view.containerEl.querySelector('a')).not.toBeNull();
				h.settings.excludeFolders = ['Private/'];
				h.view.containerEl.querySelector('a')!.click();
			}
		}
		expect(h.writes).toBe(0);
		expect(h.read(h.file)).toBe(h.initial);
	} finally { await h.close(); }
});

it('creates and cleans fixtures under the OS temporary directory', async () => {
	const h = await exclusionVault(false);
	try { expect(relative(realpathSync(tmpdir()), realpathSync(h.root))).toMatch(/^test_exclusions_/); }
	finally { await h.close(); }
	expect(existsSync(h.root)).toBe(false);
});
