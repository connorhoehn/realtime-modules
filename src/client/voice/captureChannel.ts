// realtime-modules/src/client/voice/captureChannel.ts
//
// Channel naming for ambient (non-call) voice capture.
//
// The live-captions sidecar is a GENERIC speech-to-text HTTP service; only its
// FEEDER was ever call-scoped. `X-Channel-Arn` is free-form — the sidecar keys
// an accumulator by it and publishes to Redis `captions:<value>`. The gateway's
// caption-relay psubscribes `captions:*` and fans out to the WS channel
// `captions:<sha1(value)[:24]>`.
//
// So a routing key of `capture:<captureId>` rides the EXISTING relay with no
// server change at all. The hash is not for privacy — it is because the
// subscribe service caps channel names at 50 chars of [A-Za-z0-9:_-].
//
// MUST stay in lockstep with captionWsChannel() in the gateway's
// src/caption-relay.ts and the frontend's lib/captionChannel.ts.

/** Routing key handed to the sidecar as `X-Channel-Arn` for a capture session. */
export function captureRoutingKey(captureId: string): string {
  return `capture:${captureId}`;
}

/**
 * The gateway WS channel a capture session's transcripts arrive on.
 *
 * Async because SubtleCrypto is: `crypto.subtle` is only available in a secure
 * context (https, or localhost), which is also the only place getUserMedia
 * works — so if this throws, capture was never going to run anyway.
 */
export async function captureWsChannel(routingKey: string): Promise<string> {
  const data = new TextEncoder().encode(routingKey);
  const digest = await crypto.subtle.digest('SHA-1', data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `captions:${hex.slice(0, 24)}`;
}

/**
 * Capture ids must survive being embedded in a routing key and a URL, so keep
 * them to an unambiguous charset. Generated client-side; the server re-validates
 * (a routing key is a fan-out address, and an unvalidated one lets a caller
 * address someone else's caption channel).
 */
export const CAPTURE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidCaptureId(id: string): boolean {
  return CAPTURE_ID_PATTERN.test(id);
}

/** Generate a random capture id. Opaque — carries no user or document identity. */
export function generateCaptureId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
