#!/usr/bin/env node
'use strict';
/**
 * tmk-platform - resolve and enforce the Docker platform policy.
 *
 *   tmk-platform resolve  [--publish]     print the platform string ('' = native)
 *   tmk-platform preflight [--publish]    exit 1 BEFORE a build that would need QEMU
 *   tmk-platform assert-built <image> [--publish]
 *                                         prove the built image matches the target
 *   tmk-platform env      [--publish]     emit shell exports for `eval`
 *
 * Env:
 *   TMK_DOCKER_PLATFORM  explicit override; `native`/`host`/`off` force native arch
 *   TMK_ALLOW_QEMU=1     opt in to cross-arch emulation for this build
 */

const { spawnSync } = require('node:child_process');
const { resolvePlatform, preflight, assertBuiltPlatform } = require('../lib/platform.cjs');

const TAG = '[tmk-platform]';

function sh(cmd) {
  return spawnSync(cmd, { shell: true, encoding: 'utf8' });
}

function daemonArch() {
  const r = sh('docker version --format "{{.Server.Arch}}"');
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

function builtPlatform(image) {
  const r = sh(`docker image inspect --format "{{.Os}}/{{.Architecture}}" "${image}"`);
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] || 'resolve';
  const purpose = argv.includes('--publish') ? 'publish' : 'local';
  const allowQemu = process.env.TMK_ALLOW_QEMU === '1';
  const arch = daemonArch();

  const { platform, reason } = resolvePlatform({
    requested: process.env.TMK_DOCKER_PLATFORM || '',
    purpose,
    daemonArch: arch,
  });

  if (cmd === 'resolve') {
    process.stdout.write(platform);
    return 0;
  }

  if (cmd === 'env') {
    // A native build must UNSET the variable, not set it empty: an empty
    // DOCKER_DEFAULT_PLATFORM is still an inherited value in some shells and
    // docker treats it as a pinned platform of "".
    if (platform) process.stdout.write(`export DOCKER_DEFAULT_PLATFORM=${platform}\n`);
    else process.stdout.write('unset DOCKER_DEFAULT_PLATFORM\n');
    return 0;
  }

  if (cmd === 'preflight') {
    const p = preflight({ platform, daemonArch: arch, allowQemu, purpose });
    console.error(`${TAG} ${reason}`);
    if (p.ok) {
      console.error(`${TAG} ${p.reason}`);
      if (p.emulated) {
        console.error(`${TAG} WARNING: emulated builds on this host have crashed QEMU and written multi-GB core dumps.`);
      }
      return 0;
    }
    console.error(`${TAG} REFUSED: ${p.reason}`);
    for (const l of p.remedy) console.error(`${TAG} ${l}`);
    return 1;
  }

  if (cmd === 'assert-built') {
    const image = argv[1];
    if (!image) {
      console.error(`${TAG} assert-built needs an image reference`);
      return 2;
    }
    const expected = purpose === 'publish' ? 'linux/amd64' : platform;
    const r = assertBuiltPlatform({ built: builtPlatform(image), expected });
    console.error(`${TAG} ${r.ok ? r.reason : 'REFUSED: ' + r.reason}`);
    return r.ok ? 0 : 1;
  }

  console.error(`${TAG} unknown command: ${cmd}`);
  return 2;
}

if (require.main === module) process.exit(main());
module.exports = { main };
