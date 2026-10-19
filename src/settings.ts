import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type SmartMemoryPlugin from './main';
import { LITE_DAEMON_URL } from './types';

const TEXT_DEBOUNCE_MS = 500;

export class SmartMemorySettingTab extends PluginSettingTab {
	plugin: SmartMemoryPlugin;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	/** Tracks an in-flight saveSettings() launched by the debounce timer
	 *  so flushPendingSave() can wait for it to complete before testing. */
	private inFlightSave: Promise<void> | null = null;

	constructor(app: App, plugin: SmartMemoryPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide(): void {
		// Flush any pending text debounce when leaving the settings tab.
		// Track the save in inFlightSave (like debouncedSave/flushPendingSave)
		// so a concurrent flush can await it, and catch failures so a rejected
		// save doesn't surface as an unhandled rejection.
		if (this.saveTimer !== null) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
			this.inFlightSave = this.plugin.saveSettings()
				.catch((err) => {
					new Notice(`SmartMemory: failed to save settings — ${err instanceof Error ? err.message : String(err)}`);
				})
				.finally(() => {
					this.inFlightSave = null;
				});
		}
	}

	private debouncedSave(): void {
		if (this.saveTimer !== null) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			this.inFlightSave = this.plugin.saveSettings().finally(() => {
				this.inFlightSave = null;
			});
		}, TEXT_DEBOUNCE_MS);
	}

	private async flushPendingSave(): Promise<void> {
		// Case 1: a debounce timer is queued — fire it now and await
		if (this.saveTimer !== null) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
			this.inFlightSave = this.plugin.saveSettings().finally(() => {
				this.inFlightSave = null;
			});
		}
		// Case 2: a debounce-triggered save is already in-flight — await it
		if (this.inFlightSave) {
			await this.inFlightSave;
		}
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'SmartMemory' });

		const securityWarning = containerEl.createDiv({ cls: 'smartmemory-warning' });
		securityWarning.setText(
			'Your API key is stored locally in plaintext. If you sync your vault via git, ' +
			'add `.obsidian/plugins/smartmemory/data.json` to `.gitignore`.'
		);

		// Auth
		containerEl.createEl('h3', { text: 'Connection' });

		// DIST-OBSIDIAN-LITE-1: Cloud / Lite mode radio
		new Setting(containerEl)
			.setName('Mode')
			.setDesc('Cloud uses api.smartmemory.ai (requires API key). Local runs against the smartmemory daemon on this machine (no key needed).')
			.addDropdown(dd => dd
				.addOption('cloud', 'Cloud')
				.addOption('lite', 'Local (lite)')
				.setValue(this.plugin.settings.mode)
				.onChange((value) => {
					const newMode = (value === 'lite' ? 'lite' : 'cloud') as 'cloud' | 'lite';
					const switching = this.plugin.settings.mode !== newMode;
					this.plugin.settings.mode = newMode;
					if (switching) {
						// Sensible defaults when toggling: lite → daemon URL,
						// cloud → hosted URL. Only overwrite if the user is on
						// the *other* mode's default (so a custom URL survives).
						if (newMode === 'lite' && this.plugin.settings.apiUrl === 'https://api.smartmemory.ai') {
							this.plugin.settings.apiUrl = LITE_DAEMON_URL;
						} else if (newMode === 'cloud' && this.plugin.settings.apiUrl === LITE_DAEMON_URL) {
							this.plugin.settings.apiUrl = 'https://api.smartmemory.ai';
						}
					}
					// Save synchronously so initClient() runs against the new mode
					// before the user can interact with the re-rendered tab. Using
					// debouncedSave here would orphan the timer when display()
					// rebuilds the dropdown, causing a double-save.
					void this.plugin.saveSettings();
					this.display();  // re-render so API key field hides/shows
				}));

		new Setting(containerEl)
			.setName('API URL')
			.setDesc(this.plugin.settings.mode === 'lite'
				? 'Local daemon endpoint. Default is http://127.0.0.1:9114, so start the daemon with SMARTMEMORY_DAEMON_PORT=9114.'
				: 'SmartMemory service endpoint')
			.addText(text => text
				.setPlaceholder(this.plugin.settings.mode === 'lite' ? LITE_DAEMON_URL : 'https://api.smartmemory.ai')
				.setValue(this.plugin.settings.apiUrl)
				.onChange((value) => {
					this.plugin.settings.apiUrl = value || (this.plugin.settings.mode === 'lite' ? LITE_DAEMON_URL : 'https://api.smartmemory.ai');
					this.debouncedSave();
				}));

		// API key field is hidden in lite mode — daemon has no auth, key is meaningless.
		if (this.plugin.settings.mode !== 'lite') {
			new Setting(containerEl)
				.setName('API key')
				.setDesc('Generate from your SmartMemory web UI. Or set SMARTMEMORY_API_KEY env var.')
				.addText(text => {
					text.setPlaceholder('sm_...')
						.setValue(this.plugin.settings.apiKey)
						.onChange((value) => {
							this.plugin.settings.apiKey = value;
							this.debouncedSave();
						});
					// Mask the secret while editing
					text.inputEl.type = 'password';
					text.inputEl.autocomplete = 'off';
				});
		} else {
			const liteHelp = containerEl.createDiv({ cls: 'setting-item' });
			liteHelp.createEl('div', {
				cls: 'setting-item-info',
				text: 'Local mode runs against smartmemory daemon on this machine — no API key required.',
			});
		}

		new Setting(containerEl)
			.setName('Test connection')
			.addButton(btn => btn
				.setButtonText('Test')
				.onClick(async () => {
					// Flush any pending debounced save so the client is reinitialized
					// against the freshly-edited settings before we test the connection.
					await this.flushPendingSave();
					const ok = await this.plugin.testConnection();
					new Notice(ok ? 'SmartMemory: connected' : 'SmartMemory: connection failed');
				}));

		// Advanced — workspace ID is auto-discovered from /auth/me on first
		// connect; only power users in multi-workspace tenants need to override.
		const advanced = containerEl.createEl('details', { cls: 'smartmemory-advanced' });
		advanced.createEl('summary', { text: 'Advanced' });
		new Setting(advanced)
			.setName('Workspace ID override')
			.setDesc('Leave blank to use the workspace your API key is bound to. Set only when you belong to multiple workspaces and want to target a non-default one.')
			.addText(text => {
				text.setPlaceholder('Auto-discovered')
					.setValue(this.plugin.settings.workspaceId)
					.onChange((value) => {
						this.plugin.settings.workspaceId = value.trim();
						this.debouncedSave();
					});
			});

		// Ingest
		containerEl.createEl('h3', { text: 'Ingest' });

		new Setting(containerEl)
			.setName('Auto-ingest on save')
			.setDesc('Automatically ingest notes after editing (debounced)')
			.addToggle(t => t
				.setValue(this.plugin.settings.autoIngestOnSave)
				.onChange(async (v) => {
					this.plugin.settings.autoIngestOnSave = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto-ingest on create')
			.setDesc('Ingest new notes when created')
			.addToggle(t => t
				.setValue(this.plugin.settings.autoIngestOnCreate)
				.onChange(async (v) => {
					this.plugin.settings.autoIngestOnCreate = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Exclude folders')
			.setDesc('Comma-separated path prefixes excluded from all note sends and edits (e.g. templates/, .obsidian/). Case-insensitive, including subfolders. Without a trailing /, an entry also matches sibling names that start with it. Add / to match only that folder and its subfolders.')
			.addText(text => text
				.setValue(this.plugin.settings.excludeFolders.join(','))
				.onChange((value) => {
					this.plugin.settings.excludeFolders = value.split(',').map(s => s.trim()).filter(Boolean);
					this.debouncedSave();
				}));

		// Frontmatter
		containerEl.createEl('h3', { text: 'Frontmatter' });

		this.addToggle(
			containerEl,
			'Keep notes OKF-conformant',
			'Writes native OKF type and resource fields. Resource links each note version to its SmartMemory item and is required for contextual panels and mapping recovery.',
			'okfConformance',
		);
		this.addToggle(
			containerEl,
			'Write SmartMemory OKF extension',
			'Adds optional extracted entities and typed graph edges under one nested smartmemory block. Existing unknown extension keys are preserved.',
			'writeSmartMemoryExtension',
		);

		// Suggestions
		containerEl.createEl('h3', { text: 'Inline Suggestions' });

		this.addToggle(containerEl, 'Enable inline suggestions', 'Show related-memory suggestions while typing (off by default)', 'inlineSuggestionsEnabled');

		new Setting(containerEl)
			.setName('Suggestion frequency')
			.setDesc('How aggressively to surface suggestions while typing')
			.addDropdown(d => d
				.addOption('aggressive', 'Aggressive (1s)')
				.addOption('balanced', 'Balanced (2s)')
				.addOption('minimal', 'Minimal (5s)')
				.setValue(this.plugin.settings.suggestionFrequency)
				.onChange(async (value) => {
					this.plugin.settings.suggestionFrequency = value as any;
					await this.plugin.saveSettings();
				}));

		// Contradiction detection
		containerEl.createEl('h3', { text: 'Contradiction Detection' });

		this.addToggle(containerEl, 'Show supersession banner', 'Warn when a note has been superseded', 'contradictionBannerEnabled');

		// Graph
		containerEl.createEl('h3', { text: 'Knowledge Graph' });

		new Setting(containerEl)
			.setName('Default hops')
			.setDesc('Default neighborhood depth for the graph pane')
			.addSlider(s => s
				.setLimits(1, 3, 1)
				.setValue(this.plugin.settings.graphDefaultHops)
				.setDynamicTooltip()
				.onChange(async (v) => {
					this.plugin.settings.graphDefaultHops = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Max nodes')
			.setDesc('Maximum nodes shown in the graph pane')
			.addText(text => text
				.setValue(String(this.plugin.settings.graphMaxNodes))
				.onChange((value) => {
					const n = parseInt(value, 10);
					if (!isNaN(n) && n > 0) {
						this.plugin.settings.graphMaxNodes = n;
						this.debouncedSave();
					}
				}));
	}

	private addToggle(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		key: keyof typeof this.plugin.settings,
	): void {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addToggle(t => t
				.setValue(this.plugin.settings[key] as boolean)
				.onChange(async (v) => {
					(this.plugin.settings as any)[key] = v;
					await this.plugin.saveSettings();
				}));
	}
}
