# Work graph v2: reader-first checkpoint

Version 0.70.0 adds opt-in viewer contracts and strict validation. V1 payloads, snapshot readers, reference encoding and client transport remain unchanged. This release does not enable a v2 writer, endpoint, subscription or historical query.

New exports include `WorkGraphQueryV2`, `WorkGraphSnapshotV2`, explicit authorized effort membership, artifact revision/anchor metadata, independent operation and attention leases, bounded event counts, composite cursor claim types, and `WorkReferenceV2`. `encodeWorkReferenceV2` is an opt-in writer; `decodeAnyWorkReference` reads both versions. The old `decodeWorkReference` still rejects v2. Do not switch producers until recipient resolvers and storage accept the new version.

Validation rejects extra private fields, metadata on locked/existence-only entities, dangling membership, duplicate evidence, pending revisions advertised as available, unauthorized revision attention, and future entity/revision/feedback timestamps in as-of responses. Queries use real IANA local-day bounds, including DST. Cursor claims are a type, not a signed composite cursor implementation. The validator is not an authorization engine.

Next: settle source/session/attempt/lineage events, negotiated HTTP/WS readers and writers, historical reconstruction, authorization of each detail/count/anchor, revision-aware action exchange, recipient reference resolution, and composite replay. Do not manufacture these fields from presence or current lifecycle status. The app's full design and acceptance roadmap is `realtime-examples/docs/design/active-now-vertical-plan.md`.

Checkpoint checks: all 114 Jest suites / 1,392 tests passed; production build and 29-subpath export verification passed; typecheck passed. Focused work-graph suites: 9 / 85 tests. No consumer pin has been moved to this version as part of this checkpoint.

## 0.71.0 — producers, shared server helpers and an opt-in client reader

This release makes a v2 response producible and readable end to end. V1 stays
byte-for-byte identical: the v1 snapshot request body, stream message set,
reference encoding and `WorkGraphSnapshot` shape are unchanged, and the v1 hook
test still asserts the exact `{ scope, signal }` request and six-key socket
request.

**Source-declared provenance.** `projectEvent` now creates the cross-source
relationships the payloads already carried: a pipeline run's `inputs`
(`run -derived-from-> input`), a document revision's `producedByRunId`
(`run -produced-> document`), and a conversation's `explicitRelatedResource`
(`conversation -discussed-> resource`). The counterpart must already be
projected and must resolve to exactly one node; otherwise the relationship is
dropped. Nothing is linked because two entities share an actor, a day, a
project, or a machine. Two optional payload fields were added for this:
`PipelinePayload.inputs` (explicit `WorkSourceRef[]`) and
`CloudComputePayload.projectLabel`. Both are optional, so existing producers
validate unchanged, and neither is accepted on a payload kind that never
declared it.

**Shared server helpers** (`work-graph/serverV2`, also re-exported from
`work-graph/server`): `deriveWorkEfforts` walks source-declared edges out from
anchor nodes (`project`, `task`, `meeting` by default) so each effort is real
provenance; nodes reachable from no anchor stay ungrouped rather than being
merged on a heuristic. `buildWorkGraphSnapshotV2` assembles and strictly
validates. `bucketWorkEvents` buckets against the real IANA local day,
`freshWorkOperations` drops expired leases, and `detailsForDisclosedNodes`
keeps details to nodes at full `details` disclosure.

**Client**: `useWorkGraph({ schemaVersion: 2, window: { start, end, mode } })`
sends an additive `activity` field on the snapshot and socket requests,
validates with `validateWorkGraphSnapshotV2`, and exposes
`graph.activity` (`query`, `temporal`, `efforts`, `details`, `operations`,
`eventBuckets`). An invalid window fails locally as `invalid-query` instead of
being sent. A v2 caller also accepts one additive stream message,
`{ kind: 'activity', subscriptionGeneration, policyRevision?, snapshot }`,
which replaces only the activity layer and is ignored when the generation or
policy revision does not match. V1 callers still reject that message.

