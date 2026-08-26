/** Ladder rungs, most specific first. `resolveTier` walks them in order. */
export type TargetTier = 'selection' | 'section' | 'viewport' | 'route' | 'none';
/**
 * How much a consumer should trust the frame's `sectionId`/anchor.
 *
 * Derived from the tier, never from a model. Exposed separately so consumers
 * can gate on confidence without knowing the ladder.
 */
export type ContextConfidence = 'exact' | 'high' | 'medium' | 'low' | 'none';
/**
 * The anchor triple, in degradation order.
 *
 * relPos    — an opaque host-supplied position INSIDE the section. The intended
 *             shape is a Yjs relative position (encoded), which survives
 *             concurrent edits by other people. Absent when the host has no
 *             CRDT position to give.
 * sectionId — the grain the document-comments table already stores. Survives
 *             any edit within the section, dies only if the section is deleted.
 * quote     — verbatim text the remark was about. Survives a section being
 *             split or renumbered, and is the only rung that can re-find a
 *             target in a document that was restructured wholesale.
 *
 * A consumer re-anchoring later walks DOWN this list and stops at the first
 * rung that still resolves. Phase 1 attaches at `sectionId` grain because the
 * document-comments table has no anchor columns; relPos and quote are carried
 * so that adding those columns later is a read-path change, not a re-capture.
 */
export interface ContextAnchor {
    relPos?: string | undefined;
    sectionId?: string | undefined;
    quote?: string | undefined;
}
/** What the host page knows about the screen at one instant. */
export interface CaptureContextSample {
    /** Entity the route addresses, e.g. `{ entityType: 'document', entityId }`. */
    route?: {
        entityType: string;
        entityId: string;
    } | undefined;
    /** An explicit text selection, if any. */
    selection?: {
        sectionId: string;
        quote?: string | undefined;
        relPos?: string | undefined;
    } | undefined;
    /** Section holding keyboard focus, with a caret position if the host has one. */
    focusedSection?: {
        sectionId: string;
        relPos?: string | undefined;
    } | null | undefined;
    /** Convenience form of `focusedSection` for hosts with no caret to report. */
    focusedSectionId?: string | null | undefined;
    /**
     * Sections visible in the viewport with the fraction of the viewport each
     * covers (0..1). Order is irrelevant; the largest wins if it clears
     * `viewportDominanceRatio`.
     */
    viewport?: Array<{
        sectionId: string;
        ratio: number;
    }> | undefined;
}
/**
 * The published context contract. Every transcript carries exactly one.
 *
 * `t0_ms`/`t1_ms` bound the utterance on the CAPTURING CLIENT's clock, in epoch
 * milliseconds. They come from the push-to-talk press and release, which is the
 * precise, authoritative boundary — the sidecar's own Window struct carries no
 * timestamps at all and cuts at a hard 3.0 s, so it could not supply this even
 * in principle. Consumers should treat the span as the utterance's extent and
 * NOT try to derive per-word timing from it.
 */
export interface ContextFrame {
    entityType: string;
    entityId: string;
    /** Set when `entityType === 'document'`. Convenience for the common consumer. */
    documentId?: string | undefined;
    sectionId?: string | undefined;
    anchor: ContextAnchor;
    tier: TargetTier;
    confidence: ContextConfidence;
    /**
     * The span covered more than one entity/section. The frame still carries the
     * START target — but a consumer MUST NOT write without human confirmation.
     */
    contextSplit: boolean;
    /** `!contextSplit && tier !== 'none'`. The one flag a sink should branch on. */
    autoAttach: boolean;
    /** Human-readable why, surfaced in the UI so attachment is never a mystery. */
    reason: string;
    /** Utterance span, epoch ms, capturing client's clock. */
    t0_ms: number;
    t1_ms: number;
    /** What the END sample would have chosen. Diagnostic ONLY — never acted on. */
    endTier: TargetTier;
    endSectionId?: string | undefined;
    /** Phase 1 has exactly one acquisition mode, and it is deliberate. */
    capturedBy: 'push-to-talk';
}
export interface ResolveContextOptions {
    /**
     * Minimum share of the viewport a single section must occupy before the
     * 'viewport' rung fires. Below this, two things are on screen and neither is
     * "the" target — fall through to the route rung rather than guess.
     */
    viewportDominanceRatio?: number;
}
interface Rung {
    tier: TargetTier;
    sectionId?: string | undefined;
    relPos?: string | undefined;
    quote?: string | undefined;
    reason: string;
}
/** Walk the ladder. Deterministic — same sample in, same rung out. */
export declare function resolveTier(sample: CaptureContextSample, opts?: ResolveContextOptions): Rung;
/**
 * Build the frame from the bounded span.
 *
 * Note the asymmetry, which is the whole design: everything about WHERE comes
 * from `start`. `end` contributes exactly two things — `endTier`/`endSectionId`
 * for diagnostics, and the ability to set `contextSplit`, which only ever
 * REMOVES permission to write. There is no code path by which a later sample
 * redirects an utterance to a different container.
 */
export declare function buildContextFrame(params: {
    start: CaptureContextSample;
    end: CaptureContextSample;
    t0_ms: number;
    t1_ms: number;
    options?: ResolveContextOptions;
}): ContextFrame;
/**
 * Walk the anchor triple in degradation order.
 *
 * `resolvers` are tried relPos -> sectionId -> quote; the first that returns a
 * non-null value wins, and the rung that produced it is reported so a consumer
 * can tell an exact re-anchor from a fuzzy one.
 */
export declare function resolveAnchor<T>(anchor: ContextAnchor, resolvers: {
    byRelPos?: (relPos: string) => T | null;
    bySectionId?: (sectionId: string) => T | null;
    byQuote?: (quote: string) => T | null;
}): {
    value: T;
    via: 'relPos' | 'sectionId' | 'quote';
} | null;
export {};
//# sourceMappingURL=contextFrame.d.ts.map