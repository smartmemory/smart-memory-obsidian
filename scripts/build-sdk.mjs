import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Build a disposable source snapshot. Never run tooling in the input checkout. */
export function buildSdk(pluginDir) {
	const source = resolve(process.env.SMARTMEMORY_SDK_PATH || join(pluginDir, '../smart-memory-sdk-js'));
	if (!existsSync(join(source, 'package.json'))) {
		throw new Error(`SDK checkout missing at ${source}. Set SMARTMEMORY_SDK_PATH to smart-memory-sdk-js.`);
	}
	function git(...args) {
		try {
			return execFileSync('git', ['--no-optional-locks', '-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
		} catch (error) {
			throw new Error(`SDK git metadata unavailable at ${source}: ${error.message}`);
		}
	}
	// Reject a plain directory nested in another repository: its SHA is not the SDK's.
	if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(source)) {
		throw new Error(`SDK checkout at ${source} must be its own git repository.`);
	}
	const gitSha = git('rev-parse', 'HEAD');
	const dirty = git('status', '--porcelain', '--untracked-files=all').length > 0;
	if (!existsSync(join(source, 'node_modules'))) {
		throw new Error(`SDK build dependencies missing at ${source}. Run npm install --ignore-scripts --no-package-lock in the SDK checkout first.`);
	}
	const scratch = resolve(process.env.SMARTMEMORY_BUILD_SCRATCH || join(pluginDir, '.build'));
	mkdirSync(scratch, { recursive: true });
	const dir = mkdtempSync(join(scratch, 'plugin-sdk-'));
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	try {
		// Include tracked edits and untracked source, but never ignored dist or caches.
		const files = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
		for (const file of files) {
			if (/^(node_modules|dist)(\/|$)/.test(file)) continue;
			const target = join(dir, file);
			mkdirSync(dirname(target), { recursive: true });
			cpSync(join(source, file), target, { dereference: true });
		}
		// A private dependency copy also keeps Vite's config cache off the input checkout.
		cpSync(realpathSync(join(source, 'node_modules')), join(dir, 'node_modules'), {
			recursive: true, verbatimSymlinks: true,
		});
		console.log(`[SDK] Rebuilding git=${gitSha} dirty=${dirty}`);
		const result = spawnSync('npm', ['run', 'build'], { cwd: dir, stdio: 'inherit' });
		if (result.error || result.status !== 0) {
			throw new Error(`SDK build failed for ${source}: ${result.error?.message || `exit ${result.status}, signal ${result.signal}`}`);
		}
		const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
		// Resolve both legacy plugin imports and scoped graph-library imports to this build.
		const alias = {};
		for (const [subpath, entry] of Object.entries(pkg.exports)) {
			const output = typeof entry === 'string' ? entry : entry.default;
			if (!output?.startsWith('./dist/') || !existsSync(join(dir, output))) {
				throw new Error(`SDK build failed: missing dist export ${subpath} (${output}) in ${source}.`);
			}
			const suffix = subpath === '.' ? '' : subpath.slice(1);
			alias[`smartmemory-sdk-js${suffix}`] = join(dir, output);
			alias[`@smartmemory/sdk-js${suffix}`] = join(dir, output);
		}
		return { alias, banner: `// SmartMemory SDK git=${gitSha} dirty=${dirty}`, cleanup };
	} catch (error) {
		cleanup();
		throw new Error(`SDK build failed for ${source}: ${error.message}`, { cause: error });
	}
}
