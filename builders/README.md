# amd64 builders

Cross-architecture builds happen where the silicon is real. This directory holds
the ways to get a native `linux/amd64` artefact from an arm64 workstation, so the
next repo does not invent a fourth one.

## Choose in this order

### 1. GitHub Actions (default, free, no infrastructure)

`ubuntu-latest` runners are natively x86_64. The publish workflow builds there
and pushes straight to ECR. Nothing to provision, nothing to tear down.

**Caveat that bit this org on 2026-07-31:** private repos on the GitHub Free plan
get a fixed monthly Actions allowance. When it is exhausted, jobs do not queue and
do not fail loudly at the step level. They are created, assigned no runner, record
zero steps, and complete as `failure` in two to three seconds. The only place the
real cause appears is the check-run annotation:

> The job was not started because recent account payments have failed or your
> spending limit needs to be increased.

A `conclusion: failure` here looks identical to a red build. Before debugging a
workflow that fails in under five seconds, check the annotation:

```
gh api repos/<owner>/<repo>/check-runs/<job_id>/annotations
```

This is why option 2 exists and should stay maintained rather than deleted.

### 2. Remote amd64 Docker daemon on EC2 (`amd64-ec2.sh`)

An on-demand EC2 instance registered as a docker context. Every existing script
works against it unchanged, because it is just a remote daemon:

```bash
eval "$(builders/amd64-ec2.sh env)"     # exports DOCKER_CONTEXT
scripts/publish-image.sh staging        # builds natively on amd64, pushes to ECR
```

Lifecycle: `up`, `status`, `env`, `down`, `terminate`. Billed only while running;
`down` keeps the disk at roughly $0.10/GB-month. The build context is streamed
from the workstation and `docker login` forwards ECR credentials to the remote
daemon, so the instance needs no IAM role and holds no secrets.

The cost of this option is that it depends on remembering `down`.

### 3. QEMU emulation on the workstation

Do not. Kept here only so the reasoning is not rediscovered a fifth time.
Observed repeatedly on Windows-on-ARM with Docker Desktop:

- `next build` (Turbopack, a Rust binary) killing QEMU itself:
  `QEMU internal SIGILL {code=ILLOPC}`, `QEMU internal SIGSEGV`
- 1-2GB core dumps per crash into `%LOCALAPPDATA%\Temp\wsl-crashes`; 12.6GB in a
  single build attempt, filling the system drive mid-build
- binfmt registration living in the WSL VM kernel and being wiped by
  `wsl --shutdown`, giving an instant `exec format error`
- emulation deregistering itself mid-session: a clean x86_64 probe, then
  `exec format error` minutes later on an unchanged host
- `pnpm install` dying with `spawn ENOEXEC` in a postinstall

`tmk-platform preflight` refuses this path by default. `TMK_ALLOW_QEMU=1` opts in.

Disable the core dumps regardless, in `%USERPROFILE%\.wslconfig`:

```ini
[wsl2]
maxCrashDumpCount = -1
```

Note this key lives under `[wsl2]`. A `[general] crashDumpEnabled = false` block
is silently ignored by WSL and looks exactly like a working fix.

## Unscripted: CodeBuild (graphene_supply, 2026-07-31)

While Actions was billing-blocked, a one-off CodeBuild path was stood up for
`graphene-supply`. It works, and it produced a real published image. It is
recorded here because the resources are live and **nothing in any repo creates,
describes or destroys them**:

| Resource | Name |
| --- | --- |
| S3 bucket | `graphene-supply-fallback-build-433041915499` (~5.3 MB, a git archive) |
| IAM role | `graphene-staging-supply-web-fallback-build` (push verbs on `graphene-staging-supply-web` only) |
| CodeBuild | `graphene-staging-supply-web-fallback-build`, `standard:7.0`, `BUILD_GENERAL1_LARGE`, privileged |

Created 2026-07-31T14:53 AEDT. The IAM grant is correctly narrow, mirroring
infra's PR #112 rather than widening it, and the build gated on a `/healthz` 200
and an inlined-origin check before pushing, which is stricter than the CI path.
The problem is not the design, it is that it exists only as prose on the
`docs/portal-image-published-via-codebuild` branch.

Two ways to resolve, and it needs a decision rather than drift:

1. **Script it** into `builders/amd64-codebuild.sh` with `up`/`build`/`down`
   alongside the EC2 option. CodeBuild is arguably the better fallback: nothing
   idles, so there is no `down` to forget.
2. **Tear it down** and standardise on the EC2 builder.

Leaving it as-is means three live AWS resources that no code owns and no
onboarding document mentions.
