'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { archOf, normaliseArch, resolvePlatform, preflight, assertBuiltPlatform } =
  require('../lib/platform.cjs');

test('archOf and normaliseArch handle the spellings docker actually emits', () => {
  assert.equal(archOf('linux/amd64'), 'amd64');
  assert.equal(archOf('amd64'), 'amd64');
  assert.equal(archOf(''), '');
  assert.equal(normaliseArch('x86_64'), 'amd64');
  assert.equal(normaliseArch('aarch64'), 'arm64');
  assert.equal(normaliseArch('ARM64'), 'arm64');
});

test('INVERTED DEFAULT: a local build on an arm64 host is native, not amd64', () => {
  // The predecessor returned linux/amd64 here, which is what forced QEMU.
  const r = resolvePlatform({ purpose: 'local', daemonArch: 'arm64' });
  assert.equal(r.platform, '');
  assert.match(r.reason, /native/);
});

test('publish still demands linux/amd64 regardless of host', () => {
  const r = resolvePlatform({ purpose: 'publish', daemonArch: 'arm64' });
  assert.equal(r.platform, 'linux/amd64');
});

test('an explicit TMK_DOCKER_PLATFORM wins, and bare arch is expanded', () => {
  assert.equal(resolvePlatform({ requested: 'linux/arm64' }).platform, 'linux/arm64');
  assert.equal(resolvePlatform({ requested: 'amd64' }).platform, 'linux/amd64');
});

test('opt-out sentinels resolve to native', () => {
  for (const s of ['native', 'host', 'off']) {
    assert.equal(resolvePlatform({ requested: s, purpose: 'local' }).platform, '', s);
  }
});

test('FAIL FAST: amd64 on an arm64 daemon is refused, with a remedy', () => {
  const p = preflight({ platform: 'linux/amd64', daemonArch: 'arm64' });
  assert.equal(p.ok, false);
  assert.match(p.reason, /QEMU/);
  assert.ok(p.remedy.length > 0, 'a refusal must always name the way forward');
  assert.ok(p.remedy.join(' ').includes('TMK_ALLOW_QEMU'));
});

test('emulation proceeds only with an explicit opt-in, and says so loudly', () => {
  const p = preflight({ platform: 'linux/amd64', daemonArch: 'arm64', allowQemu: true });
  assert.equal(p.ok, true);
  assert.equal(p.emulated, true);
  assert.match(p.reason, /EMULATED/);
});

test('native builds pass preflight on both architectures', () => {
  assert.equal(preflight({ platform: 'linux/amd64', daemonArch: 'x86_64' }).ok, true);
  assert.equal(preflight({ platform: 'linux/arm64', daemonArch: 'aarch64' }).ok, true);
  assert.equal(preflight({ platform: '', daemonArch: 'arm64' }).ok, true);
});

test('an unknown daemon arch does not invent a mismatch', () => {
  const p = preflight({ platform: 'linux/amd64', daemonArch: '' });
  assert.equal(p.ok, true);
  assert.equal(p.emulated, false);
});

test('assertBuiltPlatform catches an arm64 image headed for an amd64 target', () => {
  const r = assertBuiltPlatform({ built: 'linux/arm64', expected: 'linux/amd64' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /immutable tag/);
});

test('assertBuiltPlatform passes on a match and normalises spellings', () => {
  assert.equal(assertBuiltPlatform({ built: 'linux/x86_64', expected: 'linux/amd64' }).ok, true);
});

test('assertBuiltPlatform fails closed when the built arch is unreadable', () => {
  assert.equal(assertBuiltPlatform({ built: '', expected: 'linux/amd64' }).ok, false);
});
