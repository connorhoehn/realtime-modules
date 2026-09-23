// realtime-modules/src/client/documents/transport.ts
//
// The transport seam the documents hooks share with `usePipelineCatalog`: a
// host-owned `{ send, onMessage }` handle, else the nearest
// GatewaySocketProvider, and `null` for no live frames. Plus the reconnect
// rule: every session epoch after the first is a new connection that may have
// missed frames, so the hook re-reads once.

import { useEffect, useRef } from 'react';
import { useGatewayOptional } from '../GatewaySocketProvider';
import type { PipelineRunTransport } from '../pipelines/usePipelineRunStatus';

export interface DocumentsLiveOptions {
  /** platform-api origin, e.g. `http://localhost:3001`. */
  apiBaseUrl: string;
  /** Bearer for the REST reads and writes; `null` leaves the hook idle. */
  idToken: string | null;
  /** A host-owned socket. Omit to use the nearest GatewaySocketProvider; `null` disables live frames. */
  transport?: PipelineRunTransport | null;
  /** The host socket's session epoch, for a host-owned transport. Read from the gateway context otherwise. */
  sessionEpoch?: number;
  /** `false` mounts nothing — no read, no subscription. Default true. */
  enabled?: boolean;
}

export interface ResolvedTransport {
  send?: PipelineRunTransport['send'];
  onMessage?: PipelineRunTransport['onMessage'];
  epoch?: number;
}

export function useResolvedTransport(transport: PipelineRunTransport | null | undefined, sessionEpoch?: number): ResolvedTransport {
  const gateway = useGatewayOptional();
  const send = transport === null ? undefined : transport ? transport.send : (gateway?.sendMessage as PipelineRunTransport['send'] | undefined);
  const onMessage = transport === null ? undefined : transport ? transport.onMessage : (gateway?.onMessage as PipelineRunTransport['onMessage'] | undefined);
  const epoch = sessionEpoch ?? (transport === undefined ? gateway?.sessionEpoch : undefined);
  return { send, onMessage, epoch };
}

/** Calls `refresh` once per session epoch after the first one seen (a reconnect). */
export function useRefreshOnReconnect(epoch: number | undefined, refresh: () => void): void {
  const seen = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (epoch === undefined) return;
    if (seen.current === undefined) { seen.current = epoch; return; }
    if (epoch === seen.current) return;
    seen.current = epoch;
    refresh();
  }, [epoch, refresh]);
}
