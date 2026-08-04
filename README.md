# @tokenomik/local-ci-gate

Shared local CI isolation for Tokenomik repos that share one Docker daemon.

## Why

Every graphene repo shipped its own copy of `reap-testcontainers.cjs`. Each copy
listed containers with `docker ps -aq --filter label=org.testcontainers=true` and
`docker rm -f`'d everything it found. That label is applied by the testcontainers
library itself, in every repo, so on a workstation running several repos at once
whichever gate started last destroyed the live fixtures of every gate already in
flight. It surfaced as this, in a suite whose code was fine:

```
docker.errors.NotFound: 404 ... No such container: f776456c4e17
203 passed, 1 error
```

`graphene_supply` later added an age heuristic that spared young running
containers. That heuristic is a proxy for ownership, it was correct, and it never
propagated to the other eleven repos carrying the same script. This package is
that fix, generalised and distributed once.

## Install

Git URL dependency, no registry needed:

```json
{
  "devDependencies": {
    "@tokenomik/local-ci-gate": "github:Tokenomik/local-ci-gate#v1.0.0"
  }
}
```

Bump the tag to upgrade. That is the whole release process.

## Configure

`gate.config.json` at the repo root:

```json
{
  "repoId": "graphene_supply",
  "minAgeMinutes": 30,
  "portBlock": [57200, 57299]
}
```

`repoId` must be unique per *checkout*, not per repo name: a git worktree under
`C:\repos\wt\supply-build` is a different owner on the same daemon and must not
be reaped by its parent.

If the file is absent the tool falls back to `package.json` name, then the
directory name, and says so on stdout. It never guesses silently.

## Use

```jsonc
// package.json
"scripts": {
  "pretest":  "tmk-reap-test-hygiene",
  "posttest": "tmk-reap-test-hygiene"
}
```

Repos without a `package.json` (graphene_engine) call the binary directly:

```
node node_modules/@tokenomik/local-ci-gate/bin/reap-test-hygiene.cjs
```

### Labelling containers (optional, recommended)

Attribution works with no code changes at all for compose containers, via the
`com.docker.compose.project.working_dir` label Docker already applies. Labelling
testcontainers moves them from a time-based guess to a certainty.

Node:

```js
const { withTmkLabels } = require('@tokenomik/local-ci-gate');
const pg = await withTmkLabels(new GenericContainer('postgres:16-alpine')).start();
```

Python (testcontainers 4.x accepts custom labels; the `org.testcontainers`
namespace is reserved and will raise if written to):

```python
# conftest.py
import json, os
TMK_LABELS = json.loads(os.environ.get("TMK_LABELS_JSON", "{}"))

PostgresContainer("postgres:16-alpine").with_kwargs(labels=TMK_LABELS)
```

The gate exports `TMK_LABELS_JSON`, `TMK_RUN_ID` and `TMK_REPO_ID` before
spawning the suite, via `runEnv()`, so both reaper passes and the suite agree on
which containers belong to this run.

## Decision rules

First match wins.

| # | Evidence | Outcome |
|---|----------|---------|
| 1 | `com.tokenomik.run` equals our run id | reap, any age |
| 2 | `com.tokenomik.repo` is some other repo | **spare, always** |
| 3 | `com.docker.compose.project.working_dir` is some other checkout | **spare, always** |
| 4 | compose container belonging to us | spare: dev stack, out of scope |
| 5 | `com.tokenomik.repo` is us | reap if stopped, or older than `minAgeMinutes` |
| 6 | `org.testcontainers=true`, unattributed | reap if stopped, or older than `minAgeMinutes` |
| 7 | anything else | spare: not ours to touch |

Rules 2 and 3 are deterministic, not probabilistic, and they are the ones that
close the cross-repo destruction. Rule 6 is the legacy path and shrinks as repos
adopt labelling. `--include-running` overrides age, never ownership.

Volume pruning is scoped to `label=com.tokenomik.repo=<repoId>` and refuses
entirely while anything is spared or any live testcontainer exists on the daemon.
It will never again prune by `org.testcontainers`, which reaches every repo.
Reclamation is therefore weaker until labelling is adopted. That is deliberate:
the failure mode of pruning too little is disk, and the failure mode of pruning
too much is a red gate in a repo nobody is looking at.

## Exit codes

Always 0. Hygiene must never be the reason a gate goes red; the previous tooling
turned a cleanup problem into a delivery problem.

## Tests

```
npm test
```

The decision logic is pure and tested directly, including regression tests for
the cross-repo destruction and for `--include-running` not becoming a licence to
cross repos.

## Docker platform policy (v1.1.0)

Local builds are native. Published artefacts are `linux/amd64`. Cross-architecture
builds happen on real silicon, never under QEMU on the workstation.

```bash
# in a shell script
. "$(node -p "require.resolve('@tokenomik/local-ci-gate/lib/docker-platform.sh')")"
initialize_docker_platform            # sets DOCKER_DEFAULT_PLATFORM, then refuses
                                      # a build that would need emulation
assert_docker_amd64_parity            # before any push to ECR
assert_built_platform "$IMAGE"        # proves what was actually built

# or directly
npx tmk-platform preflight
npx tmk-platform preflight --publish
npx tmk-platform assert-built myimage:sha --publish
```

The predecessor (`scripts/lib/docker-platform.sh`, copied between repos) defaulted
every build to `linux/amd64` and installed QEMU binfmt to make that work on an ARM
host. That default is inverted here: emulation is an explicit, discouraged opt-in
via `TMK_ALLOW_QEMU=1`, and a refusal always names the way forward.

See `builders/README.md` for how to get a native amd64 artefact, and for the live
AWS resources that currently have no owning code.

## Host serialisation and worker caps (v1.2.0)

Ownership labelling stopped repos destroying each other's containers. It did not
stop them all running at once. On a 12-core host, four repos each sizing a worker
pool to the core count asks for ~48 workers, plus containers, plus the WSL2 VM
which by default is handed every core and half the RAM. CPU starvation then makes
container startup waits and test timeouts fail non-deterministically, which
surfaces as flaky red gates that look like code defects.

```js
const { withLock } = require('@tokenomik/local-ci-gate/hostlock');
const { runnerEnv } = require('@tokenomik/local-ci-gate/concurrency');

// lint / typecheck / unit: unchanged, still parallel across repos
await runPhases(nonDockerPhases);

// docker phases: one repo at a time, host-wide
await withLock(cfg.repoId, async () => {
  const env = { ...process.env, ...runnerEnv({ hostLocked: true }) };
  await runPhases(dockerPhases, { env });
});
```

Only the Docker phases are serialised, so the queue covers what actually
contends. `runnerEnv` emits `VITEST_MAX_THREADS`, `JEST_WORKERS`,
`PYTEST_XDIST_AUTO_NUM_WORKERS`, `UV_THREADPOOL_SIZE` and appends
`--max-old-space-size` to any existing `NODE_OPTIONS` -- an unbounded V8 heap was
observed reaching 8GB in one process, which pushes the box into swap and presents
as CPU exhaustion.

`DEFAULTS.wslProcessors` mirrors `processors=` in `%USERPROFILE%\.wslconfig`.
Change one, change the other, or the host-core budget silently drifts.

