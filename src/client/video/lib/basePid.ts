// A remote media participant's BASE pid: the id its camera publishes under. A publisher's screen share is the same id with
// the one known suffix `:screen`, and both land on one participant entry (one tile per person).
//
// Only that known suffix is stripped. A participant id may itself hold a colon: an interview guest's media id is
// `guest:<inviteId>-<stamp>`. Cutting at the first colon (the old `fullPid.split(':')[0]`) turned every such id into
// `guest`, so two guests shared one entry and the tile lost its name and app user id.

/** The suffix a publisher's screen-share producer carries on its participant id. */
export const SCREEN_PID_SUFFIX = ':screen';

/** `hank:screen` → `hank`; `guest:inv-1-k3j2:screen` → `guest:inv-1-k3j2`; any other id is returned as it is. */
export function basePidOf(fullPid: string): string {
  return fullPid.endsWith(SCREEN_PID_SUFFIX) ? fullPid.slice(0, -SCREEN_PID_SUFFIX.length) : fullPid;
}
