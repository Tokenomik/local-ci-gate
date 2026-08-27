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

test('a holder that stopped heartbeating is stale, even while its PID looks alive', () => {
  const held = {
    repo: 'graphene_supply',
    pid: 25760,
    token: 'x',
    at: Date.now() - 60_000,
    heartbeatAt: Date.now() - (HEARTBEAT_STALE_MS + 5_000),
  };
  // The exact shape of the incident: the PID answers, because something else
  // now owns that number.
  const { stale, reason } = isStale(held, { alive: () => true });
  assert.equal(stale, true, 'a lapsed heartbeat outranks a live-looking pid');
  assert.match(reason, /stopped heartbeating/);
  assert.match(reason, /graphene_supply/);
});

test('a fresh heartbeat keeps the lock held', () => {
  const held = { repo: 'a', pid: 1, token: 'x', at: Date.now(), heartbeatAt: Date.now() };
  assert.equal(isStale(held, { alive: () => true }).stale, false);
});

test('a lapsed heartbeat is stale even in the first minutes of a lock', () => {
  // The old age-based rule only fired at 45 minutes, which is why the incident
  // ran for eighteen without resolving.
  const held = {
    repo: 'a',
    pid: 1,
    token: 'x',
    at: Date.now() - 30_000,
    heartbeatAt: Date.now() - (HEARTBEAT_STALE_MS + 1),
  };
  assert.equal(isStale(held, { alive: () => true }).stale, true);
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
