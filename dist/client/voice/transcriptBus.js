"use strict";
// realtime-modules/src/client/voice/transcriptBus.ts
//
// One published transcript, many consumers.
//
// The capture hook must not know what happens to an utterance. Phase 1 has two
// sinks already — attach as a document comment, and raise a work item for the
// proposal/acceptance lane — and hardwiring either into `useVoiceCapture` would
// make the second one a fork of the first. So the hook publishes here and sinks
// subscribe.
//
// Deliberately a plain in-process emitter: no queue, no replay, no persistence.
// A transcript is delivered to whoever is listening at the moment it completes.
// If a sink needs durability it should persist on receipt — that is a decision
// for the sink, and this module has no opinion about it.
Object.defineProperty(exports, "__esModule", { value: true });
exports.subscribeTranscripts = subscribeTranscripts;
exports.publishTranscript = publishTranscript;
exports.__resetTranscriptHandlers = __resetTranscriptHandlers;
const handlers = new Set();
/**
 * Subscribe to completed utterances. Returns an unsubscribe function.
 *
 * Safe to call from a React effect; safe to call from module scope in a
 * long-lived worker. Handlers are invoked synchronously in registration order,
 * and a throwing handler cannot stop the others.
 */
function subscribeTranscripts(handler) {
    handlers.add(handler);
    return () => {
        handlers.delete(handler);
    };
}
/** Publish. Called by `useVoiceCapture`; sinks should never call this. */
function publishTranscript(event) {
    for (const handler of [...handlers]) {
        try {
            handler(event);
        }
        catch (err) {
            // One bad sink must not deny the transcript to every other sink.
            // eslint-disable-next-line no-console
            console.error('[voice-capture] transcript handler threw', err);
        }
    }
}
/** Test seam. */
function __resetTranscriptHandlers() {
    handlers.clear();
}
//# sourceMappingURL=transcriptBus.js.map