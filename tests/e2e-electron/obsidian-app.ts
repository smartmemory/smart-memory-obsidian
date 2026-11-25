/**
 * obsidian-app.ts — DIST-OBSIDIAN-E2E-2 (Tier 2)
 *
 * Playwright fixture that boots the REAL Obsidian Electron binary into the
 * committed fixture vault with the built plugin live, talking to a local mock
 * backend. This is the substrate the whole tier rests on; the spec assertions
 * are thin by comparison.
 *
 * Why not Playwright's `_electron.launch`?
 *   That attaches to the Electron MAIN process via the Node inspector
 *   (`--inspect`). Obsidian is a packaged app with the
 *   `EnableNodeCliInspectArguments` Electron fuse disabled, so `--inspect` is
 *   ignored and the launch never connects. Obsidian DOES expose the renderer
 *   CDP via `--remote-debugging-port`, so we spawn it ourselves and
 *   `chromium.connectOverCDP()` to that endpoint, driving the window as a
 *   normal Page. (Same approach the mature wdio-obsidian-service uses.)
 *
 * Boot mechanism (Obsidian has no --open-vault flag):
 *   1. Build + install plugin binaries into the fixture vault (global-setup).
 *   2. Start the mock backend on an ephemeral port.
 *   3. Write data.json into the fixture plugin dir pointing apiUrl at the mock,
 *      with onboarding pre-completed and background ingest/sweeps disabled.
 *   4. Seed a fresh per-run <userData>/obsidian.json registering the fixture
 *      vault with open:true AND updateDisabled:true (pins the bundled app asar,
 *      so Obsidian doesn't hot-update + relaunch and sever the CDP connection).
 *   5. Spawn Obsidian with --remote-debugging-port=0, parse the DevTools ws
 *      endpoint from its output, and connectOverCDP to it.
 */
import { test as base, expect, chromium, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { startMockBackend } from './mock-backend';

const FIXTURE_VAULT = resolve(__dirname, 'fixture-vault');
const FIXTURE_PLUGIN_DIR = resolve(FIXTURE_VAULT, '.obsidian', 'plugins', 'smartmemory');
const RUNS_DIR = resolve(__dirname, '.obsidian-test-runs');

function resolveObsidianBinary(): string {
	if (process.env.OBSIDIAN_BIN) return process.env.OBSIDIAN_BIN;
	switch (process.platform) {
		case 'darwin':
			return '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
		case 'linux':
			// Set OBSIDIAN_BIN to your Obsidian binary (or extracted AppImage); this is a fallback.
			return '/opt/Obsidian/obsidian';
		case 'win32':
			return resolve(process.env.LOCALAPPDATA || '', 'Obsidian', 'Obsidian.exe');
		default:
			throw new Error(`Unsupported platform for Obsidian E2E: ${process.platform}`);
	}
}

export interface ObsidianHarness {
	page: Page;
	consoleErrors: string[];
	mockRequests: Array<{ method: string; path: string; query: Record<string, string> }>;
	/** Open a vault note by path (e.g. "Decisions Source.md") via Obsidian's own API. */
	openNote(path: string): Promise<void>;
	/** Run a plugin command by id (e.g. "open-decisions-panel"). */
	runCommand(id: string): Promise<void>;
	/** Path of the currently active markdown file, or null. */
	activeNotePath(): Promise<string | null>;
	/** Registered command ids (for palette-registration assertions). */
	commandIds(): Promise<string[]>;
}

export const test = base.extend<{ obsidian: ObsidianHarness }>({
	obsidian: async ({}, use, testInfo) => {
		const runDir = resolve(RUNS_DIR, `run-${testInfo.workerIndex}-${testInfo.testId}`);
		const userDataDir = resolve(runDir, 'userData');
		// Guarantee a genuinely fresh userData: testIds are deterministic, so a
		// failed prior run (whose teardown was skipped) could leave a downloaded
		// obsidian-<ver>.asar here — which makes Obsidian do a two-stage
		// installer->app relaunch that severs the CDP connection.
		rmSync(runDir, { recursive: true, force: true });
		mkdirSync(userDataDir, { recursive: true });

		// 1. Mock backend.
		const mock = await startMockBackend({ log: !!process.env.E2E_VERBOSE });

		// 2. Runtime plugin settings — point at the mock, skip onboarding, no bg noise.
		mkdirSync(FIXTURE_PLUGIN_DIR, { recursive: true });
		writeFileSync(
			resolve(FIXTURE_PLUGIN_DIR, 'data.json'),
			JSON.stringify(
				{
					settings: {
						mode: 'cloud',
						apiKey: 'e2e-key',
						apiUrl: mock.url,
						workspaceId: 'team-e2e',
						autoIngestOnSave: false,
						autoIngestOnCreate: false,
						contradictionBannerEnabled: false,
						inlineSuggestionsEnabled: false,
						hasCompletedOnboarding: true,
						hasSeenIngestTour: true,
					},
				},
				null,
				2,
			),
		);

		// 3. Seed the vault registry. updateDisabled pins the bundled app asar so
		// Obsidian won't hot-update + relaunch (which severs CDP).
		writeFileSync(
			resolve(userDataDir, 'obsidian.json'),
			JSON.stringify({
				updateDisabled: true,
				vaults: {
					e2efixturevault00: { path: FIXTURE_VAULT, ts: 1717545600000, open: true },
				},
			}),
		);

		// 4. Spawn Obsidian with the renderer CDP open.
		const args = [`--user-data-dir=${userDataDir}`, '--remote-debugging-port=0', '--disable-gpu'];
		if (process.platform === 'linux') args.push('--no-sandbox');

		// detached so the child is its own process-group leader — lets teardown
		// kill the whole Electron process tree via process.kill(-pid).
		const proc = spawn(resolveObsidianBinary(), args, {
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: process.platform !== 'win32',
		});

		let browser: Browser | undefined;
		try {
			const wsEndpoint = await parseDevtoolsEndpoint(proc, 45_000);
			browser = await chromium.connectOverCDP(wsEndpoint);
			const page = await waitForVaultPage(browser, 45_000);

			// Console-error collection — wired to the renderer so the
			// "loads without console errors" assertion is real, not a no-op.
			const consoleErrors: string[] = [];
			page.on('console', (msg) => {
				if (msg.type() === 'error') consoleErrors.push(msg.text());
			});
			page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

			// Wait for our plugin to finish loading before any test runs.
			await waitForPluginLoaded(page);

			const harness: ObsidianHarness = {
				page,
				consoleErrors,
				mockRequests: mock.requests,
				openNote: (path) =>
					page.evaluate(async (p) => {
						const a = (window as any).app;
						const file = a.vault.getAbstractFileByPath(p);
						if (!file) throw new Error(`fixture note not found: ${p}`);
						await a.workspace.getLeaf(false).openFile(file);
					}, path),
				runCommand: (id) =>
					page.evaluate((cmdId) => {
						// Obsidian namespaces command ids as `<pluginId>:<id>`.
						const full = cmdId.includes(':') ? cmdId : `smartmemory:${cmdId}`;
						return (window as any).app.commands.executeCommandById(full);
					}, id),
				activeNotePath: () =>
					page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path ?? null),
				commandIds: () =>
					page.evaluate(() => Object.keys((window as any).app.commands.commands)),
			};

			await use(harness);
		} finally {
			// Teardown — disconnect CDP, then kill the Obsidian process tree.
			await browser?.close().catch(() => {});
			killProcessTree(proc);
			await mock.close().catch(() => {});
			rmSync(runDir, { recursive: true, force: true });
		}
	},
});

