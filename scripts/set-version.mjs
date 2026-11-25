#!/usr/bin/env node
/**
 * The plugin version follows the SmartMemory core release it ships with
 * (OBSIDIAN-RELEASE-SYNC-SUBMIT-1). Replaces the old per-commit patch bump.
 *
 *   node scripts/set-version.mjs 2.0.7   set manifest.json, package.json and
 *                                        versions.json to 2.0.7
 *   node scripts/set-version.mjs --check exit 1 unless the three agree
 *                                        (run by the pre-commit hook)
 *
 * Obsidian installs the GitHub release whose tag equals manifest.json
 * `version` exactly (x.y.z, no `v`), and reads versions.json to map each
 * plugin version to its minAppVersion.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = (f) => join(root, f);
const read = (f) => readFileSync(path(f), 'utf8');
const json = (f) => JSON.parse(read(f));
const SEMVER = /^\d+\.\d+\.\d+$/;

export function check() {
	const manifest = json('manifest.json');
	const pkg = json('package.json');
	const versions = json('versions.json');
	const problems = [];
	if (!SEMVER.test(manifest.version)) problems.push(`manifest.json version "${manifest.version}" is not x.y.z`);
	if (pkg.version !== manifest.version) problems.push(`package.json ${pkg.version} != manifest.json ${manifest.version}`);
	if (versions[manifest.version] !== manifest.minAppVersion) {
		problems.push(`versions.json["${manifest.version}"] is ${JSON.stringify(versions[manifest.version])}, expected "${manifest.minAppVersion}"`);
	}
	return problems;
}

// Replace only the "version" value so the files keep their formatting.
function setVersionField(file, version) {
	const text = read(file);
	const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
	if (next === text && json(file).version !== version) throw new Error(`no "version" field in ${file}`);
	writeFileSync(path(file), next);
}

export function setVersion(version) {
	if (!SEMVER.test(version)) throw new Error(`version must be x.y.z with no "v": got "${version}"`);
	const manifest = json('manifest.json');
	setVersionField('manifest.json', version);
	setVersionField('package.json', version);
	const versions = json('versions.json');
	if (versions[version] !== manifest.minAppVersion) {
		versions[version] = manifest.minAppVersion;
		writeFileSync(path('versions.json'), JSON.stringify(versions, null, '\t') + '\n');
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const arg = process.argv[2];
	if (arg === '--check') {
		const problems = check();
		for (const p of problems) console.error(`[set-version] ${p}`);
		if (problems.length) {
			console.error('[set-version] fix with: node scripts/set-version.mjs <core version>');
			process.exit(1);
		}
	} else if (arg) {
		setVersion(arg);
		console.log(`[set-version] manifest.json, package.json, versions.json -> ${arg}`);
	} else {
		console.error('usage: node scripts/set-version.mjs <x.y.z> | --check');
		process.exit(2);
	}
}
