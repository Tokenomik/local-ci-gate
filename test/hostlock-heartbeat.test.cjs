'use strict';

/**
 * The defect of 27 August 2026, as a test.
 *
 * A gate waited eighteen minutes on `held by graphene_supply (pid 25760)` when
 * pid 25760 did not exist. The file's own header claimed each lock carried the
 * holder's start time and that staleness was judged on it; the payload carried
 * no such thing, so a dead holder whose PID had been recycled looked alive for
 * the full forty-five minute window, and every repository on the workstation
 * queued behind a corpse.
 *
 * These are the cases that would have caught it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isStale, heartbeat, readLock, HEARTBEAT_STALE_MS } = require('../lib/hostlock.cjs');

function tmpLock(name) {
  return path.join(os.tmpdir(), `hostlock-hb-${name}-${process.pid}-${Date.now()}.lock`);
}

test('a stalled holder whose PID is still alive is NOT stale - it keeps the lock', () => {
  // This is the incident, corrected. A running suite stalled its heartbeat for
  // longer than the window (observed: 544s) while its PID kept running. The old
  // behaviour stole the lock here and two gates collided, killing the live one.
  // A stale heartbeat on a LIVE pid must now keep waiting, not steal.
  const held = {
    repo: 'graphene_supply',
    pid: 25760,
    token: 'x',
    at: Date.now() - 60_000,                                   // young lock (well under the 45min cap)
    heartbeatAt: Date.now() - (HEARTBEAT_STALE_MS + 5_000),    // heartbeat lapsed
  };
  const { stale } = isStale(held, { alive: () => true });       // pid answers AND is genuinely ours
  assert.equal(stale, false, 'a stalled-but-live holder keeps its lock');
});

test('a holder that stopped heartbeating AND whose pid is gone is stale', () => {
  // The clean-kill case the heartbeat exists to catch fast: the holder was killed,
  // its pid is gone, and we must reclaim within the heartbeat window, not wait the
  // full 45min cap.
  const held = {
    repo: 'graphene_supply',
    pid: 25760,
    token: 'x',
    at: Date.now() - 60_000,
    heartbeatAt: Date.now() - (HEARTBEAT_STALE_MS + 5_000),
  };
  const { stale, reason } = isStale(held, { alive: () => false });
  assert.equal(stale, true, 'a lapsed heartbeat on a dead pid is reclaimable');
  assert.match(reason, /stopped heartbeating/);
});

test('a fresh heartbeat keeps the lock held', () => {
  const held = { repo: 'a', pid: 1, token: 'x', at: Date.now(), heartbeatAt: Date.now() };
  assert.equal(isStale(held, { alive: () => true }).stale, false);
});

test('PID reuse cannot deadlock: a lapsed heartbeat on a live-looking reused pid still clears at the 45min cap', () => {
  // The scenario the heartbeat-only design feared: the holder died, its pid number
  // was recycled by something unrelated, so the pid 'answers'. We keep waiting
  // while it looks alive - but only until the hard age cap, which condemns ANY
  // lock older than staleMs regardless of pid or heartbeat. So a recycled pid
  // self-heals at the cap instead of deadlocking.
  const held = {
    repo: 'graphene_supply',
    pid: 25760,
    token: 'x',
    at: Date.now() - (46 * 60_000),                            // older than the 45min cap
    heartbeatAt: Date.now() - (HEARTBEAT_STALE_MS + 5_000),
  };
  const { stale, reason } = isStale(held, { alive: () => true });
  assert.equal(stale, true, 'the hard age cap clears it even though the pid looks alive');
  assert.match(reason, /min/);
});

test('a lock with no heartbeat falls back to the pid check rather than being stale', () => {
  // Written by an older version. Upgrading must not invalidate a lock a running
  // suite still holds.
  const held = { repo: 'a', pid: 1, token: 'x', at: Date.now() };
  assert.equal(isStale(held, { alive: () => true }).stale, false, 'no heartbeat, live pid: still held');
  assert.equal(isStale(held, { alive: () => false }).stale, true, 'no heartbeat, dead pid: stale');
});

test('heartbeat only ever touches our own lock', () => {
  const lockPath = tmpLock('foreign');
  fs.writeFileSync(lockPath, JSON.stringify({ repo: 'other', pid: 1, token: 'theirs', at: Date.now(), heartbeatAt: 1 }));
  assert.equal(heartbeat(lockPath, 'ours'), false, 'refuses to beat on somebody else’s lock');
  assert.equal(readLock(lockPath).heartbeatAt, 1, 'and leaves it untouched');
  fs.unlinkSync(lockPath);
});

test('heartbeat advances our own timestamp', () => {
  const lockPath = tmpLock('ours');
  fs.writeFileSync(lockPath, JSON.stringify({ repo: 'a', pid: process.pid, token: 'ours', at: Date.now(), heartbeatAt: 1 }));
  assert.equal(heartbeat(lockPath, 'ours'), true);
  assert.ok(readLock(lockPath).heartbeatAt > 1);
  fs.unlinkSync(lockPath);
});

test('heartbeat on a lock that has been cleared reports failure rather than recreating it', () => {
  const lockPath = tmpLock('gone');
  assert.equal(heartbeat(lockPath, 'ours'), false);
  assert.equal(fs.existsSync(lockPath), false, 'a heartbeat must never resurrect a released lock');
});
