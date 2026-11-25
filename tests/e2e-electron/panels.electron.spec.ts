/**
 * panels.electron.spec.ts — DIST-OBSIDIAN-E2E-2 (Tier 2)
 *
 * Scenarios that only the real Obsidian runtime can verify — the 20% Tier 1's
 * jsdom polyfill cannot reach: command registration, panel reveal in the real
 * right sidebar, and the active-leaf-change refresh path against the real
 * Workspace (the exact path that shipped broken for ~2 weeks under Tier 1).
 */
import { test, expect } from './obsidian-app';

const DECISIONS_VIEW = 'smartmemory-decisions';
// The view's content pane specifically — `[data-type=...]` alone also matches
// the tab header, so scope to .workspace-leaf-content.
const DECISIONS_CONTENT = `.workspace-leaf-content[data-type="${DECISIONS_VIEW}"]`;

test('core plugin commands are registered in the command palette', async ({ obsidian }) => {
	const ids = await obsidian.commandIds();
	for (const expected of [
		'smartmemory:open-decisions-panel',
		'smartmemory:open-lineage-panel',
		'smartmemory:open-supersessions-panel',
		'smartmemory:recall-current-note',
		'smartmemory:ingest-current-note',
	]) {
		expect(ids, `command ${expected} should be registered`).toContain(expected);
	}
});

test('decisions panel reveals as a leaf in the right sidebar', async ({ obsidian }) => {
	await obsidian.openNote('Decisions Source.md');
	await obsidian.runCommand('open-decisions-panel');

	await expect
		.poll(
			() =>
				obsidian.page.evaluate(
					(viewType) => (window as any).app.workspace.getLeavesOfType(viewType).length,
					DECISIONS_VIEW,
				),
			{ timeout: 10_000, message: 'a smartmemory-decisions leaf should be open' },
		)
		.toBeGreaterThan(0);

	// And its content container is mounted in the real DOM.
	await expect(obsidian.page.locator(DECISIONS_CONTENT)).toBeVisible();
});

test('panel renders mock-backed rows for the active note and refreshes on note switch', async ({ obsidian }) => {
	// Open the mapped note, then reveal the panel.
	await obsidian.openNote('Decisions Source.md');
	await obsidian.runCommand('open-decisions-panel');

	// Backbone assertion: the SDK call carried the active note's memory id.
	await expect
		.poll(() => obsidian.mockRequests.some((r) => r.query.provenance_memory_id === 'mem-decisions-001'), {
			timeout: 10_000,
			message: 'panel should call the backend with mem-decisions-001 for the first note',
		})
		.toBe(true);

	// Content assertion: the canned decision for that id is rendered in real Obsidian.
	await expect(obsidian.page.locator(DECISIONS_CONTENT)).toContainText('FalkorDB', {
		timeout: 10_000,
	});

	// Switch the active note — the real Workspace must fire active-leaf-change,
	// the panel must re-derive the id and re-call the backend.
	await obsidian.openNote('Lineage Source.md');

	await expect
		.poll(() => obsidian.mockRequests.some((r) => r.query.provenance_memory_id === 'mem-lineage-001'), {
			timeout: 10_000,
			message: 'panel should re-call the backend with mem-lineage-001 after switching notes',
		})
		.toBe(true);

	// And the rendered content updated to the new note's decision.
	await expect(obsidian.page.locator(DECISIONS_CONTENT)).toContainText('chunk conversations', {
		timeout: 10_000,
	});
});
