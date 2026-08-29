/**
 * Paced fog reveal.
 *
 * Coverage arrives in clusters: one accepted fix reveals every cell within
 * `DEFAULT_REVEAL_RADIUS_M`, and the server answers a viewport query with
 * everything explored inside it. Punching all of that out at once opens a hole
 * the size of a neighbourhood in a single frame, which reads as a bug rather
 * than as exploration. The queue in here spaces reveals out instead: cells are
 * queued in the order they were walked and handed back one at a time, at most
 * one per interval, so the fog follows the runner tile by tile.
 *
 * Reveals stay monotonic: a released cell is remembered forever and can never
 * be queued — or re-fogged — again.
 */
export const TILE_REVEAL_INTERVAL_MS = 1_000;

export interface TileRevealQueueOptions {
  /** Minimum gap between two reveals. */
  intervalMs?: number;
}

export interface TileRevealQueue {
  /** Queues cells in walk order, skipping revealed and already queued ones. */
  enqueue(keys: readonly string[]): void;
  /**
   * The cells whose turn has come, in queue order. At most one cell per
   * interval, so a backlog drains at the same pace it was walked.
   */
  release(now: number): string[];
  /** Cells released so far, in release order. */
  readonly revealed: ReadonlySet<string>;
  /** Cells still waiting for their turn. */
  readonly pending: number;
}

export function createTileRevealQueue({
  intervalMs = TILE_REVEAL_INTERVAL_MS,
}: TileRevealQueueOptions = {}): TileRevealQueue {
  const revealed = new Set<string>();
  const queued = new Set<string>();
  const queue: string[] = [];
  let lastReleaseAt: number | null = null;

  return {
    enqueue(keys) {
      for (const key of keys) {
        if (revealed.has(key) || queued.has(key)) continue;
        queued.add(key);
        queue.push(key);
      }
    },
    release(now) {
      // An empty queue banks no credit: standing still must not buy a burst of
      // reveals for the moment the runner starts moving again.
      const next = queue[0];
      if (next === undefined) return [];
      if (lastReleaseAt !== null && now - lastReleaseAt < intervalMs) return [];

      queue.shift();
      queued.delete(next);
      revealed.add(next);
      lastReleaseAt = now;
      return [next];
    },
    get revealed() {
      return revealed;
    },
    get pending() {
      return queue.length;
    },
  };
}
