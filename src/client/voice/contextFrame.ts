// realtime-modules/src/client/voice/contextFrame.ts
//
// WHERE a spoken utterance belongs. This file is a PUBLISHED CONTRACT — the
// comment path and the work-item/proposal lane are both consumers, and neither
// may reinterpret it.
//
// The rule it exists to enforce:
//
//     Rules pick the TARGET; the model only ever picks the ACTION.
//
// Every mis-attachment failure in the prior art came from a system that
// INFERRED which container a remark belonged to. Here the human act — pressing
// push-to-talk — chooses the container, deterministically, from what was
// already on screen at that instant. A model downstream may classify intent,
// draft a header, propose an edit. It must NEVER choose the document.
//
// Three consequences, all enforced below:
//
//  1. The target is LATCHED at utterance START and never re-decided. The END
//     sample is taken ONLY to detect that the context moved — it can take
//     `autoAttach` away, and can never redirect the frame somewhere else.
//  2. If start and end disagree, `contextSplit` is true and the utterance is
//     never auto-attached. A remark spoken across a scroll belongs to whichever
//     thing the speaker had in mind, and we cannot know which — so we ask.
//  3. The anchor degrades in a fixed order: relPos -> sectionId -> quote. Each
//     rung survives a class of edit the one above it does not, so a consumer
//     re-anchoring later walks DOWN the triple and stops at the first hit.
//
// Pure functions. No React, no DOM, no network.

/** Ladder rungs, most specific first. `resolveTier` walks them in order. */
export type TargetTier =
  | 'selection'   // user had text selected — unambiguous
  | 'section'     // a section held keyboard focus
  | 'viewport'    // one section dominated what was on screen
  | 'route'       // the URL names an entity; nothing finer is known
  | 'none';       // nothing addressable — do not attach

/**
 * How much a consumer should trust the frame's `sectionId`/anchor.
 *
 * Derived from the tier, never from a model. Exposed separately so consumers
 * can gate on confidence without knowing the ladder.
 */
export type ContextConfidence = 'exact' | 'high' | 'medium' | 'low' | 'none';

const CONFIDENCE_BY_TIER: Record<TargetTier, ContextConfidence> = {
  selection: 'exact',
  section: 'high',
  viewport: 'medium',
  route: 'low',
  none: 'none',
};

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
  route?: { entityType: string; entityId: string } | undefined;
  /** An explicit text selection, if any. */
  selection?:
    | { sectionId: string; quote?: string | undefined; relPos?: string | undefined }
    | undefined;
  /** Section holding keyboard focus, with a caret position if the host has one. */
  focusedSection?:
    | { sectionId: string; relPos?: string | undefined }
    | null
    | undefined;
  /** Convenience form of `focusedSection` for hosts with no caret to report. */
  focusedSectionId?: string | null | undefined;
  /**
   * Sections visible in the viewport with the fraction of the viewport each
   * covers (0..1). Order is irrelevant; the largest wins if it clears
   * `viewportDominanceRatio`.
   */
  viewport?: Array<{ sectionId: string; ratio: number }> | undefined;
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

const DEFAULT_DOMINANCE = 0.6;

interface Rung {
  tier: TargetTier;
  sectionId?: string | undefined;
  relPos?: string | undefined;
  quote?: string | undefined;
  reason: string;
}

/** Walk the ladder. Deterministic — same sample in, same rung out. */
export function resolveTier(
  sample: CaptureContextSample,
  opts: ResolveContextOptions = {},
): Rung {
  const dominance = opts.viewportDominanceRatio ?? DEFAULT_DOMINANCE;

  if (sample.selection?.sectionId) {
    return {
      tier: 'selection',
      sectionId: sample.selection.sectionId,
      relPos: sample.selection.relPos,
      quote: sample.selection.quote,
      reason: 'text was selected',
    };
  }

  const focused = sample.focusedSection ?? undefined;
  const focusedId = focused?.sectionId ?? sample.focusedSectionId ?? undefined;
  if (focusedId) {
    return {
      tier: 'section',
      sectionId: focusedId,
      relPos: focused?.relPos,
      reason: 'section had focus',
    };
  }

  const visible = (sample.viewport ?? []).filter((v) => v.sectionId && v.ratio > 0);
  if (visible.length > 0) {
    const top = visible.reduce((a, b) => (b.ratio > a.ratio ? b : a));
    if (top.ratio >= dominance) {
      return {
        tier: 'viewport',
        sectionId: top.sectionId,
        reason: `section filled ${Math.round(top.ratio * 100)}% of the viewport`,
      };
    }
  }

  if (sample.route?.entityId) {
    return { tier: 'route', reason: 'the open page addresses this entity' };
  }

  return { tier: 'none', reason: 'nothing addressable was on screen' };
}

