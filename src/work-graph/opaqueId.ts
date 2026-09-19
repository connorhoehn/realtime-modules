import { digest } from 'lib0/hash/sha256';

/** Deterministic identity, not an authorization token. No source fields escape. */
export function opaqueWorkId(prefix: 'node' | 'edge' | 'placeholder', ...parts: string[]): string {
  const bytes: Uint8Array = digest(new TextEncoder().encode(JSON.stringify(parts)));
  const hash = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `wg_${prefix}_${hash}`;
}
