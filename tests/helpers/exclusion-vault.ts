import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { createServer } from 'node:http';
import { load, dump } from 'js-yaml';
import { MarkdownView, TFile, TFolder } from 'obsidian';
import { SmartMemoryClient } from 'smartmemory-sdk-js/core';
import SmartMemoryPlugin from '../../src/main';
import { MappingStore } from '../../src/bridge/mapping-store';
import { IngestService } from '../../src/services/ingest';
import { SearchService } from '../../src/services/search';
import { ContradictionService } from '../../src/services/contradiction';
import { PerIdCache } from '../../src/services/per-id-cache';
import { DEFAULT_SETTINGS } from '../../src/types';

/** Host adapter only: notes live on disk and the real SDK uses loopback HTTP.
 * No real Obsidian runtime is available in Vitest. Never contact a live API. */
export async function exclusionVault(excluded: boolean, path = 'Private/note.md') {
	const root = mkdtempSync(resolve(tmpdir(), 'test_exclusions_'));
	const response: any = {
		item_id: 'item-1', memory_type: 'semantic', items: [], decisions: [], lineage: [],
		entities: [{ name: 'Target' }],
		neighbors: [{ item_id: 'entity-1', content: 'Target', link_type: 'CONTAINS_ENTITY' }],
	};
	const requests: Array<{ method: string; url: string; body: string }> = [];
	const pending = new Set<Promise<unknown>>();
	let missing = false;
	let onRequest: ((url: string) => void) | undefined;
	const server = createServer(async (req, res) => {
		let body = '';
		for await (const chunk of req) body += chunk;
		requests.push({ method: req.method!, url: req.url!, body });
		onRequest?.(req.url!);
		if (missing && req.url === '/memory/item-1' && req.method === 'GET') {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end('{"detail":"missing"}');
			return;
		}
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(response));
	});
	await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
	const base = `http://127.0.0.1:${(server.address() as any).port}`;
	let apiCalls = 0;
	const client = new SmartMemoryClient({
		apiBaseUrl: base, mode: 'none', storage: 'memory',
		fetchFn: async (input: any, init: any) => {
			if (new URL(String(input)).origin !== base) throw new Error('Non-loopback request blocked');
			apiCalls++;
			const flight = fetch(input, init);
			pending.add(flight);
			try { return await flight; } finally { pending.delete(flight); }
		},
	});
	const file = Object.assign(new TFile(), { path, basename: 'note', name: 'note.md' });
	const parent = Object.assign(new TFolder(), { path: dirname(path), children: [file] });
	file.parent = parent;
	const initial = '---\nsmartmemory_id: item-1\nsmartmemory_type: semantic\n---\nTarget is mentioned in this private paragraph.\n';
	const diskPath = (p: string) => resolve(root, p);
	function put(p: string, text: string) {
		mkdirSync(dirname(diskPath(p)), { recursive: true });
		writeFileSync(diskPath(p), text);
	}
	put(path, initial);
	const files = [file];
	let writes = 0;
	const read = (f: TFile) => readFileSync(diskPath(f.path), 'utf8');
	const frontmatter = (f: TFile) => load(read(f).match(/^---\n([\s\S]*?)\n---/)?.[1] || '') || {};
	const handlers = new Map<string, (...args: any[]) => any>();
	const cleanups: Array<() => void> = [];
	const commands = new Map<string, any>();
	const view: any = Object.assign(new MarkdownView(), {
		file, containerEl: document.createElement('div'),
		editor: {
			getSelection: () => '', getValue: () => read(file), getCursor: () => ({ line: 4, ch: 0 }),
			replaceSelection: (text: string) => { writes++; put(file.path, read(file) + text); },
		},
	});
	view.leaf = { view };
	let activeFile = file;
	const app: any = {
		vault: {
			on: (event: string, callback: any) => { handlers.set(event, callback); },
			read: async (f: TFile) => read(f), getMarkdownFiles: () => files,
			modify: async (f: TFile, text: string) => { writes++; put(f.path, text); },
			getAbstractFileByPath: (p: string) => files.find(f => f.path === p) || null,
			createFolder: async (p: string) => { mkdirSync(diskPath(p), { recursive: true }); },
			create: async (p: string, text: string) => {
				writes++; put(p, text);
				const created = Object.assign(new TFile(), { path: p });
				files.push(created);
				return created;
			},
		},
		metadataCache: { getFileCache: (f: TFile) => ({ frontmatter: frontmatter(f) }) },
		fileManager: { processFrontMatter: async (f: TFile, fn: any) => {
			const fm = frontmatter(f);
			fn(fm);
			writes++;
			put(f.path, `---\n${dump(fm)}---\n${read(f).replace(/^---\n[\s\S]*?\n---\n/, '')}`);
		} },
		workspace: {
			on: (event: string, callback: any) => { handlers.set(event, callback); },
			getActiveFile: () => activeFile, getActiveViewOfType: () => view,
			iterateAllLeaves: (fn: any) => fn(view.leaf), getLeaf: () => ({ openFile: async () => {} }),
		},
	};
	const settings = { ...DEFAULT_SETTINGS, workspaceId: 'test-exclusions',
		excludeFolders: excluded ? [' ./PRIVATE// '] : [], autoIngestOnSave: true, autoIngestOnCreate: true,
		ingestDebounceMs: 500, inlineSuggestionsEnabled: true, contradictionBannerEnabled: true };
	const plugin: any = Object.assign(Object.create(SmartMemoryPlugin.prototype), {
		app, settings, client, mappingStore: new MappingStore({ fileToMemory: {}, memoryToFile: {}, entityToFile: {}, contentHashes: {} }),
		panelCache: new PerIdCache(), saveMappings: async () => {}, capabilityAvailable: () => true,
		registerEvent: () => {}, register: (fn: any) => cleanups.push(fn),
		addCommand: (cmd: any) => commands.set(cmd.id, cmd),
	});
	const service = new IngestService({ client, app, settings, mappingStore: plugin.mappingStore, pollDelayMs: 0, pollMaxAttempts: 1 });
	const enrich = service.enrichFile.bind(service);
	const background = new Set<Promise<unknown>>();
	service.enrichFile = file => {
		const flight = enrich(file);
		background.add(flight);
		void flight.finally(() => background.delete(flight));
		return flight;
	};
	plugin.ingestService = service;
	plugin.searchService = new SearchService(client);
	plugin.contradictionService = new ContradictionService(client);
	return {
		plugin, service, app, file, view, settings, requests, commands, handlers, read, root, response,
		get apiCalls() { return apiCalls; }, get writes() { return writes; }, initial,
		map: () => plugin.mappingStore.set(file.path, 'item-1'),
		missing: () => { missing = true; },
		onRequest: (fn: (url: string) => void) => { onRequest = fn; },
		activate: (f: TFile) => { activeFile = f; view.file = f; },
		async flush() { while (pending.size || background.size) await Promise.all([...pending, ...background]); },
		async close() {
			for (const fn of cleanups) fn();
			try { await this.flush(); } finally {
				server.closeAllConnections();
				try {
					await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r()));
				} finally { rmSync(root, { recursive: true, force: true }); }
			}
		},
	};
}
