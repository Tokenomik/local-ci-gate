#!/usr/bin/env node
'use strict';
/**
 * Reap stray test containers belonging to THIS repo, and nothing else.
 *
 * Usage:
 *   tmk-reap-testcontainers [--dry-run] [--min-age-minutes 30] [--include-running] [--verbose]
 *
 * Exit code is always 0: hygiene must never be the reason a gate goes red.
 * A hygiene failure that fails the build converts a cleanup problem into a
 * delivery problem, and the previous version of this tooling did exactly that.
 */

const {
  decideReap,
  decideVolumePrune,
  isTestcontainer,
  DEFAULT_MIN_AGE_MINUTES,
} = require('../lib/ownership.cjs');
const { loadConfig } = require('../lib/config.cjs');
const docker = require('../lib/docker.cjs');

const TAG = '[reap-testcontainers]';

/**
 * reap-test-hygiene forwards only `--`-prefixed argv, so a passthrough can strip
 * the VALUE and leave the flag bare. Falling back to the default matters:
 * Number.parseInt(undefined) is NaN, and every >= comparison against NaN is
 * false, which would silently turn the age guard off and reap everything.
 */
function parseMinAgeMinutes(argv, fallback) {
  const i = argv.indexOf('--min-age-minutes');
  if (i < 0) return fallback;
  const n = Number.parseInt(argv[i + 1], 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const includeRunning = argv.includes('--include-running');
  const verbose = argv.includes('--verbose');

  const cfg = loadConfig();
  const minAgeMinutes = parseMinAgeMinutes(
    argv,
    cfg.minAgeMinutes ?? DEFAULT_MIN_AGE_MINUTES,
  );

  if (!cfg.configPresent) {
    console.log(
      `${TAG} no gate.config.json found at ${cfg.repoRoot}; ` +
        `falling back to repoId="${cfg.repoId}"`,
    );
  }

  if (!docker.dockerAvailable()) {
    console.log(`${TAG} Docker not available - skip`);
    return 0;
  }

  const ids = docker.listCandidateIds();
  if (!ids.length) {
    console.log(`${TAG} no containers on this daemon`);
    return 0;
  }

  const nowMs = Date.now();
  const ctx = {
    repoId: cfg.repoId,
    repoRoot: cfg.repoRoot,
    runId: cfg.runId,
    nowMs,
    minAgeMinutes,
    includeRunning,
  };

  const containers = docker.inspectContainers(ids);
  const decided = containers.map((c) => ({ ...c, ...decideReap(c, ctx) }));

  const targets = decided.filter((c) => c.reap);
  const spared = decided.filter((c) => !c.reap);
  const foreign = spared.filter((c) => c.owner === 'other');

  // A reaper that silently declines to clean up reads as "nothing to clean up",
  // which is how the cross-repo problem stayed invisible for so long. Say what
  // was left alone and why.
  for (const c of spared) {
    if (verbose || c.owner === 'other' || isTestcontainer(c.labels)) {
      console.log(`${TAG} skip ${c.id} ${c.name}: ${c.reason}`);
    }
  }

  for (const c of targets) {
    const r = docker.removeContainer(c.fullId, { dryRun });
    if (r.dryRun) {
      console.log(`${TAG} dry-run: would remove ${c.id} ${c.name} (${c.reason})`);
    } else if (r.ok) {
      console.log(`${TAG} removed ${c.id} ${c.name} (${c.reason})`);
    } else {
      console.warn(`${TAG} failed to remove ${c.id}: ${r.stderr}`);
    }
  }

  const liveTestcontainerCount = spared.filter(
    (c) => c.running && isTestcontainer(c.labels),
  ).length;

  const vp = decideVolumePrune({
    repoId: cfg.repoId,
    sparedCount: spared.filter((c) => c.running).length,
    liveTestcontainerCount,
  });

  if (vp.prune) {
    const r = docker.pruneVolumes(vp.filters, { dryRun });
    if (r.dryRun) console.log(`${TAG} dry-run: would run ${r.cmd}`);
    else if (r.ok && r.stdout) console.log(`${TAG} volume prune (${vp.reason}): ${r.stdout}`);
  } else if (verbose) {
    console.log(`${TAG} volume prune skipped: ${vp.reason}`);
  }

  console.log(
    `${TAG} done: repo=${cfg.repoId} run=${cfg.runId} ` +
      `removed=${dryRun ? 0 : targets.length} spared=${spared.length} ` +
      `(${foreign.length} owned by other repos)`,
  );
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { main, parseMinAgeMinutes };
