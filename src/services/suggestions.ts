import type { SearchService, SearchResult } from './search';
import { RECALL_EXCLUDE_ORIGIN_PREFIXES } from './search';
import type { SmartMemorySettings } from '../types';

const MIN_QUERY_LENGTH = 20;

export type SuggestionFrequency = SmartMemorySettings['suggestionFrequency'];

export function frequencyToDelayMs(frequency: SuggestionFrequency): number {
	switch (frequency) {
		case 'aggressive': return 1000;
		case 'minimal': return 5000;
		default: return 2000;
	}
}

export interface SuggestionEngineConfig {
	/** Getter returns the current SearchService or null if disconnected.
	 *  Lazy resolution avoids stale references when settings reinitialize the client. */
	getSearch: () => SearchService | null;
	settings: SmartMemorySettings;
	onSuggestions: (results: SearchResult[], query: string) => void;
}

/**
 * Debounced inline-suggestion engine.
 *
 * - Debounces query firing by suggestionFrequency setting (1s/2s/5s)
 * - Drops queries shorter than MIN_QUERY_LENGTH (avoids noise from typing
 *   single words)
 * - Sequence-number stale-discard: results from older requests are
 *   ignored when a newer request has been started, since requestUrl
 *   doesn't support cancellation
 */
export class SuggestionEngine {
	private getSearch: () => SearchService | null;
	private settings: SmartMemorySettings;
	private onSuggestions: (results: SearchResult[], query: string) => void;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private requestSeq = 0;

	constructor(cfg: SuggestionEngineConfig) {
		this.getSearch = cfg.getSearch;
		this.settings = cfg.settings;
		this.onSuggestions = cfg.onSuggestions;
	}

	updateSettings(settings: SmartMemorySettings): void {
		this.settings = settings;
	}

	queryDebounced(text: string, canQuery: () => boolean = () => true): void {
		if (!this.settings.inlineSuggestionsEnabled) return;
		if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);

		const trimmed = text.trim();
		if (trimmed.length < MIN_QUERY_LENGTH) {
			// Input shrank below the query floor (e.g. the user deleted a
			// paragraph). Drop any in-flight request and clear whatever
			// suggestions are still rendered — otherwise stale suggestions for
			// the deleted text linger on screen. The timer is already cleared
			// above; bump the seq so a returning runQuery discards itself.
			this.requestSeq++;
			this.onSuggestions([], trimmed);
			return;
		}

		const delay = frequencyToDelayMs(this.settings.suggestionFrequency);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			if (!canQuery()) return;
			void this.runQuery(trimmed);
		}, delay);
	}

	cancel(): void {
		if (this.debounceTimer !== null) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		// Bump seq so any in-flight result is discarded
		this.requestSeq++;
	}

	private async runQuery(query: string): Promise<void> {
		const seq = ++this.requestSeq;
		const search = this.getSearch();
		if (!search) return; // not connected
		try {
			const results = await search.search({
				query,
				topK: 3,
				multiHop: false,
				excludeOriginPrefixes: RECALL_EXCLUDE_ORIGIN_PREFIXES,
			});
			if (seq !== this.requestSeq) return; // stale

			const threshold = this.settings.suggestionConfidenceThreshold;
			const filtered = results.filter(r =>
				r.score === null || r.score >= threshold
			);

			this.onSuggestions(filtered, query);
		} catch {
			// Silently ignore — suggestions are best-effort
		}
	}
}
