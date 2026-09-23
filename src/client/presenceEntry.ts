// realtime-modules/src/client/presenceEntry.ts
//
// The ONE presence entry a socket has, shared by every presence user in the tab.
//
// The gateway's PresenceService keeps one entry per client (socket) and every
// `presence:set` REPLACES it whole: status, metadata and the `channels` list.
// So two independent writers on one socket clobber each other. The app-wide
// chat presence (`channels: ['general']`) and a document's presence
// (`channels: ['doc:<id>']`) would take turns removing each other: the last
// `set` wins, and the loser's peers see the person vanish.
//
// This module is the socket's single source for that entry. Callers JOIN the
// channels they are present in (refcounted, so two hooks on one channel are
// fine) and PATCH the status and metadata; every frame it builds carries the
// union of joined channels and the merged metadata. A metadata key patched to
// `null` is removed.
//
// ## Leaving a channel
//
// The gateway broadcasts a `set` only to the entry's NEW channels, so peers on
// a channel you drop are never told (until your socket closes). Leaving
// therefore sends two frames: one that still lists the channel and names it in
// `metadata._left` (every peer's `usePresence` drops you from that channel on
// it), then one without it (the server forgets you there, so a later
// subscriber's snapshot does not include you).
//
// One module-level entry per JS realm — a tab has one gateway socket. Tests
// reset it with `resetPresenceEntry()`.

import type { PresenceStatus } from './types';

/** Metadata key that names the channels an entry is leaving. */
export const PRESENCE_LEFT_KEY = '_left';

const joined = new Map<string, number>();
let status: PresenceStatus | string = 'online';
let metadata: Record<string, unknown> = {};

// A type alias, not an interface, so it is assignable to `Record<string, unknown>` (the socket's `send`).
export type PresenceSetFrame = {
  service: 'presence';
  action: 'set';
  status: PresenceStatus;
  metadata: Record<string, unknown>;
  channels: string[];
};

export interface PresencePatch {
  status?: PresenceStatus | string;
  /** Merged into the entry's metadata; a `null` value removes the key. */
  metadata?: Record<string, unknown>;
  /**
   * Channels to list in THIS frame even if nobody joined them (the legacy
   * one-channel `setStatus`/`updateMetadata` behaviour). Not remembered.
   */
  alsoChannels?: readonly string[];
}

/** The channels this socket is present in, in join order. */
export function joinedPresenceChannels(): string[] {
  return [...joined.keys()];
}

/**
 * Be present in `channel`. Returns a release; the release answers true when it
 * dropped the LAST reference (the caller should then send `presenceLeaveFrames`).
 */
export function joinPresenceChannel(channel: string): () => boolean {
  joined.set(channel, (joined.get(channel) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return false;
    released = true;
    const count = (joined.get(channel) ?? 1) - 1;
    if (count > 0) {
      joined.set(channel, count);
      return false;
    }
    joined.delete(channel);
    return true;
  };
}

function mergeMetadata(patch: Record<string, unknown> | undefined): void {
  if (!patch) return;
  const next = { ...metadata };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  metadata = next;
}

/** Apply a patch and build the full `set` frame for the socket's entry. */
export function presenceSetFrame(patch: PresencePatch = {}): PresenceSetFrame {
  if (patch.status !== undefined) status = patch.status;
  mergeMetadata(patch.metadata);
  const channels = [...joined.keys()];
  for (const extra of patch.alsoChannels ?? []) if (!channels.includes(extra)) channels.push(extra);
  return {
    service: 'presence',
    action: 'set',
    status: status as PresenceStatus,
    metadata: { ...metadata },
    channels,
  };
}

/**
 * The two frames that take this socket out of `channel` (already released
 * from `joinPresenceChannel`). See "Leaving a channel" above.
 */
export function presenceLeaveFrames(channel: string, patch: Pick<PresencePatch, 'metadata'> = {}): PresenceSetFrame[] {
  mergeMetadata(patch.metadata);
  const remaining = [...joined.keys()].filter((joinedChannel) => joinedChannel !== channel);
  const base = { service: 'presence' as const, action: 'set' as const, status: status as PresenceStatus };
  return [
    { ...base, metadata: { ...metadata, [PRESENCE_LEFT_KEY]: [channel] }, channels: [...remaining, channel] },
    { ...base, metadata: { ...metadata }, channels: remaining },
  ];
}

/** Test-only: forget every join, the status and the metadata. */
export function resetPresenceEntry(): void {
  joined.clear();
  status = 'online';
  metadata = {};
}
