'use strict';
/**
 * Pure ownership + reap decisions. No Docker, no filesystem, no process exit.
 * Everything here is directly unit-testable; see test/ownership.test.cjs.
 *
 * WHY THIS EXISTS
 * ---------------
 * The old reaper listed `docker ps -aq --filter label=org.testcontainers=true`
 * and `docker rm -f` everything it found. That label is applied by the
 * testcontainers library itself, in every repo, so on a workstation running one
 * Docker daemon and several repos at once, whichever gate started last destroyed
 * the live fixtures of every gate already in flight. graphene_supply later added
 * an age heuristic that spared young running containers. That heuristic is a
 * proxy for ownership; this module replaces the proxy with evidence where
 * evidence exists, and keeps the heuristic only as the last resort.
 *
 * EVIDENCE LADDER (first match wins)
 * ----------------------------------
 *  1. com.tokenomik.run  == our run id      -> ours, this run. Reap.
 *  2. com.tokenomik.repo != our repo id     -> another repo's. Spare, always.
 *  3. com.docker.compose.project.working_dir set
 *        != our repo root                   -> another repo's compose. Spare, always.
 *        == our repo root                   -> our compose stack, not a test
 *                                              fixture. Spare: this tool reaps
 *                                              testcontainers, not dev stacks.
 *  4. com.tokenomik.repo == our repo id     -> ours, older run. Age guard.
 *  5. org.testcontainers=true, unattributed -> age guard, biased to sparing.
 *  6. anything else                         -> spare. Not ours to touch.
 *
 * Rules 2 and 3 are deterministic, not probabilistic: they are the ones that
 * actually close the cross-repo destruction. Rule 5 is the legacy path and
 * disappears as repos adopt labelling.
 */

const LABEL_TC = 'org.testcontainers';
const LABEL_TC_SESSION = 'org.testcontainers.session-id';
const LABEL_TMK_REPO = 'com.tokenomik.repo';
const LABEL_TMK_RUN = 'com.tokenomik.run';
const LABEL_COMPOSE_DIR = 'com.docker.compose.project.working_dir';
const LABEL_COMPOSE_PROJECT = 'com.docker.compose.project';

/**
 * Generous by design, inherited from graphene_supply's guard. Raising it only
 * delays reclaiming a leaked container until the next run. Lowering it risks
 * destroying a live run's database. Asymmetric costs, asymmetric default.
 */
const DEFAULT_MIN_AGE_MINUTES = 30;

/**
 * Windows paths are case-insensitive and arrive with mixed separators and
 * occasional trailing slashes. Compare on a normalised form or rule 3 silently
 * fails open, which is the failure mode that matters.
 */
