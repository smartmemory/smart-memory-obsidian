/**
 * Vitest mock of the Obsidian API surface used by the plugin.
 *
 * Scope: enough to mount panels under jsdom + vitest and assert their
 * rendered DOM. Production code paths get an extended `HTMLElement` with
 * `createDiv`/`createEl`/`createSpan`/`empty`/`addClass` at runtime via
 * Obsidian's prototype patching; we polyfill the same methods here on
 * `globalThis.HTMLElement.prototype` so panel code under test sees the
 * exact same surface.
 *
 * Filed under DIST-OBSIDIAN-E2E-1 — Tier 1 (jsdom panel-rendering harness).
 * Tier 2 (real Obsidian Electron drive-the-app E2E) is out of scope here.
 */

// ---------------------------------------------------------------------------
// Polyfill Obsidian-flavored HTMLElement helpers onto jsdom's HTMLElement.
// ---------------------------------------------------------------------------

interface ElementOpts {
	cls?: string | string[];
	text?: string;
	href?: string;
	attr?: Record<string, string>;
}

function applyOpts(el: HTMLElement, opts?: ElementOpts): void {
	if (!opts) return;
	if (opts.cls) {
		const classes = Array.isArray(opts.cls) ? opts.cls : opts.cls.split(/\s+/).filter(Boolean);
		for (const c of classes) el.classList.add(c);
	}
	if (typeof opts.text === 'string') el.textContent = opts.text;
	if (typeof opts.href === 'string') (el as HTMLAnchorElement).href = opts.href;
	if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
}

// Only polyfill once. In a jsdom environment, HTMLElement is the global.
const HE = (globalThis as any).HTMLElement;
if (HE && !(HE.prototype as any).__sm_obsidian_polyfilled) {
	HE.prototype.createEl = function (tag: string, opts?: ElementOpts): HTMLElement {
		const child = (this as HTMLElement).ownerDocument!.createElement(tag);
		applyOpts(child, opts);
		(this as HTMLElement).appendChild(child);
		return child;
	};
	HE.prototype.createDiv = function (opts?: ElementOpts | string): HTMLElement {
		const normalized = typeof opts === 'string' ? { cls: opts } : opts;
		return (this as any).createEl('div', normalized);
	};
	HE.prototype.createSpan = function (opts?: ElementOpts | string): HTMLElement {
		const normalized = typeof opts === 'string' ? { cls: opts } : opts;
		return (this as any).createEl('span', normalized);
	};
	HE.prototype.empty = function (): void {
		const self = this as HTMLElement;
		while (self.firstChild) self.removeChild(self.firstChild);
	};
	HE.prototype.addClass = function (cls: string): void {
		(this as HTMLElement).classList.add(cls);
	};
	HE.prototype.removeClass = function (cls: string): void {
		(this as HTMLElement).classList.remove(cls);
	};
	HE.prototype.toggleClass = function (cls: string, on?: boolean): void {
		if (typeof on === 'boolean') (this as HTMLElement).classList.toggle(cls, on);
		else (this as HTMLElement).classList.toggle(cls);
	};
	HE.prototype.setText = function (text: string): void {
		(this as HTMLElement).textContent = text;
	};
	(HE.prototype as any).__sm_obsidian_polyfilled = true;
}

/** Convenience for tests that want a fresh detached root element. */
export function newDom(): HTMLElement {
	const root = document.createElement('div');
	document.body.appendChild(root);
	return root;
}

// ---------------------------------------------------------------------------
// Obsidian class stubs.
// ---------------------------------------------------------------------------

export interface RequestUrlResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
	json: any;
	arrayBuffer: ArrayBuffer;
}

export interface RequestUrlParam {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	contentType?: string;
	throw?: boolean;
}

export const requestUrl = async (_param: RequestUrlParam): Promise<RequestUrlResponse> => {
	throw new Error('requestUrl mock not configured — use vi.mocked(requestUrl).mockResolvedValue(...)');
};

export class Plugin {
	app: any;
	manifest: any;
	async onload(): Promise<void> {}
	onunload(): void {}
	addCommand(_cmd: any): void {}
	registerView(_type: string, _factory: any): void {}
	registerEvent(_ref: any): void {}
}

export class PluginSettingTab {
	app: any;
	plugin: any;
	containerEl: any;
}

/**
 * ItemView stub with a real two-child containerEl (header + content),
 * matching what Obsidian's runtime provides. The panel base reads
 * `this.containerEl.children[1]` so two children must exist.
 */
export class ItemView {
	containerEl: HTMLElement;
	leaf: any;
	private _registeredEvents: any[] = [];

	constructor(leaf?: any) {
		this.leaf = leaf;
		this.containerEl = document.createElement('div');
		// children[0] = header, children[1] = content (Obsidian convention).
		this.containerEl.appendChild(document.createElement('div'));
		this.containerEl.appendChild(document.createElement('div'));
	}

	getViewType(): string { return ''; }
	getDisplayText(): string { return ''; }
	getIcon(): string { return ''; }

	registerEvent(ref: any): void {
		this._registeredEvents.push(ref);
	}
}

export class WorkspaceLeaf {
	view: any;
}

export const MarkdownView = class {
	editor: any;
};

export class Modal {
	app: any;
	contentEl: any;
	constructor(app: any) {
		this.app = app;
		this.contentEl = document.createElement('div');
	}
	open(): void { void (this as any).onOpen?.(); }
	close(): void { (this as any).onClose?.(); }
}

export class TAbstractFile {
	path: string = '';
}

export class TFile extends TAbstractFile {
	extension: string = 'md';
	parent: TFolder | null = null;
	basename: string = '';
}

export class TFolder {
	path: string = '';
	children: Array<TFile | TFolder> = [];
}

export class Notice {
	static lastMessage: string | null = null;
	constructor(msg: string) {
		Notice.lastMessage = msg;
	}
}