/** True when two rungs name the same thing at the same grain. */
function sameRung(a: Rung, b: Rung): boolean {
  return a.tier === b.tier && a.sectionId === b.sectionId;
}

/**
 * Build the frame from the bounded span.
 *
 * Note the asymmetry, which is the whole design: everything about WHERE comes
 * from `start`. `end` contributes exactly two things — `endTier`/`endSectionId`
 * for diagnostics, and the ability to set `contextSplit`, which only ever
 * REMOVES permission to write. There is no code path by which a later sample
 * redirects an utterance to a different container.
 */
export function buildContextFrame(params: {
  start: CaptureContextSample;
  end: CaptureContextSample;
  t0_ms: number;
  t1_ms: number;
  options?: ResolveContextOptions;
}): ContextFrame {
  const { start, end, t0_ms, t1_ms, options = {} } = params;
  const startRung = resolveTier(start, options);
  const endRung = resolveTier(end, options);

  // Entity identity is part of the split test: scrolling within one document is
  // survivable at route grain, but NAVIGATING mid-utterance is not.
  const startEntity = start.route?.entityId;
  const endEntity = end.route?.entityId;
  const contextSplit = !sameRung(startRung, endRung) || startEntity !== endEntity;

  const entityType = start.route?.entityType ?? '';
  const entityId = startEntity ?? '';

  const frame: ContextFrame = {
    entityType,
    entityId,
    ...(entityType === 'document' && entityId ? { documentId: entityId } : {}),
    ...(startRung.sectionId ? { sectionId: startRung.sectionId } : {}),
    anchor: {
      ...(startRung.relPos ? { relPos: startRung.relPos } : {}),
      ...(startRung.sectionId ? { sectionId: startRung.sectionId } : {}),
      ...(startRung.quote ? { quote: startRung.quote } : {}),
    },
    tier: startRung.tier,
    confidence: CONFIDENCE_BY_TIER[startRung.tier],
    contextSplit,
    autoAttach: !contextSplit && startRung.tier !== 'none',
    reason: startRung.reason,
    t0_ms,
    t1_ms,
    endTier: endRung.tier,
    ...(endRung.sectionId ? { endSectionId: endRung.sectionId } : {}),
    capturedBy: 'push-to-talk',
  };
  return frame;
}

/**
 * Walk the anchor triple in degradation order.
 *
 * `resolvers` are tried relPos -> sectionId -> quote; the first that returns a
 * non-null value wins, and the rung that produced it is reported so a consumer
 * can tell an exact re-anchor from a fuzzy one.
 */
export function resolveAnchor<T>(
  anchor: ContextAnchor,
  resolvers: {
    byRelPos?: (relPos: string) => T | null;
    bySectionId?: (sectionId: string) => T | null;
    byQuote?: (quote: string) => T | null;
  },
): { value: T; via: 'relPos' | 'sectionId' | 'quote' } | null {
  if (anchor.relPos && resolvers.byRelPos) {
    const v = resolvers.byRelPos(anchor.relPos);
    if (v != null) return { value: v, via: 'relPos' };
  }
  if (anchor.sectionId && resolvers.bySectionId) {
    const v = resolvers.bySectionId(anchor.sectionId);
    if (v != null) return { value: v, via: 'sectionId' };
  }
  if (anchor.quote && resolvers.byQuote) {
    const v = resolvers.byQuote(anchor.quote);
    if (v != null) return { value: v, via: 'quote' };
  }
  return null;
}
