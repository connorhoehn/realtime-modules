# Work graph v2: reader-first checkpoint

Version 0.70.0 adds opt-in viewer contracts and strict validation. V1 payloads, snapshot readers, reference encoding and client transport remain unchanged. This release does not enable a v2 writer, endpoint, subscription or historical query.

New exports include `WorkGraphQueryV2`, `WorkGraphSnapshotV2`, explicit authorized effort membership, artifact revision/anchor metadata, independent operation and attention leases, bounded event counts, composite cursor claim types, and `WorkReferenceV2`. `encodeWorkReferenceV2` is an opt-in writer; `decodeAnyWorkReference` reads both versions. The old `decodeWorkReference` still rejects v2. Do not switch producers until recipient resolvers and storage accept the new version.

Validation rejects extra private fields, metadata on locked/existence-only entities, dangling membership, duplicate evidence, pending revisions advertised as available, unauthorized revision attention, and future entity/revision/feedback timestamps in as-of responses. Queries use real IANA local-day bounds, including DST. Cursor claims are a type, not a signed composite cursor implementation. The validator is not an authorization engine.

Next: settle source/session/attempt/lineage events, negotiated HTTP/WS readers and writers, historical reconstruction, authorization of each detail/count/anchor, revision-aware action exchange, recipient reference resolution, and composite replay. Do not manufacture these fields from presence or current lifecycle status. The app's full design and acceptance roadmap is `realtime-examples/docs/design/active-now-vertical-plan.md`.

Checkpoint checks: all 114 Jest suites / 1,392 tests passed; production build and 29-subpath export verification passed; typecheck passed. Focused work-graph suites: 9 / 85 tests. No consumer pin has been moved to this version as part of this checkpoint.
