# Current direct recipients — 0.101.0

Channel admission does not cover user-addressed call frames or notification
replay. `attachRealtime({ filterClientMessage })` supplies a last-mile filter
to the local router for direct sends, local sends, broadcasts and channel
fanout. The public `ClientMessageFilter` type is exported from `./server`.

Return the original frame or a filtered copy to deliver it; return `null` to
suppress it. Synchronous predicates preserve synchronous sends. Async results
are awaited and discarded after disconnect, auth-context replacement or
handle replacement. Channel sends also retain their subscription generation
fence through the awaited filter; unsubscribe/resubscribe cannot revive an old
frame. Throws and rejections suppress delivery. A slow or refused
recipient does not prevent a permitted peer from receiving a broadcast.
Channel publication continues to enforce its existing channel checks.

The host owns policy and resource resolution. For example, an inbox bulk
frame may contain items from several tenants: filter each item using current
directory and resource access, retain membership fences across the whole
read, then recheck current identity before returning the copied batch. Never
mutate the shared frame or delete stored items just because a particular tab
cannot read them now.

`notifications({ authorize })` also supplies an async, fail-closed admission
hook for inbound history/read-state actions. It runs before store work; it
does not replace the last-mile recipient filter. Refusals emit
`AUTHZ_NOTIFICATION_DENIED`. Identity still comes from the router, so a
client-provided userId cannot redirect read-state writes.

Call action envelopes retain the resolved lobby even when a terminal action
was sent with only a callId and deletes call state before delivery. This lets
recipient policy resolve that resource after teardown. Sender action policy,
call ownership, seat recovery and call storage behavior remain in place.

Custom routers are responsible for equivalent delivery filtering;
`attachRealtime` does not wrap a custom transport. This feature establishes
neither distributed routing nor media-plane acceptance. It cannot withdraw
frames already delivered to a browser. Filters run on each delivery and add
the host policy/directory cost; capacity must be measured with that policy.
