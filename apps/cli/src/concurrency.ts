/**
 * Concurrency primitives for wave mode (`worktree_lanes > 1`).
 *
 * The loop was serial by construction, and serial execution was doing real work: it made
 * double-claims and cross-PR merge collisions impossible without any coordination. Running lanes in
 * parallel gives that up, so each guarantee it was providing implicitly has to be re-established
 * explicitly. These are those mechanisms.
 *
 * Everything here is INTRA-PROCESS. One driver process coordinating its own lanes is exactly what
 * these solve; two driver processes against the same board still race on the Owner field, because
 * Projects v2 has no conditional field update to build a compare-and-set on. Do not read a green
 * wave run as evidence that concurrent drivers are safe.
 */

/**
 * A FIFO mutex. Waiters are served in arrival order, so a lane cannot be starved by later arrivals —
 * which matters for the merge lock, where the queue is the merge order.
 */
export type Mutex = {
  /** Run `fn` with the lock held. Released on throw. */
  run: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Waiters currently queued behind the holder. For logging only. */
  waiting: () => number;
};

export const createMutex = (): Mutex => {
  const waiters: (() => void)[] = [];
  let held = false;

  const acquire = async (): Promise<void> => {
    if (!held) {
      held = true;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  };

  const release = (): void => {
    const next = waiters.shift();
    // Hand the lock straight to the next waiter rather than clearing `held` — clearing it would let a
    // task that arrives before the woken waiter actually runs jump the queue.
    if (next) next();
    else held = false;
  };

  return {
    run: async <T>(fn: () => Promise<T>): Promise<T> => {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
    waiting: () => waiters.length,
  };
};

/**
 * A pool of lane indices `0…size-1`. `acquire` resolves with the lowest free index, waiting when the
 * pool is exhausted.
 *
 * Lowest-free rather than round-robin on purpose: lanes are persistent worktrees whose value is a warm
 * `node_modules` and warm build caches. Reusing low indices keeps a small working set hot, where
 * round-robin would spread N issues across N cold-ish lanes.
 */
export type LanePool = {
  acquire: () => Promise<number>;
  release: (lane: number) => void;
  size: number;
};

export const createLanePool = (size: number): LanePool => {
  const free = Array.from({ length: size }, (_, i) => i);
  const waiters: ((lane: number) => void)[] = [];

  return {
    size,
    acquire: async (): Promise<number> => {
      const lane = free.shift();
      if (lane !== undefined) return lane;
      return new Promise<number>((resolve) => waiters.push(resolve));
    },
    release: (lane: number): void => {
      const next = waiters.shift();
      if (next) next(lane);
      else {
        free.push(lane);
        free.sort((a, b) => a - b);
      }
    },
  };
};

/**
 * Pull items off a shared cursor and run `work` on each, `concurrency` at a time.
 *
 * Stops early and rethrows the FIRST error whose `isFatal` says the whole run is doomed (an exhausted
 * API quota, a dead runner CLI — anything that will fail identically for every remaining item). Peers
 * already in flight are allowed to finish rather than being killed: they hold board claims and may
 * hold an open PR, and abandoning those mid-pipeline is what leaves items stranded In Progress.
 * Non-fatal errors are reported through `onError` and the queue continues.
 */
export const runPooled = async <T>(
  items: T[],
  concurrency: number,
  work: (item: T, lane: number) => Promise<void>,
  opts: {
    pool: LanePool;
    isFatal: (e: unknown) => boolean;
    onError: (e: unknown, item: T) => void;
  },
): Promise<void> => {
  let cursor = 0;
  let fatal: unknown;

  const worker = async (): Promise<void> => {
    for (;;) {
      // `fatal` is checked before taking work, so a doomed run stops claiming new issues immediately
      // while in-flight ones finish.
      if (fatal !== undefined) return;
      // Safe without a lock: reading and incrementing is synchronous, and JS runs it to completion
      // before any other worker resumes.
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;

      const lane = await opts.pool.acquire();
      try {
        await work(item, lane);
      } catch (e) {
        if (opts.isFatal(e)) fatal ??= e;
        else opts.onError(e, item);
      } finally {
        opts.pool.release(lane);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  if (fatal !== undefined) throw fatal;
};
