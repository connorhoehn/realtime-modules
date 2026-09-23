import type { RunDraft, RunDraftInput, RunDraftPhase } from './work';
import type { DocumentsLiveOptions } from './transport';
export interface UseRunDraftOptions extends DocumentsLiveOptions {
    documentGrant?: string | null;
}
export interface UseRunDraftResult {
    /** The draft the pane shows (newest not cancelled); `null` = "No draft". */
    draft: RunDraft | null;
    /** `runDraftPhase(draft)`: none · draft · dispatching · unconfirmed (> 60 s) · dispatched · cancelled. */
    phase: RunDraftPhase;
    /** The id the next `save` / `dispatch` uses — the draft's, or the one minted for the next draft. */
    draftId: string;
    loading: boolean;
    error?: string;
    /** Upsert the draft. Retrying the same input replays; a changed input carries `expectedRevision`. */
    save: (input: RunDraftInput) => Promise<RunDraft>;
    /** Dispatch the saved draft. Concurrent calls share one request. */
    dispatch: () => Promise<RunDraft>;
    /** Cancel the dispatched run through the existing cancel route. */
    stop: (reason?: string) => Promise<void>;
    /** 'save' | 'dispatch' | 'stop' while one is in flight. */
    busy: 'save' | 'dispatch' | 'stop' | null;
    /** Set by a 409 on save (the draft changed elsewhere) or dispatch (refused / in progress). */
    conflict: string | null;
    refresh: () => void;
    /**
     * Start a fresh draft: `draft` becomes `null` (phase `none`) and `draftId` a
     * newly minted requestId, so the next `save` creates a second draft instead
     * of hitting the dispatched one. The draft that was showing moves to
     * `history` and stays readable there (its signals keep it current); list
     * re-reads never bring it — or anything older — back as the current draft.
     * Refused while a dispatch is in flight. Returns the new `draftId`.
     */
    startNew: () => string;
    /** Drafts set aside by `startNew`, newest first, kept up to date. Empty until then. */
    history: RunDraft[];
}
export declare function useRunDraft(documentId: string | null | undefined, opts: UseRunDraftOptions): UseRunDraftResult;
//# sourceMappingURL=useRunDraft.d.ts.map