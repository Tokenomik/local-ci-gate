'use strict';

/**
 * A host-wide mutex for Docker-dependent gate runs.
 *
 * Several repositories on one workstation share one Docker daemon, one CPU and
 * one set of ports. Without a mutex their suites interleave and starve each
 * other's containers; with one, the second repository waits and only the gate
 * collides rather than everything.
 *
 * PID REUSE, AND WHY A HEARTBEAT REPLACED IT
 * ------------------------------------------
 * Liveness alone is not proof the holder is alive: Windows recycles PIDs
 * briskly, and a recycled PID makes a dead lock look held. This file used to
 * say that each lock carried the holder's start time and that staleness was
 * judged on it. It did not - the payload carried pid, token, at and host, and
 * nothing else - so the protection the comment described was never implemented.
 *
 * On 27 August 2026 that cost eighteen minutes of a gate waiting on
 * `held by graphene_supply (pid 25760)` when pid 25760 did not exist. Every
 * repository on the workstation queued behind a corpse.
 *
 * Rather than add the start-time comparison, the holder now **heartbeats**: it
 * rewrites its own timestamp every few seconds while it holds the lock. A
 * holder that was killed stops heartbeating, and the lock goes stale within a
 * poll or two whatever its PID is doing. This sidesteps PID reuse entirely
 * rather than trying to detect it, needs no query of another process, and is
 * the same discipline the resource model asks for elsewhere: liveness is a
 * signal the owner emits, not one an observer infers.
 *
 * The failure modes remain asymmetric - treating a live lock as stale corrupts
 * a running suite, while treating a dead lock as live costs a wait - so the
 * heartbeat window is generous relative to the interval.
 */

const fs = require('node:fs');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const crypto = require('node:crypto');

const LOCK_PATH = path.join(os.tmpdir(), 'tokenomik-local-ci-gate.lock');

const DEFAULT_TIMEOUT_MS = 125 * 60 * 1000;
const DEFAULT_POLL_MS = 3 * 1000;

/** A holder older than this is presumed dead however healthy its PID looks. */
const DEFAULT_STALE_MS = 120 * 60 * 1000;

/** How often a holder rewrites its timestamp while it works. */
const HEARTBEAT_MS = 5 * 1000;

/**
 * How far behind a heartbeat may fall before the holder is presumed gone.
 *
 * Six intervals, because a machine under the load this mutex exists to manage
 * will occasionally miss one, and a false stale is the expensive direction.
 */
const HEARTBEAT_STALE_MS = HEARTBEAT_MS * 24; // 2 min

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to another user: alive for our purposes.
    return e && e.code === 'EPERM';
  }
}

function readLock(lockPath = LOCK_PATH) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Pure staleness decision, so it can be tested without spawning processes.
 * @returns {{stale:boolean, reason:string}}
 */
function isStale(held, { nowMs = Date.now(), staleMs = DEFAULT_STALE_MS, alive = pidAlive } = {}) {
  if (!held || typeof held !== 'object') {
    return { stale: true, reason: 'lock file unreadable or malformed' };
  }
  if (!Number.isInteger(held.pid)) {
    return { stale: true, reason: 'lock file has no usable pid' };
  }

  const ageMs = nowMs - (held.at || 0);
  if (ageMs > staleMs) {
    return {
      stale: true,
      reason: `held ${Math.round(ageMs / 60000)}min (> ${Math.round(staleMs / 60000)}min) - presumed dead`,
    };
  }

  /*
   * The heartbeat decides, when there is one.
   *
   * A killed holder stops writing it, so this catches the case a PID check
   * cannot: a dead holder whose number has been recycled by something else.
   * Locks written by an older version carry no heartbeat, so their absence
   * falls through to the PID check rather than being treated as stale - an
   * upgrade must not invalidate a lock a running suite still holds.
   */
  if (Number.isFinite(held.heartbeatAt)) {
    const sinceBeat = nowMs - held.heartbeatAt;
    if (sinceBeat > HEARTBEAT_STALE_MS) {
      /*
       * Silence is death. The heartbeat runs on a worker thread, so a live
       * holder beats every few seconds whatever its main thread is doing - a
       * 25-minute spawnSync test step no longer stalls it. That is what makes
       * this safe: 1.4.1 saw a healthy holder silent for 544s and had to make
       * the PID a veto, which sent a hung or recycled holder to the 2h cap.
       *
       * With a trustworthy heartbeat the PID is no longer consulted here. A
       * recycled PID is alive and silent - exactly what this catches - and a
       * hung holder is reclaimed in minutes rather than hours. The window is
       * generous (2 min) for genuine OS-level stalls of the writer itself.
       */
      return {
        stale: true,
        reason: `holder ${held.repo || '?'} (pid ${held.pid}) stopped heartbeating ${Math.round(sinceBeat / 1000)}s ago (> ${HEARTBEAT_STALE_MS / 1000}s)`,
      };
    }
  }

  if (!alive(held.pid)) {
    return { stale: true, reason: `holder pid ${held.pid} is gone` };
  }

  return { stale: false, reason: `held by ${held.repo || '?'} (pid ${held.pid})` };
}

