# Changelog

## 0.97.1 — 2026-09-25

- **client/video (fix):** `useDocumentCall` counted a call you are not in from
  `participantCount`, and ignored the `participantUserIds` the `active-call`
  reply carries, so "Join · N" / "3 people in the call" was wrong. The count is
  now the distinct `participantUserIds` (falling back to `participantCount` only
  when a reply has no ids), kept live by `participant-state` / `user-status` /
  `accepted` frames for that call, and re-asked with `status` every
  `discoveryPollMs` (default 15 s) while you watch it. New `inCallUserIds`
  (the people behind the count, joined or not).
- **call (fix):** a `status` reply built from the local cache listed only this
  replica's sockets; it now unions the cluster roster. For document calls the
  user ids come from the meta's connection map, so people on other replicas are
  named instead of falling back to "caller + every invitee", and
  `participantCount` counts people rather than tabs.

## 0.97.0 — 2026-09-24

Document-call host moderation (mockup 06 person menu).

- **call:** host-only actions `mute-participant`, `remove-participant`,
  `transfer-host` (`{ callId, userId }`; refused for non-hosts, for the host
  themself, and for people not in the call). Mute sends
  `mute-participant { callId, userId, by }` to every connection of the target
  only; their participant-state carries the change to the rest. Remove sends
  `remove-participant` to the target, marks their invite `removed`, drops their
  connections from the roster on every replica (store + cross-node departure),
  clears their presentation, and sends everyone else `user-status: left`
  (reason `removed`) and `call-meta`; `accepted` / `participant-state` from a
  removed person are refused until a new invite. Transfer patches `hostUserId`
  (the old host stays an accepted participant) and broadcasts `call-meta`.
  `DocumentCallInviteState` gains `removed`.
- **client/video:** `useDocumentCall` gains `muteParticipant(userId)`,
  `removeParticipant(userId)`, `transferHost(userId)`, the local-only
  `setMutedForMe(userId, muted)` (reflected as `participant.mutedForMe`), and
  `moderation` (`{ kind: 'muted' | 'removed', by, at }`). When muted by the host
  the hook turns the mic off through `media.setMicEnabled(false)`; when removed
  it leaves without sending `ended` (phase `ended`, reason `removed`) and
  releases its platform-api seat.
- event-catalog 0.8.3 declares the frames (`document-calls@1.1.0`).

## 0.96.1 — 2026-09-24

- **server (documents):** `DocumentMeta.editors?: string[]` — the user ids a
  document is shared with. `_toWire` passes it on `documentList` /
  `documentUpdated` / single reads when non-empty, so readers can show who a
  document is shared with ("Document collaborators" in the document-call start
  panel). `handleUpdateDocumentMeta` now carries it through its whole-row
  `putDocument`; before, a rename un-shared the document in any store that
  persists it. Never taken from a client payload.

## 0.96.0 — 2026-09-24

Document calls: a call that belongs to a document review (realtime-examples
`docs/design/document-calls/SPEC.md` §4–5).

- **call (fix): ring expiry is per target.** The invite sweep used to forget
  the whole call once `inviteExpiresAt` passed, so one unanswered invitee in a
  group call — or an unanswered mid-call invite — ended the call for everyone,
  and on two replicas an accept on the other node never counted. A call
  someone answered is now never forgotten by the sweep (checked locally and in
  the state store); only the expired target's replay entry is dropped. An
  unanswered legacy 1:1 ring still ends as a missed call. The replay path
  follows the same rule. The tick body is now `runInviteSweep(now?)`.
- **call:** `DocumentCallMeta` + `DocumentCallMetaStore`, with
  `InMemoryDocumentCallMetaStore` and `RedisDocumentCallMetaStore`
  (`call:meta:<callId>` hash, TTL 4 h, one field per invited person so two
  replicas never overwrite each other's marks, presenter written then read
  back; `call:meta-index` set for the sweep). New `CallServiceOptions`:
  `metaStore`, `onOfflineInvite(target, invite)`, `isClientAlive(clientId)`.
- **call:** new actions `meta` (reply `call-meta` to the asker),
  `set-documents` (any participant), `present` (presenter or host may replace a
  presenter; only review documents), `set-title` (host); server-only
  `call-meta` and `invite-expired`; `user-status` gains `reconnecting`.
- **call:** a `kind:'document-review'` invite writes the meta on the call's
  first invite and marks each target `ringing` (online) or `notified` (no
  connected client, or `ring:false` — `onOfflineInvite` runs). Document calls
  never broadcast to every client: signalling with no targets goes to the
  call's participants. `ended` with `forEveryone` is host-only and ends the call
  on every node; plain `ended` is one person leaving (`user-status: left`), the
  last one out ends it. A dropped socket is `reconnecting` for the rejoin grace,
  then `left`; a lone participant refreshing keeps the call. The sweep leader
  expires rings per person (`missed`, `invite-expired` to the inviter) and,
  with `isClientAlive`, prunes roster entries whose replica died.
- **client/video:** `useMediaDevices`, `useAudioVideoSettings` (stored under
  `call-device-preferences`, compatible with the older DevicePreferences
  shape), `useDocumentCall` (PA session create/join/end + `activeCallSessionId`,
  signalling, roster, follow-the-presenter with `onNavigate`, reconnect
  re-sends; the consumer mounts `LVSHangoutSessionProvider` with `lvs` and
  passes the session back as `media`) and `useIncomingDocumentCalls` (FIFO
  rings, 60 s TTL, `accept` / `decline(reason)` / `dismiss`).
- event-catalog 0.8.2 declares the new frames (`document-calls` bundle).

## 0.95.11 — 2026-09-25

- **server/crdt:** `copyDocument` claims the new document's channel for the
  requester's node (as `seedDocument` does) before writing its snapshot, and
  releases it after — an owner-gated snapshot store refused the write
  otherwise, so every copy on the gateway failed with `copy_failed`.

## 0.95.10 — 2026-09-25

- **server/crdt:** `copyDocument { documentId, requestId, title? }` — needs
  `read` on the source and `create`; makes a new document (source type, icon,
  description, conversation; title `<source> (copy)` unless given; owned by the
  verified actor) with a clone of the source's CRDT content (meta `id`/`title`
  rewritten, `importSourceRevision` dropped), snapshotted before it is
  announced. Answers `documentCopied { requestId, sourceId, document }` or
  `documentCopyFailed { requestId, sourceId, error, code }` (code
  `invalid_request | unauthenticated | forbidden | not_found | copy_failed`);
  broadcasts `documentCreated` and does not announce in a conversation. A
  failure after the row was written deletes it.
- **client/documents:** `useDocumentFolders` soft-delete trash — placements
  carry `trashedAt?`/`trashedBy?`; trashed documents are counted nowhere
  (folder counts, tree, `unfiled`, `totalCount`); new `trashed` (newest first),
  `isTrashed(id)`, `trashDocuments(ids)` and `restoreDocuments(ids)`
  (optimistic, rolled back on refusal) over the gateway's `document-folders`
  `trashDocuments`/`restoreDocuments`.

## 0.95.9 — 2026-09-25

- **client/documents:** `useDocumentSearch` asks for `fresh=1` on a
  `refreshKey` change or `refresh()`, so a document the host just created is in
  the answer (the server otherwise answers from a 10 s row cache).

## 0.95.8 — 2026-09-25

