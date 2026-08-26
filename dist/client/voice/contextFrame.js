"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveTier = resolveTier;
exports.buildContextFrame = buildContextFrame;
exports.resolveAnchor = resolveAnchor;
const CONFIDENCE_BY_TIER = {
    selection: 'exact',
    section: 'high',
    viewport: 'medium',
    route: 'low',
    none: 'none',
};
const DEFAULT_DOMINANCE = 0.6;
/** Walk the ladder. Deterministic — same sample in, same rung out. */
function resolveTier(sample, opts = {}) {
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
function sameRung(a, b) {
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
function buildContextFrame(params) {
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
    const frame = {
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
function resolveAnchor(anchor, resolvers) {
    if (anchor.relPos && resolvers.byRelPos) {
        const v = resolvers.byRelPos(anchor.relPos);
        if (v != null)
            return { value: v, via: 'relPos' };
    }
    if (anchor.sectionId && resolvers.bySectionId) {
        const v = resolvers.bySectionId(anchor.sectionId);
        if (v != null)
            return { value: v, via: 'sectionId' };
    }
    if (anchor.quote && resolvers.byQuote) {
        const v = resolvers.byQuote(anchor.quote);
        if (v != null)
            return { value: v, via: 'quote' };
    }
    return null;
}
//# sourceMappingURL=contextFrame.js.map