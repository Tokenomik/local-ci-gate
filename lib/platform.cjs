'use strict';
/**
 * Docker platform policy. Pure decisions, no shell, no Docker. Tested directly.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * The predecessor (consumer/scripts/lib/docker-platform.sh, itself ported by copy
 * from tmk-intelligence) defaulted EVERY build to linux/amd64 for cloud parity,
 * and installed QEMU binfmt to make that work on an ARM host. On Windows-on-ARM
 * that default is expensive and unreliable rather than merely slow. Observed on
 * this workstation, repeatedly:
 *
 *   - `next build` (Turbopack, a Rust binary) killing QEMU itself with
 *     "QEMU internal SIGILL {code=ILLOPC}" and "QEMU internal SIGSEGV"
 *   - 1-2GB core dumps per crash into %LOCALAPPDATA%\Temp\wsl-crashes;
 *     12.6GB in a single build attempt, filling C: mid-build
 *   - binfmt registration living in the WSL VM kernel and being wiped by
 *     `wsl --shutdown`, producing an instant "exec format error"
 *   - emulation DEREGISTERING ITSELF mid-session: a clean x86_64 probe, then
 *     "exec format error" minutes later on an unchanged host
 *   - `pnpm install` dying with "spawn ENOEXEC" in a postinstall
 *
 * So the default inverts. Local builds are NATIVE. Cross-architecture builds
 * happen where the silicon is real: a GitHub-hosted runner, or a remote amd64
 * builder. Emulation becomes an explicit, discouraged opt-in.
 *
 * What does NOT change: a PUBLISHED artefact must still be linux/amd64, because
 * Fargate's runtimePlatform is X86_64 and an arm64 manifest fails at pull time
 * with `CannotPullContainerError`, by which point the immutable SHA tag is spent
 * and can only be corrected by a new commit. Parity is asserted at publish, not
 * imposed on every local build.
 */

const OPT_OUT = new Set(['native', 'host', 'off', '']);

/** linux/amd64 -> amd64 ; amd64 -> amd64 ; '' -> '' */
function archOf(platform) {
  if (!platform) return '';
  const s = String(platform).trim().toLowerCase();
  const parts = s.split('/');
  return parts[parts.length - 1] || '';
}

function normaliseArch(a) {
  const s = String(a || '').trim().toLowerCase();
  if (s === 'x86_64' || s === 'amd64') return 'amd64';
  if (s === 'aarch64' || s === 'arm64') return 'arm64';
  return s;
}

/**
 * Resolve the platform string for a build.
 *
 * @param {{requested?:string, purpose?:'local'|'publish', daemonArch?:string}} o
 * @returns {{platform:string, reason:string}}  platform '' means "native daemon arch"
 */
function resolvePlatform({ requested = '', purpose = 'local', daemonArch = '' } = {}) {
  const raw = String(requested || '').trim().toLowerCase().replace(/\s+/g, '');

  if (raw && !OPT_OUT.has(raw)) {
    return { platform: raw.includes('/') ? raw : `linux/${raw}`, reason: 'TMK_DOCKER_PLATFORM set explicitly' };
  }

  if (purpose === 'publish') {
    // Non-negotiable: the artefact must match the Fargate runtimePlatform.
    return { platform: 'linux/amd64', reason: 'publish requires cloud parity (Fargate is X86_64)' };
  }

  if (OPT_OUT.has(raw) && raw !== '') {
    return { platform: '', reason: 'TMK_DOCKER_PLATFORM opt-out (native)' };
  }

  const arch = normaliseArch(daemonArch);
  return {
    platform: '',
    reason: arch ? `local default: native (linux/${arch})` : 'local default: native',
  };
}

/**
 * Decide whether a build may proceed, BEFORE anything is downloaded or built.
 *
 * The whole point is to fail at second zero rather than at minute twenty with a
 * 2GB core dump. A refusal must always name the way forward.
 *
 * @returns {{ok:boolean, emulated:boolean, reason:string, remedy:string[]}}
 */
function preflight({ platform = '', daemonArch = '', allowQemu = false, purpose = 'local' } = {}) {
  const target = normaliseArch(archOf(platform));
  const host = normaliseArch(daemonArch);

  if (!target) {
    return { ok: true, emulated: false, reason: 'native build (no platform pinned)', remedy: [] };
  }
  if (!host) {
    // Cannot prove a mismatch; do not invent one.
    return { ok: true, emulated: false, reason: 'daemon architecture unknown - proceeding', remedy: [] };
  }
  if (target === host) {
    return { ok: true, emulated: false, reason: `native build (${host})`, remedy: [] };
  }

  const remedy = [
    'Build where the silicon is real:',
    '  - GitHub Actions (ubuntu-latest is natively amd64) via the publish workflow',
    '  - a remote amd64 builder: see builders/README.md in @tokenomik/local-ci-gate',
    'Or, knowing the cost, opt in to emulation for THIS build:',
    '  TMK_ALLOW_QEMU=1',
    'Emulation on this host has produced QEMU SIGILL/SIGSEGV crashes and multi-GB',
    'core dumps. It is not a supported path.',
  ];

  if (allowQemu) {
    return {
      ok: true,
      emulated: true,
      reason: `EMULATED ${target} on ${host} host - TMK_ALLOW_QEMU=1 given`,
      remedy: [],
    };
  }

  return {
    ok: false,
    emulated: false,
    reason:
      `refusing to build linux/${target} on a ${host} daemon: this needs QEMU emulation` +
      (purpose === 'publish' ? ' (publish requires linux/amd64)' : ''),
    remedy,
  };
}

/**
 * `--platform` REQUESTS an architecture. This PROVES what was produced.
 * A mismatch is otherwise invisible until ECS refuses to pull, long after the
 * immutable tag is spent.
 */
function assertBuiltPlatform({ built = '', expected = '' } = {}) {
  const b = normaliseArch(archOf(built));
  const e = normaliseArch(archOf(expected));
  if (!b) return { ok: false, reason: 'could not read the built image architecture' };
  if (!e) return { ok: true, reason: `built ${b}, no expectation to check against` };
  if (b !== e) {
    return {
      ok: false,
      reason: `built linux/${b}, but the deploy target is linux/${e}. ` +
        'Pushing this would burn the immutable tag on an unpullable image.',
    };
  }
  return { ok: true, reason: `verified linux/${b}` };
}

module.exports = { archOf, normaliseArch, resolvePlatform, preflight, assertBuiltPlatform };