function normPath(p) {
  if (!p || typeof p !== 'string') return '';
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function samePath(a, b) {
  const na = normPath(a);
  const nb = normPath(b);
  return Boolean(na) && na === nb;
}

/**
 * Attribute a container to an owner using only its labels.
 * @returns {{owner: 'ours'|'ours-run'|'other'|'unknown', via: string, detail: string}}
 */
function attribute(labels = {}, ctx = {}) {
  const l = labels || {};
  const runId = ctx.runId || '';
  const repoId = ctx.repoId || '';
  const repoRoot = ctx.repoRoot || '';

  if (runId && l[LABEL_TMK_RUN] === runId) {
    return { owner: 'ours-run', via: LABEL_TMK_RUN, detail: runId };
  }
  if (l[LABEL_TMK_REPO]) {
    if (repoId && l[LABEL_TMK_REPO] === repoId) {
      return { owner: 'ours', via: LABEL_TMK_REPO, detail: l[LABEL_TMK_REPO] };
    }
    return { owner: 'other', via: LABEL_TMK_REPO, detail: l[LABEL_TMK_REPO] };
  }
  if (l[LABEL_COMPOSE_DIR]) {
    if (repoRoot && samePath(l[LABEL_COMPOSE_DIR], repoRoot)) {
      return {
        owner: 'ours',
        via: LABEL_COMPOSE_DIR,
        detail: l[LABEL_COMPOSE_PROJECT] || l[LABEL_COMPOSE_DIR],
      };
    }
    return {
      owner: 'other',
      via: LABEL_COMPOSE_DIR,
      detail: l[LABEL_COMPOSE_PROJECT] || l[LABEL_COMPOSE_DIR],
    };
  }
  return { owner: 'unknown', via: 'none', detail: l[LABEL_TC_SESSION] || '' };
}

function isCompose(labels = {}) {
  return Boolean((labels || {})[LABEL_COMPOSE_DIR] || (labels || {})[LABEL_COMPOSE_PROJECT]);
}

function isTestcontainer(labels = {}) {
  return String((labels || {})[LABEL_TC]) === 'true';
}

function isRyuk(name = '') {
  return /testcontainers-ryuk-/i.test(String(name || ''));
}

/**
 * Decide whether a single container should be removed.
 *
 * @param {{id?:string,name?:string,running:boolean,startedAtMs:number,labels?:object}} container
 * @param {{repoId:string,repoRoot:string,runId:string,nowMs:number,
 *          minAgeMinutes?:number,includeRunning?:boolean}} ctx
 * @returns {{reap:boolean, reason:string, owner:string}}
 */
function decideReap(container, ctx) {
  const {
    running = false,
    startedAtMs = NaN,
    labels = {},
    name = '',
  } = container || {};
  const {
    nowMs = Date.now(),
    minAgeMinutes = DEFAULT_MIN_AGE_MINUTES,
    includeRunning = false,
  } = ctx || {};

  const att = attribute(labels, ctx);
  const owner = att.owner;

  // Rule 2 and 3: positive evidence of a different owner. Never touch.
  if (owner === 'other') {
    return {
      reap: false,
      owner,
      reason: `owned by ${att.detail} (via ${att.via}) - not ours`,
    };
  }

  // Rule 1: our own run, unambiguously. Safe to remove regardless of age.
  if (owner === 'ours-run') {
    return { reap: true, owner, reason: 'created by this run' };
  }

  // Our own compose stack is a dev dependency, not a test fixture. A
  // testcontainers reaper that tears down the developer's database has
  // exceeded its remit, and would take out the very Postgres the next suite
  // expects to find already running.
  if (isCompose(labels)) {
    return {
      reap: false,
      owner,
      reason: `compose service ${att.detail} - dev stack, out of scope`,
    };
  }

  // Ryuk belongs to a testcontainers session. Killing a live one strands the
  // containers it was tracking.
  if (isRyuk(name) && running) {
    return { reap: false, owner, reason: 'live ryuk reaper - left alone' };
  }

  // Beyond this point only testcontainers-created containers are candidates.
  if (!isTestcontainer(labels) && owner !== 'ours') {
    return { reap: false, owner, reason: 'not a testcontainers container - out of scope' };
  }

  if (!running) {
    return { reap: true, owner, reason: 'not running - stray by definition' };
  }
  if (includeRunning) {
    return { reap: true, owner, reason: 'running, --include-running given' };
  }

  const ageMinutes = (nowMs - startedAtMs) / 60000;
  if (!Number.isFinite(ageMinutes)) {
    // Fail safe: an unreadable start time is not evidence a container is stray.
    return { reap: false, owner, reason: 'running, start time unreadable - left alone' };
  }
  if (ageMinutes >= minAgeMinutes) {
    return {
      reap: true,
      owner,
      reason: `running for ${Math.round(ageMinutes)}min (>= ${minAgeMinutes}min)`,
    };
  }
  return {
    reap: false,
    owner,
    reason:
      `running for ${Math.round(ageMinutes)}min (< ${minAgeMinutes}min) - ` +
      'assumed live, possibly another repo sharing this daemon',
  };
}

/**
 * Volume pruning is the other half of the old host-wide behaviour. Pruning by
 * `label=org.testcontainers=true` reaches across every repo on the daemon, so it
 * is only safe when nothing anywhere could still own those volumes.
 *
 * @returns {{prune:boolean, filters:string[], reason:string}}
 */
function decideVolumePrune({ repoId, sparedCount, liveTestcontainerCount, dryRun = false }) {
  if (sparedCount > 0) {
    return {
      prune: false,
      filters: [],
      reason: `${sparedCount} container(s) spared - their volumes are in use`,
    };
  }
  if (liveTestcontainerCount > 0) {
    return {
      prune: false,
      filters: [],
      reason: `${liveTestcontainerCount} live testcontainer(s) on this daemon - prune would cross repos`,
    };
  }
  // Testcontainers volumes are ANONYMOUS: the library creates them per run and
  // labels the CONTAINER, not the volume. Filtering the prune by this kit's repo
  // label therefore matched nothing, every time - verified on a live daemon where
  // 163 dangling volumes had accumulated and `docker volume ls -f label=tmk.repo`
  // and `-f label=org.testcontainers=true` both returned ZERO.
  //
  // So the filter made the prune look scoped while doing nothing at all, and
  // 11 GB of orphaned volumes built up unnoticed. A no-op that reads as a
  // safeguard is worse than no safeguard.
  //
  // The safety here is not the label - it is the two guards above. We only reach
  // this point when nothing was spared and no live testcontainer exists anywhere
  // on the daemon, which is exactly the condition under which a dangling volume
  // cannot still be owned. `dangling=true` then removes only volumes no container
  // references, which never includes a running container's mounts.
  if (repoId) {
    return {
      prune: true,
      filters: ['dangling=true'],
      reason: `${repoId}: no live testcontainers on this daemon, pruning dangling volumes`,
    };
  }
  return { prune: false, filters: [], reason: 'no repo id - refusing an unscoped prune' };
}

module.exports = {
  LABEL_TC,
  LABEL_TC_SESSION,
  LABEL_TMK_REPO,
  LABEL_TMK_RUN,
  LABEL_COMPOSE_DIR,
  LABEL_COMPOSE_PROJECT,
  DEFAULT_MIN_AGE_MINUTES,
  normPath,
  samePath,
  attribute,
  isCompose,
  isTestcontainer,
  isRyuk,
  decideReap,
  decideVolumePrune,
};
