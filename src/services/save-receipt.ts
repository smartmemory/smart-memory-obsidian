/**
 * Read the SmartMemory 2.0 save receipt a `client.memories.ingest(...)` call
 * resolves to (smart-memory-docs docs/features/SM2-SAVE-1/save-receipt-contract.json).
 *
 * Assumed SDK build: smart-memory-sdk-js branch `rel-callers-jssdk-1` (f37df78,
 * REL-CALLERS-JSSDK-1). There `ingest` resolves to a `SaveReceipt` whose
 * `item_id` delegates to `subject.item_id` and whose `revision` is a wire field.
 * The SDK itself throws on an unknown major, subject kind or state, so a
 * receipt that reaches this function is already a readable 1.x receipt.
 *
 * A receipt that names no item is a typed refusal. It is never read as success.
 */

export type SaveReceiptErrorCode = 'admission_error' | 'no_item_id';

export class SaveReceiptError extends Error {
	readonly code: SaveReceiptErrorCode;
	readonly runId?: string;
	readonly statusUrl?: string;
	constructor(code: SaveReceiptErrorCode, message: string, runId?: string, statusUrl?: string) {
		super(`${code}: ${message}${runId ? ` (run_id ${runId})` : ''}`);
		this.name = 'SaveReceiptError';
		this.code = code;
		this.runId = runId;
		this.statusUrl = statusUrl;
	}
}

export interface SavedItem {
	itemId: string;
	/** Item revision the receipt reports; absent when the receipt carries none. */
	revision?: number;
	runId?: string;
}

export function readSaveReceipt(result: unknown, path: string): SavedItem {
	const r: any = result;
	const runId: string | undefined = typeof r?.run_id === 'string' ? r.run_id : undefined;
	if (r?.admission_error) {
		const e = r.admission_error;
		console.warn('[smartmemory] save refused at admission; note not saved', path, e?.code);
		throw new SaveReceiptError('admission_error', `${e?.code}: ${e?.message}`, runId, r.status_url);
	}
	const itemId = r?.subject?.item_id ?? r?.item_id;
	if (typeof itemId !== 'string' || !itemId) {
		console.warn('[smartmemory] save receipt names no item_id; note not mapped', path, runId);
		throw new SaveReceiptError('no_item_id', 'the save receipt carries no item_id', runId, r?.status_url);
	}
	const rev = r?.revision ?? r?.result?.revision;
	return { itemId, revision: typeof rev === 'number' ? rev : undefined, runId };
}