/** Parse the "DevTools listening on ws://..." endpoint Obsidian prints when --remote-debugging-port is set. */
function parseDevtoolsEndpoint(proc: ChildProcess, timeoutMs: number): Promise<string> {
	return new Promise<string>((resolveEndpoint, reject) => {
		const timer = setTimeout(
			() => reject(new Error('Obsidian did not print a DevTools endpoint within timeout')),
			timeoutMs,
		);
		const scan = (buf: Buffer | string) => {
			const m = String(buf).match(/DevTools listening on (ws:\/\/\S+)/);
			if (m) {
				clearTimeout(timer);
				resolveEndpoint(m[1]);
			}
		};
		proc.stderr?.on('data', scan);
		proc.stdout?.on('data', scan);
		proc.on('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`Obsidian exited before exposing CDP (code ${code})`));
		});
	});
}

/** Find the connected page that actually hosts the vault workspace (not devtools/loader). */
async function waitForVaultPage(browser: Browser, timeoutMs: number): Promise<Page> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const pages = browser.contexts().flatMap((c) => c.pages());
		for (const p of pages) {
			const ready = await p
				.evaluate(() => !!document.querySelector('.workspace') && !!(window as any).app?.workspace)
				.catch(() => false);
			if (ready) return p;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error('Obsidian vault window did not appear within timeout (vault registry may not have been honored)');
}

/** Wait until the smartmemory plugin instance is registered and loaded. */
async function waitForPluginLoaded(page: Page, timeoutMs = 30_000): Promise<void> {
	await page.waitForFunction(
		() => {
			const plugins = (window as any).app?.plugins;
			return !!plugins?.plugins?.smartmemory && plugins.enabledPlugins?.has?.('smartmemory');
		},
		undefined,
		{ timeout: timeoutMs },
	);
}

function killProcessTree(proc: ChildProcess): void {
	try {
		proc.kill('SIGTERM');
	} catch {
		/* already gone */
	}
	// Belt-and-suspenders: Electron spawns helper processes; SIGTERM on the
	// parent usually cascades, but guard against stragglers on POSIX.
	if (proc.pid && process.platform !== 'win32') {
		try {
			process.kill(-proc.pid, 'SIGTERM');
		} catch {
			/* no process group or already gone */
		}
	}
}

export { expect };
