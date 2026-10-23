/**
 * High-performance, lightweight in-memory LRU Cache.
 * Used to store rendered SVGs keyed by `${file.path}:${file.stat.mtime}`.
 */

export interface CachedSvg {
  svg: string;
  width: number;
  height: number;
  viewBox: string;
}

export class LruCache<K, V> {
  private cache = new Map<K, V>();
  private capacity: number;

  constructor(capacity = 100) {
    this.capacity = Math.max(1, capacity);
  }

  get(key: K): V | undefined {
    if (!this.cache.has(key)) {
      return undefined;
    }
    const val = this.cache.get(key)!;
    // Refresh position to make it most recently used
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      // Evict least recently used item (the first key in Map insertion order)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, value);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  getCapacity(): number {
    return this.capacity;
  }

  setCapacity(newCapacity: number): void {
    this.capacity = Math.max(1, newCapacity);
    while (this.cache.size > this.capacity) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
  }
}
