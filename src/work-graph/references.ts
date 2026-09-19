import type { WorkReference } from './contracts';
import { WORK_GRAPH_LIMITS } from './contracts';
import { validateWorkReference } from './validation';

const PREFIX = 'wg1.';

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new RangeError('work reference encoding is malformed');
  const standard = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=');
  let binary: string;
  try { binary = atob(padded); } catch { throw new RangeError('work reference encoding is malformed'); }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new RangeError('work reference is not valid UTF-8'); }
}

/** Serialize only stable identifiers and graph context; private labels never enter the token. */
export function encodeWorkReference(reference: WorkReference): string {
  const checked = validateWorkReference(reference);
  if (!checked.ok) throw new RangeError(checked.errors.join(' '));
  const json = JSON.stringify(checked.value);
  if (new TextEncoder().encode(json).byteLength > WORK_GRAPH_LIMITS.referenceBytes) {
    throw new RangeError('work reference exceeds its byte limit');
  }
  return `${PREFIX}${toBase64Url(json)}`;
}

export function decodeWorkReference(encoded: string): WorkReference {
  if (!encoded.startsWith(PREFIX) || encoded.length > PREFIX.length + Math.ceil(WORK_GRAPH_LIMITS.referenceBytes * 4 / 3) + 4) {
    throw new RangeError('work reference version or size is unsupported');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(fromBase64Url(encoded.slice(PREFIX.length))); } catch (error) {
    if (error instanceof RangeError) throw error;
    throw new RangeError('work reference JSON is malformed');
  }
  const checked = validateWorkReference(parsed);
  if (!checked.ok) throw new RangeError(checked.errors.join(' '));
  return checked.value;
}
