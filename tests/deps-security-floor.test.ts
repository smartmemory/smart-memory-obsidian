// @vitest-environment node
// DEPS-SEC-OBSIDIAN-1: the build toolchain must not be declared or installed below the
// version that clears its published advisories. One row per (package, check); no backend.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.cwd();
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));

// Lowest version of a plain ^/~/exact range ("^0.25.0" -> [0,25,0]). Anything else is refused.
function lowerBound(range: string): number[] {
	const m = /^[\^~]?(\d+)\.(\d+)\.(\d+)$/.exec(range);
	if (!m) throw new Error(`unsupported range syntax: ${range}`);
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function atLeast(version: number[], floor: number[]): boolean {
	for (let i = 0; i < 3; i++) {
		if (version[i] !== floor[i]) return version[i] > floor[i];
	}
	return true;
}

// floor = first version that clears every advisory (DEPS-AUDIT-1 section 1).
// check: where the version is read from.
const rows = [
	{ pkg: 'postcss', floor: '8.5.23', check: 'declared', severity: 'HIGH' },
	{ pkg: 'esbuild', floor: '0.25.0', check: 'declared', severity: 'MODERATE' },
	{ pkg: 'postcss', floor: '8.5.23', check: 'installed', severity: 'HIGH' },
	{ pkg: 'esbuild', floor: '0.25.0', check: 'installed', severity: 'MODERATE' },
] as const;

describe('security-floor versions of the build toolchain', () => {
	it.each(rows.map((r) => [`${r.check} ${r.pkg} >= ${r.floor} (${r.severity})`, r] as const))('%s', (_name, row) => {
		const floor = lowerBound(row.floor);
		if (row.check === 'declared') {
			const range = manifest.devDependencies?.[row.pkg];
			expect(range, `${row.pkg} missing from devDependencies`).toBeTypeOf('string');
			expect(atLeast(lowerBound(range), floor), `${row.pkg} range ${range} admits versions below ${row.floor}`).toBe(true);
			return;
		}
		const installedPath = join(repo, 'node_modules', row.pkg, 'package.json');
		if (!existsSync(installedPath)) {
			console.warn(`[deps-security-floor] WARNING: no installed ${row.pkg} at ${installedPath}, installed-version row not checked. Run npm install.`);
			return;
		}
		const installed = JSON.parse(readFileSync(installedPath, 'utf8')).version as string;
		expect(atLeast(lowerBound(installed), floor), `installed ${row.pkg}@${installed} is below ${row.floor}`).toBe(true);
	});
});

// DEPS-SEC-FLOOR-GUARD-CLASS-1: lowerBound() already refuses every range form that could admit a version
// below the floor (operators, prerelease, `||` arms). Pin that: one row per repro, each must throw.
describe('lowerBound refuses ranges that can admit versions below the floor', () => {
	const unsafe = ['<6.4.3', '<=6.4.3', '^4.1.11-rc.0', '4.1.11-beta.0', '^4.1.12 || 4.0.18', '>=4.1.11 <5', '4.1.x', '*', '>4.1.10', 'latest', ''];
	it.each(unsafe.map((r) => [r] as const))('%j is unsupported', (range) => {
		expect(() => lowerBound(range)).toThrow(/unsupported range syntax/);
	});

	const safe = [['^4.10.0', [4, 10, 0]], ['~4.1.11', [4, 1, 11]], ['4.1.11', [4, 1, 11]]] as const;
	it.each(safe)('%s parses to its own lower bound', (range, expected) => {
		expect(lowerBound(range)).toEqual([...expected]);
	});

	it('an installed prerelease is refused rather than compared as its release', () => {
		expect(() => lowerBound('6.4.3-beta.0')).toThrow(/unsupported range syntax/);
	});
});
