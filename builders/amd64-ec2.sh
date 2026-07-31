#!/usr/bin/env bash
# amd64-builder.sh — an on-demand NATIVE linux/amd64 Docker builder on EC2.
#
# WHY THIS EXISTS
#   This workstation is Windows-on-ARM. Building the linux/amd64 artefact locally means QEMU
#   emulation, and emulation on this host is not merely slow — it is unreliable. Observed, in four
#   consecutive attempts:
#     1. `next build` (Turbopack, a Rust binary) killed QEMU itself: "QEMU internal SIGILL
#        {code=ILLOPC}" / "QEMU internal SIGSEGV".
#     2. Each crash wrote a 1-2GB core dump to %LOCALAPPDATA%\Temp\wsl-crashes — 12.6GB in ONE
#        build, which filled the system drive mid-build.
#     3. binfmt registration lives in the WSL VM kernel and is wiped by `wsl --shutdown`, producing
#        an instant "exec /bin/sh: exec format error".
#     4. `pnpm install` died with "spawn ENOEXEC" in the cpu-features postinstall, and emulation was
#        observed DEREGISTERING ITSELF mid-session (a clean x86_64 probe, then `exec format error`
#        minutes later on an unchanged host).
#   So we build on real x86_64 silicon instead. See scripts/lib/docker-platform.sh for the policy
#   that stops an arm64 artefact ever reaching ECR.
#
# HOW IT WORKS
#   Docker's CLI can drive a REMOTE daemon over SSH. This script manages a small EC2 instance and
#   wires it up as a docker context. Once `up`, every existing script works against it unchanged:
#
#     eval "$(scripts/amd64-builder.sh env)"      # exports DOCKER_CONTEXT
#     scripts/publish-image.sh staging            # builds natively on amd64, pushes to ECR
#
#   The build context is streamed from this machine, and `docker login` forwards YOUR AWS ECR
#   credentials to the remote daemon — so the instance needs no IAM role and holds no secrets.
#
# COMMANDS
#   up         create (or start) the instance and register the docker context
#   status     show instance state, IP, and context wiring
#   env        print the `export DOCKER_CONTEXT=...` line for eval
#   down       STOP the instance (keeps the disk; costs only EBS ~$0.10/GB-month)
#   terminate  destroy the instance, security group and key pair
#
# COST
#   Billed only while RUNNING. `down` when you are finished — that is the whole point of the
#   lifecycle commands. Default type is overridable with BUILDER_INSTANCE_TYPE.
#
# Env:
#   AWS_REGION             default ap-southeast-2
#   BUILDER_INSTANCE_TYPE  default c7i.xlarge (4 vCPU). c7i.2xlarge roughly halves build time for
#                          about double the hourly rate — similar cost per build, less waiting.
#   BUILDER_VOLUME_GB      default 60

set -euo pipefail

# Git Bash on Windows rewrites any argument that LOOKS like a POSIX path into a Windows one, which
# corrupts AWS arguments that merely happen to start with a slash: the SSM parameter name
# /aws/service/... and the block device /dev/xvda both became "C:/Program Files/Git/...". Neither is a
# filesystem path. No-op on Linux and macOS.
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

AWS_REGION="${AWS_REGION:-ap-southeast-2}"
INSTANCE_TYPE="${BUILDER_INSTANCE_TYPE:-c7i.xlarge}"
VOLUME_GB="${BUILDER_VOLUME_GB:-60}"

NAME="graphene-amd64-builder"
CONTEXT_NAME="graphene-amd64"
SSH_ALIAS="graphene-amd64-builder"
KEY_DIR="${HOME}/.ssh"
KEY_PATH="${KEY_DIR}/${NAME}.pem"

aws_ec2() { aws ec2 --region "$AWS_REGION" "$@"; }

# Resolve the one instance we manage, ignoring terminated ones so a fresh `up` after `terminate`
# does not try to revive a corpse.
find_instance() {
  aws_ec2 describe-instances \
    --filters "Name=tag:Name,Values=${NAME}" \
              "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null | grep -v '^None$' || true
}

instance_state() {
  aws_ec2 describe-instances --instance-ids "$1" \
    --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || echo unknown
}

instance_ip() {
  aws_ec2 describe-instances --instance-ids "$1" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text 2>/dev/null | grep -v '^None$' || true
}

my_ip() {
  # The SG is locked to this /32. Home/office IPs move, so `up` always re-authorises the current one
  # rather than leaving a stale (or worse, widened) rule behind.
  curl -s --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]'
}

