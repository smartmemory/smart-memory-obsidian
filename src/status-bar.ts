import type { ConnectionStatus } from './types';

export interface StatusBarActions {
	onIngest?: () => void;
	onSearch?: () => void;
	onSettings?: () => void;
	onUpgrade?: () => void;
}

export class StatusBarController {
	private el: HTMLElement;
	private status: ConnectionStatus = 'disconnected';
	private memoryCount: number = 0;
	private memoryLimit: number | null = null;
	private lastSync: Date | null = null;
	private actions: StatusBarActions = {};
	/** Bound so it can be removed in dispose(). */
	private readonly openHandler: () => void;
	/** The document-level outside-click dismiss listener, while a menu is open. */
	private dismissHandler: ((evt: MouseEvent) => void) | null = null;
	/** Pending setTimeout that arms the dismiss listener, so dispose can cancel it. */
	private menuTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(el: HTMLElement) {
		this.el = el;
		this.el.addClass('smartmemory-status-bar');
		this.openHandler = () => this.openMenu();
		this.el.addEventListener('click', this.openHandler);
		this.render();
	}

	/**
	 * Tear down all listeners and any open menu. MUST be called from the
	 * plugin's onunload — otherwise an open menu leaves a document-level click
	 * listener (and a detached body element) dangling past unload.
	 */
	dispose(): void {
		this.el.removeEventListener('click', this.openHandler);
		this.closeMenu();
	}

	/** Remove the popup menu, its document listener, and any pending arm timer. */
	private closeMenu(): void {
		if (this.menuTimer !== null) {
			clearTimeout(this.menuTimer);
			this.menuTimer = null;
		}
		document.querySelector('.smartmemory-status-menu')?.remove();
		if (this.dismissHandler) {
			document.removeEventListener('click', this.dismissHandler, true);
			this.dismissHandler = null;
		}
	}

	setActions(actions: StatusBarActions): void {
		this.actions = actions;
	}

	setStatus(status: ConnectionStatus): void {
		this.status = status;
		this.render();
	}

	setCount(count: number, limit: number | null = null): void {
		this.memoryCount = count;
		this.memoryLimit = limit;
		this.render();
	}

	setLastSync(date: Date): void {
		this.lastSync = date;
		this.render();
	}

	private openMenu(): void {
		// Simple toggle menu rendered as a popup attached to the status bar.
		// We avoid Obsidian's Menu API here to keep the footprint small;
		// host plugin can wire actions in via setActions().
		const existing = document.querySelector('.smartmemory-status-menu');
		if (existing) {
			// Toggle off — and remove the dismiss listener/timer too, not just
			// the element, so a re-open doesn't accumulate dangling listeners.
			this.closeMenu();
			return;
		}

		const menu = document.body.createDiv({ cls: 'smartmemory-status-menu' });
		const rect = this.el.getBoundingClientRect();
		menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
		menu.style.right = `${window.innerWidth - rect.right}px`;

		const addItem = (label: string, fn?: () => void) => {
			if (!fn) return;
			const item = menu.createDiv({ cls: 'smartmemory-status-menu-item', text: label });
			item.addEventListener('click', () => {
				menu.remove();
				fn();
			});
		};

		addItem('Ingest current note', this.actions.onIngest);
		addItem('Search', this.actions.onSearch);
		addItem('Settings', this.actions.onSettings);
		if (this.memoryLimit !== null && this.memoryCount >= this.memoryLimit * 0.8) {
			addItem('Upgrade to remove free tier limit', this.actions.onUpgrade);
		}

		// Click outside to dismiss. Check both the menu and the status bar
		// element so clicking the dot/text spans inside the bar doesn't
		// dismiss-then-reopen on the same bubbled click.
		const dismiss = (evt: MouseEvent) => {
			const target = evt.target as Node;
			if (!menu.contains(target) && !this.el.contains(target)) {
				this.closeMenu();
			}
		};
		this.dismissHandler = dismiss;
		this.menuTimer = setTimeout(() => {
			this.menuTimer = null;
			document.addEventListener('click', dismiss, true);
		}, 0);
	}

	private render(): void {
		this.el.empty();
		this.el.setAttribute('role', 'button');
		this.el.setAttribute('tabindex', '0');

		const dotColor = {
			connected: 'green',
			disconnected: 'red',
			syncing: 'orange',
		}[this.status];

		const dot = this.el.createSpan({ cls: 'smartmemory-status-dot' });
		dot.style.color = dotColor;
		dot.setText('●');
		// Color is the visual signal but screen readers need text
		dot.setAttribute('aria-label', `SmartMemory ${this.status}`);
		dot.setAttribute('role', 'status');

		const text = this.el.createSpan({ cls: 'smartmemory-status-text' });

		if (this.status === 'disconnected') {
			text.setText(' SmartMemory: disconnected');
			return;
		}

		const countDisplay = this.memoryLimit !== null
			? `${this.memoryCount}/${this.memoryLimit} (free tier)`
			: `${this.memoryCount} memories`;
		text.setText(` SmartMemory: ${countDisplay}`);

		if (this.lastSync) {
			const ago = formatRelativeTime(this.lastSync);
			this.el.createSpan({ cls: 'smartmemory-status-sync', text: ` · synced ${ago}` });
		}
	}
}

function formatRelativeTime(date: Date): string {
	const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
	if (seconds < 60) return 'just now';
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}
