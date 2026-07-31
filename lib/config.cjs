'use strict';
/**
 * Repo identity and run identity.
 *
 * Identity must NOT come from package.json alone: graphene_engine has no root
 * package.json at all (it is a Python repo with Node helper scripts), and the
 * three repos that do have one disagree on convention (graphene-infra,
 * graphene_supply, graphene-consumer). An explicit gate.config.json is the
 * source of truth, with fallbacks so the tool still does something sane in a
 * repo that has not been configured yet.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CONFIG_FILE = 'gate.config.json';

/** Walk up from cwd looking for a repo marker. */
function findRepoRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (
      fs.existsSync(path.join(dir, CONFIG_FILE)) ||
      fs.existsSync(path.join(dir, '.git'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * A repo id must be stable and daemon-unique. Directory name is the last
 * fallback and is good enough, because two checkouts of the same repo in
 * different directories genuinely are different owners on this daemon -- see
 * the worktrees under C:\repos\wt.
 */
function resolveRepoId(repoRoot) {
  const cfg = readJson(path.join(repoRoot, CONFIG_FILE));
  if (cfg && cfg.repoId) return String(cfg.repoId);
  const pkg = readJson(path.join(repoRoot, 'package.json'));
  if (pkg && pkg.name) return String(pkg.name).replace(/^@[^/]+\//, '');
  return path.basename(repoRoot);
}

function loadConfig(cwd = process.cwd()) {
  const repoRoot = findRepoRoot(cwd);
  const cfg = readJson(path.join(repoRoot, CONFIG_FILE)) || {};
  const repoId = resolveRepoId(repoRoot);

  // One run id per process tree. The gate exports TMK_RUN_ID before spawning
  // the suite, so the pre-run reaper, the suite and the post-run reaper all
  // agree on which containers belong to this run.
  const runId =
    process.env.TMK_RUN_ID ||
    `${repoId}-${Date.now().toString(36)}-${process.pid}`;

  return {
    repoRoot,
    repoId,
    runId,
    host: os.hostname(),
    minAgeMinutes: Number.isFinite(cfg.minAgeMinutes)
      ? cfg.minAgeMinutes
      : undefined,
    portBlock: Array.isArray(cfg.portBlock) ? cfg.portBlock : null,
    configPresent: fs.existsSync(path.join(repoRoot, CONFIG_FILE)),
    raw: cfg,
  };
}

/**
 * The label set every container this repo creates should carry. Note the
 * org.testcontainers namespace is reserved by the library and rejected if
 * written to, so everything here sits under com.tokenomik.
 */
function labelsFor(cfg) {
  return {
    'com.tokenomik.repo': cfg.repoId,
    'com.tokenomik.run': cfg.runId,
    'com.tokenomik.host': cfg.host,
  };
}

module.exports = { CONFIG_FILE, findRepoRoot, resolveRepoId, loadConfig, labelsFor };
