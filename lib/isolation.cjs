'use strict';
/**
 * Public entry point: everything a repo's gate or test suite needs to make its
 * containers attributable.
 *
 * Node suites:
 *   const { withTmkLabels } = require('@tokenomik/local-ci-gate');
 *   const pg = await withTmkLabels(new GenericContainer('postgres:16-alpine')).start();
 *
 * Python suites: export the labels as JSON and read them in conftest.py, so the
 * label set has exactly one definition. See README.
 *
 * Compose:
 *   docker compose -p <composeProject()> ...
 * although compose containers are already attributable via their
 * com.docker.compose.project.working_dir label, so this is belt and braces.
 */

const { loadConfig, labelsFor } = require('./config.cjs');
const ownership = require('./ownership.cjs');

const config = loadConfig();
const LABELS = labelsFor(config);

/** Apply the label set to a testcontainers-node builder. */
function withTmkLabels(container) {
  if (!container || typeof container.withLabels !== 'function') {
    throw new TypeError(
      'withTmkLabels expects a testcontainers GenericContainer builder',
    );
  }
  return container.withLabels(LABELS);
}

/** A compose project name unique to this repo and run. */
function composeProject() {
  return `${config.repoId}-${config.runId}`.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
}

/**
 * Environment a gate should export before spawning a suite, so the suite and
 * both reaper passes agree on the run id.
 */
function runEnv() {
  return {
    TMK_RUN_ID: config.runId,
    TMK_REPO_ID: config.repoId,
    TMK_LABELS_JSON: JSON.stringify(LABELS),
  };
}

module.exports = {
  config,
  LABELS,
  withTmkLabels,
  composeProject,
  runEnv,
  ownership,
};
