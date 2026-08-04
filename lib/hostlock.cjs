'use strict';
/**
 * A host-wide mutex, so that only one repo runs its Docker-dependent test phases
 * at a time on a shared workstation.
 *
 * WHY
 * ---
 * Ownership labelling (v1.0.0) stopped repos DESTROYING each other's containers.
 * It did nothing to stop them all RUNNING at once. On a 12-core host, four repos
 * each sizing a worker pool to the core count asks for ~48 workers, plus
 * containers, plus the WSL2 VM which by default is handed all 12 cores and half
 * the RAM. The result is not merely slow: CPU starvation makes container startup
 * waits and test timeouts fail non-deterministically, which surfaces as flaky red
 * gates that look like code defects.
 *
 * Only the Docker phases are serialised. Lint, typecheck and unit tests do not
 * contend for the daemon and stay parallel, so the queue covers what actually
 * collides rather than everything.
 *
 * PID REUSE
 * ---------
 * Liveness alone is not proof the holder is alive: Windows recycles PIDs briskly,
 * and a recycled PID makes a dead lock look held forever. Each lock therefore
 * carries a random token and the holder's start time, and staleness is judged on
 * age as well as liveness. The failure modes are asymmetric -- treating a live
 * lock as stale corrupts a running suite, while treating a dead lock as live
 * costs a wait -- so every ambiguous case resolves toward waiting.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const LOCK_PATH = process.env.TMK_HOSTLOCK_PATH || path.join(os.tmpdir(), 'tmk-localci.lock');

/** A holder older than this is presumed dead however healthy its PID looks. */
const DEFAULT_STALE_MS = 45 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 40 * 60 * 1000;
const DEFAULT_POLL_MS = 3000;

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
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Release only if we still hold it. Comparing the token stops a process whose
 * lock was reaped as stale from later deleting somebody else's lock.
 */
function releaseIfOurs(lockPath, token) {
  const held = readLock(lockPath);
  if (held && held.token && held.token !== token) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire the host lock.
 *
 * @returns {Promise<() => void>} release function, idempotent
 */
async function acquire(repo, opts = {}) {
  const {
    lockPath = LOCK_PATH,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    staleMs = DEFAULT_STALE_MS,
    pollMs = DEFAULT_POLL_MS,
    log = (m) => process.stderr.write(`[hostlock] ${m}\n`),
  } = opts;

  const token = crypto.randomBytes(8).toString('hex');
  const payload = { repo, pid: process.pid, token, at: Date.now(), host: os.hostname() };
  const deadline = Date.now() + timeoutMs;
  let waited = false;

  for (;;) {
    if (tryWrite(lockPath, payload)) {
      if (waited) log(`acquired after waiting`);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releaseIfOurs(lockPath, token);
      };
      // A Ctrl-C that leaves the lock behind wedges every other repo for the
      // full stale window, so unwind on every path out.
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

    if (!waited) {
      log(`waiting: ${reason}`);
      waited = true;
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

module.exports = { acquire, withLock, isStale, readLock, releaseIfOurs, LOCK_PATH, DEFAULT_STALE_MS };