ensure_key_pair() {
  if aws_ec2 describe-key-pairs --key-names "$NAME" >/dev/null 2>&1; then
    if [[ ! -f "$KEY_PATH" ]]; then
      echo "amd64-builder: ❌ AWS has key pair '${NAME}' but the private key is missing locally:" >&2
      echo "               ${KEY_PATH}" >&2
      echo "               Run '$0 terminate' to clear it, then '$0 up' to issue a fresh pair." >&2
      exit 1
    fi
    return 0
  fi

  echo "amd64-builder: creating key pair ${NAME}"
  mkdir -p "$KEY_DIR"
  aws_ec2 create-key-pair --key-name "$NAME" --query 'KeyMaterial' --output text > "$KEY_PATH"
  chmod 600 "$KEY_PATH"
  # Windows OpenSSH authorises by ACL, not POSIX mode, and REFUSES a key other principals can read.
  # chmod alone leaves it unusable there, so tighten the ACL too when we are on Windows.
  if command -v icacls.exe >/dev/null 2>&1; then
    local win_path
    win_path="$(cygpath -w "$KEY_PATH" 2>/dev/null || echo "$KEY_PATH")"
    icacls.exe "$win_path" /inheritance:r >/dev/null 2>&1 || true
    icacls.exe "$win_path" /grant:r "${USERNAME:-$USER}:R" >/dev/null 2>&1 || true
  fi
}

ensure_security_group() {
  local sg_id
  sg_id="$(aws_ec2 describe-security-groups --filters "Name=group-name,Values=${NAME}" \
             --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null | grep -v '^None$' || true)"

  if [[ -z "$sg_id" ]]; then
    echo "amd64-builder: creating security group ${NAME}" >&2
    sg_id="$(aws_ec2 create-security-group --group-name "$NAME" \
               --description "SSH access for the graphene amd64 docker builder" \
               --query 'GroupId' --output text)"
  fi

  local ip
  ip="$(my_ip)"
  if [[ -z "$ip" ]]; then
    echo "amd64-builder: could not determine this machine's public IP; refusing to open the SG." >&2
    exit 1
  fi

  # Drop every existing ingress rule before adding today's IP. Without this the group accretes stale
  # /32s from old networks, each one a standing SSH exposure.
  local existing
  existing="$(aws_ec2 describe-security-groups --group-ids "$sg_id" \
                --query 'SecurityGroups[0].IpPermissions' --output json)"
  if [[ "$existing" != "[]" && -n "$existing" ]]; then
    aws_ec2 revoke-security-group-ingress --group-id "$sg_id" --ip-permissions "$existing" >/dev/null 2>&1 || true
  fi

  echo "amd64-builder: authorising SSH from ${ip}/32" >&2
  aws_ec2 authorize-security-group-ingress --group-id "$sg_id" \
    --protocol tcp --port 22 --cidr "${ip}/32" >/dev/null

  printf '%s' "$sg_id"
}

launch_instance() {
  local sg_id="$1"

  # Resolve the current Amazon Linux 2023 x86_64 AMI from the SSM public parameter rather than
  # pinning an ID that rots. x86_64 is the entire point of this machine — do not templatise it.
  local ami
  ami="$(aws ssm get-parameter --region "$AWS_REGION" \
          --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
          --query 'Parameter.Value' --output text)" || true
  if [[ -z "$ami" || "$ami" == "None" ]]; then
    # Guard explicitly: `set -e` does NOT abort the caller when a function is invoked inside a command
    # substitution, so without this the failure sails on and RunInstances is called with no ImageId.
    echo "amd64-builder: ❌ could not resolve the Amazon Linux 2023 x86_64 AMI." >&2
    exit 1
  fi
  echo "amd64-builder: AMI ${ami} (Amazon Linux 2023, x86_64)" >&2

  local user_data
  user_data="$(cat <<'EOF'
#!/bin/bash
set -eux
dnf install -y docker
systemctl enable --now docker
usermod -aG docker ec2-user
# Marker the `up` command polls for. Written last, so its presence means docker is genuinely ready.
touch /var/lib/cloud/amd64-builder-ready
EOF
)"

  local instance_id
  instance_id="$(aws_ec2 run-instances \
    --image-id "$ami" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$NAME" \
    --security-group-ids "$sg_id" \
    --block-device-mappings "DeviceName=/dev/xvda,Ebs={VolumeSize=${VOLUME_GB},VolumeType=gp3,DeleteOnTermination=true}" \
    --user-data "$user_data" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${NAME}},{Key=ManagedBy,Value=graphene-consumer/scripts/amd64-builder.sh},{Key=Purpose,Value=native-amd64-image-build}]" \
    --query 'Instances[0].InstanceId' --output text)" || true

  if [[ -z "$instance_id" || "$instance_id" == "None" ]]; then
    echo "amd64-builder: ❌ RunInstances did not return an instance id." >&2
    exit 1
  fi

  echo "amd64-builder: launched ${instance_id} (${INSTANCE_TYPE}, ${VOLUME_GB}GB)" >&2
  printf '%s' "$instance_id"
}