- **client/documents:** `useDocumentSearch({ apiBaseUrl, idToken, query, sort,
  filters })` over platform-api `GET /api/document-search` — ranked (title >
  summary > body, recency tiebreak), paged by cursor (`loadMore`), scoped to
  documents the viewer may read. The words are debounced (200 ms), every new
  request aborts the one in flight, `refreshKey` re-reads the first page. Plus
  `fetchDocumentSearch`, `documentSearchUrl` and the normalizers
  (realtime-examples NFR #230).

## 0.95.7 — 2026-09-25

- **client/documents:** `useLinkedDocumentWork(ids, opts)` — the work rows of
  the documents an item links to, kept live on each linked `doc-work:<id>`
  (re-reads only the signalled row). A 403/404 read lands in `restricted` and is
  never subscribed, so a viewer learns neither the title nor the status of an
  item they cannot read (realtime-examples NFR #137, Loop 37 activity).

## 0.95.5 — 2026-09-24

- **client/deck revise:** a `waiting-for-model` phase, labelled "Waiting for a
  model slot" — the platform's revise waits its turn when every fleet-wide
  model slot is taken (realtime-examples Loop 35 ppt).
- **client/pipelines:** `pipeline.step.waiting` (reason `model-slot`) reads as
  the running step "· Waiting for a model slot" with its place in line
  ("Next in line", "3 in line"); `state: 'granted'` returns to the plain step
  label.

## 0.95.4 — 2026-09-24

- **server/crdt:** `createDocument` with `meta.announce: false` files the
  document in `meta.channel` (that conversation's members can open it) without
  calling `onDocumentCreated`, so no card is posted in the conversation. Omitted
  or `true` keeps today's behaviour. (realtime-examples Loop 33: the deck
  preview script shares a test deck with #general without posting there.)

## 0.95.3 — 2026-09-24

- **client:** `usePresentationRevisions({ apiBaseUrl, documentId, idToken,
  focusRevisionId?, pageSize?, transport?, fetchImpl? })` — a deck's revisions
  a page at a time (`GET …/revisions?limit&before`, newest first; the head
  alone with its slides), `olderCount` / `loadOlder`, a focused revision read
  on its own. One module cache per (api, deck, signed-in person): every view
  of a deck reads the head page once between them. A revision written while
  open (`revision-written`, NFR #15) is prepended with one
  `GET …/revisions/:rev`; a gap re-reads the head page. Moved from the
  realtime-examples frontend (`usePresentationDocument`). Also
  `mergePresentationRevisions`, `releasePresentationRevisions`,
  `PRESENTATION_REVISION_PAGE_SIZE`.

## 0.95.1 — 2026-09-23

- **client/pipelines:** a run's steps follow its pipeline's order, without the
  trigger. `stepsFromSnapshot` orders by the definition (edges, node order for
  ties) when one is known — the run's own `pipelineDefinitionSnapshot`, or the
  new `StepLabelTables.definitions` — and by `startedAt` otherwise; trigger
  nodes are dropped. `usePipelineRunStatus` reads `GET /api/pipelines/:id`
  once per pipeline, only when a snapshot leaves the order a guess
  (`snapshotNeedsStepOrder`: a step without a start time and no definition on
  the run), and re-orders the card when it lands. New exports
  `orderStepsByDefinition`, `snapshotNeedsStepOrder`,
  `PipelineStepOrderDefinition`. realtime-examples NFR #158: a deck-revise
  run card read "Composer edit, Check the edit, Read the deck…".

## 0.95.0 — 2026-09-23

- **client/pipelines:** `usePipelineRunStatus` stops polling what its frames
  already carry. With a live transport a running run is re-read every
  `livePollMs` (new, default 30 s; never faster than `pollMs`) instead of every
  1.5 s; with none, `pollMs` as before. Nothing is re-read while the tab is
  hidden (one read on coming back), and a settled run never is. A snapshot's
  new `executorRunId` (an /agent loop's accept-time row pointing at the run
  that executes it) subscribes that run's `pipeline:run:<id>` channel too and
  lands its frames on the card that asked. realtime-examples NFR #136: an idle
  chat with six old loops made 104 reads in 20 s.

## 0.93.0 — 2026-09-23

- **client/documents:** `useRunDraft` returns `startNew()` and `history`.
  `startNew()` clears the shown draft (`phase: 'none'`) and mints a fresh
  requestId, so the Run draft pane can start a second draft after one was
  dispatched. The draft that was showing moves to `history` (newest first); its
  `doc:run_draft_updated` signals keep that entry current, and list re-reads
  (reconnect, other drafts' signals) never bring it — or anything older — back
  as the current draft. Refused while a dispatch is in flight. Additive.

## 0.92.0 — 2026-09-23

- **work-graph (NFR #126):** `ViewerWorkActivityDetail.pause?: WorkRunPause`
  (`{ reason: 'awaiting_approval' | 'paused_at_breakpoint'; step?: string }`)
  — why a `waiting` run is waiting, so a card can say "Needs approval" or
  "Paused at write" instead of a bare "Waiting". Optional and additive;
  `validateWorkGraphSnapshotV2` accepts it only on a run/agent node whose
  status is `waiting` (a resumed run carries none), with a label-length step.

## 0.90.0 — 2026-09-23

- **client/documents (new subpath, also re-exported from `./client`):** the
  Documents four-pane Work / detail / Run draft view's data (realtime-examples
  `docs/design/documents-detail/PLAN.md` §2), field names exactly as the plan
  fixes them: `DocumentWork` (status · points · ownerId · priority · rank ·
  outcome · criteria · links · fieldRevisions · revision), `RunDraft`,
  `RunEstimate`, the list row / rollup, criterion and link ops.
- Pure REST helpers for scripts: `fetchDocumentWork`, `patchDocumentWork`,
  `fetchWorkList`, `fetchRunDrafts`, `fetchRunDraft`, `putRunDraft`,
  `dispatchRunDraft`, `cancelDraftRun`, `fetchRunEstimate`; plus
  `applyWorkUpdate`, `groupWorkRows` ("Not planned" for no status),
  `pointsRollup`, `runDraftPhase` (dispatching > 60 s = unconfirmed),
  `normalizeRunEstimate` (`null` = "No prior runs").
- Hooks: `useDocumentWork(documentId, opts)` — optimistic PATCH queue with
  rollback, 409 → `conflict` + re-read; `useWorkList(scope, opts)` — grouped
  rows, header rollup, live `activeRun` from `pipeline:all`;
  `useRunDraft(documentId, opts)` — the draft id is the request id, minted once
  per draft, concurrent dispatches share one request, `stop` cancels the run;
  `useRunEstimate(pipelineId, model, opts)` — cached per page until a run of
  that pipeline completes.
- Live: the gateway's id-only `doc-work:<id>` / `doc-work-scope:<scope>`
  signals (`doc:work_updated`, `doc:run_draft_updated`) make a hook re-read the
  ONE record; every hook re-reads once per reconnect epoch; no polling.
  Subscribed through the gateway's `doc-work` service (realtime-examples
  `src/realtime-fanout/doc-work-service.ts`), which checks document read access.
- `acquireChannelSubscription`: refcounted subscribe per transport, re-sent on
  a new session epoch. `usePipelineCatalog` now uses it for `pipeline:all`, so
  the catalog, the Work list and the estimate share one subscription (and
  `pipelineAllSubscribeFrames` is exported).

## 0.88.0 — 2026-09-23

- **client/pipelines:** the pipelines directory has one home for its vocabulary
  (realtime-examples `docs/design/pipelines-page/PLAN.md` §2). `catalog.ts`
  exports the `WorkType` / `PipelineKind` enums with `WORK_TYPE_LABEL`,
  `WORK_TYPE_ORDER`, `KIND_MARK`, `KIND_WORK_TYPE`, `KIND_LABEL`, the
  `PipelineOrigin` shape, and the last-run `PipelineRunRollup` platform-api
  keeps beside each definition (`lastRunId`, `lastRunAt`, `lastRunStatus`,
  `recent` ≤ 5, `failedOfRecent`, `runningCount`, `runCount`, `updatedAt`) —
  names and values reconciled with platform-api's `definition-metadata.ts` and
  `run-rollup.ts` as built.
- **client/pipelines:** `summarize` flattens an entry into what a row reads
  (`failedCount`, `totalCount`, `pendingApprovals`, `runningCount`, `mark`,
  `route`); `groupCatalog` / `groupByWorkType` order the groups by the enum,
  omit empty ones, count each, and sort rows in-flight first, then newest
  run; `statusPillFor` gives the pill's `{ tone, label, meta, text }` —
  "Published", "1 of 5 failed · 29m ago", "Failed · 10h ago", "Draft",
  "Running · 3m ago" — with `relativeTime` shaped like the host formatter.
- **client/pipelines:** `applyRunEvent` is platform-api's rollup merge rule
  ported line for line (an older or replayed event changes nothing, terminal
  is final, a run older than the full window is history), so the browser's
  copy converges with the row without a refetch; `runEventFromFrame` turns a
  gateway `pipeline:event` frame (`pipeline.run.started|resumed|completed|
  failed|cancelled|orphaned|stuck`, either spelling) into that event.
- **client/pipelines:** `usePipelineCatalog({ apiBaseUrl, idToken, transport?,
  sessionEpoch? })` reads `GET /api/pipelines/defs?include=rollup` once,
  subscribes `pipeline:all` over the same transport seam `usePipelineRunStatus`
  uses, merges every run frame into the matching entry's rollup, and on each
  new session epoch resubscribes and refreshes exactly once. Returns
  `{ entries, summaries, groups(by), loading, error, refresh }`.
- **client/pipelines:** `generatePipelineDraft(apiBaseUrl, idToken, { instruction,
  action: 'draft' | 'draft-and-run', hints?, model?, contextBudgetTokens?,
  context?, requestId? })` posts `/api/pipelines/defs/generate` with the
  request id in the body and as `Idempotency-Key` (generated by
  `newPipelineDraftRequestId` when absent), and surfaces a 422's
  `invalid_instruction` / `planner_failed` as `code` + `detail` on the error.
- All of the above is also exported from `./client`.

## 0.86.1 — 2026-09-23

- **fileupload:** an aborted `FileBlobStore.putStream` (over the cap, or the
  source erroring mid-upload) no longer leaves an empty blob behind. The
  cleanup unlinked the target as soon as it destroyed the write stream, but
  the stream opens its file asynchronously, so a late open re-created the file
  after the unlink — 3 of 20 aborts in a plain loop, and the cause of
  realtime-examples' two flaky upload-route tests (NFR #91). The unlink now
  waits for the stream's `close`; the rejection follows it.

## 0.86.0 — 2026-09-23

- **work-graph:** a stream's first frame can be a patch against the snapshot
  the reader already holds (realtime-examples NFR #85). `useWorkGraph` asks
  the snapshot with `activity.viewBase: 1`; a platform that answers with
  `viewHash` has published that view for the gateway, and the hook seeds its
  patch base from the snapshot and forwards `baseViewHash` on the socket
  request. Without `viewHash` nothing changes (first frame whole).
- **work-graph:** `WorkGraphSnapshotV2.viewHash?` (43-char base64url);
  `validateWorkGraphSnapshotV2` accepts it and rejects anything else in it.

## 0.85.0 — 2026-09-23

- **server:** a document's owner display name is persisted on the row
  (`DocumentMeta.ownerName`, written at creation, carried through renames,
  never taken from an `updateDocumentMeta` payload) and `_toWire` reads it
  before the per-process sidecar — "Owned by …" survives a restart and reads
  the same on every replica (realtime-examples NFR #80).
- **server:** `MetadataStore.setOwnerNameIfAbsent?` (optional) +
  `DocumentMetadataService.backfillOwnerNames`: rows from before the field
  are named when their OWNER lists documents, one conditional
  single-attribute write per row. `MemoryMetadataStore` implements it.

## 0.84.0 — 2026-09-23

- New `reset-required` reason `source-unavailable`: the gateway could not reach or hear back
  from the platform (5xx, timeout, refused, not ready). It is not an access change, so
  `useWorkGraph` keeps the graph on screen and refetches, like `gap`/`replay-unavailable`.
  Only a proven access change arrives as `invalidate`.
- `useWorkGraph` keeps the last authorized graph through transient failures (dropped socket,
  5xx/timeout snapshot) until `outageGraceMs`; past it the graph clears with the error. A
  refusal (401/403/404) and every `invalidate` still clear at once. Every retry re-authorizes
  through a fresh snapshot.

## 0.83.2 — 2026-09-23

- `useWorkGraph` abandons a snapshot request after `snapshotTimeoutMs` (10 s) and retries it as
  a transient failure. Live, a GET into a restarting gateway hung 30 s, long enough for the
  host's 20 s stall guard to show "unavailable" although the retry loop was healthy (NFR #68).

## 0.83.1 — 2026-09-23

- View patch wire format, measured live: `order` is a list of indices into the list
  upsert/remove produced, not ids (an edited detail moving to the top sent 60 ids, 4.7 KB of a
  9.3 KB frame), and `eventBuckets` is a keyed list patch by `at` instead of the whole array
  (1.7 KB). 0.83.0 patches are not read by 0.83.1 and vice versa; only the gateway at
  realtime-examples e29039f5 ever sent them.

## 0.83.0 — 2026-09-23

- Work-graph view patches (NFR #66). New shared `diffWorkGraphViewV2` /
  `applyWorkGraphViewPatchV2` (`@connorhoehn/realtime-modules/work-graph`): a keyed patch of
  the v2 activity view (efforts by `id`, details by `nodeId`: upsert, remove, order only when
  it moved; the small fields travel whole). `useWorkGraph` v2 sends `viewPatch: 1` on its
  socket request and applies `batch.viewPatch` against the view of the last stream frame
  (`baseWatermark`); a patch for any other base resyncs from a snapshot with the graph kept.
- `useWorkGraph` retries transient failures (NFR #68): a snapshot error without a 4xx status
  (5xx, refused connection, timeout, 408/429) and a dropped/errored socket back off
  exponentially from `reconnectDelayMs` to `retryMaxDelayMs` (15 s) with jitter, reset by the
  next good snapshot. `error` is reported only once the outage has lasted `outageGraceMs`
  (20 s), and retrying continues after that. A 4xx refusal (401/403/404…) is still final.

## 0.82.1 — 2026-09-23

- `useWorkGraph` (schemaVersion 2) applies the gateway's v2 delta frames. Every v2 batch
  carries the refreshed activity `view` beside the v1 operations, and the hook ran it through
  the v1 validator, whose exact-key check rejected the `view` key — so the hook recovered
  with a full snapshot refetch on EVERY change, and no v2 panel ever applied a delta. The
  graph half now goes through the v1 reducer and the view is validated against the graph the
  delta produced, with the v2 snapshot validator (every effort member, detail and lease must
  be a node/edge the viewer holds); an invalid view still recovers.

## 0.82.0 — 2026-09-23

- Presence: one entry per socket, shared by every presence user (`presenceEntry.ts`). The
  gateway keeps ONE presence entry per client and every `set` replaces it whole, so the
  app-wide chat presence and a document's presence clobbered each other's channels and
  metadata. `usePresence(channel, { join: true })` now joins the channel (refcounted),
  announces on mount and after each reconnect, and leaves on unmount; every frame carries the
  union of joined channels and the merged metadata (`null` removes a key). Leaving sends a
  `set` still listing the channel with `metadata._left: [channel]` (peers drop you) and then
  one without it. Exported helpers for raw senders: `joinPresenceChannel`,
  `presenceSetFrame`, `presenceLeaveFrames`, `joinedPresenceChannels`, `resetPresenceEntry`,
  `PRESENCE_LEFT_KEY`. Without `join` the hook behaves as before, except its frames keep the
  socket's joined channels and metadata instead of replacing them.

## 0.81.0 — 2026-09-22

- `useDeckReviseStatus` follows composer edits that run as pipelines
  (`POST /api/deck/revise-run`, REVIEW.md "Composer edits run as pipelines"): new phase
  `saving` ("Saving the new revision"); each activity carries `pipelineRunId` (kept from the
  first event that names it), and on `completed` the `revisionId` the pipeline wrote (`null`
  when nothing changed) and `rebasedOnto`; on `failed` a `code` (`revision-conflict`).
  Additive — frames from the older `/api/deck/revise` read exactly as before.

## 0.80.0 — 2026-09-22

- `useAgentLoopRun(runId, { apiBaseUrl, idToken, transport?, pollMs? })`: one agent loop
  for a task card or strip — `phase` (planning/running/completed/failed/cancelled/budget),
  `steps`, `currentStep`, `stepsDone`/`stepsTotal`/`percent` (a count of steps, not a time
  estimate), `startedAt`, `canStop` + `stop()`. Reads platform-api `GET /api/agent-loops/:runId`,
  re-reads (debounced) on the run's `pipeline:event` frames on `pipeline:run:<executorRunId>`,
  and polls every 5 s only while the loop is live. `canPause` is `false` with the platform's
  `pauseUnsupportedReason`: the platform answers pause/resume with 501.
- `useDeckReviseStatus(documentId, { transport? })`: in-flight `POST /api/deck/revise` edits on
  a presentation from any tab — `active`, `recent`, `latest`, `generatingSlideIds`,
  `isGenerating`, `get(requestId)`. Listens on `pipeline:run:deck-revise:<documentId>` for
  `pipeline.deck.revise.{started,phase,completed,failed}`; phases `started → reading-sources →
  asking-model → checking → completed|failed`, each with a label; an edit with no terminal
  event for 60 s goes `stale`. Pure helpers `reduceDeckReviseFrame`, `markStaleDeckRevises`,
  `deckReviseChannel` exported for hosts that own their own socket.

## 0.79.2 — 2026-09-22

- `useReactions`: an empty channel (a host whose channel has not resolved) sends no
  subscribe/unsubscribe/send/remove frame; the gateway answered each with
  `SERVICE_INTERNAL_ERROR` "Channel name is required".

## 0.79.1 — 2026-09-22

- `useWorkGraph`: a server `reset-required` for `gap`/`replay-unavailable` keeps the last
  authorized graph on screen until the refetched snapshot lands (a failed refetch still
  clears it). Invalidations, `scope-changed`, malformed frames and socket closes still
  start from an empty graph.

## [Unreleased] — document integration contracts

- Add short-lived Ed25519 document grants with tenant/document/operation binding and authoritative session-epoch verification across transports.
- Await operation-aware CRDT authorization, filter document listings/presence, and add single-owner idempotent binary canvas seeding.
- Acknowledge correlated updates only after durable snapshot commit; expose pending/error/retry state separately from initial sync and preserve pending updates across reconnect.
- Share canvas extension assembly and headless schema-aware seed conversion, preserving front matter and image/table nodes.
- Add an explicit document-grant WebSocket protocol and asynchronous upload authorization seam.


## 0.69.4 — 2026-09-20

- Canvas import and Markdown paste now use the live editor schema: GFM tables
  become native TableKit nodes; images retain source URLs, alt text and titles,
  including assessment `attachment:` references. Block-image schemas split
  surrounding prose safely; inline-image schemas retain inline placement.
- Export reconstructs Markdown tables and images instead of flattening cells or
  dropping image nodes. Table alignment survives when CanvasTextAlign is present.
- Schemas without the required extensions retain source Markdown visibly and
  report unsupported content. Linked images also retain both URLs as Markdown:
  the Yjs bridge currently drops marks on image atoms. Rich layout such as cell
  spans/fonts remains in binary Yjs storage, not losslessly in GFM exports.
- Added real-schema, binary-restore and actual-hook regressions. All 1,355 tests
  pass; TypeScript build and all 29 export checks pass. Table/Image peers are
  test-only dependencies; consumers continue to supply their own extensions.

## 0.69.3 — 2026-09-20

- CRDT subscription admission now honors an explicit `false` from the supplied
  router. Rejected clients receive no hydration, snapshot or subscription success.
  Legacy routers returning void remain compatible. The TypeScript router contract
  now accepts boolean admission results, matching the existing gateway.
- Destroy test awareness clients after each ledger case so the full test process
  exits normally. Validation: 1,342 tests pass; build and 29 export checks pass.

## 0.69.2 — 2026-09-20

- Failed or corrupt durable snapshot reads now reject instead of producing an
  empty editable document. `retrieveLatestSnapshot`, `hydrateYDoc` and
  `handleListSnapshots` callers must handle rejection; only a missing snapshot
  represents a new document or empty history.
- Concurrent subscribers and direct updates share one pending hydration per
  channel. Updates load existing durable content before accepting new edits.
  Failed loads discard incomplete state, roll back the router subscription and
  allow retry after storage recovers. Remote updates remain buffered while loading.
- Corrupt hot-cache data falls back to durable storage. Yjs bytes are validated
  on a temporary document before applying them to live state. Incomplete loads
  cannot be checkpointed over the durable document.
- Validation: five new regressions reproduced the previous behavior; all 1,341
  tests passed and exited cleanly. After preserving the remote subscription
  ordering, all 13 focused hydration/policy/commit tests pass; build and all 29
  published export checks pass. Multi-writer fencing and full document policy
  remain separate work.

## 0.69.1 — 2026-09-20

- CRDT updates and awareness now consult the supplied channel policy on every
  call, including direct handler calls and policy revocation after subscribing.
  A denied subscription can no longer be followed by an unchecked update.
- `SnapshotManager.writeSnapshot` now rejects durable-store failures. Callers
  making explicit saves must handle rejection; background timers/sweeps catch
  failures and retain dirty state for retry. Failed pre-clear/pre-restore
  checkpoints stop those operations before replacing the current document.
- Snapshot writes serialize per channel. Edits arriving during a write remain
  dirty, and the cache is populated only after durable persistence succeeds.
- Named saves return the actual stored timestamp. Same-process version keys
  increase monotonically, preventing same-tick manual versions from colliding.
- This is not complete document authorization or multi-writer fencing. The
  hook still defaults to permissive; deployments own collection/history policy.
  Snapshot author/type metadata and cold-store read-failure semantics remain
  separate adoption gaps.
- Validation: 1,336 tests passed; build and 29-subpath export verification passed.
  The full Jest run retained handles after completion; the eight new regressions
  exit cleanly with `--detectOpenHandles`.


## 0.69.0 — 2026-09-18

- **`useActivity` gains `publish`** — the write half of a feed that could only
  be read.

  `ActivityService` has always accepted `{ service: 'activity', action:
  'publish', event: { eventType, detail? } }`. The hook exposed `events` and
  `loadHistory` and nothing else, so recording an event meant dropping to
  `useGateway().send()` and hand-rolling an envelope this hook already owns.

  `publish(eventType, detail?)` takes the type and the detail. It cannot take
  more: the server stamps `timestamp`, `userId` and `displayName` from the
  connection's own auth context, so a client cannot publish as somebody else.
  The event returns through the normal broadcast — the publisher is not
  excluded from it — so `events` fills from the server's enriched copy rather
  than an optimistic local one, and shows what every other subscriber sees.

  No `satisfies` annotation on the send-site: event-catalog declares this
  service's subscribe, unsubscribe and getHistory but not publish. The verb is
  real on both servers — EC declares the inbound `ws.activity.published` as
  "confirmation sent back to the client that published an activity event" —
  so the omission is a gap in the catalog's outbound set, not a missing
  capability. The cursor verbs sit on the same footing.

  Checked against a running server: the frame the hook sends comes back as a
  broadcast carrying `userId: 'u-ada'` plus the `activity/published` ack.


## 0.68.4 — 2026-09-18

- **`useActivity` was documented as channel-scoped and is not.**
  Documentation and a test; no behaviour change.

  The hook takes a channel, and the README's hook table answered "Yes" under
  Channel-scoped. Live events are global: `ActivityService` publishes every one
  to a single `activity:broadcast` channel that every connection is
  auto-subscribed to on connect, and neither the envelope nor the payload
  carries a channel to filter on. `useActivity('room:1')` shows you events
  published from `room:2`.

  Measured rather than read: two clients subscribed to different channels, one
  publishes, both receive it.

  This is not a bug in the service — the hook's own header explains the design
  and why per-frame filtering is impossible. It is a bug in what the README
  told people, and the consequence is a real one: a per-room feed built on
  that promise shows every room's activity to every viewer, including rooms a
  viewer has no part in.

  The hook row, the `./activity` subpath row and the recipe now say so, and the
  hook table's preamble defines "channel-scoped" as what a hook RECEIVES
  rather than what it subscribes with. `channel` still scopes `loadHistory`,
  which does carry `channelId` — so the replay is per-channel while the live
  tail is not.


## 0.68.3 — 2026-09-18

- **The notifications recipe documented the receiving half and not the
  sending half.** Documentation and tests.

  Attach `notifications()`, mount `useNotifications()`, and nothing ever
  arrives — because a notification is created by your own server code calling
  `notifyUser`, and the recipe never mentioned it. It is a method on the
  service rather than a WS action, which is right: who gets notified is the
  app's decision, not a frame the browser sends. `attachRealtime` exposes it
  as `handle.services.notification`.

  Verified live before writing it down: `notifyUser` delivers
  `notification:new` in exactly the payload-nested shape `useNotifications`
  parses, and two tests pin that — including that a different user gets
  `delivered: 0`.

  The recipe now covers it, and says what `delivered: 0` means: not an error,
  just nobody with a tab open.

- **Read state never leaves the device, and nothing said so.**

  `useNotifications` sends nothing at all — `markAsRead` moves a mark in local
  storage. The service has `markRead` / `markAllRead` actions and no hook
  calls them, so a notification read on a laptop still shows unread on a
  phone. Documented in both the recipe and the hook, rather than changed:
  making the hook send would be a behaviour and product decision, not a fix.

  The hook's header also still claimed "the gateway won't emit these until
  M3+; the server-side wiring is deferred". `NotificationService` ships in
  this package and emits them today.


## 0.68.2 — 2026-09-18

- **Eight hooks behind the media subpaths were documented nowhere.**
  Documentation and guard only.

  The hook-coverage check added in 0.52.x only ever looked at `./client`, so
  everything behind `./client/video`, `./client/voice` and
  `./client/media-effects` was free to drift unmentioned — and did:
  `useLVSContext`, `useLVSHangoutShared`, `useLVSRecordings`,
  `useLVSViewerCount`, `useLVSHlsPlayer`, `useLiveCaptions`,
  `useVoiceCapture`, `useMediaEffects`. A subpath having its own barrel is not
  a reason for its API to be undiscoverable.

  The README now carries a short table per media subpath, next to the main
  hook reference but separate from it, since these do not come from `./client`
  and talk to a live-video-streaming deployment rather than to
  `attachRealtime`.

  `verify-exports` grows a fifth check covering those subpaths. It accepts a
  mention anywhere in README or `docs/` rather than demanding a table row,
  because these are described in prose and recipes and forcing them into the
  `./client` table would blur the boundary the subpaths exist to draw.


## 0.68.1 — 2026-09-18

- **Disconnect cleanup ran before a client's in-flight frames finished**,
  leaving a permanent phantom in the presence roster.

  A close is another event on the same connection, and it arrived after those
  frames. Running cleanup first lets a frame complete for a client every
  service has already forgotten — and re-register it.

  Presence is where it shows: `onClientDisconnect` marks the entry offline and
  schedules eviction, then the queued `presence/set` lands and marks it ONLINE
  again. No further close will ever fire for that connection, so it sits in
  every subscriber's roster forever. The offline filter added in 0.66.0 cannot
  catch it, because the status is online.

  Measured against a real server: a client subscribes, sends a slow frame and
  a presence update, then hard-drops. Three seconds later the roster still
  read `online`. With the fix it reads `offline` — the ordinary tombstone the
  eviction path and the 0.66.0 filter already handle.

  A closing connection now waits for its own queue before tearing down,
  bounded at five seconds so a handler that never settles cannot hold cleanup
  open with it. An idle queue closes immediately, which the third test pins.


## 0.68.0 — 2026-09-18

- **Frames from one connection were handled concurrently, not in order.**

  `ws.on('message', async …)` reads as sequential and is not: an EventEmitter
  never awaits a listener, so the next frame began while the previous one sat
  in its first await. Two frames sent back to back finished in whichever order
  their awaits happened to resolve.

  Measured on a real server with a service whose delay the frame dictates:
  send `leave` (60 ms) then `join` (0 ms) and the handler log reads
  `start:leave → start:join → end:join → end:leave`. The leave lands last, so
  the client is joined and then immediately un-joined.

  That is the reconnect path exactly. Every channel hook sends `leave` then
  `join` on a new session, and whether the client ends up subscribed depended
  on which handler's awaits resolved first — a coin flip that a slower store
  (DynamoDB, Redis) biases the wrong way. It undercuts 0.65.0, which existed
  to stop exactly this silence. Two `send` frames in quick succession could be
  persisted out of order for the same reason.

  Each connection now has a promise chain: its frames serialise, other
  connections stay concurrent. That is the right granularity — the websocket
  delivered these in order, and honouring that ordering is the server's job. A
  frame that throws is caught so it cannot stall the ones behind it.


## 0.67.1 — 2026-09-18

- **A reconnect emptied the activity feed and left it empty.** Same root as
  0.67.0, worse outcome.

  `useActivity` cleared its events when the subscribe effect ran, which was
  harmless while that only happened on mount. 0.65.0 made it run on every
  reconnect.

  Chat at least gets something back — join auto-pushes recent history. An
  activity subscribe pushes nothing: the server answers with a bare
  `subscribed` ack. So the feed was cleared and nothing refilled it. Every
  network blip wiped the panel for good, with no event, no error and no way
  for the app to notice.

  A reconnect no longer clears. Those events are still true — they happened,
  and a new socket does not un-happen them — and live events resume appending
  on the new connection. A channel change still clears, because that is a
  different read.

  For the gap while the socket was down, a caller who had used `loadHistory`
  gets it re-asked at the same depth. Only that caller: a history frame
  REPLACES the list, so re-asking unprompted would discard the live events
  this change just protected.


## 0.67.0 — 2026-09-18

- **A reconnect cut `useChat` back to twenty messages.** Introduced by 0.65.0;
  fixed here.

  Joining a channel auto-pushes the server's `joinHistoryLimit`, twenty by
  default, and a `history` frame REPLACES the hook's list rather than merging
  into it. Both were true before 0.65.0 and harmless, because the join effect
  only ever ran on mount.

  Making every reconnect re-join turned that into a visible loss: a reader who
  had called `loadHistory(200)` and scrolled back through a conversation
  dropped to the last twenty the moment the network blipped, with no event, no
  error and nothing to restore from. The hook exposes no reconnect signal, so
  the app could not put it back either.

  `useChat` now remembers the limit `loadHistory` was last called with and
  re-asks for it after a re-join. Only after a reconnect — a first mount and a
  channel change both start from the join push, as before — and only when the
  caller had actually asked for history. An omitted limit travels across as
  omitted, so "the server's default" stays the server's default rather than
  becoming a number this hook invented.


## 0.66.1 — 2026-09-18

- **A test I added in 0.51.x started failing at midday.** Fixed; it was mine.

  The membership suite's frozen-clock case spied on `Date.now` to pin the
  history floor, but a message is stamped with `new Date().toISOString()`,
  which that spy does not touch. So the message carried the REAL time while
  the floor carried the frozen one, and the test only passed while the wall
  clock happened to sit before 2026-09-18T12:00:00Z. Once it went past, the
  message sorted after the floor and the assertion inverted.

  It now uses `jest.setSystemTime`, which fakes `new Date()` as well, with
  timers left real since ChatService runs a periodic cache sweep this test has
  no reason to drive. Verified by running it pinned to 2020 and to 2099 — a
  test about a millisecond collision should not care what day it is.

- **The chat recipe's graduation section named one of three stores.**

  It taught `chat({ store })`, which is the deprecated spelling of
  `chatStore`, and said nothing about the other two. `membershipStore` is the
  one that matters: it has NO default, so leaving it out means `addMembers` is
  refused — "Membership is not enabled on this gateway" — and every channel
  stays readable by anyone who joins. A consumer following the recipe and
  expecting private channels gets that error with nothing in the docs
  explaining it.

  That default is deliberate, not a bug: membership is opt-in and the service
  says so plainly when you try to use it unwired. The recipe now says so too,
  and covers `readReceiptStore` alongside it.


## 0.66.0 — 2026-09-18

- **`usePresence` showed a ghost for every client that dropped during its
  subscribe.** After 0.65.0 the commonest ghost is you, right after your own
  reconnect.

  `PresenceService` does not delete a dropped client immediately. It marks the
  entry `offline`, broadcasts a departure, and evicts only after a grace
  window so a quick reconnect does not flap the roster. The eviction itself
  broadcasts nothing.

  The hook handled the departure broadcast correctly — that path deletes — but
  took the subscribe SNAPSHOT verbatim, tombstones included. So a client that
  subscribes during someone's grace window receives the tombstone, missed the
  departure that preceded it, and is never told again: the ghost stays for the
  rest of the session.

  Reconnect is the ordinary way to land in that window. The hook re-subscribes
  on the new socket (0.65.0), the snapshot still carries the old connection's
  tombstone, and the user sees a second copy of themselves — a roster that
  counts two people in a room holding one.

  The snapshot now drops `offline` entries, which is what the departure path
  already did. `away` and `busy` are untouched: those are members who stepped
  out, not corpses.

  Found by driving a real server — connect, hard-drop the socket, reconnect,
  re-ask for the roster — which came back holding two entries for one user.


## 0.65.1 — 2026-09-18

- **`useChatMembers` and `useChatReadReceipts` were left out of 0.65.0.** Same
  defect, same fix.

  Both ask for their state once and are answered once — nothing is pushed on
  join, as `useChatReadReceipts` says in its own header. Both opened that
  request from an effect whose `refresh` is `useCallback(…, [send])`, so like
  the five hooks fixed in 0.65.0 it ran on mount and never again.

  The symptom differs: not silence but staleness. After a reconnect the roster
  and the receipts are whatever they were before the drop, so anyone added or
  removed while offline, and any message read while offline, is invisible for
  the rest of the session. For members that is worse than cosmetic — being
  removed while disconnected leaves a client that still shows itself as a
  member and still lets you type, until the send comes back `not-a-member`.

  Both now carry `sessionEpoch` in those deps. Checked the rest of the surface
  while here: `useFileUpload` holds no subscription of its own and rides
  channel membership, so 0.65.0 already covers it; `useVideoHangout` sends
  only on user action; `usePins` reads over REST and never had a socket
  subscription to lose.


## 0.65.0 — 2026-09-18

- **Channel hooks never re-subscribed after a reconnect.** `useChat`,
  `usePresence`, `useActivity`, `useReactions` and `useCursor` went silently
  dead after any network blip.

  A reconnect is a new server-side connection that has joined nothing. Each
  hook opened its subscription from an effect keyed on `[channel, send]`, and
  `send` is `useCallback(…, [])` — stable for the hook's whole life. So the
  effect ran once, on mount, and never again. The socket came back,
  `connectionState` read `'connected'`, the UI looked healthy, and the channel
  delivered nothing for the rest of the session. No throw, no log, no error
  frame.

  `useWebSocket` had already assigned the responsibility, in a comment next to
  its auto-resubscribe: "the gateway's pull model leaves subscribe lifecycle to
  feature hooks". No hook had a signal to act on.

  `UseWebSocketReturn.sessionEpoch` is that signal — it increments on the first
  connect and on every reconnect. The five hooks include it in their subscribe
  deps.

  It is OPTIONAL on the type on purpose. An app may bridge its own socket onto
  `GatewayContext` instead of mounting the provider, which `./client`
  documents, and those context objects are built by hand; requiring the field
  would break every one of them at compile time to add something they cannot
  meaningfully supply. Undefined means "no session signal", and a hook then
  behaves exactly as before — which is correct, because that caller owns the
  socket's lifecycle.

  Eight tests drive the real socket path rather than a fake send/onMessage
  pair, since the bug lived in the seam between them: each hook re-subscribing
  on a fresh socket, three reconnects in a row, re-joining the channel the hook
  is on NOW rather than the one it mounted with, and no churn for a
  socket-explicit caller.


## 0.64.0 — 2026-09-18

- **Every chat, cursor, reaction and CRDT refusal read as "UNKNOWN / Gateway
  error".** `useWebSocket` parsed one of the two error shapes on the wire.

  Two shapes exist, and `@connorhoehn/event-catalog`'s `ws.error` declares both
  with the ground truth written into it: chat, reaction, cursor and crdt nest
  under `error: { code, message, … }`; presence and activity send a flat
  top-level message. `createWsHandler`'s own refusals are flat too.

  The parser read only the flat one. So `SERVICE_NOT_AVAILABLE` came through
  perfectly — which is why this was never noticed — while `not-a-member`,
  `forbidden`, "Channel name is required" and every other service-level
  refusal landed as `UNKNOWN` with the message "Gateway error", the real
  reason discarded from a frame that was carrying it.

  `lastError` is the only place any of this surfaces: no feature hook exposes
  an error channel, so `useGateway().lastError` is a consumer's entire view of
  why the server said no. It now reads both shapes.

  `GatewayError` gains `service`, which both shapes carry. `lastError` is one
  slot shared by every service on the socket, so without it a chat refusal and
  a cursor refusal are indistinguishable once stored.

  Verified against a live server: the same four refusals that used to arrive
  as UNKNOWN now carry their codes, messages and originating service.


## 0.63.0 — 2026-09-18

- **The generic `subscribe` service was missing, so `useWebSocket().subscribe()`
  did nothing.** `attachRealtime` now registers it unconditionally.

  `subscribe()` / `unsubscribe()` are the whole channel API of the low-level
  hook, and `autoResubscribe` replays them on every reconnect. All of it is
  addressed to `service: 'subscribe'`, and nothing was registered under that
  name — so against `attachRealtime` every frame came back
  `SERVICE_NOT_AVAILABLE`, including the reconnect replay, which faithfully
  re-sent frames that had already been refused.

  This is channel membership, not a feature, so it is always present rather
  than something to attach. A feature you supply under the name `subscribe`
  still wins: the built-in is registered after your features and only if the
  name is free.

  The wire shape is not invented — `@connorhoehn/event-catalog` declares both
  directions, and the ack asymmetry is its contract, honoured here: a denied
  subscribe gets NO ack, because the catalog says the frame's absence is the
  signal and a client reading "no ack" as "probably fine" would believe it
  joined a channel the server refused. Unsubscribe always acks and is
  idempotent.

  `SubscribeService` and `createSubscribeService` are exported from `./server`
  for anyone wiring `createWsHandler` by hand.

  Five tests cover the acks, the silent denial, idempotent unsubscribe, the
  two error shapes, and that a consumer's own `subscribe` feature is not
  shadowed. The wire-name guard added in 0.62.0 now includes `subscribe`.


## 0.62.0 — 2026-09-18

- **Reactions and pipeline were unreachable through `attachRealtime`.** Fixed;
  this is a behaviour change on the wire key those two register under.

  `useReactions` sends `service: 'reaction'`. `reactions()` registered under
  its manifest name, `reactions`. Every frame the hook sent came back
  `SERVICE_NOT_AVAILABLE` — subscribe, send, remove, all of it. The feature
  attached, the recipe read correctly, and nothing worked. `usePipelineRunStatus`
  sends `service: 'pipeline'` against a registration of `pipeline-ws`, the same
  way.

  `defineFeature` already had `serviceName` for exactly this split, with
  `collabDocs` using it ("wire key clients address; manifest identity is
  'document-sharing'"). Reactions and pipeline now do too. `reaction` is not a
  guess: `@connorhoehn/event-catalog` declares `client.reaction.*` as the
  canonical client frame.

  The end-to-end reactions test did not catch this because it sent
  `service: 'reactions'` — the name the server had chosen. It validated the
  server against itself. It now sends what the hook sends.

  A new test asserts the client's half of the contract for all nine wire names
  a `./client` hook addresses: a frame sent to each must be routed, not
  refused. Only `SERVICE_NOT_AVAILABLE` counts as failure — what a service does
  with a nonsense action is its own business.

- **`useVideoHangout` is not the client half of `calls()`.** Documentation
  only.

  It sends `service: 'videohangout'` and this package ships no such service, so
  against `attachRealtime` every frame it sends is refused. It is the
  signalling client for a live-video-streaming deployment, which serves that
  service and returns the `joinToken` `./client/video` needs. `CallService`
  speaks an unrelated vocabulary — `{ type: 'call', action: 'invite' |
  'active-call' | 'ended' | 'forgotten' | 'user-status' }` — and has no hook.

  Four places paired them: the README subpath table, the README migration
  table, the recipes index and the calls recipe. All four now say what is
  actually true, and the calls recipe shows the `useGateway()` code that does
  work today. A test pins the refusal so this is revisited if a
  `videohangout` service ever lands here.


## 0.61.0 — 2026-09-18

- **The recipes said `chat()` gives you pins. It does not.** Documentation and
  tests only; no behaviour change.

  `attachRealtime` adds exactly one thing to your server, the WS upgrade
  listener. It mounts no HTTP routes, and two documented views need them:
  pins are channel state served over REST, and file BYTES ride a plain HTTP
  PUT rather than the socket. The conversation recipe's table listed `pins` as
  needing `chat()` and `files` as needing `chat()` + `fileUploads()`, so a
  reader attaches the feature, mounts `usePins`, and gets a read error against
  a route nobody serves. There is no pin store anywhere in this package —
  `usePins` says in its own header that it is "the client half".

  Both rows now say which routes are yours, and the recipe publishes the exact
  shapes `GatewayRest` expects for all three pin endpoints and the two upload
  ones, so it is an afternoon rather than a dead end. `FileBlobStore` is the
  disk half of the upload routes and was already exported.

  Five tests in `gateway-rest.test.ts` pin those shapes — method, path, body,
  and that an absent `sentAt` stays off the wire rather than being sent empty.
  They were internal details until the recipe published them as a contract a
  consumer implements against.

- **`rooms()` has no client hook, and the recipe implied otherwise.**

  `./client/hangout-rooms` is a REST client for a rooms API with an optional
  WS adapter that reads `{ type: 'room.member-joined' }`. `RoomService`
  broadcasts `{ type: 'room', action: 'member-joined' }`. Same events,
  different envelope, so nothing arrives — they are halves of two different
  systems that share a word. The rooms recipe now says so instead of pairing
  them, and the recipes index lists the room service's client half as "none
  yet" rather than naming `useChannel`, which never spoke those frames either.

  The index also still credited cursors to `useAwarenessState`; `useCursor`
  has existed since 0.52.0.


## 0.60.0 — 2026-09-18

- **`path` has no default, and the recipes said it did.** Documentation and
  test only; no behaviour change.

  All nine attach recipes told the reader to "point the client at the same
  origin (`/realtime` by default)", while their own server snippet passed no
  `path` at all. There is no default: `createWsHandler` filters by path only
  when one is given, and with none it calls `handleUpgrade` on every WebSocket
  upgrade the server receives.

  That is a live hazard rather than a wording slip, because `attachRealtime`
  is sold as attaching to an http.Server you already have — and a server you
  already have may already carry a WebSocket endpoint. Without `path`, that
  endpoint is claimed. Nothing errors; the other endpoint simply stops
  answering. The repo's own attach test harness has always passed
  `path: '/realtime'`, so nothing caught it.

  Every recipe snippet now passes `path` and says what omitting it costs. The
  option's own docstring carries the same warning, which is where someone
  reaching for it will actually look.

  Two tests pin the behaviour: unset claims `/`, `/realtime` and
  `/something/else/entirely` alike; set claims only its own subtree and leaves
  a co-existing endpoint answering. Note the handler cannot stop another
  listener from *seeing* an upgrade — Node runs them all — so what it controls
  is which sockets it claims, and that is what the tests assert.


## 0.59.0 — 2026-09-18

- **`./client` imports without Tiptap installed.** It could not before, and
  every Tiptap peer is declared optional.

  `import { useChat } from '@connorhoehn/realtime-modules/client'` threw
  `Cannot find module '@tiptap/y-tiptap'` for anyone who had not installed it
  — which is anyone who believed `peerDependenciesMeta`, since npm neither
  installs an optional peer nor warns about a missing one. Nothing about the
  failure pointed at chat.

  Two paths carried it, and the second was the sillier one:

  - `useCanvasDocument` imported `prosemirrorJSONToYXmlFragment` and
    `yXmlFragmentToProsemirrorJSON` from `@tiptap/y-tiptap` at module scope,
    and the `./client` barrel re-exports that module.
  - `pmModel` reached `@tiptap/core` through `MacroNode` and `schema/callout`
    purely to read `MACRO_NODE_NAME`, the callout names and
    `normalizeCalloutVariant` — a string constant and a pure function that
    happened to live next to Tiptap `Node` definitions.

  The names and the variant vocabulary now live in `canvas/nodeNames.ts`, with
  no Tiptap import; both Node modules re-export from there, so
  `./adapters/tiptap` keeps the exact surface it had. The two `y-tiptap`
  functions are loaded on use, the way `./server-ws` lazy-loads `ws`, so only
  reading or writing a canvas document needs the package.

  This is what the `./client` barrel's header has claimed all along: that
  Tiptap lives behind `./adapters/tiptap` so consumers on Monaco, CodeMirror
  or contentEditable "don't pull in Tiptap or ProseMirror".

  `peerDependenciesMeta._subpaths` listed `./client` for all seven Tiptap
  peers, though only `@tiptap/y-tiptap` was ever reachable from it. All seven
  now name only `./adapters/tiptap`. `react` gained `./client/ws`, which it
  was missing — that subpath is Yjs-free, not React-free.

  `test/contract/optional-peers.test.ts` walks the built require graph and
  asserts no subpath eagerly needs a peer whose `_subpaths` disclaims it,
  plus imports `./client` with every `@tiptap` resolution forced to fail.
  `y-protocols` stays eager on `./client` on purpose: that barrel is the CRDT
  surface, its `_subpaths` says so, and `./client/ws` is the Yjs-free one.


## 0.58.0 — 2026-09-18

- **Types named in exported signatures are now importable.** Eleven were not,
  from six subpaths.

  TypeScript emits a `.d.ts` that mentions a module-local type without
  complaint, so the build stays green, the signature reads correctly in an
  editor, and the type is simply unnameable. A consumer can still pass an
  object literal, because structural typing does not care — but cannot declare
  a variable for it, write a factory that returns one, or type the prop they
  forward it to. Nothing errors; the API just resists being built on. Deep
  imports are no escape: there is no `./client/*` in `exports`, so
  `.../client/useWebSocket` is blocked.

  - `./client`, `./client/ws` — `UseWebSocketPersistConfig`, the type of the
    `persist` option.
  - `./client`, `./agent-streaming/client` — `AgentStep`, the element type of
    the `steps` this hook returns.
  - `./client` — `UnsupportedForm`, from `MaterializeResult.unsupported`.
  - `./client/pipelines` — the element type of `PipelineRunSnapshot.steps`,
    which was called `Step`; exported as `PipelineSnapshotStep` to sit beside
    `PipelineRunStepDetail` and `PipelineRunStepStatus`.
  - `./client/video` — `TransportLog`, the `log` option on every transport
    helper the barrel already re-exports.
  - `./fileupload` — the router and logger contracts a consumer must satisfy
    to construct `FileUploadService`, plus `FileUploadStatus`. They were called
    `RouterLike` and `LoggerLike`; exported as `FileUploadMessageRouter` and
    `FileUploadLogger`, matching `CursorLogger`, `NotificationLogger` and the
    rest.
  - `./room` — `RoomAnnounceEvent`, carried on an announce frame's `event`.
  - `./server` — `AwarenessLedger`, named by `CRDTServiceOpts.awarenessLedger`.

  `useWebSocket`'s `webSocketImpl` was typed `WSCtor`, an unexported local
  alias, and is now `typeof WebSocket` — which needs no export and matches
  what `GatewaySocketProviderProps` already said.

  `PresenceMode` has the same problem and is deliberately NOT fixed:
  `DocumentPresenceService` uses `export =`, which forbids any other export
  from that module, so exposing it needs a module-shape change rather than an
  export line.

  `test/contract/public-types.test.ts` pins all of it. Like the conformance
  test, its assertions are the types: drop one of these exports and the suite
  stops compiling.


## 0.57.0 — 2026-09-18

- **`cursor()`, `social()`, `ingest()`, `pipeline()`, `typedDocuments()`**
  (`./server`) — the five `attachRealtime` presets that took no arguments now
  forward their service's config.

  Each wraps a service with a real options bag, and each threw it away.
  `presence()` carries a note about `authorizeChannel` having "used to be
  unreachable through attachRealtime entirely"; these five were the same bug,
  unfixed, and `attachRealtime` is the path the README and every recipe point
  at.

  Cursor was the worst case, because neither route worked. `CursorManifest`
  advertises `CURSOR_THROTTLE_INTERVAL_MS`, `CURSOR_TTL_MS` and
  `CURSOR_CLEANUP_INTERVAL_MS` with defaults and descriptions, and nothing in
  `src/cursor` reads `process.env` — the service takes those three from
  `CursorConfig` or from hard-coded constants. With the preset taking no
  options either, all three were settable by neither environment nor code, and
  so were `supportedModes` and the service-level `authorizeChannel`.

  Note the env-var declarations are still inert for chat, cursor, reactions and
  activity — `presence` and `fileupload` read theirs. That is a separate
  inconsistency and is left alone here; after this change every one of those
  values is at least reachable in code.


## 0.56.0 — 2026-09-18

- **`httpBase`** (`./client`) — `GatewaySocketProvider` and `createGatewayRest`
  accept where the REST half lives.

  It was derived from the socket URL and only from there, on the stated
  assumption that "the gateway serves its REST routes on the same origin it
  accepts sockets on". Two deployments break that, and neither is exotic:

  - A gateway under a path prefix. `httpBaseFromSocketUrl` keeps the origin and
    discards the path, so `wss://example.com/gateway/ws` yields
    `https://example.com` and every REST call misses the `/gateway` prefix.
  - A split origin — sockets terminating at `wss://ws.example.com`, REST served
    from `https://api.example.com`.

  Both fail the way this surface keeps failing: the request 404s, and a 404 is
  exactly what the hooks read as "this gateway has no such endpoint", so
  capabilities report optimistically enabled and pins come back empty with
  nothing logged.

  The escape hatch was to pass a whole `rest` object — reimplementing five
  methods, including the `status`-on-error contract the hooks depend on, to
  change a base URL.

  `httpBase: ''` is honoured as page-relative rather than treated as unset,
  which is what a dev server proxying `/api` needs; the parameter is checked
  against `undefined` for that reason. Omitted, the derivation is unchanged.
  An explicit base also builds a working shim from a socket URL that does not
  parse, where the derivation could only return null.


## 0.55.0 — 2026-09-18

- **`useNotifications({ storage })`** (`./client`) — read-state persistence is
  injectable.

  The hook called `localStorage.getItem` / `.setItem` on the bare global. React
  Native has no localStorage, so read marks silently never survived a reload
  there — while this hook's own design notes, and the comment above its export,
  both promised marks persist across a refresh. The failure is quiet by
  construction: the writes were already wrapped in try/catch precisely because
  they might not work.

  It also left nothing to say for a tab-scoped app that wants sessionStorage, a
  multi-tenant one needing a namespaced store, or a test that would rather not
  patch a global. `useWebSocket` has taken `persist.storage: Storage` since it
  was written; this is the same seam, one hook over.

  `storage` defaults to `globalThis.localStorage`, so a browser app is
  unchanged. `null` means memory only — the honest setting for SSR and for
  privacy modes where the write would throw anyway. The global is now resolved
  through a guarded read, since a privacy mode can throw on the property access
  itself and not only on the call.


## 0.54.0 — 2026-09-18

- **`webSocketImpl`** (`./client`) — `useWebSocket` and `GatewaySocketProvider`
  accept the WebSocket constructor to use.

  `getWebSocketCtor()` read `globalThis.WebSocket` and nothing else, while its
  own docstring said it "allows tests to inject one via an attached property".
  The only attached property available was the global itself, so every caller
  needing a different implementation had the same single move: assign
  `globalThis.WebSocket`, and remember to put the real one back. This hook's own
  test suite does exactly that, in a beforeEach/afterEach pair, which is the
  clearest evidence the seam was missing.

  That closed the door on Node before 22 (no global WebSocket — so no SSR render
  and no script reaching the gateway without patching a global), on React
  Native's own implementation, and on any test wanting a fake scoped to itself
  rather than to the process.

  Defaults to `globalThis.WebSocket`, so nothing changes for a browser app. When
  neither the option nor the global is present the hook still reports
  `NO_WEBSOCKET` rather than throwing — an environment without WebSocket is a
  configuration to report, not a crash.


## 0.53.0 — 2026-09-17

- **`GatewayRest.getFeatureFlag`** (`./client`) — the seam `useFeatureFlag` was
  already using, now declared and implemented.

  The hook has always called `rest.getFeatureFlag(name)`, but reached it through
  `(gateway as unknown as { rest?: unknown }).rest`. Behind that cast, two things
  were true and neither was visible: `GatewayRest` never declared the method, so
  an app bridging its own socket onto `GatewayContext` could type `getCapability`
  and not this one; and `createGatewayRest` — the shim every provider-mounted app
  gets by default — never implemented it. Every such app took the `defaultValue`
  branch regardless of what the gateway would have said. The kill-switch was
  wired at both ends and could not fire, which is the same failure the capability
  shim was written to fix.

  `createGatewayRest` now calls `GET /api/feature-flags/:name`, attaching `status`
  to the error exactly as `getCapability` does, so a 404 still means "no such
  route here, keep the default" rather than a hard failure. A gateway without the
  route behaves as before.

  The casts in `useFeatureFlag` and `useCapability` are gone — `rest` has been a
  declared field on `GatewayContextValue` for some time, and both hooks' comments
  still claimed otherwise. A `null` answer (flag unknown to the gateway) now
  resolves to the caller's default instead of reaching `result.enabled` on null
  and landing in the catch-all.


## 0.52.0 — 2026-09-17

- **`useCursor`** (`./client`) — the client half of the cursor triple.

  `CursorService` and its manifest have shipped since the Wave 2 lift with no
  hook to match, and both the README and the adoption guide answered the gap by
  pointing at `useAwarenessState`. That answer only holds if a Yjs document is
  already mounted, because awareness rides the CRDT provider. A channel that
  wants Figma-style cursors over the gateway and nothing else had to hand-roll
  the frames — which is exactly the work this package exists to absorb.

  `useCursor(channel, opts?)` returns `{ cursors, move, refresh }` and speaks
  the service's own verbs: subscribe on mount with the snapshot that comes back,
  per-client `update` replacing in place, `remove` on disconnect or TTL sweep.

  `move()` throttles locally at the interval the service enforces (250 ms), and
  holds the suppressed position for the trailing edge. That second half is the
  point: the service drops anything faster *silently*, so a component wired to
  `onMouseMove` has ~95% of its frames discarded after crossing the wire, and
  the cursor other people see freezes at the last accepted position rather than
  where the pointer came to rest.

  Socket-explicit and provider-optional like `useReactions` — pass
  `opts.socket` and no `GatewaySocketProvider` is needed; pass neither and the
  hook is inert rather than throwing. `opts.selfClientId` keeps a stale cursor
  of your own out of the snapshot.


## 0.51.0 — 2026-09-16

- **`usePins`** (`./client`) — `pin()` takes an optional `sentAt`, the time the
  message was SENT, and `PinnedMessage` carries it back.

  A pinned panel had only `pinnedAt` to show, so a message sent at 19:27 and
  pinned at 20:53 read as 20:53 in the pinned list and 19:27 in the transcript —
  the same message at two times, and the pinned list showing the one you cannot
  match against the transcript to find it again. The pinning act belongs in the
  byline next to `pinnedBy`, which is where Teams and Slack put it and where
  this already had a place to go.

  The hook does not guess: no `sentAt` from the caller means the key is left off
  the wire frame and off the optimistic row, rather than sent empty or stamped
  from the local clock. The optimistic row is on screen for a full round trip,
  and a wrong time shown for a moment still reads as the message's time.

  Optional on both sides, so existing callers compile unchanged; pins the
  gateway stored before it had the field come back without one, and consumers
  fall back to `pinnedAt` or to no time at all.

## 0.47.0 — 2026-09-16

- **`useAgentStream`** (`./client`) — surfaces AG-UI `STEP_STARTED` /
  `STEP_FINISHED` and `REASONING_*` events, previously dropped as "ignored
  for now". Adds two fields to the hook's returned state:
  - `steps: AgentStep[]` — `{ name, startedAt, finishedAt?, status:
    'running' | 'done' }`, one entry per `STEP_STARTED`, closed by the next
    matching `STEP_FINISHED` for that `stepName` (matches the most recent
    still-running entry, so a repeated step name across a retry within one
    run gets its own entry rather than clobbering the first).
  - `reasoning: string` — chain-of-thought text accumulated from
    `REASONING_MESSAGE_CONTENT`/`REASONING_MESSAGE_CHUNK` deltas.
    `REASONING_START`/`REASONING_END`/`REASONING_ENCRYPTED_VALUE` carry no
    text and stay ignored.

  Both reset at every point the hook already resets `streamingText` for a
  new run — `sendMessage`, `RUN_STARTED`, and `reset()` — so they never leak
  across turns. No existing field's shape changed.

## 0.31.0 — 2026-08-26

- **`useCanvasCapture`** (`./client`) — turns a `<canvas>` the page already
  owns into a live `MediaStreamTrack`, with NO permission prompt, because the
  page captures its own output rather than the user's screen. This is what you
  want for recording a diagram/whiteboard/chart: `getDisplayMedia` requires a
  gesture and a source picker and always will, whereas
  `canvas.captureStream()` does not — and self-capture is the honest primitive
  anyway.

  It mirrors the sources into its own surface on a fixed interval instead of
  capturing them directly, because a static canvas only paints on change and a
  direct capture stalls between edits. That also makes it a compositor: pass
  `[scene, overlay]` and both layers land in one track. Default 5 fps, chosen
  because a diagram changes in discrete edits and every encoder downstream
  drops duplicate frames anyway.

  `capturing` is derived from the track's own `readyState`, never a separate
  boolean, so a UI claiming "off" over a live track is not expressible.

## 0.28.0 — 2026-08-26

Collaborative diagramming — an Excalidraw ↔ Yjs binding. New subpath
`./adapters/excalidraw`.

- **`ExcalidrawYjsBinding`** — binds an Excalidraw scene to a Y.Doc as a keyed
  `Y.Map<elementId, Y.Map<prop>>`. Since Excalidraw 0.17 carries z-order on the
  element as a fractional `index`, ordering is just another property and no
  ordering CRDT is needed — read sorts by `index`. One Y.Map per element means
  two people dragging two shapes write disjoint keys and both edits survive;
  two people editing the same shape land on per-property LWW. Deletes are
  tombstones (`isDeleted: true`), never key removal.
- **`useCollaborativeDiagram`** — owns the binding lifecycle and publishes
  pointers on the EXISTING awareness channel under a top-level `diagram` key
  (sibling of `user` / `cursor` / `call` — nesting under `user` would be
  clobbered by `useAwarenessState`'s whole-object flush). Throttled to 50ms.
- **No new sync machinery.** Transport, snapshots, hot cache, idle eviction,
  cross-node fan-out and authz all come from the existing `useYjsDoc` /
  `GatewayProvider` / `CRDTService` stack, which is schema-agnostic. A diagram
  is just a differently-shaped Y.Doc on a `doc:` channel.
- **No `@excalidraw/excalidraw` dependency.** The binding is typed
  structurally against `{ id, version, versionNonce, index }`, so `./client`
  stays as light as it was and an Excalidraw major cannot break this package.

## 0.27.0 — 2026-08-26

Ambient voice capture — push-to-talk transcription on any page, not just in
a call. New subpath `./client/voice`.

- **`useVoiceCapture`** — getUserMedia → AudioWorklet → 16 kHz mono s16le →
  POSTed to an authenticated proxy in front of the live-captions sidecar;
  transcripts come back over the existing gateway `caption` fan-out. Audio
  does NOT ride the WebSocket (the gateway coerces frames to UTF-8 strings).
  The MediaStreamTrack is released on every stop, including error and unmount
  paths, so the OS recording indicator can never disagree with the UI. Audio
  is never retained — only the transcript.
- **`ContextFrame`** (`contextFrame.ts`) — the published contract for WHERE an
  utterance attaches. The target is latched from the screen at the instant of
  the press and never re-decided; the release sample can only ever set
  `contextSplit` and withdraw `autoAttach`. Five-rung ladder (selection →
  focused section → viewport-dominant → route entity → none) with a matching
  confidence tier, and an anchor triple that degrades relPos → sectionId →
  quote. Rules pick the target; a model may only pick the action.
- **`subscribeTranscripts` / `TranscriptReadyEvent`** — `{ text, context,
  t0_ms, t1_ms, outcome, lines, speechMs }` delivered to every sink. The
  comment path is one subscriber, not a privileged one.
- **`UtteranceAggregator`** — rejoins the several caption lines the sidecar
  emits for one thought (it cuts ASR windows at a hard 3.0 s), ordered by the
  emitter's per-participant `seq`. Reports `lost` when speech was sent and no
  transcript came back — the only observable signal that the sidecar's
  bounded, metric-less ASR queue dropped a window.
- **`attachTranscriptAsComment`** — reference sink, posting to the existing
  document-comments endpoint at section grain.
- **`useLiveCaptions`** now accepts a `channel` in place of `callId`, so
  non-call captures are no longer filtered out by the call-scoped guard, and
  accepts the sidecar's own `participantId` field name.

## 0.23.0 — 2026-08-25

Person-to-person DM support in the chat layer (`./chat`):

- **`ChatMessage.userId?`** — first-class authenticated-subject identity
  on messages, distinct from the per-connection `clientId`. Stamped at
  send time by the new `identityResolver` ChatService option, which also
  merges `displayName`/`avatarUrl` into metadata where the sender didn't
  provide them (sender-provided metadata wins). No resolver ⇒ behavior
  unchanged. `useChat` surfaces the field client-side.
- **dm channel helpers** (`dmChannels.ts`, exported from `./chat`):
  `isDmChatChannel` / `dmChatChannelFor` / `dmChannelMembers`. Canonical
  form `chat:dm:<sorted userIds>`; names past 100 chars fall back to the
  hashed, non-reversible `chat:dmg:<sha1[0..24)>` group form.
- **`enforceDmMembership`** ChatService option (defaults ON when an
  identityResolver is present) — join/send on member-addressed dm
  channels is gated on the resolved userId, fail-closed, rejecting with
  error code `CHAT_DM_FORBIDDEN`. Non-dm channels unaffected.
- **`onDmMessage`** seam — fire-and-forget observer after successful dm
  sends (parsed members; `[]` for hashed group channels), for
  conversations indexes / notification fan-out in consumers.

## 0.20.0 — 2026-08-20

- **`collabDocs()`** — the fourteenth built-in feature; CRDT document sync
  is now attachable like everything else (in-memory snapshot/metadata/
  hot-cache defaults, `authz` + store seams for production). The matrix
  grows to 14 solo boots and 91 pairs, plus a live subscribe round-trip.
- **`RealtimeFeature.serviceName`** — explicit wire routing key when it
  differs from the manifest identity (CRDT's manifest is
  'document-sharing'; every client hook addresses `service: 'crdt'`).
- **Lifecycle-aware `dispose()`** — services exposing `shutdown()`/`stop()`
  get them called before the WS listener detaches (CRDT flushes snapshots);
  best-effort per service.


## 0.19.0 — 2026-08-18

The pluggable composition layer. The unit of adoption is the FEATURE — you
attach capabilities to an http.Server you already have:

    attachRealtime(httpServer, { features: [chat(), presence(), rooms()] })

- **`attachRealtime` + `defineFeature`** (`./server`): open registry — the
  thirteen built-ins (chat, presence, cursor, reactions, activity, social,
  calls, ingest, pipeline, typedDocuments, rooms, notifications,
  fileUploads) are ordinary `defineFeature` calls; app-defined features
  plug in identically. À-la-carte composition is enforced by a test matrix
  (13 solo boots over real WebSockets, all 78 pairs, zero interference with
  the host app's HTTP routes).
- **`RealtimeRouter`** exported contract (union of the per-service router
  slices, M3 authz semantics included) + `LocalRealtimeRouter`, the
  zero-infra single-process default with identity from the WS auth context
  and a `ChannelAuthorize` hook (subscribe + publish). Multi-node: swap the
  transport via `attachRealtime({ router })`, not the features.
- **`server-ws`**: `WsHandlerHandle.getClientContext` exposes the auth
  context so routers can derive identity locally.
- **Recipes** (`docs/recipes/`): one page per capability — attach, hook,
  ui-components surface, graduation path.
- **Guardrails**: `verify:exports` runs inside `build` (subpaths backed
  both directions: exports→dist and dist→src); `smoke:features` attaches
  all 13 features against the BUILT dist.
- **Tags normalized** to semantic `vX.Y.Z` (prefixed `realtime-modules-v*`
  purged; mapping in `docs/releases/tag-normalization-2026-08-18.md`).


## 0.18.0 — 2026-08-18

The server side comes home. Four services extracted from websocket-gateway
into first-class subpaths (the gateway now consumes them through thin shims):

- **`./call`** (breaking): replaced the v0.6-era ancestor with the evolved
  implementation the gateway had grown 5.5x in-tree — invite dedup,
  InMemory/Redis call-state stores, cross-node departure pub/sub, sweeper
  leadership. New `CallServiceOptions.withSpan` tracing seam (pass-through
  default; this library does not depend on distributed-core).
- **`./room`** (new): RoomService + InMemory/Redis room-state stores.
  Metric hooks are injected via `RoomServiceOptions.metrics` (no-op default).
- **`./notification`** (new): NotificationService + RedisNotificationStore,
  moved verbatim (already dependency-pure).
- **`./fileupload`** (new): FileUploadService + FileBlobStore. Metadata
  persistence is the `FileUploadMetadataStore` interface (in-memory default;
  the gateway's DynamoDB repository satisfies it structurally). Channel
  authz is an injected hook — **default allows everything**; multi-tenant
  deployments must wire their interceptor.

## 0.17.0 — 2026-08-18

Restored the 11 server-module sources deleted at v0.6.0 (the "client-only"
turn was never completed — consumers kept importing the compiled output,
which shipped without source for ten minors). Three dist-only patches
back-ported to TypeScript (chat publisher authz, presence mode, presence
colors). Build is now self-cleaning so dist/ can never outlive src/ again.


All notable changes to `@connorhoehn/realtime-modules` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the package remains on the `0.x` line, all releases are considered
**unstable**: APIs, subpath export shapes, and storage-contract interfaces
may change between minor versions. Consumers should pin to exact tags and
re-run `npm run typecheck` on every bump.

---

## [Unreleased]

## [0.16.0] — 2026-06-13

Graduation release: the four hooks that previously shipped Beta because their
gateway-side services did not yet exist are now **Stable** — the gateway shipped
`FileUploadService`, `NotificationService`, `CapabilityService` (+ `GET
/api/capabilities`), and the feature-flag store (+ `GET
/api/feature-flags/:name`) this week, so every one of these hooks now talks to a
real server instead of a client-side fallback. Docs-only graduation; no code or
subpath-shape changes. Bumped as a minor per the graduation = minor convention.

### Changed

- **Maturity table:** `useFileUpload`, `useNotifications`, `useCapability`, and
  `useFeatureFlag` moved from **Beta** to **Stable**. Notes corrected — the
  former "gateway service not yet wired" reasons are all resolved — and the
  gateway env each hook depends on is now documented:
  - `useFileUpload` → `FILEUPLOAD_TABLE`, `FILEUPLOAD_PUBLIC_BASE`
  - `useFeatureFlag` → `FEATURE_FLAGS_JSON` (seeds the gateway's flag store)
  - `useNotifications` → DDB-backed via the gateway's DDB table prefix (no
    dedicated env)
  - `useCapability` → CRD-scoped (no env)
- **Install section:** rewritten for GitHub Packages (`@connorhoehn:registry=
  https://npm.pkg.github.com` + exact-version pin) instead of the stale "not on
  npm, git-tag pin `#v0.7.4`" instructions. Versioning + status notes updated to
  match (published version or git SHA, not git tags).

## [0.15.2] — 2026-06-12

Adopt event-catalog 0.3.58 and resolve contract-conformance divergence note
(b): the gateway send-back envelopes the inbound hooks parse are now fully
declared in EC, so the contract test asserts the hooks' parsers against the
complete send-back set instead of leaving them as TODO.

### Changed

- **Re-pinned `@connorhoehn/event-catalog` devDependency to 0.3.58**
  (`#5c7a907`), which declared the gateway services' SEND-BACK envelopes per
  the service implementations the gateway runs
  (`dist/{chat,presence,reactions,cursor,activity,crdt}/`) — adding the
  previously-missing `reaction/reaction_unsubscribed`, `available_reactions`
  and `crdt:awareness` frames and reconciling `reaction_subscribed`/`sent` +
  `ws.error` against ground truth.

### Contract test (`test/contract/contract-conformance.test.ts`)

- **Divergence note (b) RESOLVED.** Added §3b asserting the gateway-real
  action-frame envelopes `useChat` / `usePresence` / `useReactions` parse
  (`{type:'chat',action:'message'|'history'}`,
  `{type:'presence',action:'subscribed'|'set'|'update'}`,
  `{type:'reaction',action:'reaction_received'}`) against the EC declarations:
  envelope discriminants (type/action/channel) pinned, and each payload slot
  (`message` / `presence` / `data`) asserted to accept the local post-parse
  type (`ChatMessage` / `PresenceEntry` / `Reaction`) field-wise. Also pins the
  newly-declared `reaction_unsubscribed` / `available_reactions` ack envelopes
  and the `crdt:awareness` coalesced-awareness frame. The former
  "assertions remain TODO" caveat is gone.

## [0.15.1] — 2026-06-11

Fix two `ChatService` wire-authz gaps found during the M3 kind validation
(gateway commit `b6ecc59b`).

### Fixed

- **Gap #9 (serious) — chat sends bypassed publisher authz.**
  `handleSendMessage` broadcasts via `messageRouter.sendToChannel` *without*
  `excludeClientId` so the sender receives their own message (sender-echo).
  The gateway router's publisher-authz check (control-plane CRD publisher
  role restrictions → `AUTHZ_CHANNEL_DENIED`) was gated on `excludeClientId`,
  so ChatRoom/RealtimeChannel CRD publisher restrictions were **never enforced
  for chat messages**. `ChatService` now passes the sender as an explicit
  `publisherClientId` option (`broadcastMessage(channel, data, publisherClientId)`
  → `sendToChannel(channel, msg, null, { publisherClientId })`), decoupling the
  AUTHZ subject from ECHO control. Echo behaviour is unchanged. Requires a
  gateway router that honours `opts.publisherClientId` (gateway re-pinned to
  match); older routers ignore the extra option harmlessly.
- **Gap #10 — `handleJoinChannel` ignored subscribe denial.** It called
  `subscribeToChannel`, discarded the `false` return, then acked
  `{ type:'chat', action:'joined' }` and registered a local subscription even
  when the router denied the subscribe (and had already emitted
  `AUTHZ_CHANNEL_DENIED`). On a `false` return it now sends no joined ack and
  registers no local subscription; `void`/`true` still means subscribed
  (back-compat with routers that don't return a boolean).

### Notes

- `ChatMessageRouter.sendToChannel` / `subscribeToChannel` type surfaces
  widened (optional `excludeClientId` + `opts.publisherClientId`; subscribe
  may return `boolean | void`).
- Unit coverage: `test/chat/ChatService.authz.test.ts`.

## [0.15.0] — 2026-06-11

Connection-semantics change (EKS discovery finding #9, verified on a real
cluster): the gateway silently DROPS any inbound frame that arrives before
its per-connection session bootstrap completes — it signals readiness with
the `{ type: 'session', status: 'connected', clientId, sessionToken,
nodeId, restored }` frame. `useWebSocket` previously flipped
`connectionState` to `'connected'` in `ws.onopen`, so on any real-latency
network every connected-gated subscribe frame (GatewaySocketProvider
feature auto-subscribe, useCRDT, feature hooks) was sent before the
session frame and silently vanished — the client believed it was
subscribed and received nothing until the next reconnect re-raced
(14,846/14,846 subscribe frames lost on EKS). Loopback/in-process
deployments never reproduce this because open≈session.

### Changed

- **useWebSocket — session-gated `'connected'`.** `ws.onopen` no longer
  transitions `connectionState`; the hook stays `'connecting'` until the
  `{ type: 'session' }` frame arrives (the existing handshake-capture
  handler now owns the transition). `onConnect` and `autoResubscribe`
  replay also fire on session establishment, not on open. The same
  gating applies on every reconnect — connected-gated effects in
  GatewaySocketProvider / useCRDT / feature hooks and the
  session-frame-driven resubscribe in useYjsDoc now naturally wait for
  the new session.
- **useWebSocket — pre-session send queue.** `send()` calls made while
  the socket is OPEN but the session is not yet established are queued
  (bounded at 100 frames, drop-oldest with a `console.warn`) and flushed
  in order on session arrival. The queue is per-connection-attempt: it
  is dropped on close/disconnect/new-connect since connected-gated
  effects re-issue their subscribes on the next `'connected'`
  transition. Sends while the socket is not open remain a silent no-op
  (unchanged).

### Added

- **useWebSocket — `sessionTimeoutMs` option (default 3000).** Plain
  (non-gateway) WS servers never send a session frame and would hang in
  `'connecting'` forever under the new gating. If no session frame
  arrives within `sessionTimeoutMs` of socket open, the hook logs a
  `console.warn`, transitions to `'connected'` anyway, and flushes the
  queue — preserving the legacy open-means-connected behavior.
  (`./server-ws`'s `createWsHandler` sends the handshake, so the
  fallback only fires against third-party servers.)

### Notes

- `GatewayProvider` (Yjs) needed no change: its crdt subscribe triggers
  live in useYjsDoc (session-frame-driven + now-queued mount-time send)
  and useCRDT (`connectionState === 'connected'`-gated), both covered by
  the gating + queue. `GatewaySocketProvider`'s feature auto-subscribe is
  likewise covered — it keys off `connectionState === 'connected'`.
- `./client/ws` re-exports the fixed hook; no surface change beyond the
  new `sessionTimeoutMs` option.
- Docs: README "Connection semantics", USAGE-PATTERNS notes, and a v3
  addendum in docs/USEWEBSOCKET-GAP-vs-GATEWAY.md.

## [0.14.1] — 2026-06-10

Contract-adoption patch: adopt event-catalog v0.3.57, which backfills the
gateway-verified verbs flagged by this library's 0.14.0 contract test
(divergence notes c + the §2 "no EC declaration yet" carve-outs). No wire
behavior changes — the hooks already sent these frames; they are now
type-pinned against the canonical declarations.

### Changed

- **event-catalog devDependency** re-pinned to v0.3.57
  (`6bc9e09805d732cffa05006588383732538986d4`), which declares
  `client.chat.leave`, `client.reaction.subscribe`,
  `client.reaction.unsubscribe`, `client.reaction.getAvailable`,
  `client.presence.get` and `client.presence.heartbeat`.
- **useChat** — the cleanup `leave` send-site now carries
  `satisfies ClientFramePayload<'client.chat.leave'>` like its siblings.
- **useReactions** — the mount/cleanup `subscribe` / `unsubscribe`
  send-sites now carry their `satisfies ClientFramePayload<...>`
  annotations.
- **contract test** — divergence note (c) resolved; the outbound
  frame-name pin covers all 31 EC declarations, and §2 directly asserts
  chat.leave, reaction.subscribe/unsubscribe/getAvailable and
  presence.get/heartbeat (the latter three have no hook send-site today
  and are asserted against the EC shapes only). Divergence note (b)
  (inbound send-back envelope declarations) remains open — the 0.3.57
  backfill is outbound-only.

## [0.14.0] — 2026-06-10

Protocol-correction release (hub#1497 Part 2): three client hooks now speak
the **gateway-real WS verbs**, verified directly against the gateway's
installed Chat/Presence/Reaction service implementations. The previously
sent verbs were NEVER accepted by the gateway, so no working consumer
depended on them — but the outbound wire changes are behavior changes,
hence a minor bump.

### Changed

- **useChat speaks the real chat verbs `join | leave | send | history`.**
  The chat service rejected `subscribe` ("Unknown chat action: subscribe")
  and requires a prior `join` before `send` ("You must join the channel
  before sending messages"). The hook now joins its channel on mount /
  channel change and leaves on cleanup. `join` auto-pushes recent channel
  history from the gateway, so no explicit history request is sent on join;
  `loadHistory(limit?)` remains for explicit re-fetch and now omits `limit`
  when not provided (gateway default applies — EC 0.3.56 corrected `limit`
  to optional). Inbound: the hook now parses the gateway-real envelopes
  `{ type: 'chat', action: 'message', message }` and `{ type: 'chat',
  action: 'history', messages }` payload-first, with the legacy flat
  `chat:message` / `chat:history` shapes kept as a fallback.
- **useReactions sends the real reaction verb `send`.** The reaction
  service rejected `react` ("Unknown reaction action: react"). The hook
  also gains the subscribe/unsubscribe lifecycle (broadcasts are only
  delivered to subscribed clients) and parses the gateway-real inbound
  envelope `{ type: 'reaction', action: 'reaction_received', data }`
  (channel-filtered via `data.channel`), with the legacy flat
  `reaction:new` / `reaction:history` shapes kept as a fallback.
- **usePresence presence/set is gateway-correct.** The presence service
  REQUIRES `status` ("Status is required") and reads only `{ status,
  metadata, channels }` — the previously sent top-level `channel` was
  silently IGNORED (deprecated in the EC declaration). `setStatus` /
  `updateMetadata` now send `channels: [channel]` (the real pinning
  mechanism) instead of `channel`, and `updateMetadata` carries the
  last-known status (default `'online'`) so metadata-only updates no
  longer error. Because the service replaces the whole entry on every set,
  the hook also carries accumulated metadata across `setStatus` calls.
  Inbound: the hook parses the gateway-real envelopes
  (`presence/subscribed` roster snapshot, `presence/set` own-ack,
  `presence/update` broadcast filtered via `presence.channels`,
  `presence/offline` departure) with the legacy flat
  `presence:state/joined/updated/left` shapes kept as a fallback.
- **GatewaySocketProvider feature auto-wiring fixed.** The `chat` feature
  now emits a `join` frame (was the never-accepted `subscribe`), and both
  presence subscribe + chat join are skipped when no channel is set — the
  gateway rejects channel-less frames ("Channel is required" / "Channel
  name is required"), so the old `channel: undefined` frames only produced
  server errors.
- **event-catalog devDependency re-pinned to v0.3.56** (`a61596a`), which
  corrected the `client.*` declarations against gateway ground truth.
  `useActivity.loadHistory` regained its `satisfies` annotation now that
  `client.activity.getHistory` is declared (closes the hub#1492 EC-side
  divergence).
- **NO legacy dual-sends:** the old verbs were never accepted by the
  gateway (the only server), so the hooks send only the corrected frames.

### Added

- `publishConfig.registry` → `https://npm.pkg.github.com` (publish-prep).
- New jsdom suites `test/client/useChat.test.tsx` and
  `test/client/usePresence.test.tsx` cover the join/leave + subscribe
  lifecycles, status/metadata carry, both inbound envelope generations,
  and ack-frame ignoring; `useReactions.test.tsx` extended with the
  gateway-real protocol block.

### Fixed

- **Contract test tracks the corrected EC 0.3.56 contract.** Frame-name pin
  renames (`client.chat.subscribe` → `client.chat.join`,
  `client.reaction.react` → `client.reaction.send`,
  `client.activity.history` → `client.activity.getHistory`); Local* shapes
  updated to the gateway-real frames (presence.subscribe channel required,
  presence.set status required + channels[], chat.history limit optional);
  the `_actHistDiverges` divergence pin replaced by a direct `_actHist`
  assertion; new `_presSetStatusRequired` regression pin; runtime section
  uses `client.reaction.send`.

## [0.13.1] — 2026-06-10

### Fixed

- **useActivity parses the REAL gateway envelopes (hub#1492).** The hook
  previously parsed flat `{ type: 'activity:event', channel, ...fields }` /
  `{ type: 'activity:history', channel, events }` frames, but the gateway's
  ActivityService actually emits:
  - live: `{ type: 'activity:event', payload: { eventType, detail,
    timestamp, userId, displayName } }` — payload-wrapped, **no channel
    field** on the envelope or payload;
  - history: `{ type: 'activity', action: 'history', events, channelId,
    timestamp }`.
  The hook now parses payload-first with the old flat shapes kept as a
  legacy fallback (old/other servers keep working mid-migration).
  Channel-filtering decision: the gateway broadcasts every live activity
  event to the single global `activity:broadcast` channel and scopes
  delivery via that subscription (`sendToChannel`), so live frames are
  accepted unfiltered; history responses are filtered by `channelId`
  (legacy `channel` honoured), and legacy flat live frames keep their
  channel filter.
- **useActivity outbound frames now match what the gateway accepts.** The
  gateway's `ActivityService.handleAction` reads `channelId` (the previous
  `channel`-only frames were rejected with "channelId is required") and the
  history verb is `getHistory` (`history` was rejected with "Unknown
  activity action"). subscribe/unsubscribe/getHistory now send `channelId`
  (plus the legacy `channel` field for old-server tolerance);
  `loadHistory()` sends `action: 'getHistory'`. Note: history is an
  explicit `getHistory` request — the gateway does NOT auto-send history on
  subscribe.
- **Contract test updated.** §2 activity block asserts the gateway-real
  frames; the `getHistory` divergence from event-catalog's stale
  `client.activity.history` declaration (action `'history'`) is pinned via
  `_actHistDiverges` so an EC-side fix flips it loudly; divergence note (a)
  marked resolved, new note (d) flags the stale EC outbound declarations.
- New jsdom suite `test/client/useActivity.test.tsx` covers both envelope
  generations (real payload-wrapped + legacy flat), history filtering,
  ack-frame ignoring, and the outbound frame shapes.

## [0.13.0] — 2026-06-10

### Added

- **event-catalog client-frame contract adoption (Wave A3).** The library now
  consumes the canonical client-frame types generated by
  `@connorhoehn/event-catalog` v0.3.55 (`client-frames` subpath: 25 outbound
  `client.<service>.<action>` frames + 12 inbound `ws.*` hook-contract
  declarations). Every outbound send-site in `useChat`, `usePresence`,
  `useReactions`, `useActivity`, `useFileUpload`, `useVideoHangout`,
  `useCRDT`, `useYjsDoc`, `useWebSocket`, `GatewaySocketProvider`, and
  `GatewayProvider` is annotated with `satisfies
  ClientFramePayload<'client.…'>`, so frame-shape drift against the catalog
  fails the build. All imports are **type-only**: the built `dist/` carries
  zero event-catalog references and consumers need no new dependency
  (event-catalog moved from dependencies to devDependencies, SHA-pinned to
  `19907ecc…` — it was never imported at runtime).
- **`npm run check:contract`** — standalone drift guard
  (`tsc -p tsconfig.contract.json`) over
  `test/contract/contract-conformance.test.ts`, which pins the full outbound
  frame-name set and asserts assignability between the local public types
  (`PresenceEntry`, `HangoutParticipant`, `Notification`,
  `CapabilityDescriptor`, `ActivityEvent`, `Reaction`, …) and the
  EC-generated unions. The same file runs (and is type-checked) under
  `npm test`, so drift fails the regular suite too. Public API in
  `src/client/types.ts` is unchanged — local types are asserted against EC,
  not aliased to it.

### Fixed

- `useReactions` header no longer documents a
  `{ service: 'reaction', action: 'history', channel, limit }` outbound frame
  — no code path has ever sent it; `client.reaction.react` is the hook's only
  outbound frame. `usePresence` / `useActivity` headers now also list their
  `unsubscribe` frames.

### Known divergences (documented in test/contract, not changed here)

- `useActivity` parses a flat `activity:event` / `activity:history` envelope;
  the gateway (and EC ground truth) emit
  `{ type: 'activity:event', payload: {…} }` and
  `{ type: 'activity', action: 'history', events, channelId }`. Field shapes
  match; the envelope parser fix is a behavior change deferred past A3.
- `useChat` / `useReactions` inbound hook-contract envelopes
  (`chat:message`, `reaction:new`, … flat) have no EC declarations yet — the
  existing `ws.chat.*` / `ws.reaction.*` entries describe the gateway's
  `type:'chat'` action-frame envelope (Wave A2 naming-tension note).
- `GatewayProvider` forwards awareness `mode` as plain `string`
  (`useAwarenessState.updateMode` accepts any string); EC narrows it to
  `'editor' | 'reviewer' | 'reader'`. Narrowing the call-site would be a wire
  change, so the frame stays `Record`-typed with the conformance assertion
  carrying the canonical shape.

## [0.11.1] — 2026-05-28

### Fixed

- `dist/` rebuilt and committed to the git tag so consumers installing via
  `github:connorhoehn/realtime-modules#realtime-modules-v0.11.1` get a tarball
  that already contains compiled artifacts. Prior tags shipped without
  refreshed dist after `useLVSHangout` fixes and the subpath-exports patch,
  forcing consumers to run `prepare` (which fails on alpine without a build
  toolchain). No source/API changes — patch-only release for tag installability.

## [0.7.4] — 2026-05-21

### Added

- **`useNotifications()`** — user-scoped notification inbox hook returning
  `{ notifications, unreadCount, markAsRead, markAllRead, remove, clearAll }`.
  Listens for `notification:new`, `notification:read`, and
  `notification:bulk-update` frames from the gateway without any channel filter
  (notifications are user-scoped, not channel-scoped).
  Read state is persisted in `localStorage` under `'rmn:notifications:read'` so
  a page refresh does not lose marks. In-memory list is capped at 100 entries
  (configurable via `maxNotifications` option). Gateway-side notification service
  is not yet wired — hook is the consumer surface; server wiring is deferred.
  Exported from `./client`.

## [0.7.3] — 2026-05-21

### Fixed

- **`./server` subpath restored** — the `./server` export entry was
  inadvertently dropped during the v0.6.0 server-side pruning. It is
  needed by gateway integration tests that import the `server-ws` handler
  factory through the legacy path. Restored in `package.json` exports map.

## [0.7.2] — 2026-05-21

### Added

- **`useFileUpload(channel)`** — React hook for gateway-mediated file upload
  lifecycle. Returns `{ uploads, upload, cancel, removeCompleted }`. Handles
  the full presigned-URL flow: `request-upload` → `fileupload:url` → XHR PUT
  with progress → `complete` → `fileupload:complete` (or `scanning` / `clean` /
  `infected` / `failed`). Supports cancel mid-upload. Exported from `./client`.
- **`useVideoHangout(channel)`** — React hook for LVS video session signaling.
  Returns `{ session, participants, joinToken, start, join, leave, end,
  toggleVideo, toggleAudio }`. Manages the WS signaling layer only — WebRTC /
  media is the web-broadcast-shim's concern. `joinToken` is passed to the
  consumer's `<Stage>` component. Exported from `./client`.

## [0.7.1] — 2026-05-21

### Added

- **`GatewayProxyClient` automatic HMAC signing** — pass `serviceAuthSecret`
  + `serviceAuthClientId` to the constructor and the client computes and
  attaches an `X-Service-Auth: v1.<id>.<ts>.<mac>` header on every request
  automatically. Algorithm is inlined using Node's built-in `crypto` — no
  extra runtime dependency. Wire format is compatible with
  `@connorhoehn/service-runtime`'s `signEnvelope` / `verifyEnvelope`.
  When both signing options are omitted, the client continues to operate in
  legacy (no-auth) mode.

## [0.7.0] — 2026-05-21

### Added

- **`useChat(channel)`** — React hook returning `{ messages, sendMessage, loadHistory }`.
  Listens for `chat:message` and `chat:history` inbound frames; sends via the gateway
  chat service. Messages accumulate newest-last; `loadHistory()` sends a `chat:history`
  action frame (default limit 50).
- **`usePresence(channel)`** — React hook returning `{ roster, setStatus, updateMetadata }`.
  Maintains a `PresenceEntry[]` roster keyed by `clientId` (sorted for stable render).
  Handles `presence:state` (full snapshot), `presence:joined`, `presence:updated`,
  `presence:left` frames. Auto-subscribes / unsubscribes on channel change.
- **`useReactions(channel)`** — React hook returning `{ reactions, react }`.
  Bounded to the most recent 50 `Reaction[]`. Handles `reaction:new` and `reaction:history`
  inbound frames; `react(emoji)` sends a `reaction:react` action frame.
- **`useActivity(channel)`** — React hook returning `{ events, loadHistory }`.
  Accumulates `ActivityEvent[]` oldest-first. Handles `activity:event` and
  `activity:history` frames; auto-subscribes on channel change.
- **`GatewayContextValue`** — extended context type for `useGateway()` that adds
  `onMessage(handler) => () => void` — a post-init message subscription bus
  child hooks use to register inbound frame handlers without prop-drilling.
  `GatewaySocketProvider` fans all inbound WS frames through this bus. Type exported
  from `./client`.

### Changed

- **`GatewaySocketProvider`** now wires an `onMessage` callback into `useWebSocket` and
  distributes frames to child-registered handlers (e.g. useChat, usePresence) in
  registration order. Existing consumer behaviour is unchanged — the bus is additive.
- **`useGateway()`** now returns `GatewayContextValue` (superset of `UseWebSocketHookReturn`).
  All existing callsites remain compatible; `onMessage` is an additive field.

## [0.6.0] — 2026-05-21

Server-side services removed; client-only release.

### Changed

- **Dropped all server-side service classes** — `CRDTService`, `ChatService`,
  `PresenceService`, `ReactionService`, `ActivityService`, and all supporting
  server subpaths (`./chat`, `./presence`, `./reactions`, `./activity`,
  `./server`, `./cursor`, `./ingest`, `./pipeline`, `./social`, `./call`,
  `./typed-documents`) removed from the package. These moved in-tree to
  `realtime-examples/src/`. Package is now client-library-only: `./client`,
  `./client/ws`, `./agent-streaming`, `./agent-streaming/client`,
  `./proxy-client`, `./server-ws`, `./adapters/tiptap`.
- Pruned orphan tests that referenced removed server exports.
- README and ADOPTION-GUIDE rewritten for the client-only v0.6+ surface.

## [0.5.x] — 2026-05-21

### 0.5.3
- Pre-built dist for v0.5.3; DC v0.33.0 dependency pin updated.

### 0.5.2
- Unified integration test harness for all 10 `FEATURE_REGISTRY` features via
  `createRealtimeServer` factory.

### 0.5.1
- Integration test coverage across all 10 features (social, call, ingest, pipeline,
  typed-documents, + the Wave-2 core set).

### 0.5.0
- Per-feature adapter overrides + `FeaturePlugin` lifecycle hooks on
  `createRealtimeServer`. DC `PeriodicSweep` replaces hand-rolled `setInterval`
  in timer code.

## [0.4.x] — 2026-05-20

### 0.4.3
- `FEATURE_REGISTRY` 10/10 complete; `/client/ws` subpath shipping
  `GatewaySocketProvider`; README TypeScript requirements documented.

### 0.4.0
- **`createRealtimeServer` factory** — zero-config server setup with `inMemoryAdapters`.
- **`GatewaySocketProvider` `features` prop** + **`useFeatures` hook** — declarative
  feature activation; provider auto-subscribes on connect for 'presence' and 'chat'.
- Yjs moved to direct dependency; peer-dep subpath requirements annotated.
- Integration test harness (`startTestServer` + `connectTestClient`).

## [0.3.0] — 2026-05-19

### Fixed

- **`GatewayProxyClient` doc-comments** — removed "will 404" warnings
  on channel-publish / presence-query / chat-history / activity-history
  methods. Gateway HTTP API routes shipped in websocket-gateway commit
  `a62195c` (Wave 6); methods now work, gated by service-auth HMAC.
  Doc-comments updated to reflect the new requirement
  (`SERVICE_AUTH_SECRET` wired in helm before methods activate).

### Changed

- Verified `useAgentStream` is discoverable from package root in
  addition to `./client` and `./agent-streaming/client` subpaths.
  No change required; already exported via `export * from './client'`
  in `src/index.ts`.

## [0.2.1] — 2026-05-19

### Fixed

- **`useAgentStream` bundling failure for non-CRDT consumers** — added
  `./agent-streaming/client` subpath that exports `useAgentStream`
  without transitively importing Yjs/y-protocols. The `/client` barrel
  re-exports `GatewayProvider` which imports `y-protocols/awareness`
  at module top; consumers like OrgIQ portal that don't have Yjs
  installed failed to bundle under Vite. The new subpath bypasses
  the Yjs-bound exports. Pairs with the server-side
  `./agent-streaming` middleware.
- **Release process** — added `prepublishOnly` script and `RELEASE.md`
  recipe to prevent the v0.2.0 issue (tag created without running
  `npm run build`; dist/ missing useAgentStream.{js,d.ts}). file:
  consumers were saved by `prepare` hook on install, but
  `git tag` checkouts would have shipped incomplete dist.

## [0.2.0] — 2026-05-19

Wave 5 — Lambda-app enablement.

### Added

- **`./proxy-client` subpath** — `GatewayProxyClient` class for
  Lambda-native apps (OrgIQ, future App #3) to USE gateway-hosted
  realtime features over HTTP without speaking WebSocket. Wraps the
  gateway's existing ops endpoints (`/health`, `/cluster`, `/stats`,
  `/metrics`, `/hooks/pipeline/:path`) and pins URL shapes for the
  strategic channel/presence/chat/activity surface (those routes
  will 404 until gateway ships matching HTTP endpoints — documented
  as gateway-side follow-up). Includes `ProxyClientError` taxonomy
  (`Network` / `Http` / `Timeout`). +20 tests.
- **`useAgentStream` React hook in `./client`** — pairs with the
  server-side `agentStreamMiddleware` (`./agent-streaming`) for full
  FE adoption of AG-UI v0.1.x. Returns `{messages, streamingText,
  activeToolCalls, sessionId, isStreaming, error, sendMessage,
  reset, loadHistory}`. Replaces hand-rolled per-app hooks (OrgIQ's
  `useAgUiStream.ts` ~188 LOC) with a single library import. Handles
  CUSTOM `session` and `tool_call_result` events internally for
  AG-UI spec-gap interop. +13 tests.

### Fixed

- **README install path** — git-tag pin pattern
  (`github:owner/repo#tag`) was documented but doesn't work (npm
  clones gateway repo root, not the `realtime-modules/` subdirectory).
  README now documents `file:` sibling pin as canonical.
- **Subpath polish** — dropped `SubscriptionTracker` leak from `./chat`
  barrel (no external consumers, verified).

### Documentation

- **Transport-tiers section** added to README: Lambda lane
  (`/agent-streaming` only; HTTP+SSE via AWS Lambda Web Adapter on
  Function URL with `AWS_LWA_INVOKE_MODE=response_stream`) vs ECS
  lane (13 subpaths assuming persistent WebSocket via
  `MessageRouterContract`). Calls out the WS-on-Lambda-via-API-Gateway
  trap for cross-app shared state.

### Known gaps (documented, not blocking)

- Gateway-side HTTP endpoints for channel publish / presence query /
  chat history / activity history don't exist yet — `proxy-client`
  pins URL shapes but those methods return 404 until gateway ships
  matching routes.
- AG-UI v0.1.x spec gaps (sessionId on RUN_STARTED, result on
  TOOL_CALL_END) handled via CUSTOM events in `useAgentStream`.

---

## 0.1.0 — 2026-05-19

First public version. 16 subpaths shipped (server/client primitives + 10
fan-out services + agent-streaming + FeatureManifest contract). Gateway
is the reference consumer; OrgIQ adoption underway. 0.x is unstable —
pin exact tags; storage contracts are load-bearing.

### Added

- **`./client` — `useWebSocket` hook (Wave 3 fill).** Lifts the
  transport/reconnect/session logic currently duplicated in the
  gateway frontend (`frontend/src/hooks/useWebSocket.ts`) into a
  shared hook satisfying the existing `UseWebSocketReturn` contract.
- **`./client` — `useWebSocket` v2 (gateway swap-unblock).** Closes the
  five gaps documented in `docs/USEWEBSOCKET-GAP-vs-GATEWAY.md` so the
  gateway can drop its in-tree hook:
    - `persist?: { storage, keyPrefix? }` — opt-in sessionStorage
      persistence for `sessionToken` / `clientId` across page reloads.
    - `maxRetries?: number` (default `Infinity`) — when finite,
      exhausted retries transition to `disconnected` and emit a
      terminal `RECONNECT_EXHAUSTED` `GatewayError`.
    - `defaultChannel?: string` — seeds `currentChannel` on first
      render so feature hooks observe a non-empty channel.
    - Stale-socket guards on every handler (`onopen` / `onmessage` /
      `onerror` / `onclose`) — drops late events from sockets that
      React StrictMode's double-mount has already superseded.
    - `autoResubscribe?: boolean` (default `false`) — auto-replay of
      tracked channels on reconnect is now opt-in. Default matches
      gateway's pull model where feature hooks own subscribe lifecycle.
    - All five behaviors are opt-in / backward-compatible; existing
      consumers continue to work without changes.
- **`./server` — WebSocket handler factory (Wave 3 fill).** Server-side
  counterpart so consumers no longer have to hand-roll WS wiring around
  `CRDTService` + `MessageRouterContract`.

#### Scaffold + core (commit `61496b7`)

- Package skeleton: `@connorhoehn/realtime-modules`, MIT license,
  optional peer-deps for `react`, `express`, `yjs`, `y-protocols`,
  `@tiptap/*` so subpaths can be cherry-picked without pulling
  unrelated runtimes.
- Build + test toolchain: `tsc`, `jest` with `ts-jest`, `jsdom`
  environment for React-tier tests, `prepare` script so `file:` pins
  rebuild on install.
- **`FeatureManifest` type contract** (root export) — the shape every
  feature ships alongside its UI + backend triple: `name`, `version`,
  `envVars`, `channels`, `declarations`, `dependencies`, and
  `install.{backendRoutes,frontendImport}` hooks for the future CLI.

#### `./server` — CRDT (Cut 1, commit `ac3940b`)

Lifted from gateway's collaborative-documents stack:

- **`CRDTService`** — orchestrator for collaborative document state.
  Options-bag constructor accepting `messageRouter`, `snapshotStore`,
  `metadataStore`, `hotCache`, `logger`, and an optional `authz`
  callback (default permissive).
- **`SnapshotManager`** — parameterized over the `SnapshotStore` and
  `HotCache` contracts. Owns gzip snapshotting + restore.
- **`DocumentMetadataService`** — parameterized over the `MetadataStore`
  contract. Owns document-level metadata (titles, version names, etc.).
- **`DocumentPresenceService`**, **`AwarenessCoalescer`**, and
  **`IdleEvictionManager`** — awareness-state coalescing + idle-room
  eviction.
- **Store contracts**: `SnapshotStore`, `MetadataStore`, `HotCache`,
  `MessageRouterContract` — the entire pluggable-storage surface area.
  Snapshot bytes are gzipped at the contract boundary; stores
  round-trip them byte-for-byte.
- **In-memory store implementations**: `MemorySnapshotStore`,
  `MemoryMetadataStore`, `MemoryHotCache` — what the test suite uses
  and what zero-config consumers get out of the box.
- **`config` namespace** export — tuning knobs (snapshot intervals,
  eviction windows, operation batch window) as module-level constants.
- **`crdtManifest`** — `FeatureManifest` export for the CRDT feature.

#### `./client` — CRDT client (Cut 1, commit `ac3940b`)

- **`GatewayProvider`** — editor-agnostic Y.js provider. Bridges any
  `UseWebSocketReturn`-shaped transport to a `Y.Doc`.
- **Hooks**: `useYjsDoc`, `useAwarenessState`, `useCRDT`,
  `useIdleDetector`.
- **`SharedTextEditor`** — `contentEditable`-based fallback editor so
  consumers can render collaborative text without pulling in Tiptap,
  Monaco, or CodeMirror.
- **`UseWebSocketReturn` type contract** — `client/types.ts`. Now paired
  with a shipped `useWebSocket` implementation (see Wave 3 fill above).

#### `./adapters/tiptap` — Tiptap integration (commit `ac3940b`)

- **`TiptapEditor`** + **`EditorToolbar`** — wired against `Y.Doc` +
  `GatewayProvider`. Lives in a dedicated subpath so Monaco / CodeMirror
  / `contentEditable` consumers don't pay for Tiptap or ProseMirror.

#### `./agent-streaming` — AG-UI v0.1.x server emitter (commit `ac3940b`)

- **`AgentStreamImpl`** — server-side emitter implementing all 28 AG-UI
  v0.1.x event types with correct field naming (text, tool calls,
  reasoning, state, activity, lifecycle, etc.).
- **`createAgentStream`** — factory that opens an SSE response with
  keepalive heartbeat.
- **`agentStreamMiddleware`** — Express `RequestHandler` factory for
  `POST /…/stream` endpoints. The only Express-aware export in the
  package today.
- **`agentStreamingManifest`** — `FeatureManifest` export.
- Pairs with `@connorhoehnslalom/ui-components/agents` on the client.

#### `./presence` — Wave 2 (commit `74fd725`)

- **`PresenceService`** — in-process presence tracking with
  `subscribe`, `get`, `set`, and `heartbeat`. Configurable heartbeat /
  eviction timeouts and a pluggable `authorize` hook for per-channel
  access control.
- **`presenceManifest`** — `FeatureManifest` export.

#### `./chat` — Wave 2 (commit `74fd725`)

- **`ChatService`** — channel `join` / `leave` / `send` / `history`
  with an LRU-backed per-channel message cache.
- **`ChatStore` interface** + **`InMemoryChatStore`** reference
  implementation — the bring-your-own-storage seam for chat history.
- **`chatManifest`** — `FeatureManifest` export.

#### `./reactions` — Wave 2 (commit `74fd725`)

- **`ReactionService`** — emoji reactions tracked in a per-channel
  ring-buffer history.
- **Default reaction catalog** — 12 built-in emoji reactions out of
  the box.
- **`reactionsManifest`** — `FeatureManifest` export.

#### Docs (commit `74fd725`)

- `docs/ADOPTION-GUIDE.md` — operator-facing guide covering install,
  subpath overview, end-to-end "agent dashboard" example,
  bring-your-own-storage adapter recipe, `FeatureManifest` pattern,
  what's-not-included, and operational notes (peer-dep handling,
  cross-consumer pinning, logging/metrics, config overrides).

### Planned (post-extraction)

- **`realtime-modules` CLI** — `npx realtime-modules add <feature>`
  scaffolder that reads `FeatureManifest.install.{backendRoutes,frontendImport}`
  and wires the consumer's app. Aspirational; deferred until the package
  is extracted to its own repo.

### Known gaps at 0.1.0

- **No Express route mounters.** Features (other than
  `agentStreamMiddleware`) ship as service classes; backend route
  mounting is the consumer's responsibility.
- **No `realtime-modules` CLI.** `npx realtime-modules add <feature>`
  is aspirational.
- **`FeatureManifest` exports are partial.** All subpath manifests
  (`crdtManifest`, `agentStreamingManifest`, `presenceManifest`,
  `chatManifest`, `reactionsManifest`) are present, but platform
  tooling that consumes them (gateway / edge-gateway boot-time
  validation, channel pre-registration, event-catalog wiring) is not
  yet wired end-to-end.

### Stability

Every public API in `0.1.0` is **unstable** under the `0.x` contract.
Storage interfaces (`SnapshotStore`, `MetadataStore`, `HotCache`,
`ChatStore`, `MessageRouterContract`) are load-bearing — breaking
changes to those shapes will bump the minor version and be called out
explicitly in release notes so consumer adapter implementations can be
updated in lockstep.

[Unreleased]: https://github.com/connorhoehn/realtime-modules/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/connorhoehn/realtime-modules/releases/tag/v0.1.0
