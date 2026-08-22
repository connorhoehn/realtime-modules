// Tiny JWT body decoder — no signature verification. Used to extract
// the `arn` claim from platform-api-minted participant tokens so the
// hook layer can build WHIP/WHEP URLs without the caller passing the
// ARN separately.
//
// Lifted from the existing inline `decodeArnFromToken` in
// realtime-examples/frontend/src/lib/video/useHangoutEmbed.ts.

export interface DecodedToken {
  sub?: string;
  arn?: string;
  channelArn?: string;
  role?: string;
  participantId?: string;
  exp?: number;
  email?: string;
  given_name?: string;
  family_name?: string;
  [key: string]: unknown;
}

/**
 * Decode a JWT body (the middle segment between two dots). Returns
 * null on any parse failure — never throws. Caller is responsible
 * for checking the result.
 */
export function decodeJwt(token: string | null | undefined): DecodedToken | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const body = parts[1];
    const padded = body + '='.repeat((4 - (body.length % 4)) % 4);
    const url2b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(url2b64);
    return JSON.parse(json) as DecodedToken;
  } catch {
    return null;
  }
}

/**
 * Extract the channel ARN from a participant token. Tries `arn` first
 * (the LVS convention), then `channelArn` (platform-api alternate).
 */
export function decodeArn(token: string | null | undefined): string | null {
  const claims = decodeJwt(token);
  if (!claims) return null;
  if (typeof claims.arn === 'string' && claims.arn.length > 0) return claims.arn;
  if (typeof claims.channelArn === 'string' && claims.channelArn.length > 0) return claims.channelArn;
  return null;
}

/**
 * Return seconds remaining until the JWT `exp` claim. Negative when
 * already expired. `Infinity` if the token has no `exp` (unbounded).
 * `null` on parse failure (treat as expired by the caller).
 */
export function jwtSecondsRemaining(token: string | null | undefined, now: Date = new Date()): number | null {
  const claims = decodeJwt(token);
  if (!claims) return null;
  if (typeof claims.exp !== 'number') return Infinity;
  return claims.exp - Math.floor(now.getTime() / 1000);
}
