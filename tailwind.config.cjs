/**
 * Tailwind config for the Obsidian plugin.
 *
 * The shared @smartmemory/graph component library uses Tailwind utility classes
 * (~150 unique). We scan its JSX sources at build time and emit only the used
 * classes into styles.css. The plugin's own TS files don't use Tailwind today
 * but are scanned anyway in case they grow into it.
 *
 * The whole stylesheet is wrapped under .smartmemory-graph-view so utilities
 * don't leak into the rest of Obsidian — see esbuild.config.mjs PostCSS step.
 */
const fs = require('fs');
const path = require('path');

// Resolve the graph library through node_modules (a symlink to the real
// checkout) so a build from an isolated git worktree scans the same sources as
// the main checkout. The sibling path is only a fallback, and a miss is loud:
// scanning nothing silently shrinks styles.css.
function graphSrcDir() {
	for (const candidate of [
		path.join(__dirname, 'node_modules/@smartmemory/graph'),
		path.join(__dirname, '../smart-memory-graph'),
	]) {
		const src = path.join(candidate, 'src');
		if (fs.existsSync(src)) return fs.realpathSync(src);
	}
	console.warn('[tailwind] WARNING: smart-memory-graph/src not found; styles.css will omit graph utility classes');
	return null;
}

const graphSrc = graphSrcDir();

module.exports = {
	content: [
		'./src/**/*.{ts,tsx,js,jsx}',
		...(graphSrc ? [path.join(graphSrc, '**/*.{js,jsx}')] : []),
	],
	theme: { extend: {} },
	plugins: [],
	corePlugins: {
		preflight: false, // Don't reset Obsidian's base styles
	},
};
