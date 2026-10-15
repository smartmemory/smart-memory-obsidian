import { afterEach, expect, it, vi } from 'vitest';
import { isPathExcluded } from '../src/util/exclusions';
import { VaultEvents } from '../src/services/vault-events';
import { InlineSuggestions } from '../src/enrichers/suggestions';
import { registerSearchCommands } from '../src/commands/search';
import { RecallModal } from '../src/views/recall-modal';
import { AutolinkModal } from '../src/views/autolink-modal';
import { exclusionVault } from './helpers/exclusion-vault';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren(); });

const boundaries: Array<[string, string, boolean]> = [
	['Private/note.md', 'Private', true],
	['private/sub/note.md', ' PRIVATE/// ', true],
	['Private\\sub\\note.md', './private/', true],
	['./Private//sub/../note.md/', '/PRIVATE/', true],
	['Prive\u0301/note.md', 'Privé/', true],
	['PrivateArchive/note.md', 'Private', true],
	['PrivateArchive/x.md', 'Private', true],
	['journal-2024/x.md', 'journal', true],
	['PrivateArchive/x.md', 'Private/', false],
	['PrivateArchive/x.md', 'Private\\', false],
	['Public/Private/note.md', 'Private/', false],
	['Public/note.md', '', true],
	['Public/note.md', '   ', true],
	['Private', 'Private/', true],
];

it.each(boundaries)('normalizes %s against %s => %s', (path, folder, excluded) => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	expect(isPathExcluded(path as string, { excludeFolders: [folder as string] }, 'normalization')).toBe(excluded);
	expect(warn).toHaveBeenCalledTimes(excluded ? 1 : 0);
});

// Literal reference: 88b75fc, src/services/ingest.ts:428-438.
function baseExcluded(path: string, pattern: string): boolean {
	const normalized = pattern.endsWith('/') ? pattern : pattern + '/';
	return path.startsWith(normalized) || path.startsWith(pattern);
}

it('never narrows the base rule for configured path prefixes in the table', () => {
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	for (const [path, folder] of boundaries) {
		const base = baseExcluded(path, folder);
		expect(Number(isPathExcluded(path, { excludeFolders: [folder] }, 'legacy-compatibility')),
			`${JSON.stringify(path)} against ${JSON.stringify(folder)}`).toBeGreaterThanOrEqual(Number(base));
	}
});

type Vault = Awaited<ReturnType<typeof exclusionVault>>;
const pendingPaths: Array<{ name: string; sent: number; run: (h: Vault) => Promise<unknown> }> = [
	{ name: 'auto event debounce', sent: 0, run: async h => {
		new VaultEvents(h.plugin).register();
		h.handlers.get('modify')!(h.file);
		h.settings.excludeFolders = ['Private/'];
		await new Promise(r => setTimeout(r, 550));
	} },
	{ name: 'inline suggestion debounce', sent: 0, run: async h => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const inline = new InlineSuggestions(h.plugin);
		inline.start();
		h.handlers.get('editor-change')!(h.view.editor, h.view);
		h.settings.excludeFolders = ['Private/'];
		await vi.advanceTimersByTimeAsync(2000);
		inline.stop();
	} },
	{ name: 'ingest vault read', sent: 0, run: async h => {
		const read = h.app.vault.read;
		h.app.vault.read = async (file: any) => {
			const text = await read(file);
			h.settings.excludeFolders = ['Private/'];
			return text;
		};
		await h.service.ingestFile(h.file);
	} },
	{ name: 'metadata update response', sent: 1, run: async h => {
		h.onRequest(() => { h.settings.excludeFolders = ['Private/']; });
		await h.service.ingestFile(h.file, { metadataOnly: true });
	} },
	{ name: 'enrichment item response', sent: 1, run: async h => {
		h.onRequest(() => { h.settings.excludeFolders = ['Private/']; });
		await h.service.enrichFile(h.file);
	} },
	{ name: 'enrichment neighbor response', sent: 2, run: async h => {
		h.onRequest(url => { if (url.includes('neighbors')) h.settings.excludeFolders = ['Private/']; });
		await h.service.enrichFile(h.file);
	} },
	{ name: 'recall vault read', sent: 0, run: async h => {
		const read = h.app.vault.read;
		h.app.vault.read = async (file: any) => {
			const text = await read(file);
			h.settings.excludeFolders = ['Private/'];
			return text;
		};
		registerSearchCommands(h.plugin);
		await h.commands.get('smartmemory-recall-current-note').callback();
	} },
	{ name: 'recall fallback file differs from editor', sent: 0, run: async h => {
		// An editor can remain visible while workspace focus tracks another file.
		h.view.file = { path: 'Public/other.md' };
		h.settings.excludeFolders = ['Private/'];
		registerSearchCommands(h.plugin);
		await h.commands.get('smartmemory-recall-current-note').callback();
	} },
	{ name: 'recall modal source renamed', sent: 0, run: async h => {
		const preview = new RecallModal(h.app, h.plugin, 'captured note text', h.file);
		h.file.path = 'Private/renamed.md';
		h.settings.excludeFolders = ['Private/'];
		await preview.onOpen();
		h.file.path = 'Private/note.md';
	} },
	{ name: 'autolink preview read', sent: 0, run: async h => {
		const preview = new AutolinkModal(h.app, h.file, h.initial, [{
			start: h.initial.indexOf('Target'), end: h.initial.indexOf('Target') + 6,
			matchedText: 'Target', target: 'Target.md', entityName: 'Target',
		}] as any, h.plugin);
		const read = h.app.vault.read;
		h.app.vault.read = async (file: any) => {
			const text = await read(file);
			h.settings.excludeFolders = ['Private/'];
			return text;
		};
		await (preview as any).applyAndClose();
	} },
];

it.each(pendingPaths)('stops pending $name when the folder becomes excluded', async ({ sent, run }) => {
	const h = await exclusionVault(false);
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		await run(h);
		await h.flush();
		expect(h.apiCalls).toBe(sent); // Only requests started before exclusion are allowed.
		expect(h.writes).toBe(0);
		expect(h.read(h.file)).toBe(h.initial);
	} finally { await h.close(); }
});
