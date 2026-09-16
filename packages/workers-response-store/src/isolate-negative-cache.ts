export class IsolateNegativeCache<K, V> {
  private readonly misses = new Map<K, number>();
  private readonly pending = new Map<K, Promise<V | null>>();

  constructor(
    private readonly capacity: number,
    private readonly ttlMs: number,
  ) {}

  async getOrLoad(key: K, load: () => Promise<V | null>): Promise<V | null> {
    const expiresAt = this.misses.get(key);
    if (expiresAt !== undefined) {
      if (expiresAt > Date.now()) {
        this.misses.delete(key);
        this.misses.set(key, expiresAt);
        return null;
      }
      this.misses.delete(key);
    }

    const existing = this.pending.get(key);
    if (existing) return existing;

    const pending = Promise.resolve().then(load);
    this.pending.set(key, pending);
    try {
      const value = await pending;
      if (value === null && this.pending.get(key) === pending) {
        this.misses.set(key, Date.now() + this.ttlMs);
        if (this.misses.size > this.capacity) {
          const oldest = this.misses.keys().next();
          if (!oldest.done) this.misses.delete(oldest.value);
        }
      }
      return value;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
  }

  delete(key: K): void {
    this.pending.delete(key);
    this.misses.delete(key);
  }
}
