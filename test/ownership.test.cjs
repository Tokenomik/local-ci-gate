'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  attribute,
  decideReap,
  decideVolumePrune,
  samePath,
  DEFAULT_MIN_AGE_MINUTES,
} = require('../lib/ownership.cjs');

const NOW = Date.parse('2026-07-31T12:00:00Z');
const CTX = {
  repoId: 'graphene_supply',
  repoRoot: 'C:\\repos\\tokenomik\\graphene_supply',
  runId: 'graphene_supply-abc-1234',
  nowMs: NOW,
  minAgeMinutes: DEFAULT_MIN_AGE_MINUTES,
};

const minsAgo = (m) => NOW - m * 60000;

test('samePath normalises Windows separators, case and trailing slash', () => {
  assert.ok(samePath('C:\\repos\\Tokenomik\\graphene_supply', 'c:/repos/tokenomik/graphene_supply/'));
  assert.ok(!samePath('C:\\repos\\tokenomik\\graphene_engine', 'C:\\repos\\tokenomik\\graphene_supply'));
  assert.ok(!samePath('', 'C:\\repos'));
});

test('attribute: our run id wins over everything', () => {
  const a = attribute({ 'com.tokenomik.run': CTX.runId, 'com.tokenomik.repo': 'other' }, CTX);
  assert.equal(a.owner, 'ours-run');
});

test('attribute: a different repo label is positive evidence of another owner', () => {
  const a = attribute({ 'com.tokenomik.repo': 'graphene_engine' }, CTX);
  assert.equal(a.owner, 'other');
  assert.equal(a.detail, 'graphene_engine');
});

test('attribute: compose working_dir attributes to the owning checkout', () => {
  const mine = attribute(
    {
      'com.docker.compose.project.working_dir': 'C:\\repos\\tokenomik\\graphene_supply',
      'com.docker.compose.project': 'graphene_supply',
    },
    CTX,
  );
  assert.equal(mine.owner, 'ours');

  const theirs = attribute(
    {
      'com.docker.compose.project.working_dir': 'C:\\repos\\graphene-consumer',
      'com.docker.compose.project': 'graphene-consumer',
    },
    CTX,
  );
  assert.equal(theirs.owner, 'other');
});

test('attribute: a worktree of the same repo is a different owner', () => {
  // C:\repos\wt\supply-build is a live worktree on this workstation. It shares
  // the repo name but not the checkout, and its containers are not ours.
  const a = attribute(
    { 'com.docker.compose.project.working_dir': 'C:\\repos\\wt\\supply-build' },
    CTX,
  );
  assert.equal(a.owner, 'other');
});

test('REGRESSION: another repo live testcontainer is never reaped', () => {
  // This is the exact failure the old reaper caused: docker rm -f on a
  // container another repo's suite was mid-way through using, surfacing as
  // docker.errors.NotFound 404 in that repo's teardown.
  const d = decideReap(
    {
      name: 'boring_hopper',
      running: true,
      startedAtMs: minsAgo(2),
      labels: { 'org.testcontainers': 'true', 'com.tokenomik.repo': 'graphene_engine' },
    },
    CTX,
  );
  assert.equal(d.reap, false);
  assert.match(d.reason, /graphene_engine/);
});

test('REGRESSION: an OLD container owned by another repo is still never reaped', () => {
  // Age must not override ownership. The old heuristic would have reaped this.
  const d = decideReap(
    {
      running: true,
      startedAtMs: minsAgo(600),
      labels: { 'org.testcontainers': 'true', 'com.tokenomik.repo': 'graphene_engine' },
    },
    CTX,
  );
  assert.equal(d.reap, false);
});

test('our own compose dev stack is out of scope', () => {
  const d = decideReap(
    {
      name: 'graphene_supply-postgres-1',
      running: true,
      startedAtMs: minsAgo(240),
      labels: {
        'com.docker.compose.project': 'graphene_supply',
        'com.docker.compose.project.working_dir': 'C:\\repos\\tokenomik\\graphene_supply',
      },
    },
    CTX,
  );
  assert.equal(d.reap, false);
  assert.match(d.reason, /dev stack/);
});

