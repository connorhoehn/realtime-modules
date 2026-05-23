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
export declare function decodeJwt(token: string | null | undefined): DecodedToken | null;
/**
 * Extract the channel ARN from a participant token. Tries `arn` first
 * (the LVS convention), then `channelArn` (platform-api alternate).
 */
export declare function decodeArn(token: string | null | undefined): string | null;
/**
 * Return seconds remaining until the JWT `exp` claim. Negative when
 * already expired. `Infinity` if the token has no `exp` (unbounded).
 * `null` on parse failure (treat as expired by the caller).
 */
export declare function jwtSecondsRemaining(token: string | null | undefined, now?: Date): number | null;
//# sourceMappingURL=jwt.d.ts.map