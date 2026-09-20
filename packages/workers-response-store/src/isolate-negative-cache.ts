export class IsolateNegativeCache<K> {
  private readonly misses = new Map<K, number>();

  constructor(
    private readonly capacity: number,
    private readonly ttlMs: number,
  ) {}

  has(key: K): boolean {
    const expiresAt = this.misses.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.misses.delete(key);
      return false;
    }

    this.misses.delete(key);
    this.misses.set(key, expiresAt);
    return true;
  }

  add(key: K): void {
    this.misses.delete(key);
    this.misses.set(key, Date.now() + this.ttlMs);
    if (this.misses.size > this.capacity) {
      const oldest = this.misses.keys().next();
      if (!oldest.done) this.misses.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.misses.delete(key);
  }
}