wait_for_ssh() {
  local ip="$1"
  echo "amd64-builder: waiting for SSH + docker on ${ip} (up to 5 min)" >&2
  for _ in $(seq 1 60); do
    if ssh -i "$KEY_PATH" \
          -o StrictHostKeyChecking=accept-new \
          -o UserKnownHostsFile="${KEY_DIR}/known_hosts" \
          -o ConnectTimeout=5 -o BatchMode=yes \
          "ec2-user@${ip}" \
          'test -f /var/lib/cloud/amd64-builder-ready && docker version >/dev/null 2>&1' >/dev/null 2>&1; then
      echo "amd64-builder: remote docker is ready" >&2
      return 0
    fi
    sleep 5
  done
  echo "amd64-builder: ❌ timed out waiting for remote docker." >&2
  echo "amd64-builder: debug with: ssh -i ${KEY_PATH} ec2-user@${ip} 'sudo cat /var/log/cloud-init-output.log'" >&2
  return 1
}

drop_ssh_config_block() {
  # Strip our Host block, leaving every other entry untouched. Shared by write_ssh_config (which
  # then re-adds it with the current IP) and terminate (which must not leave it behind).
  local cfg="${KEY_DIR}/config"
  [[ -f "$cfg" ]] || return 0
  local tmp
  tmp="$(mktemp)"
  awk -v alias="$SSH_ALIAS" '
    $1 == "Host" && $2 == alias { skip = 1; next }
    $1 == "Host" && $2 != alias { skip = 0 }
    !skip { print }
  ' "$cfg" > "$tmp"
  mv "$tmp" "$cfg"
  chmod 600 "$cfg" 2>/dev/null || true
}

forget_host_key() {
  # The instance's public IP goes back to AWS's pool on release and will belong to somebody else.
  # Leaving its key in known_hosts means a future connection to that address either warns about a
  # changed key or, worse, matches a host we have no relationship with.
  local ip="$1"
  [[ -n "$ip" && -f "${KEY_DIR}/known_hosts" ]] || return 0
  ssh-keygen -R "$ip" -f "${KEY_DIR}/known_hosts" >/dev/null 2>&1 || true
}

write_ssh_config() {
  local ip="$1"
  # `docker context ... host=ssh://X` shells out to ssh with no way to pass -i, so the identity has
  # to come from ssh_config. Rewrite our block in place each time: the public IP changes on every
  # stop/start.
  local cfg="${KEY_DIR}/config"
  mkdir -p "$KEY_DIR"
  touch "$cfg"
  drop_ssh_config_block

  cat >> "$cfg" <<EOF
Host ${SSH_ALIAS}
  HostName ${ip}
  User ec2-user
  IdentityFile ${KEY_PATH}
  StrictHostKeyChecking accept-new
  UserKnownHostsFile ${KEY_DIR}/known_hosts
  IdentitiesOnly yes
EOF

  chmod 600 "$cfg" 2>/dev/null || true
  echo "amd64-builder: ssh alias '${SSH_ALIAS}' -> ${ip}" >&2
}

wire_context() {
  # Recreate rather than update: the endpoint is keyed on the alias, and a stale context silently
  # points docker at an address that is now someone else's instance.
  docker context rm -f "$CONTEXT_NAME" >/dev/null 2>&1 || true
  docker context create "$CONTEXT_NAME" \
    --description "Native linux/amd64 builder on EC2" \
    --docker "host=ssh://${SSH_ALIAS}" >/dev/null
  echo "amd64-builder: docker context '${CONTEXT_NAME}' created" >&2
}

verify_native_amd64() {
  # The entire justification for this instance is that it is REAL x86_64. Prove it, so a
  # misconfiguration cannot quietly hand us back an emulated or arm64 daemon.
  local arch
  arch="$(docker --context "$CONTEXT_NAME" version --format '{{.Server.Arch}}' 2>/dev/null || true)"
  if [[ "$arch" != "amd64" ]]; then
    echo "amd64-builder: ❌ remote daemon reports arch '${arch:-unknown}', expected amd64." >&2
    return 1
  fi
  echo "amd64-builder: remote daemon arch = amd64 ✓" >&2
}

