# Docker platform policy, shared. Source this before any `docker build`.
#
#   . "$(node -p "require.resolve('@tokenomik/local-ci-gate/lib/docker-platform.sh')")"
#
# This is a thin shell face over bin/tmk-platform.cjs so the decision logic has
# exactly one implementation and is unit-tested. It replaces the per-repo copies
# of scripts/lib/docker-platform.sh, which were ported by copying and had already
# diverged: consumer had one, supply had the policy only as a YAML comment, engine
# and infra had nothing at all.
#
# POLICY
#   Local builds are NATIVE by default. The predecessor defaulted every build to
#   linux/amd64 and installed QEMU binfmt to make that work on an ARM host; on
#   Windows-on-ARM that produced QEMU SIGILL/SIGSEGV crashes, multi-GB core dumps,
#   and binfmt registrations silently wiped by `wsl --shutdown`.
#
#   PUBLISHED artefacts are still linux/amd64, always. Fargate's runtimePlatform
#   is X86_64, an arm64 manifest fails at pull with CannotPullContainerError, and
#   the immutable SHA tag it burned cannot be reused.
#
#   Cross-architecture builds happen where the silicon is real. See
#   builders/README.md.
#
# ENV
#   TMK_DOCKER_PLATFORM  explicit override; `native`/`host`/`off` force native
#   TMK_ALLOW_QEMU=1     opt in to emulation for this build (discouraged)

_tmk_platform_bin() {
  node -p "require.resolve('@tokenomik/local-ci-gate/bin/tmk-platform.cjs')" 2>/dev/null
}

# Echo the platform string ('' means native daemon arch).
resolve_docker_platform() {
  node "$(_tmk_platform_bin)" resolve "$@"
}

# Set or unset DOCKER_DEFAULT_PLATFORM, then refuse a build that would need QEMU.
# Returns non-zero on refusal so `set -e` callers stop before doing any work.
initialize_docker_platform() {
  local bin
  bin="$(_tmk_platform_bin)"
  if [ -z "$bin" ]; then
    echo "ERROR: @tokenomik/local-ci-gate is not installed. Run your package manager install." >&2
    return 1
  fi
  eval "$(node "$bin" env "$@")"
  node "$bin" preflight "$@"
}

# Publishing is parity-required. Call before pushing anything to ECR.
assert_docker_amd64_parity() {
  node "$(_tmk_platform_bin)" preflight --publish
}

# --platform REQUESTS a platform; this PROVES we got it.
assert_built_platform() {
  node "$(_tmk_platform_bin)" assert-built "$1" "${2:-}"
}
