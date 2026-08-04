'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { acquire, isStale, releaseIfOurs, DEFAULT_STALE_MS } = require('../lib/hostlock.cjs');
const { computeWorkers, runnerEnv, containerCpus } = require('../lib/concurrency.cjs');

function tmpLock(name) {
  const p = path.join(os.tmpdir(), `tmk-test-${name}-${process.pid}-${Math.random().toString(36).slice(2)}.lock`);
  try { fs.unlinkSync(p); } catch {}
  return p;
}

// ---------------------------------------------------------------- staleness --

test('a live, recent holder is not stale', () => {
  const r = isStale({ pid: process.pid, at: Date.now(), repo: 'supply' }, { alive: () => true });
  assert.equal(r.stale, false);
  assert.match(r.reason, /supply/);
});

test('a holder older than the stale window is presumed dead even if the pid lives', () => {
  // Guards against PID reuse making a dead lock look permanently held.
  const r = isStale(
    { pid: process.pid, at: Date.now() - DEFAULT_STALE_MS - 1000, repo: 'supply' },
    { alive: () => true },
  );
  assert.equal(r.stale, true);
  assert.match(r.reason, /presumed dead/);
});

test('a dead pid within the window is stale', () => {
  const r = isStale({ pid: 999999, at: Date.now(), repo: 'engine' }, { alive: () => false });
  assert.equal(r.stale, true);
  assert.match(r.reason, /gone/);
});

test('a malformed or empty lock file is stale, not fatal', () => {
  assert.equal(isStale(null).stale, true);
  assert.equal(isStale({}).stale, true);
  assert.equal(isStale({ pid: 'nope', at: Date.now() }).stale, true);
});

// ------------------------------------------------------------- mutual excl. --

test('the lock is mutually exclusive, and releases cleanly', async () => {
  const lockPath = tmpLock('mutex');
  const release = await acquire('graphene_supply', { lockPath, log: () => {} });
  assert.ok(fs.existsSync(lockPath));

  // A second acquirer must not get in while the first holds it.
  let got = false;
  const second = acquire('graphene_engine', {
    lockPath, timeoutMs: 400, pollMs: 50, log: () => {},
  }).then((r) => { got = true; return r; }).catch(() => null);

  await new Promise((r) => setTimeout(r, 250));
  assert.equal(got, false, 'second acquirer entered while the lock was held');

  release();
  assert.equal(fs.existsSync(lockPath), false, 'release must remove the lock file');
  const r2 = await second;
  if (r2) r2();
});

test('a waiter acquires once the holder releases', async () => {
  const lockPath = tmpLock('handoff');
  const first = await acquire('repo-a', { lockPath, log: () => {} });
  const waiter = acquire('repo-b', { lockPath, timeoutMs: 5000, pollMs: 25, log: () => {} });
  setTimeout(first, 100);
  const release = await waiter;
  assert.ok(fs.existsSync(lockPath));
  release();
});

test('a stale lock is cleared rather than waited out', async () => {
  const lockPath = tmpLock('stale');
  fs.writeFileSync(lockPath, JSON.stringify({ repo: 'dead', pid: 999999, token: 'x', at: Date.now() }));
  const release = await acquire('graphene_supply', {
    lockPath, timeoutMs: 2000, pollMs: 25, log: () => {},
  });
  const held = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(held.repo, 'graphene_supply');
  release();
});

test('acquire times out rather than hanging forever', async () => {
  const lockPath = tmpLock('timeout');
  const release = await acquire('holder', { lockPath, log: () => {} });
  await assert.rejects(
    () => acquire('other', { lockPath, timeoutMs: 200, pollMs: 25, log: () => {} }),
    /timed out/,
  );
  release();
});

test('release is idempotent and never deletes a lock we no longer own', async () => {
  const lockPath = tmpLock('token');
  const release = await acquire('repo-a', { lockPath, log: () => {} });
  release();
  release(); // must not throw

  // Somebody else now holds it; our stale release must not remove theirs.
  fs.writeFileSync(lockPath, JSON.stringify({ repo: 'repo-b', pid: process.pid, token: 'other', at: Date.now() }));
  assert.equal(releaseIfOurs(lockPath, 'ours'), false);
  assert.ok(fs.existsSync(lockPath), 'a foreign lock must survive our release');
  fs.unlinkSync(lockPath);
});

// ------------------------------------------------------------- concurrency --

test('workers are divided across expected concurrent repos', () => {
  // 12 cores, WSL2 given 8 -> host share 12 - 4 = 8; two repos -> 4 each.
  const r = computeWorkers({ cores: 12, wslProcessors: 8, expectedConcurrentRepos: 2 });
  assert.equal(r.hostCores, 8);
  assert.equal(r.workers, 4);
});

test('under the host lock the pool is not divided twice', () => {
  const r = computeWorkers({ cores: 12, wslProcessors: 8, hostLocked: true });
  assert.equal(r.workers, 8);
  assert.match(r.reason, /hostlock/);
});

test('never drops below one worker on a small box', () => {
  const r = computeWorkers({ cores: 2, wslProcessors: 8, expectedConcurrentRepos: 8 });
  assert.ok(r.workers >= 1);
});

test('runnerEnv caps the heap and covers the runners we actually use', () => {
  const e = runnerEnv({ cores: 12, wslProcessors: 8, expectedConcurrentRepos: 2, nodeOptions: '' });
  assert.equal(e.VITEST_MAX_THREADS, '4');
  assert.equal(e.JEST_WORKERS, '4');
  assert.equal(e.PYTEST_XDIST_AUTO_NUM_WORKERS, '4');
  assert.match(e.NODE_OPTIONS, /--max-old-space-size=2048/);
});

test('runnerEnv preserves existing NODE_OPTIONS and does not double the heap flag', () => {
  const e = runnerEnv({ cores: 12, nodeOptions: '--enable-source-maps' });
  assert.match(e.NODE_OPTIONS, /--enable-source-maps/);
  assert.equal((e.NODE_OPTIONS.match(/--max-old-space-size/g) || []).length, 1);

  const e2 = runnerEnv({ cores: 12, nodeOptions: '--max-old-space-size=512' });
  assert.equal(e2.NODE_OPTIONS, '--max-old-space-size=512', 'an explicit heap setting must win');
});

test('container cpu cap is bounded and at least 1', () => {
  assert.ok(containerCpus({ cores: 12, wslProcessors: 8 }) >= 1);
  assert.ok(containerCpus({ cores: 64, wslProcessors: 8 }) <= 2);
});
