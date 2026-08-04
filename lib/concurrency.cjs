'use strict';
/**
 * Worker-pool and heap sizing for a shared workstation.
 *
 * THE DEFAULT IS WRONG FOR US
 * ---------------------------
 * Every mainstream runner sizes its pool to the host core count: vitest's thread
 * pool, jest's `maxWorkers` (cores - 1), `pytest -n auto`, `node --test`. That
 * default assumes the runner owns the machine. It does not. Measured on this
 * workstation: 12 logical CPUs, and WSL2 by default taking all 12 plus half the
 * RAM for the Docker VM, while the test workers themselves run on the Windows
 * side. Four repos at once ask for roughly 48 workers on 12 shared cores.
 *
 * Two separate budgets matter, and conflating them is the usual mistake:
 *   - CORES are shared with the WSL2 VM, so the host share is what can be spent.
 *   - HEAP is per worker. An unbounded V8 heap on a 31.6GB box was observed
 *     reaching 8GB in a single process, which pushes everything into swap and
 *     presents as CPU exhaustion because paging is charged as system time.
 */

const os = require('node:os');

const DEFAULTS = {
  /** Cores handed to the WSL2 VM, which the host cannot spend. Mirror .wslconfig. */
  wslProcessors: 8,
  /** How many repos might reasonably run their gate at once. */
  expectedConcurrentRepos: 2,
  /** Never starve a run down to nothing. */
  minWorkers: 1,
  /** Per-worker V8 heap ceiling, MB. */
  maxOldSpaceMb: 2048,
};

/**
 * @param {{cores?:number, wslProcessors?:number, expectedConcurrentRepos?:number,
 *          hostLocked?:boolean, minWorkers?:number}} o
 * @returns {{workers:number, reason:string, hostCores:number}}
 */
function computeWorkers(o = {}) {
  const cores = Number.isInteger(o.cores) && o.cores > 0 ? o.cores : os.cpus().length;
  const wsl = Number.isInteger(o.wslProcessors) ? o.wslProcessors : DEFAULTS.wslProcessors;
  const minWorkers = o.minWorkers ?? DEFAULTS.minWorkers;

  // WSL2 shares the same silicon rather than adding to it, but it is not busy
  // continuously, so charging the host its full allocation would over-correct.
  // Half is the working compromise.
  const hostCores = Math.max(1, cores - Math.floor(wsl / 2));

  // Under the host lock only one repo runs Docker phases at a time, so the pool
  // does not need dividing again -- that would serialise twice and waste the box.
  const divisor = o.hostLocked
    ? 1
    : Math.max(1, o.expectedConcurrentRepos ?? DEFAULTS.expectedConcurrentRepos);

  const workers = Math.max(minWorkers, Math.floor(hostCores / divisor));
  return {
    workers,
    hostCores,
    reason: o.hostLocked
      ? `${hostCores} host cores, serialised by hostlock`
      : `${hostCores} host cores / ${divisor} concurrent repos`,
  };
}

/**
 * Environment for a test runner. Emitted rather than baked into configs so one
 * policy covers vitest, jest, pytest and node --test without editing four files.
 */
function runnerEnv(o = {}) {
  const { workers } = computeWorkers(o);
  const heap = o.maxOldSpaceMb ?? DEFAULTS.maxOldSpaceMb;

  // Append rather than replace: an existing NODE_OPTIONS may carry loaders or
  // source-map flags the suite depends on.
  const existing = (o.nodeOptions ?? process.env.NODE_OPTIONS ?? '').trim();
  const heapFlag = `--max-old-space-size=${heap}`;
  const nodeOptions = /--max-old-space-size/.test(existing)
    ? existing
    : (existing ? `${existing} ${heapFlag}` : heapFlag);

  return {
    TMK_TEST_WORKERS: String(workers),
    VITEST_MAX_THREADS: String(workers),
    VITEST_MIN_THREADS: '1',
    JEST_WORKERS: String(workers),
    PYTEST_XDIST_AUTO_NUM_WORKERS: String(workers),
    UV_THREADPOOL_SIZE: String(Math.min(workers * 2, 16)),
    NODE_OPTIONS: nodeOptions,
  };
}

/** `--cpus` for a testcontainers fixture, so one runaway container cannot starve the host. */
function containerCpus(o = {}) {
  const { hostCores } = computeWorkers(o);
  return Math.max(1, Math.min(2, Math.floor(hostCores / 4)));
}

module.exports = { DEFAULTS, computeWorkers, runnerEnv, containerCpus };
