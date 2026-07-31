#!/usr/bin/env node
'use strict';
/**
 * Combined test hygiene, called at the start and end of a local run so a killed
 * run does not poison the next one.
 *
 * Usage:
 *   tmk-reap-test-hygiene [--dry-run] [--skip-orphans] [--skip-containers] [--verbose]
 *
 * Container reaping comes from this package so the ownership rules stay in one
 * place. Orphaned-process reaping stays repo-local: it is about Node and Python
 * test runners, differs per repo, and has none of the cross-repo blast radius
 * that made the container reaper worth centralising.
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const { loadConfig } = require('../lib/config.cjs');

const TAG = '[reap-test-hygiene]';

function main(argv = process.argv.slice(2)) {
  const passthrough = argv.filter((a) => a.startsWith('--'));
  const skipContainers = argv.includes('--skip-containers');
  const skipOrphans = argv.includes('--skip-orphans');
  const cfg = loadConfig();

  if (!skipContainers) {
    const r = spawnSync(
      process.execPath,
      [path.join(__dirname, 'reap-testcontainers.cjs'), ...passthrough],
      { stdio: 'inherit', cwd: cfg.repoRoot },
    );
    if (r.status !== 0) console.warn(`${TAG} container reap exited ${r.status}`);
  }

  if (!skipOrphans) {
    const local = path.join(cfg.repoRoot, 'scripts', 'reap-orphan-test-processes.cjs');
    if (fs.existsSync(local)) {
      spawnSync(
        process.execPath,
        [local, '--min-age-minutes', '1', ...passthrough],
        { stdio: 'inherit', cwd: cfg.repoRoot },
      );
    } else {
      console.log(`${TAG} no scripts/reap-orphan-test-processes.cjs in this repo - skipping`);
    }
  }

  // Always 0. Hygiene must never be the reason a gate goes red.
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { main };
