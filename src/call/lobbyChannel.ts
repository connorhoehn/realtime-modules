// The mapping between a CALL and the CONVERSATION it happened in.
//
// A call is addressed by a lobby (`dm:alice:bob`, `room:design`) and a
// conversation by a channel (`chat:dm:alice:bob`, `room:design`). They are two
// names for one place, and until now each side of the system carried its own
// half of the rule: the frontend knew how to find a channel's lobby so it
// could list that channel's recordings, and the gateway needed the inverse so
// a finished call could post itself into the right thread.
//
// Two copies of one rule in two repos drift, and the failure is silent in
// both directions — a call posts into a channel nobody reads, or a
// conversation lists no recordings for calls it definitely had. So the rule
// lives here once, in both directions, with the round trip pinned by tests.
//
// Not every lobby has a conversation. An ad-hoc lobby with no thread behind it
// maps to null, which is an answer, not a failure.
//
// THREE conversation shapes carry a lobby, not two. A multi-party DM is
// addressed by its members (`chat:dm:a:b:c`) until that id would exceed the
// 100-char channel cap, at which point it becomes a HASHED group
// (`chat:dmg:<sha1>`). Both are the same product concept — a group chat — so
// both must map. Handling only the first meant a group silently lost calling
// once it grew past the cap: the same people in a smaller group could call,
// and nothing anywhere said why.

/** `chat:dm:alice:bob` → `dm:alice:bob`; `chat:dmg:<hash>` → `dmg:<hash>`;
 *  `room:design` → `room:design`. */
export function lobbyForChannel(channel: string | null | undefined): string | null {
  if (!channel) return null;
  // `chat:dmg:` is checked FIRST: it does not start with `chat:dm:` (the
  // eighth character is 'g', not ':'), so order is not load-bearing here —
  // but reading them together is how the pair stays obviously exhaustive.
  if (channel.startsWith('chat:dmg:')) return channel.slice('chat:'.length);
  if (channel.startsWith('chat:dm:')) return channel.slice('chat:'.length);
  if (channel.startsWith('room:')) return channel;
  // A plain channel (`general`) has no call lobby: calls are addressed to
  // people or to a room, and a bare channel is neither.
  return null;
}

/** `dm:alice:bob` → `chat:dm:alice:bob`; `dmg:<hash>` → `chat:dmg:<hash>`;
 *  `room:design` → `room:design`. */
export function channelForLobby(lobby: string | null | undefined): string | null {
  if (!lobby) return null;
  if (lobby.startsWith('dmg:') || lobby.startsWith('dm:')) return `chat:${lobby}`;
  if (lobby.startsWith('room:')) return lobby;
  return null;
}
