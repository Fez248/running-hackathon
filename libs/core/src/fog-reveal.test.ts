import { describe, expect, it } from 'vitest';
import { TILE_REVEAL_INTERVAL_MS, createTileRevealQueue } from './fog-reveal';

const CELLS = ['0_0', '0_1', '0_2', '1_0', '1_1'];

describe('createTileRevealQueue', () => {
  it('reveals nothing until something is queued', () => {
    const queue = createTileRevealQueue();
    expect(queue.release(0)).toEqual([]);
    expect(queue.revealed.size).toBe(0);
  });

  it('reveals only the first queued cell when a run starts', () => {
    const queue = createTileRevealQueue();
    queue.enqueue(CELLS);
    expect(queue.release(0)).toEqual(['0_0']);
    expect(queue.revealed.size).toBe(1);
    expect(queue.pending).toBe(CELLS.length - 1);
  });

  it('reveals at most one cell per interval', () => {
    const queue = createTileRevealQueue();
    queue.enqueue(CELLS);
    const released: string[] = [];
    for (let now = 0; now <= 3 * TILE_REVEAL_INTERVAL_MS; now += 100) {
      released.push(...queue.release(now));
    }
    expect(released).toEqual(CELLS.slice(0, 4));
  });

  it('hands cells back in the order they were walked', () => {
    const queue = createTileRevealQueue({ intervalMs: 10 });
    queue.enqueue(['a', 'b']);
    queue.enqueue(['c']);
    const released: string[] = [];
    for (let now = 0; now <= 40; now += 10) released.push(...queue.release(now));
    expect(released).toEqual(['a', 'b', 'c']);
  });

  it('banks no credit while the queue is empty', () => {
    const queue = createTileRevealQueue();
    for (let now = 0; now < 10_000; now += 100) expect(queue.release(now)).toEqual([]);
    queue.enqueue(CELLS);
    // The first cell of a stationary spell opens immediately, the next one waits.
    expect(queue.release(10_000)).toEqual(['0_0']);
    expect(queue.release(10_000 + TILE_REVEAL_INTERVAL_MS - 1)).toEqual([]);
    expect(queue.release(10_000 + TILE_REVEAL_INTERVAL_MS)).toEqual(['0_1']);
  });

  it('ignores duplicates and never re-reveals a cell', () => {
    const queue = createTileRevealQueue({ intervalMs: 10 });
    queue.enqueue(['a', 'a', 'b']);
    expect(queue.pending).toBe(2);
    expect(queue.release(0)).toEqual(['a']);
    queue.enqueue(['a']);
    expect(queue.pending).toBe(1);
    expect(queue.release(10)).toEqual(['b']);
    expect(queue.release(20)).toEqual([]);
    expect([...queue.revealed]).toEqual(['a', 'b']);
  });
});
