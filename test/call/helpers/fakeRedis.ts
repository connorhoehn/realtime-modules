// In-memory Redis double shared by two CallService instances in the
// document-call tests: one Map is "the cluster's Redis", so two services
// built on it behave like two gateway replicas. Only the lowercase ioredis
// names are provided; RedisCallStateStore probes for these first.

export class FakeRedis {
  hashes = new Map<string, Map<string, string>>();
  sets = new Map<string, Set<string>>();
  strings = new Map<string, string>();
  ttls = new Map<string, number>();

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
  async set(key: string, value: string, ...args: unknown[]) {
    const opts = args[0];
    const nx = (opts && typeof opts === 'object' && (opts as { NX?: boolean }).NX) || args.includes('NX');
    if (nx && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK';
  }
}