**Additive contract fields**: optional `subtitle` on `ViewerWorkEffort`, and
optional `summary`/`lines` on `ViewerWorkActivityDetail` (max
`WORK_GRAPH_V2_LIMITS.detailLines`). Validation rejects them on locked or
existence-only entities exactly as before.

Still not done: v2 reference writing stays opt-in and disabled, deltas remain
v1 node/edge operations, and historical reconstruction is unchanged — an
`as-of` answer the host cannot reconstruct must still be reported as `recent`.

## 0.72.0 — authorized per-node pane detail

`ViewerWorkActivityDetail` gains optional pane data, all of it additive and all
of it subject to the same disclosure rules as the node it describes:
`inputs`, `sources` and `workItem` (`ViewerWorkNodeLink`: `nodeId`, `label`,
optional `meta`), `transcript` (`segments[]` plus `askEnabled`),
`artifact.pageCount`, `anchors[].index`, and `pending.message`.

Validation enforces that a link names a node the same snapshot disclosed and
that is neither locked nor existence-only; a transcript with segments requires
`details` disclosure on its node, `askEnabled` requires the `view-transcript`
capability, segments must be ordered and cannot post-date an `as-of` cutoff.
`detailsForDisclosedNodes` strips each of these for the viewer rather than
substituting a placeholder or a count, so a withheld neighbour leaves no trace.

## 0.73.0 — composite v2 cursors and source anchor precision

`WorkGraphCursorCodec` gains `issueV2`/`verifyV2` for `WorkGraphCursorClaimsV2`.
A v2 token uses the `wg2.` prefix and carries per-UTC-partition watermarks (a
non-UTC local day spans two projection partitions, so a single composite
revision is not a position in either delta log), the composite
`observationWatermark`, and the complete authorized `WorkGraphQueryV2`. It is
bound to that whole query, so it cannot be replayed against another person,
day, policy revision or interval. The two versions reject each other's tokens.

`WorkSourceRef` gains an optional `anchor` (`slide`/`page`/`block`/
`transcript-segment` + id) so a source can name slide or block precision on a
`discussed` relationship. Node resolution in the projection still matches on
source and resource only — an anchor refines which part is meant, never which
entity — and the field is optional, so existing producers validate unchanged.

## 0.74.0 — a placeholder never overwrites a real source label

`projectEvent` now marks every title it invents itself (`Pipeline run`,
`Cloud terminal`, `Project`, `Agent`, `Document`, `Conversation`, `Meeting`)
as generic, and `upsertNode` keeps the existing title when a generic one
arrives for a node that already has a source-supplied name. The platform
republishes its own pipeline run transitions without `safeLabel`, which used to
reset a real name such as "Generate presentation" back to "Pipeline run" the
moment the run completed.

A document revision node is also named after the document it changed
(`"Sprint review · revision"`) instead of a row of identical "Document change"
entries; without a source label it keeps the old placeholder.

## 0.75.0 — card fields, participants, and host-named efforts

`ViewerWorkActivityDetail` gains four optional card fields: `badge` (a short
state pill), `excerpt` (a line quoted verbatim from the entity's own content),
`footer` (`{ label, note? }`), and `participants`
(`{ id, label, avatarUrl? }`, at most `WORK_GRAPH_V2_LIMITS.participants`).
`avatarUrl` must be a relative same-origin path — an absolute URL is rejected
so a card cannot be made to fetch from somewhere else.

`deriveWorkEfforts` accepts a `titleFor(anchor, members)` hook, consulted
before the outcome-or-anchor rule and ignored when it returns nothing. It lets
a host name a work stream from its anchor without the library guessing.

`CloudComputePayload.projectContext` is a new optional field: the project's own
context line, written by the source as `"<where> · <what>"`. It becomes the
project node's description, and a source that stops sending it keeps the last
one it sent — the same rule that protects a real label from a placeholder.

## 0.76.0 — a session says what it is doing

`CloudComputePayload.sessionActivity` is the box's own state line (for example
`"Tests running"`), written by the source. It becomes the terminal node's
description, so a card can show what the session is doing without the reader
inventing a status word from its lifecycle.
