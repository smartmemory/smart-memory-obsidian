import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// OBSIDIAN-RELEASE-SYNC-SUBMIT-1: the plugin version follows the core release.
const repo = resolve(__dirname, '..');
const dirs: string[] = [];

function fixture(version = '2.0.6', versions: Record<string, string> = { '2.0.6': '1.5.0' }) {
	mkdirSync(join(repo, '.build'), { recursive: true });
	const dir = mkdtempSync(join(repo, '.build', 'set-version-'));
	dirs.push(dir);
	mkdirSync(join(dir, 'scripts'));
	copyFileSync(join(repo, 'scripts/set-version.mjs'), join(dir, 'scripts/set-version.mjs'));
	writeFileSync(join(dir, 'manifest.json'), `{\n\t"id": "smartmemory",\n\t"version": "${version}",\n\t"minAppVersion": "1.5.0"\n}\n`);
	writeFileSync(join(dir, 'package.json'), `{\n\t"name": "x",\n\t"version": "${version}",\n\t"dependencies": { "y": "1.0.0" }\n}\n`);
	writeFileSync(join(dir, 'versions.json'), JSON.stringify(versions, null, '\t') + '\n');
	return dir;
}
const run = (dir: string, arg: string) => spawnSync('node', [join(dir, 'scripts/set-version.mjs'), arg], { encoding: 'utf8' });
const read = (dir: string, f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));

afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('set-version', () => {
	it('sets all three files to the core version and keeps old versions.json rows', () => {
		const dir = fixture();
		execFileSync('node', [join(dir, 'scripts/set-version.mjs'), '2.0.7']);
		expect(read(dir, 'manifest.json').version).toBe('2.0.7');
		expect(read(dir, 'package.json').version).toBe('2.0.7');
		expect(read(dir, 'package.json').dependencies.y).toBe('1.0.0');
		expect(read(dir, 'versions.json')).toEqual({ '2.0.6': '1.5.0', '2.0.7': '1.5.0' });
		expect(run(dir, '--check').status).toBe(0);
	});

	it('refuses a v-prefixed or non x.y.z version', () => {
		const dir = fixture();
		expect(run(dir, 'v2.0.7').status).not.toBe(0);
		expect(run(dir, '2.0.7-rc1').status).not.toBe(0);
		expect(read(dir, 'manifest.json').version).toBe('2.0.6');
	});

	it('check fails when versions.json lacks the manifest version', () => {
		const dir = fixture('2.0.6', { '0.2.20': '1.5.0' });
		const r = run(dir, '--check');
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('versions.json["2.0.6"]');
	});

	it('the repo itself passes the check', () => {
		expect(spawnSync('node', ['scripts/set-version.mjs', '--check'], { cwd: repo }).status).toBe(0);
	});
});
