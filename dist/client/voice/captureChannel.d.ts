/** Routing key handed to the sidecar as `X-Channel-Arn` for a capture session. */
export declare function captureRoutingKey(captureId: string): string;
/**
 * The gateway WS channel a capture session's transcripts arrive on.
 *
 * Async because SubtleCrypto is: `crypto.subtle` is only available in a secure
 * context (https, or localhost), which is also the only place getUserMedia
 * works — so if this throws, capture was never going to run anyway.
 */
export declare function captureWsChannel(routingKey: string): Promise<string>;
/**
 * Capture ids must survive being embedded in a routing key and a URL, so keep
 * them to an unambiguous charset. Generated client-side; the server re-validates
 * (a routing key is a fan-out address, and an unvalidated one lets a caller
 * address someone else's caption channel).
 */
export declare const CAPTURE_ID_PATTERN: RegExp;
export declare function isValidCaptureId(id: string): boolean;
/** Generate a random capture id. Opaque — carries no user or document identity. */
export declare function generateCaptureId(): string;
//# sourceMappingURL=captureChannel.d.ts.map