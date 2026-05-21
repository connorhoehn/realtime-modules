"use strict";
/**
 * Prep interface for the CRDT-extraction Cut 1.
 *
 * `SnapshotStore` abstracts the durable snapshot-persistence surface that
 * `SnapshotManager.ts` currently implements directly against
 * `@aws-sdk/client-dynamodb` (PutItem / Query). `HotCache` abstracts the
 * Redis `setEx` / `get` / `del` calls.
 *
 * This file is *purely additive* — the existing `SnapshotManager` is
 * unchanged. Cut 1 will refactor SnapshotManager to depend on these
 * interfaces instead of the AWS-SDK clients directly, at which point the
 * MemoryStore implementation in this directory makes the module usable in
 * tests, dev mode, and zero-config consumers (e.g. app #2).
 *
 * Field-shape notes (load-bearing for the future extraction):
 *
 *   - `gzippedBytes`: snapshots are stored on disk gzipped (see
 *     `SnapshotManager.writeSnapshot`'s `gzip(Buffer.from(stateUpdate))`
 *     call). The store contract preserves that — adapters compress / hand
 *     bytes to the wire; SnapshotManager keeps doing the gzip itself so
 *     this contract stays storage-agnostic. Implementations MUST round-
 *     trip `gzippedBytes` byte-for-byte.
 *
 *   - `timestamp` is the DDB sort key (millisecond epoch) and is also
 *     used as the human-facing "version id" in restore APIs.
 *
 *   - `versionName` is optional because the existing data set has many
 *     null entries (anonymous auto-snapshots).
 *
 *   - `VersionMeta.size` is sourced from `sizeBytes` in DDB and may be
 *     `0` for legacy rows where the field was not yet recorded.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=SnapshotStore.js.map