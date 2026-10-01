# Chat pins storage

`MemoryChatPinsStore` (`/chat`) and `DynamoChatPinsStore`
(`/server/stores/dynamo`) implement `ChatPinsStore`: `pin(input)`,
`unpin(channelId, messageId)`, and `list(channelId)`.

Pins are separate channel state. A member can pin another member's message;
unpinning never edits its metadata. The host checks channel access and stamps
`pinnedBy` from its authenticated subject before calling the store.

```ts
const pins = new DynamoChatPinsStore({
  client: dynamoClient,
  tableName: 'orgiq-social-chat-pins',
});
await pins.pin({ channelId, messageId, pinnedBy: userId, text, author, sentAt });
const rows = await pins.list(channelId);
await pins.unpin(channelId, messageId);
```

The table uses string keys `channelId` / `messageId` and numeric `ttl`.
Retention defaults to 90 days, like the chat tables. `list` follows all query
pages, excludes expired rows awaiting DynamoDB deletion, and sorts by pin
time descending. It uses a consistent read so optimistic client writes can
reconcile immediately. The client is injected; errors reach the caller.

`sentAt` is the message's send time and stays absent when unknown. It is
never replaced by the pinning clock. Previews collapse whitespace and cap at
140 characters. Re-pinning the same message replaces one row; removing an
absent pin succeeds.

For a resettable mock, construct `MemoryChatPinsStore({ rows: () => fixture.rows(),
now: () => clock.now().getTime() })`. The row getter is evaluated on each
operation, so replacing the fixture also removes old pins. Both stores accept
an injected clock for deterministic checks.
