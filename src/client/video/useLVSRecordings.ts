// useLVSRecordings — read-only hook that lists recordings for a given
// channel ARN. Thin wrapper around the LVS `GET /api/channels/:arn/recordings`
// endpoint with auto-fetch on mount + refetch helper.
//
// Pure data-layer — does NOT touch the DOM, does NOT mint playback
// tokens (that's `useLVSHlsPlayer`'s job). Designed to compose with
// list-view shells like `<RecordingList>` from ui-components.
//
// Recording shape mirrors the LVS-side record persisted by
// RecordingManager._persistRecord, with optional fields for fields
// platform-api decorates downstream (callId, lobbyName, etc.).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSafeLVSContext } from './LVSProvider';

export interface LVSRecordingSegment {
  key: string;
  url: string;
  size: number;
}

export interface LVSRecording {
  recordingId: string;
  startedAt: string; // ISO
  endedAt: string;   // ISO
  durationMs: number;
  segments: LVSRecordingSegment[];
  destination: 'local' | 's3' | string;
  totalSize?: number;
  /** Optional fields decorated by platform-api when fetched via /api/recordings */
  callId?: string;
  lobbyName?: string;
  channelArn?: string;
  participants?: Array<{ userId: string; displayName?: string }>;
}

export interface UseLVSRecordingsOptions {
  /** Channel ARN to list recordings for. Null = idle, no fetch. */
  channelArn: string | null;
  /** Override base URL (else pulled from LVSProvider). */
  baseUrl?: string;
  /** Optional bearer token (publisher streamKey or admin token). */
  authToken?: string;
}

export interface UseLVSRecordingsResult {
  recordings: LVSRecording[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useLVSRecordings(opts: UseLVSRecordingsOptions): UseLVSRecordingsResult {
  const ctx = useSafeLVSContext();
  const baseUrl = opts.baseUrl ?? ctx?.baseUrl ?? '';

  const [recordings, setRecordings] = useState<LVSRecording[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tick counter to force-refetch via refetch().
  const [tick, setTick] = useState(0);
  const refetch = useCallback(() => setTick(t => t + 1), []);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!opts.channelArn || !baseUrl) {
      setRecordings([]);
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setIsLoading(true);
    setError(null);
    const headers: Record<string, string> = {};
    if (opts.authToken) headers.Authorization = `Bearer ${opts.authToken}`;
    fetch(
      `${baseUrl}/api/channels/${encodeURIComponent(opts.channelArn)}/recordings`,
      { headers, signal: ac.signal },
    )
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as LVSRecording[] | { recordings: LVSRecording[] };
        const list = Array.isArray(data) ? data : (data?.recordings ?? []);
        if (!ac.signal.aborted) setRecordings(list);
      })
      .catch((e: any) => {
        if (ac.signal.aborted) return;
        setError(e?.message ?? String(e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setIsLoading(false);
      });
    return () => ac.abort();
  }, [opts.channelArn, baseUrl, opts.authToken, tick]);

  return useMemo(() => ({ recordings, isLoading, error, refetch }), [recordings, isLoading, error, refetch]);
}
