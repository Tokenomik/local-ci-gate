'use strict';
/**
 * Thin Docker shell. Isolated here so lib/ownership.cjs can stay pure and the
 * binaries stay short.
 */

const { spawnSync } = require('node:child_process');

function sh(cmd) {
  return spawnSync(cmd, { shell: true, encoding: 'utf8' });
}

function dockerAvailable() {
  return sh('docker version --format "{{.Server.Version}}"').status === 0;
}

/**
 * List candidate container ids.
 *
 * Deliberately NOT filtered by label=org.testcontainers=true. The whole point
 * of the rewrite is to see compose containers too, because their
 * com.docker.compose.project.working_dir label is the evidence that stops us
 * removing another repo's fixtures. Filtering them out at the daemon would
 * throw that evidence away and leave the age heuristic guessing again.
 */
function listCandidateIds() {
  const r = sh('docker ps -aq --format "{{.ID}}"');
  if (r.status !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Inspect ids in one call. A container that vanishes between list and inspect
 * is simply absent from the result: the race is benign, something else already
 * removed it.
 *
 * Labels are emitted as JSON so values containing our delimiter (Windows paths
 * with drive letters and backslashes definitely do) survive the round trip.
 */
function inspectContainers(ids) {
  if (!ids.length) return [];
  const args = ids.map((id) => `"${id}"`).join(' ');
  // Literal delimiter, not an escape. `\t` inside a Go template is not expanded
  // by `docker inspect --format`, so it arrives as the two characters
  // backslash-t and every field after the first parses as undefined -- which
  // silently empties the label map and makes every container look unattributed.
  // That is the exact shape of a reaper that goes host-wide again, so the
  // delimiter is deliberately something no path or label value contains, and
  // the JSON label blob is placed LAST so a delimiter appearing inside it can
  // be rejoined rather than truncating the record.
  const D = '|#|';
  const fmt = [
    '{{.Id}}',
    '{{.Name}}',
    '{{.State.Running}}',
    '{{.State.StartedAt}}',
    '{{json .Config.Labels}}',
  ].join(D);
  const r = sh(`docker inspect --format "${fmt}" ${args}`);
  if (!r.stdout) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(D);
      const [fullId, name, running, startedAt] = parts;
      const labelsJson = parts.slice(4).join(D);
      let labels = {};
      try {
        labels = JSON.parse(labelsJson || '{}') || {};
      } catch {
        labels = {};
      }
      return {
        fullId: fullId || '',
        id: (fullId || '').slice(0, 12),
        name: (name || '').replace(/^\//, ''),
        running: running === 'true',
        startedAtMs: Date.parse(startedAt),
        labels,
      };
    })
    .filter((c) => c.fullId);
}

function removeContainer(id, { dryRun = false } = {}) {
  if (dryRun) return { ok: true, dryRun: true };
  const r = sh(`docker rm -f "${id}"`);
  return {
    ok: r.status === 0,
    stderr: (r.stderr || r.stdout || '').trim(),
  };
}

function pruneVolumes(filters, { dryRun = false } = {}) {
  const args = filters.map((f) => `--filter ${f}`).join(' ');
  if (dryRun) return { ok: true, dryRun: true, cmd: `docker volume prune -f ${args}` };
  const r = sh(`docker volume prune -f ${args}`);
  return { ok: r.status === 0, stdout: (r.stdout || '').trim() };
}

module.exports = {
  sh,
  dockerAvailable,
  listCandidateIds,
  inspectContainers,
  removeContainer,
  pruneVolumes,
};
