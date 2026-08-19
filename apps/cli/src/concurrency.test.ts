import { describe, expect, test } from "bun:test";

import { createLanePool, createMutex, runPooled } from "./concurrency.ts";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("createMutex", () => {
  test("serializes overlapping critical sections", async () => {
    const m = createMutex();
    const events: string[] = [];
    const section = async (name: string): Promise<void> =>
      m.run(async () => {
        events.push(`${name}:enter`);
        await tick();
        events.push(`${name}:exit`);
      });

    await Promise.all([section("a"), section("b"), section("c")]);
    // No enter may appear between another holder's enter and exit.
    expect(events).toEqual(["a:enter", "a:exit", "b:enter", "b:exit", "c:enter", "c:exit"]);
  });

  test("waiters are served FIFO, so the merge order is the arrival order", async () => {
    const m = createMutex();
    const order: number[] = [];
    const tasks = [1, 2, 3, 4].map((n) =>
      m.run(async () => {
        order.push(n);
        await tick();
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  /**
   * A throw inside the critical section must not wedge the lock — the merge lock is held across a
   * network call that can fail, and a leaked lock would hang every remaining lane at merge time.
   */
  test("a throwing section releases the lock", async () => {
    const m = createMutex();
    await expect(
      m.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await m.run(async () => "recovered")).toBe("recovered");
  });

  test("waiting() reports the queue depth behind the holder", async () => {
    const m = createMutex();
    let release: () => void = () => {};
    const held = m.run(() => new Promise<void>((r) => (release = r)));
    const queued = [m.run(async () => {}), m.run(async () => {})];
    await tick();
    expect(m.waiting()).toBe(2);
    release();
    await Promise.all([held, ...queued]);
    expect(m.waiting()).toBe(0);
  });
});

describe("createLanePool", () => {
  test("hands out distinct lanes and blocks once exhausted", async () => {
    const pool = createLanePool(2);
    const a = await pool.acquire();
    const b = await pool.acquire();
    expect(new Set([a, b]).size).toBe(2);

    let third: number | undefined;
    const pending = pool.acquire().then((l) => (third = l));
    await tick();
    expect(third).toBeUndefined(); // exhausted — must wait, not hand out a duplicate

    pool.release(a);
    await pending;
    expect(third).toBe(a);
  });

  /** Lanes are persistent worktrees; reusing low indices keeps a small set of caches warm. */
  test("prefers the lowest free lane", async () => {
    const pool = createLanePool(3);
    const a = await pool.acquire();
    const b = await pool.acquire();
    const c = await pool.acquire();
    expect([a, b, c]).toEqual([0, 1, 2]);
    pool.release(2);
    pool.release(0);
    expect(await pool.acquire()).toBe(0);
  });
});

describe("runPooled", () => {
  test("every item is worked exactly once, never above the concurrency cap", async () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    const seen: number[] = [];
    let live = 0;
    let peak = 0;

    await runPooled(
      items,
      4,
      async (item) => {
        live++;
        peak = Math.max(peak, live);
        await tick();
        seen.push(item);
        live--;
      },
      { pool: createLanePool(4), isFatal: () => false, onError: () => {} },
    );

    expect(seen.toSorted((a, b) => a - b)).toEqual(items);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // it really did run in parallel
  });

  test("each concurrent item holds a distinct lane for its whole run", async () => {
    const overlaps: number[] = [];
    const held = new Set<number>();
    await runPooled(
      Array.from({ length: 8 }, (_, i) => i),
      3,
      async (_item, lane) => {
        expect(held.has(lane)).toBe(false);
        held.add(lane);
        overlaps.push(held.size);
        await tick();
        held.delete(lane);
      },
      { pool: createLanePool(3), isFatal: () => false, onError: () => {} },
    );
    expect(Math.max(...overlaps)).toBeLessThanOrEqual(3);
  });

  test("a non-fatal error is reported and the queue continues", async () => {
    const errors: number[] = [];
    const done: number[] = [];
    await runPooled(
      [1, 2, 3, 4],
      2,
      async (item) => {
        if (item === 2) throw new Error(`bad ${item}`);
        done.push(item);
      },
      {
        pool: createLanePool(2),
        isFatal: () => false,
        onError: (_e, item) => errors.push(item),
      },
    );
    expect(errors).toEqual([2]);
    expect(done.toSorted()).toEqual([1, 3, 4]);
  });

  /**
   * A run-fatal condition (exhausted quota, dead runner CLI) recurs identically for every remaining
   * item, so it must stop the run rather than blocking each item in turn — the failure mode that once
   * burned a whole curated Ready queue into Blocked in under a minute.
   */
  test("a fatal error stops new work and rethrows", async () => {
    const started: number[] = [];
    const items = Array.from({ length: 20 }, (_, i) => i);

    await expect(
      runPooled(
        items,
        2,
        async (item) => {
          started.push(item);
          await tick();
          if (item === 0) throw new Error("api-quota exhausted");
        },
        {
          pool: createLanePool(2),
          isFatal: (e) => String(e).includes("api-quota"),
          onError: () => {},
        },
      ),
    ).rejects.toThrow("api-quota");

    // Far fewer than all 20 were started — the run stopped taking work.
    expect(started.length).toBeLessThan(items.length);
  });

  test("concurrency of 1 is exactly serial", async () => {
    const events: string[] = [];
    await runPooled(
      [1, 2, 3],
      1,
      async (item) => {
        events.push(`${item}:enter`);
        await tick();
        events.push(`${item}:exit`);
      },
      { pool: createLanePool(1), isFatal: () => false, onError: () => {} },
    );
    expect(events).toEqual(["1:enter", "1:exit", "2:enter", "2:exit", "3:enter", "3:exit"]);
  });
});
