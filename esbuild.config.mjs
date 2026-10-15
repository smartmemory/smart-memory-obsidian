import esbuild from 'esbuild';
import process from 'process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { resolve } from 'path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import { buildSdk } from './scripts/build-sdk.mjs';

// Force single instances of React/ReactDOM/Cytoscape across the bundle.
// @smartmemory/graph is a file: dep with its own nested node_modules,
// which esbuild would otherwise treat as separate copies. Two React
// instances → duplicate dispatcher → "useState of null" at runtime.
// Two Cytoscape instances → layout extensions (cose-bilkent, cola,
// dagre) register on one but `cy.layout({name: 'cose-bilkent'})`
// silently falls back to grid on the other → all nodes stack at origin.
const reactDir = resolve('./node_modules/react');
const reactDomDir = resolve('./node_modules/react-dom');
// Cytoscape lives under @smartmemory/graph (its dep). Pin the path so
// the layout-extension registration in @smartmemory/graph's
// useCytoscape.js (cytoscape.use(coseBilkent)) and any other consumer
// share one cytoscape singleton.
const cytoscapeDir = resolve('./node_modules/@smartmemory/graph/node_modules/cytoscape');

const prod = process.argv[2] === 'production';
// A failed release build must not leave an older main.js looking publishable.
if (prod) rmSync('main.js', { force: true });

// Inject the manifest version at build time so main.ts can reference
// __SMARTMEMORY_VERSION__ in code that runs during onload(). Without this
// define, surfaceLoadState() throws a ReferenceError and the plugin fails
// to load.
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));

// ─── CSS pipeline ────────────────────────────────────────────────────────────
// Process src/graph.css with PostCSS (Tailwind + autoprefixer). Tailwind
// scans @smartmemory/graph's JSX sources via tailwind.config.cjs `content`
// and emits only the utilities actually used. Output is appended to the
// plugin's existing styles.css under a .smartmemory-graph-view scope so
// utility names don't leak into Obsidian's main UI.
async function buildGraphCss() {
	const input = readFileSync('src/graph.css', 'utf8');
	const result = await postcss([
		tailwindcss({ config: './tailwind.config.cjs' }),
		autoprefixer(),
	]).process(input, { from: 'src/graph.css', to: 'graph-utilities.css' });

	const scoped = `.smartmemory-graph-view {\n${result.css}\n}\n`;

	const baseStyles = existsSync('src/styles.base.css')
		? readFileSync('src/styles.base.css', 'utf8')
		: '';
	writeFileSync('styles.css', `${baseStyles}\n${scoped}`);
	console.log(`[esbuild] Wrote styles.css (${(scoped.length / 1024).toFixed(1)} KB scoped utilities + ${(baseStyles.length / 1024).toFixed(1)} KB base)`);
}

// ─── JS bundle ───────────────────────────────────────────────────────────────
let context;
let sdk;
try {
	sdk = prod ? buildSdk(process.cwd()) : null;
	context = await esbuild.context({
		entryPoints: ['src/main.ts'],
		bundle: true,
		external: ['obsidian', 'electron', '@codemirror/autocomplete', '@codemirror/collab', '@codemirror/commands', '@codemirror/language', '@codemirror/lint', '@codemirror/search', '@codemirror/state', '@codemirror/view', '@lezer/common', '@lezer/highlight', '@lezer/lr'],
		format: 'cjs',
		target: 'es2018',
		logLevel: 'info',
		sourcemap: prod ? false : 'inline',
		treeShaking: true,
		outfile: 'main.js',
		minify: prod,
		loader: { '.jsx': 'jsx' },
		jsx: 'automatic',
		banner: sdk ? { js: sdk.banner } : undefined,
		alias: {
			...sdk?.alias,
			'react': reactDir,
			'react-dom': reactDomDir,
			'react-dom/client': reactDomDir + '/client.js',
			'react/jsx-runtime': reactDir + '/jsx-runtime.js',
			'cytoscape': cytoscapeDir,
		},
		define: {
			__SMARTMEMORY_VERSION__: JSON.stringify(manifest.version),
			'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development'),
		},
	});

	await buildGraphCss();

	if (prod) {
		await context.rebuild();
	} else {
		await context.watch();
	}

} finally {
	if (prod) {
		try {
			if (context) await context.dispose();
		} finally {
			sdk?.cleanup();
		}
	}
}