cmd_up() {
  ensure_key_pair
  local sg_id instance_id state ip
  sg_id="$(ensure_security_group)"

  instance_id="$(find_instance)"
  if [[ -z "$instance_id" ]]; then
    instance_id="$(launch_instance "$sg_id")"
  else
    state="$(instance_state "$instance_id")"
    echo "amd64-builder: reusing ${instance_id} (state: ${state})" >&2
    if [[ "$state" == "stopped" ]]; then
      echo "amd64-builder: starting it" >&2
      aws_ec2 start-instances --instance-ids "$instance_id" >/dev/null
    fi
  fi

  echo "amd64-builder: waiting for instance to run" >&2
  aws_ec2 wait instance-running --instance-ids "$instance_id"

  ip="$(instance_ip "$instance_id")"
  if [[ -z "$ip" ]]; then
    echo "amd64-builder: ❌ instance has no public IP." >&2
    exit 1
  fi

  write_ssh_config "$ip"
  wait_for_ssh "$ip"
  wire_context
  verify_native_amd64

  cat >&2 <<EOF

amd64-builder: ✅ ready.

  eval "\$(scripts/amd64-builder.sh env)"
  scripts/publish-image.sh staging

Stop it when you are done — it bills only while running:

  scripts/amd64-builder.sh down
EOF
}

cmd_env() {
  # stdout is consumed by eval, so it must contain NOTHING but the export line.
  local instance_id
  instance_id="$(find_instance)"
  if [[ -z "$instance_id" || "$(instance_state "$instance_id")" != "running" ]]; then
    echo "amd64-builder: no running builder — run '$0 up' first." >&2
    exit 1
  fi
  echo "export DOCKER_CONTEXT=${CONTEXT_NAME}"
}

cmd_status() {
  local instance_id
  instance_id="$(find_instance)"
  if [[ -z "$instance_id" ]]; then
    echo "amd64-builder: no instance (run '$0 up')"
    return 0
  fi
  echo "amd64-builder: instance   ${instance_id}"
  echo "amd64-builder: state      $(instance_state "$instance_id")"
  echo "amd64-builder: public ip  $(instance_ip "$instance_id" || echo '-')"
  echo "amd64-builder: type       ${INSTANCE_TYPE}"
  if docker context inspect "$CONTEXT_NAME" >/dev/null 2>&1; then
    echo "amd64-builder: context    ${CONTEXT_NAME} (arch: $(docker --context "$CONTEXT_NAME" version --format '{{.Server.Arch}}' 2>/dev/null || echo unreachable))"
  else
    echo "amd64-builder: context    not registered"
  fi
}

cmd_down() {
  local instance_id
  instance_id="$(find_instance)"
  if [[ -z "$instance_id" ]]; then
    echo "amd64-builder: nothing to stop."
    return 0
  fi
  echo "amd64-builder: stopping ${instance_id}"
  aws_ec2 stop-instances --instance-ids "$instance_id" >/dev/null
  # gp3 in ap-southeast-2 is ~$0.096/GB-month, so 60GB is ~$6/month to keep the warm build cache.
  # Run `terminate` instead if the cache is not worth that.
  echo "amd64-builder: stopped. Compute billing ends; the ${VOLUME_GB}GB EBS volume persists (~\$6/month)."
}

cmd_terminate() {
  local instance_id last_ip=""
  instance_id="$(find_instance)"
  if [[ -n "$instance_id" ]]; then
    # Read the IP BEFORE terminating — the association is gone by the time the waiter returns.
    last_ip="$(instance_ip "$instance_id")"
    echo "amd64-builder: terminating ${instance_id}"
    aws_ec2 terminate-instances --instance-ids "$instance_id" >/dev/null
    aws_ec2 wait instance-terminated --instance-ids "$instance_id"
  fi

  # Only safe AFTER the instance is gone — the SG cannot be deleted while attached.
  local sg_id
  sg_id="$(aws_ec2 describe-security-groups --filters "Name=group-name,Values=${NAME}" \
             --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null | grep -v '^None$' || true)"
  [[ -n "$sg_id" ]] && aws_ec2 delete-security-group --group-id "$sg_id" >/dev/null 2>&1 && \
    echo "amd64-builder: deleted security group ${sg_id}"

  aws_ec2 delete-key-pair --key-name "$NAME" >/dev/null 2>&1 && echo "amd64-builder: deleted key pair ${NAME}"
  rm -f "$KEY_PATH"
  docker context rm -f "$CONTEXT_NAME" >/dev/null 2>&1 || true

  # Local state too, or the next `ssh graphene-amd64-builder` aims an accept-new host-key policy at
  # an address that now belongs to a stranger.
  drop_ssh_config_block
  forget_host_key "$last_ip"
  echo "amd64-builder: removed the ssh alias and its known_hosts entry"

  echo "amd64-builder: ✅ all resources removed."
}

case "${1:-}" in
  up)        cmd_up ;;
  env)       cmd_env ;;
  status)    cmd_status ;;
  down)      cmd_down ;;
  terminate) cmd_terminate ;;
  *)
    sed -n '2,40p' "$0"
    echo
    echo "usage: $0 <up|env|status|down|terminate>" >&2
    exit 2
    ;;
esac
