'use strict';
/**
 * There is no queue across repositories. Ever.
 *
 * For two months one lock file served the whole workstation, and a gate in one
 * project waited up to forty minutes behind a gate in an unrelated one - with a
 * banner announcing the wait as if it were a feature. A gate on one repository
 * must never be blocked by a gate on another, and this file is the rule.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const hostlock = require('../lib/hostlock.cjs');

const quiet = () => {};

test('two repositories acquire at the same time and neither waits', async () => {
  const t0 = Date.now();
  const a = await hostlock.acquire('repo-alpha', { heartbeatMs: 100, log: quiet, timeoutMs: 2_000 });
  const b = await hostlock.acquire('repo-beta', { heartbeatMs: 100, log: quiet, timeoutMs: 2_000 });
  const elapsed = Date.now() - t0;
  try {
    assert.ok(elapsed < 1_000, `second acquire should not wait on the first: took ${elapsed}ms`);
  } finally {
    a(); b();
  }
});

test('each repository gets its own lock file', () => {
  const a = hostlock.lockPathFor('repo-alpha');
  const b = hostlock.lockPathFor('repo-beta');
  assert.notEqual(a, b);
  assert.equal(path.dirname(a), path.dirname(b), 'both live in the shared lock directory');
  assert.equal(path.dirname(a), hostlock.LOCK_DIR);
});

test('the same repository IS serialised - two gates on one worktree do conflict', async () => {
  const first = await hostlock.acquire('repo-same', { heartbeatMs: 100, log: quiet, timeoutMs: 2_000 });
  const t0 = Date.now();
  let second;
  const attempt = hostlock.acquire('repo-same', { heartbeatMs: 100, log: quiet, timeoutMs: 1_500, pollMs: 50 })
    .then((r) => { second = r; return 'acquired'; }, (e) => e.code || 'rejected');
  await new Promise((r) => setTimeout(r, 400));
  first();
  const outcome = await attempt;
  try {
    assert.equal(outcome, 'acquired', 'the second gate acquires once the first releases');
    assert.ok(Date.now() - t0 >= 350, 'and it did wait for the release');
  } finally {
    if (second) second();
  }
});

test('a repo name that is not a safe filename still gets a lock', async () => {
  const release = await hostlock.acquire('C:/repos/tokenomik/graphene_supply (worktree #3)', { heartbeatMs: 100, log: quiet });
  try {
    const p = hostlock.lockPathFor('C:/repos/tokenomik/graphene_supply (worktree #3)');
    assert.ok(fs.existsSync(p), 'lock file exists at the slugged path');
    assert.doesNotMatch(path.basename(p), /[\/:#() ]/);
  } finally {
    release();
  }
});

test('liveLockCount sees every live repository and ignores a stale one', async () => {
  const a = await hostlock.acquire('count-a', { heartbeatMs: 100, log: quiet });
  const b = await hostlock.acquire('count-b', { heartbeatMs: 100, log: quiet });
  // plant a dead one: pid that cannot exist, heartbeat long lapsed
  fs.writeFileSync(hostlock.lockPathFor('count-dead'), JSON.stringify({
    repo: 'count-dead', pid: 2_147_483_000, token: 'x', at: Date.now() - 3_600_000, heartbeatAt: Date.now() - 3_600_000,
  }));
  try {
    const live = hostlock.liveLockCount();
    assert.ok(live >= 2, `expected at least our two live locks, saw ${live}`);
    // the dead one must not inflate the divisor
    const names = fs.readdirSync(hostlock.LOCK_DIR).filter((n) => n.startsWith('count-'));
    assert.equal(names.length, 3, 'three files on disk');
  } finally {
    a(); b();
    try { fs.unlinkSync(hostlock.lockPathFor('count-dead')); } catch {}
  }
});
