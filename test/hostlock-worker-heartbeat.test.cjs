'use strict';
/**
 * The heartbeat must survive a blocked main thread.
 *
 * This is the test that would have prevented 1.4.1 and the fix after it. The
 * gate calls spawnSync for its steps, which blocks the event loop; a setInterval
 * heartbeat stopped for as long as the step ran, a healthy holder went silent,
 * and a waiter stole its lock. The fix then made the PID a veto, and a hung or
 * recycled holder waited the 2h cap.
 *
 * With the heartbeat on a worker thread, neither can happen - and this proves it
 * by blocking the main thread for longer than the stale window and watching the
 * heartbeat advance anyway.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const hostlock = require('../lib/hostlock.cjs');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hl-')), 'lock.json');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('the heartbeat keeps beating while the main thread is blocked in spawnSync', async () => {
  const lockPath = tmp();
  const release = await hostlock.acquire('worker-test', { lockPath, heartbeatMs: 100, log: () => {} });
  try {
    const before = read(lockPath).heartbeatAt;

    // Block the event loop for well over several intervals, exactly as a test
    // step does. A setInterval heartbeat cannot fire during this.
    spawnSync(process.execPath, ['-e', 'const t=Date.now()+1500; while(Date.now()<t){}']);

    const after = read(lockPath).heartbeatAt;
    assert.ok(after > before + 500, `heartbeat should have advanced during the block: before=${before} after=${after}`);
  } finally {
    release();
  }
});

test('a live PID with a lapsed heartbeat is stale - a hung or recycled holder is not waited out', () => {
  // This is the case the previous fix sent to the 2h cap. Our own PID is alive
  // by construction; the heartbeat is ten minutes old.
  const now = Date.now();
  const held = { pid: process.pid, token: 'x', at: now - 15 * 60_000, heartbeatAt: now - 10 * 60_000, repo: 'hung' };
  const { stale, reason } = hostlock.isStale(held, { nowMs: now, alive: () => true });
  assert.equal(stale, true);
  assert.match(reason, /stopped heartbeating/);
});

test('a fresh heartbeat is not stale, whatever the PID check says', () => {
  const now = Date.now();
  const held = { pid: 999_999, token: 'x', at: now - 60_000, heartbeatAt: now - 3_000, repo: 'live' };
  const { stale } = hostlock.isStale(held, { nowMs: now, alive: () => true });
  assert.equal(stale, false);
});

test('a dead PID is still reclaimed at once, inside the heartbeat window', () => {
  const now = Date.now();
  const held = { pid: 999_999, token: 'x', at: now - 60_000, heartbeatAt: now - 3_000, repo: 'dead' };
  const { stale, reason } = hostlock.isStale(held, { nowMs: now, alive: () => false });
  assert.equal(stale, true);
  assert.match(reason, /gone/);
});

test('release stops the worker so the process can exit', async () => {
  const lockPath = tmp();
  const release = await hostlock.acquire('exit-test', { lockPath, heartbeatMs: 100, log: () => {} });
  release();
  // release removes our lock; the worker must not recreate or touch it afterwards
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(fs.existsSync(lockPath), false, 'the worker wrote the lock back after release');
});