function tryWrite(lockPath, payload) {
  // 'wx' is atomic create-or-fail: the OS arbitrates the race, not us.
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
  try {
    fs.writeSync(fd, JSON.stringify(payload));
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/**
 * Rewrite our own timestamp, and only ours.
 *
 * The token check matters: if our lock was judged stale and cleared while we
 * were still working, somebody else owns the file now, and beating on it would
 * make their lock look like ours.
 */
/**
 * Beat from a worker thread, so a synchronous step on the main thread cannot
 * stall it. Falls back to the event loop where workers are unavailable.
 */
function startHeartbeatWorker(lockPath, token, intervalMs) {
  const src = "const fs = require('fs');\nconst { workerData } = require('worker_threads');\nconst { lockPath, token, intervalMs } = workerData;\nsetInterval(() => {\n  try {\n    const held = JSON.parse(fs.readFileSync(lockPath, 'utf8'));\n    if (!held || held.token !== token) return;\n    held.heartbeatAt = Date.now();\n    fs.writeFileSync(lockPath, JSON.stringify(held));\n  } catch {}\n}, intervalMs);";
  let worker;
  try {
    worker = new Worker(src, { eval: true, workerData: { lockPath, token, intervalMs } });
    worker.unref();
    worker.on('error', () => {});
  } catch {
    const iv = setInterval(() => heartbeat(lockPath, token), intervalMs);
    if (typeof iv.unref === 'function') iv.unref();
    return { stop: () => clearInterval(iv) };
  }
  return { stop: () => { try { worker.terminate(); } catch {} } };
}

function heartbeat(lockPath, token) {
  const held = readLock(lockPath);
  if (!held || held.token !== token) return false;
  held.heartbeatAt = Date.now();
  try {
    fs.writeFileSync(lockPath, JSON.stringify(held));
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the lock only if it is still ours.
 *
 * Returns whether it did, because a caller that cannot tell 'released' from
 * 'somebody else owns this now' has no way to notice that its own lock was
 * judged stale while it was still working.
 */
function releaseIfOurs(lockPath, token) {
  const held = readLock(lockPath);
  if (!held || held.token !== token) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    /* already gone */
    return false;
  }
}

/**
 * Acquire the host lock.
 * @returns {Promise<() => void>} release
 */
async function acquire(repo, opts = {}) {
  const {
    lockPath = LOCK_PATH,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    staleMs = DEFAULT_STALE_MS,
    pollMs = DEFAULT_POLL_MS,
    heartbeatMs = HEARTBEAT_MS,
    log = (m) => process.stderr.write(`[hostlock] ${m}\n`),
  } = opts;

  const token = crypto.randomBytes(8).toString('hex');
  const now = Date.now();
  const payload = {
    repo,
    pid: process.pid,
    token,
    at: now,
    heartbeatAt: now,
    host: os.hostname(),
  };
  const deadline = Date.now() + timeoutMs;
  let waited = false;
  let lastReason = '';

  for (;;) {
    if (tryWrite(lockPath, payload)) {
      if (waited) log('acquired after waiting');

      /*
       * The heartbeat runs on its own thread, not the event loop.
       *
       * The gate calls spawnSync for its test steps, and spawnSync blocks the
       * event loop for the whole step - so a setInterval heartbeat stopped for as
       * long as the longest suite ran. A live holder went silent for 544s and a
       * waiter stole its lock (1.4.1). That fix made the PID a veto, which stopped
       * the theft but made a hung or recycled holder wait the full 2h cap. Both
       * symptoms have one cause: the heartbeat was never a liveness signal,
       * because the thing it measured could not beat while working. A worker
       * thread beats through any synchronous step.
       */
      const beat = startHeartbeatWorker(lockPath, token, heartbeatMs);

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        beat.stop();
        releaseIfOurs(lockPath, token);
      };
      // A Ctrl-C that leaves the lock behind wedges every other repo until the
      // heartbeat lapses, so unwind on every path out.
      process.once('exit', release);
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
        try {
          process.once(sig, () => {
            release();
            process.exit(130);
          });
        } catch {
          /* signal unsupported on this platform */
        }
      }
      return release;
    }

    const held = readLock(lockPath);
    const { stale, reason } = isStale(held, { staleMs });
    if (stale) {
      log(`clearing stale lock: ${reason}`);
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* somebody else cleared it first; loop and retry */
      }
      continue;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 60000)}min waiting for the local CI host lock: ${reason}`,
      );
    }

    /*
     * Say it again when it changes, and periodically when it does not.
     *
     * The old version logged once. An operator watching a run therefore saw a
     * single line naming a holder and a PID, with no way to tell whether that
     * was still true a quarter of an hour later - and it read as a live holder
     * when the holder had in fact died.
     */
    if (!waited || reason !== lastReason) {
      log(`waiting: ${reason}`);
      waited = true;
      lastReason = reason;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Convenience: run fn while holding the lock, always releasing. */
async function withLock(repo, fn, opts = {}) {
  const release = await acquire(repo, opts);
  try {
    return await fn();
  } finally {
    release();
  }
}

module.exports = {
  acquire,
  withLock,
  isStale,
  readLock,
  heartbeat,
  releaseIfOurs,
  LOCK_PATH,
  DEFAULT_STALE_MS,
  HEARTBEAT_MS,
  HEARTBEAT_STALE_MS,
};
