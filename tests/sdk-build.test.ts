// @vitest-environment node
// Removing the SDK rebuild or resolving either SDK name from node_modules must
// fail this real production-build regression. No HTTP/backend is involved.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

const repo = process.cwd();
const sourceSdk = resolve(process.env.SMARTMEMORY_SDK_PATH || join(repo, '../smart-memory-sdk-js'));
const scratch = resolve(process.env.SMARTMEMORY_BUILD_SCRATCH || join(repo, '.build'));
// Needs a sibling SDK checkout with node_modules; without one, skip loudly instead of failing in setup.
const sdkAvailable = existsSync(join(sourceSdk, 'package.json')) && existsSync(join(sourceSdk, 'node_modules'));
if (!sdkAvailable) {
	console.warn(`[sdk-build] WARNING: skipping production-build regression tests, no SDK checkout with node_modules at ${sourceSdk}. Set SMARTMEMORY_SDK_PATH to run them.`);
}
let root: string;
let plugin: string;
let sdk: string;
const env = Object.fromEntries(Object.entries(process.env).map(([key, value]) =>
	[key, /KEY|TOKEN|SECRET|PASSWORD/i.test(key) ? '' : value]));
function build(sdkPath = sdk) {
	return spawnSync('npm', ['run', 'build'], {
		cwd: plugin, encoding: 'utf8', timeout: 120_000,
		env: { ...env, SMARTMEMORY_SDK_PATH: sdkPath, SMARTMEMORY_BUILD_SCRATCH: join(root, 'build') },
	});
}
function output(result: ReturnType<typeof build>) { return result.stdout + result.stderr; }

describe.skipIf(!sdkAvailable)('production SDK build', () => {
beforeAll(() => {
	mkdirSync(scratch, { recursive: true });
	root = mkdtempSync(join(scratch, 'test_plugin_repro_'));
	plugin = join(root, 'plugin');
	sdk = join(root, 'smart-memory-sdk-js');
	mkdirSync(plugin);
	// Copy the real SDK, preserving git history for provenance checks.
	execFileSync('git', ['clone', '-q', '--local', '--no-hardlinks', sourceSdk, sdk]);
	cpSync(realpathSync(join(sourceSdk, 'node_modules')), join(sdk, 'node_modules'), {
		recursive: true, verbatimSymlinks: true,
	});
	// Make an actual older dist with the real compiler. No existing source dist is required.
	const seed = spawnSync('npm', ['run', 'build'], { cwd: sdk, env, encoding: 'utf8', timeout: 120_000 });
	expect(seed.status, seed.stdout + seed.stderr).toBe(0);
	const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8' }).split('\0').filter(Boolean);
	for (const file of files) {
		mkdirSync(dirname(join(plugin, file)), { recursive: true });
		cpSync(join(repo, file), join(plugin, file));
	}
	mkdirSync(join(plugin, 'node_modules'));
	for (const name of readdirSync(join(repo, 'node_modules'))) {
		if (name !== 'smartmemory-sdk-js') symlinkSync(join(repo, 'node_modules', name), join(plugin, 'node_modules', name));
	}
	symlinkSync(sdk, join(plugin, 'node_modules/smartmemory-sdk-js'), 'dir');
}, 120_000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

it('records the clean SDK commit in the production bundle', () => {
	const index = join(sdk, '.git/index');
	const indexMtime = statSync(index).mtimeMs;
	const clean = build('');
	expect(clean.status, output(clean)).toBe(0);
	expect(statSync(index).mtimeMs, 'provenance reads must not refresh the SDK git index').toBe(indexMtime);
	const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sdk, encoding: 'utf8' }).trim();
	expect(readFileSync(join(plugin, 'main.js'), 'utf8').split('\n')[0]).toContain(`SDK git=${sha} dirty=false`);
}, 120_000);

it('replaces older dist with fresh SDK source and records dirty provenance', () => {
	const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sdk, encoding: 'utf8' }).trim();
	const client = join(sdk, 'src/api/SmartMemoryClient.js');
	writeFileSync(client, readFileSync(client, 'utf8').replace('constructor(config) {', 'constructor(config) {\n    this.__pluginReproProbe = "PLUGIN_REPRO_FRESH_SOURCE";'));
	const progress = join(sdk, 'src/progress.ts');
	writeFileSync(progress, 'console.log("PLUGIN_REPRO_FRESH_PROGRESS");\n' + readFileSync(progress, 'utf8'));
	const oldCore = join(sdk, 'dist/core.js');
	writeFileSync(oldCore, 'console.log("PLUGIN_REPRO_STALE_DIST");\n' + readFileSync(oldCore, 'utf8'));
	const before = readFileSync(oldCore, 'utf8');
	const fresh = build();
	expect(fresh.status, output(fresh)).toBe(0);
	const bundle = readFileSync(join(plugin, 'main.js'), 'utf8');
	expect(bundle.includes('PLUGIN_REPRO_FRESH_SOURCE'), 'fresh SDK source must reach the bundle').toBe(true);
	expect(bundle.includes('PLUGIN_REPRO_FRESH_PROGRESS'), 'scoped SDK import must use the same fresh build').toBe(true);
	expect(bundle.includes('PLUGIN_REPRO_STALE_DIST')).toBe(false);
	expect(bundle.split('\n')[0]).toContain(`SDK git=${sha} dirty=true`);
	// The input checkout is read-only, including its intentionally old dist.
	expect(readFileSync(oldCore, 'utf8')).toBe(before);
	expect(readdirSync(join(root, 'build'))).toEqual([]);
	console.log(`stale-dist: fresh core=true, fresh scoped progress=true, stale=false, input unchanged=true; SDK git=${sha} dirty=true`);
}, 120_000);

it('builds a dirty SDK tree with a tracked file deleted and warns about it', () => {
	// Mid-refactor SDK trees delete tracked files; the snapshot must skip them, not ENOENT.
	const gone = 'README.md';
	expect(execFileSync('git', ['ls-files', gone], { cwd: sdk, encoding: 'utf8' }).trim(), 'SDK must track README.md').toBe(gone);
	rmSync(join(sdk, gone));
	const result = build();
	expect(result.status, output(result)).toBe(0);
	expect(output(result)).toContain(`skipping tracked file deleted from the working tree: ${gone}`);
	expect(readFileSync(join(plugin, 'main.js'), 'utf8').split('\n')[0]).toContain('dirty=true');
}, 120_000);

it.each([
	['missing checkout', 'missing'],
	['SDK build fail', 'broken'],
])('fails loudly on %s and leaves no release bundle', (message, mode) => {
	let sdkPath = join(root, 'missing');
	if (mode === 'broken') {
		sdkPath = sdk;
		writeFileSync(join(sdk, 'src/core.js'), 'export const = invalid JavaScript;');
	}
	writeFileSync(join(plugin, 'main.js'), '// old release bundle');
	const result = build(sdkPath);
	expect(result.status, output(result)).not.toBe(0);
	expect(output(result)).toMatch(mode === 'missing' ? /SDK.*missing|missing.*SDK/i : /SDK build fail/i);
	expect(existsSync(join(plugin, 'main.js'))).toBe(false);
	if (existsSync(join(root, 'build'))) expect(readdirSync(join(root, 'build'))).toEqual([]);
}, 120_000);
});