test('our own run is reaped regardless of age', () => {
  const d = decideReap(
    {
      running: true,
      startedAtMs: minsAgo(1),
      labels: { 'org.testcontainers': 'true', 'com.tokenomik.run': CTX.runId },
    },
    CTX,
  );
  assert.equal(d.reap, true);
});

test('unattributed stopped testcontainer is stray and reaped', () => {
  const d = decideReap(
    { running: false, startedAtMs: minsAgo(5), labels: { 'org.testcontainers': 'true' } },
    CTX,
  );
  assert.equal(d.reap, true);
});

test('unattributed young running testcontainer is spared (legacy heuristic)', () => {
  const d = decideReap(
    { running: true, startedAtMs: minsAgo(3), labels: { 'org.testcontainers': 'true' } },
    CTX,
  );
  assert.equal(d.reap, false);
});

test('unattributed old running testcontainer is reaped', () => {
  const d = decideReap(
    { running: true, startedAtMs: minsAgo(90), labels: { 'org.testcontainers': 'true' } },
    CTX,
  );
  assert.equal(d.reap, true);
});

test('unreadable start time fails safe', () => {
  const d = decideReap(
    { running: true, startedAtMs: NaN, labels: { 'org.testcontainers': 'true' } },
    CTX,
  );
  assert.equal(d.reap, false);
});

test('a live ryuk reaper is left alone', () => {
  const d = decideReap(
    {
      name: 'testcontainers-ryuk-9f2c',
      running: true,
      startedAtMs: minsAgo(120),
      labels: { 'org.testcontainers': 'true' },
    },
    CTX,
  );
  assert.equal(d.reap, false);
});

test('unrelated containers are out of scope entirely', () => {
  const d = decideReap(
    { name: 'intelligence-os-local-postgres-1', running: true, startedAtMs: minsAgo(60), labels: {} },
    CTX,
  );
  assert.equal(d.reap, false);
});

test('--include-running still respects ownership', () => {
  const ctx = { ...CTX, includeRunning: true };
  const ours = decideReap(
    { running: true, startedAtMs: minsAgo(1), labels: { 'org.testcontainers': 'true' } },
    ctx,
  );
  assert.equal(ours.reap, true);

  const theirs = decideReap(
    {
      running: true,
      startedAtMs: minsAgo(1),
      labels: { 'org.testcontainers': 'true', 'com.tokenomik.repo': 'graphene_engine' },
    },
    ctx,
  );
  assert.equal(theirs.reap, false, '--include-running must not become a licence to cross repos');
});

test('volume prune refuses while anything is spared', () => {
  const d = decideVolumePrune({ repoId: 'graphene_supply', sparedCount: 1, liveTestcontainerCount: 0 });
  assert.equal(d.prune, false);
});

test('volume prune refuses while another repo has live testcontainers', () => {
  const d = decideVolumePrune({ repoId: 'graphene_supply', sparedCount: 0, liveTestcontainerCount: 2 });
  assert.equal(d.prune, false);
});

test('volume prune is always scoped to this repo, never host-wide', () => {
  const d = decideVolumePrune({ repoId: 'graphene_supply', sparedCount: 0, liveTestcontainerCount: 0 });
  assert.equal(d.prune, true);
  assert.deepEqual(d.filters, ['label=com.tokenomik.repo=graphene_supply']);
  for (const f of d.filters) {
    assert.ok(!/org\.testcontainers/.test(f), 'must never prune by the shared testcontainers label');
  }
});

test('volume prune refuses without a repo id', () => {
  const d = decideVolumePrune({ repoId: '', sparedCount: 0, liveTestcontainerCount: 0 });
  assert.equal(d.prune, false);
});
