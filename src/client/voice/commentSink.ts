// realtime-modules/src/client/voice/commentSink.ts
//
// The simplest transcript sink: attach a spoken remark to the document section
// it was latched to, as an ordinary comment.
//
// This exists to prove the whole path end to end — press, speak, release, and
// the words appear on the right section of the right document — and to be the
// reference for the other sinks (the work-item / proposal lane subscribes to
// the same bus and does something more interesting with the same event).
//
// Phase-1 grain: `sectionId`. The document-comments table has columns for
// documentId, sectionId, text and userId and NO anchor column, so `relPos` and
// `quote` are carried in the ContextFrame but not persisted yet. Adding them is
// a schema + read-path + `doc:comment_added` payload change, all three of which
// must land together — out of scope here, and deliberately not half-done.
//
// The refusal rules below are the point of the feature, not a nicety:
//   * `contextSplit` -> never auto-attach. The speaker moved mid-sentence and
//     we genuinely do not know which thing they meant.
//   * tier 'none' or no sectionId -> nothing addressable; refuse.
//   * outcome 'lost' -> we heard speech and got no text. Writing an empty
//     comment would be worse than saying so.

import type { TranscriptReadyEvent } from './transcriptBus';

export interface AttachTranscriptOptions {
  /** platform-api base URL. Empty string means same-origin. */
  apiBaseUrl?: string;
  authToken: string;
  /**
   * Attach even when the context is ambiguous. Only ever set this from an
   * explicit human confirmation — never as a default, and never because a
   * model decided the target looked right.
   */
  confirmed?: boolean;
  fetchImpl?: typeof fetch;
}

export type AttachResult =
  | { attached: true; commentId: string; sectionId: string; documentId: string }
  | { attached: false; reason: AttachRefusal; detail: string };

export type AttachRefusal =
  | 'context-split'
  | 'no-target'
  | 'not-a-document'
  | 'empty-transcript'
  | 'transcript-lost'
  | 'request-failed';

/**
 * Decide whether an utterance may be written without asking a human.
 *
 * Split out from the request so the UI can render the SAME verdict next to the
 * live transcript, before anything is sent. A user should never be surprised by
 * a refusal after the fact.
 */
export function evaluateAttach(
  event: TranscriptReadyEvent,
  confirmed = false,
): { ok: true } | { ok: false; reason: AttachRefusal; detail: string } {
  const { context, outcome, text } = event;
  if (outcome === 'lost') {
    return {
      ok: false,
      reason: 'transcript-lost',
      detail:
        'audio was captured but no transcript came back — the transcription queue may have dropped it',
    };
  }
  if (!text.trim()) {
    return { ok: false, reason: 'empty-transcript', detail: 'nothing was transcribed' };
  }
  if (context.entityType !== 'document' || !context.documentId) {
    return {
      ok: false,
      reason: 'not-a-document',
      detail: `context addresses ${context.entityType || 'nothing'}, not a document`,
    };
  }
  if (context.tier === 'none' || !context.sectionId) {
    return { ok: false, reason: 'no-target', detail: context.reason };
  }
  if (context.contextSplit && !confirmed) {
    return {
      ok: false,
      reason: 'context-split',
      detail: `context moved mid-utterance (${context.tier} -> ${context.endTier}) — confirm the target`,
    };
  }
  return { ok: true };
}

/**
 * POST the transcript to the existing document-comments endpoint.
 *
 * Uses the endpoint exactly as it already is — no new write path, no new table,
 * no schema change. That is the whole point of picking this sink first.
 */
export async function attachTranscriptAsComment(
  event: TranscriptReadyEvent,
  opts: AttachTranscriptOptions,
): Promise<AttachResult> {
  const verdict = evaluateAttach(event, opts.confirmed);
  if (!verdict.ok) {
    return { attached: false, reason: verdict.reason, detail: verdict.detail };
  }

  const documentId = event.context.documentId!;
  const sectionId = event.context.sectionId!;
  const base = (opts.apiBaseUrl ?? '').replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(`${base}/api/documents/${encodeURIComponent(documentId)}/comments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.authToken}`,
    },
    body: JSON.stringify({ sectionId, text: event.text.trim() }),
  });

  if (!res.ok) {
    return {
      attached: false,
      reason: 'request-failed',
      detail: `comments endpoint returned ${res.status}`,
    };
  }

  const body = (await res.json()) as { comment?: { commentId?: string } };
  return {
    attached: true,
    commentId: body.comment?.commentId ?? '',
    sectionId,
    documentId,
  };
}
