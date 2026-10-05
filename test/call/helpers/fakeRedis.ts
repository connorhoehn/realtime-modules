// In-memory Redis double shared by two CallService instances in the
// document-call tests: one Map is "the cluster's Redis", so two services
// built on it behave like two gateway replicas. Only the lowercase ioredis
// names are provided; RedisCallStateStore probes for these first.

export class FakeRedis {
  hashes = new Map<string, Map<string, string>>();
  sets = new Map<string, Set<string>>();
  strings = new Map<string, string>();
  ttls = new Map<string, number>();

  // Atomic script double: these branches mutate maps without yielding.
  async command(command: string, script: string, count: number, ...values: (string | number)[]) {
    if (command !== 'EVAL') throw new Error('FakeRedis only implements EVAL here');
    const keys = values.slice(0, count).map(String);
    const args = values.slice(count).map(String);
    const hash = this.hashes.get(keys[0]);
    if (script.startsWith('-- call-claim-accepted-seat-v1')) {
      if (!hash || hash.get('lobbyName') !== args[0]) return [0, ''];
      const members = this.sets.get(keys[1]) ?? new Set<string>();
      const winner = hash.get('seat:' + args[3]);
      if (winner && winner !== args[1] && members.has(winner) && winner !== args[4]) return [0, winner];
      if (winner && winner !== args[1] && winner === args[4]) {
        members.delete(winner);
        const old = this.sets.get(args[6] + winner); old?.delete(args[2]);
        if (old?.size === 0) this.sets.delete(args[6] + winner);
      }
      hash.set('seat:' + args[3], args[1]); members.add(args[1]); this.sets.set(keys[1], members);
      for (const key of [keys[2], keys[3]]) {
        const values = this.sets.get(key) ?? new Set<string>(); values.add(args[2]); this.sets.set(key, values);
      }
      for (const key of keys) this.ttls.set(key, Number(args[5]));
      return [1, args[1]];
    }
    if (script.startsWith('-- call-resume-participant-v1')) {
      const participants = this.sets.get(keys[1]);
      if (!hash || hash.get('lobbyName') !== args[0] || !this.sets.get(keys[3])?.has(args[2])
        || (!this.strings.has(keys[4]) && (participants?.size ?? 0) < 2)) return 0;
      const winner = hash.get('seat:' + args[6]);
      if (winner && winner !== args[1] && participants?.has(winner) && !(JSON.parse(args[4]) as string[]).includes(winner)) return 0;
      hash.set('seat:' + args[6], args[1]);
      const members = participants ?? new Set<string>();
      members.add(args[1]); this.sets.set(keys[1], members);
      const clients = this.sets.get(keys[2]) ?? new Set<string>();
      clients.add(args[2]); this.sets.set(keys[2], clients);
      for (const old of JSON.parse(args[4]) as string[]) {
        if (old === args[1]) continue;
        members.delete(old);
        const oldCalls = this.sets.get(args[5] + old);
        oldCalls?.delete(args[2]);
        if (oldCalls?.size === 0) this.sets.delete(args[5] + old);
      }
      const lobby = this.sets.get(keys[5]) ?? new Set<string>();
      lobby.add(args[2]); this.sets.set(keys[5], lobby);
      this.strings.set(keys[4], '1');
      for (const key of keys) this.ttls.set(key, Number(args[3]));
      return 1;
    }
    if (script.startsWith('-- call-forget-unchanged-v1')) {
      const expected = JSON.parse(args[3]) as string[];
      const members = this.sets.get(keys[1]);
      if (!hash || hash.get('callerId') !== args[0] || hash.get('lobbyName') !== args[1]
        || (hash.get('invitedAt') ?? '') !== args[2] || (members?.size ?? 0) !== expected.length
        || expected.some((cid) => !members?.has(cid))) return 0;
      for (const cid of expected) {
        const calls = this.sets.get(args[5] + cid);
        calls?.delete(args[4]);
        if (calls?.size === 0) this.sets.delete(args[5] + cid);
      }
      this.hashes.delete(keys[0]); this.sets.delete(keys[1]); this.strings.delete(keys[2]);
      return 1;
    }
    throw new Error('Unknown FakeRedis Lua script');
  }

  async hset(key: string, field: string, value: string) {
    let h = this.hashes.get(key);
    if (!h) { h = new Map(); this.hashes.set(key, h); }
    h.set(field, value);
    return 1;
  }
  async hsetnx(key: string, field: string, value: string) {
    const h = this.hashes.get(key);
    if (h && h.has(field)) return 0;
    await this.hset(key, field, value);
    return 1;
  }
  async hget(key: string, field: string) {
    return this.hashes.get(key)?.get(field) ?? null;
  }
  async hgetall(key: string) {
    const h = this.hashes.get(key);
    return h ? Object.fromEntries(h) : {};
  }
  async hdel(key: string, ...fields: string[]) {
    const h = this.hashes.get(key);
    if (!h) return 0;
    let n = 0;
    for (const f of fields) if (h.delete(f)) n += 1;
    if (h.size === 0) this.hashes.delete(key);
    return n;
  }
  async sadd(key: string, ...members: string[]) {
    let s = this.sets.get(key);
    if (!s) { s = new Set(); this.sets.set(key, s); }
    for (const m of members) s.add(m);
    return members.length;
  }
  async srem(key: string, ...members: string[]) {
    const s = this.sets.get(key);
    if (!s) return 0;
    for (const m of members) s.delete(m);
    if (s.size === 0) this.sets.delete(key);
    return members.length;
  }
  async smembers(key: string) {
    return Array.from(this.sets.get(key) ?? []);
  }
  async del(...keys: string[]) {
    for (const k of keys) {
      this.hashes.delete(k);
      this.sets.delete(k);
      this.strings.delete(k);
    }
    return keys.length;
  }
  async expire(key: string, seconds: number) {
    this.ttls.set(key, seconds);
    return 1;
  }
  async get(key: string) {
    return this.strings.get(key) ?? null;
  }
  async set(key: string, value: string, ...args: unknown[]) {
    const opts = args[0];
    const nx = (opts && typeof opts === 'object' && (opts as { NX?: boolean }).NX) || args.includes('NX');
    if (nx && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK';
  }
}
