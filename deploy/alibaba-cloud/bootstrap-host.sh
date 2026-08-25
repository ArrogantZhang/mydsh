#!/usr/bin/env bash
set -euo pipefail

readonly MANAGED_MARKER='# Managed by DeepSeek Harness Alibaba Cloud deployment'
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
TEMP_DIR=''
TEMP_OUTPUTS=()

usage() {
  printf 'Usage: sudo %s <lowercase-dns-hostname>\n' "${0##*/}" >&2
}

cleanup() {
  local path
  for path in "${TEMP_OUTPUTS[@]}"; do
    case "$path" in
      /etc/mydsh/.public.env.*|/etc/mydsh/.mydsh.env.*|/etc/caddy/.Caddyfile.*|/etc/systemd/system/.mydsh.service.*|/etc/systemd/system/caddy.service.d/.mydsh.conf.*)
        rm -f -- "$path"
        ;;
    esac
  done
  if [[ -n "$TEMP_DIR" && "$TEMP_DIR" == /tmp/mydsh-bootstrap.* ]]; then
    rm -rf -- "$TEMP_DIR"
  fi
}

fail() {
  printf 'bootstrap-host: %s\n' "$1" >&2
  exit 1
}

install_managed_file() {
  local source=$1
  local target=$2
  local mode=$3
  local backup="${target}.pre-mydsh"
  local target_dir
  local temporary

  [[ -f "$source" ]] || fail "missing deployment asset: $source"
  if [[ -e "$target" ]] && ! grep -Fqx "$MANAGED_MARKER" "$target"; then
    [[ ! -e "$backup" ]] || fail "refusing to replace unmanaged $target because $backup already exists"
    cp -a -- "$target" "$backup"
    printf 'Saved unmanaged %s as %s.\n' "$target" "$backup"
  fi

  target_dir=$(dirname -- "$target")
  temporary=$(mktemp "${target_dir}/.${target##*/}.XXXXXX")
  TEMP_OUTPUTS+=("$temporary")
  install -o root -g root -m "$mode" -- "$source" "$temporary"
  mv -f -- "$temporary" "$target"
}

[[ $EUID -eq 0 ]] || fail 'run this script as root'
[[ $# -eq 1 ]] || {
  usage
  exit 64
}

readonly PUBLIC_HOST=$1
readonly HOST_PATTERN='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
[[ ${#PUBLIC_HOST} -le 253 && $PUBLIC_HOST =~ $HOST_PATTERN ]] || fail 'hostname must be one lowercase DNS name such as dsh.example.com'

TEMP_DIR=$(mktemp -d /tmp/mydsh-bootstrap.XXXXXX)
trap cleanup EXIT

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y apt-transport-https build-essential ca-certificates curl debian-archive-keyring debian-keyring git gnupg openssl python3

curl --fail --silent --show-error --location https://deb.nodesource.com/setup_24.x --output "$TEMP_DIR/nodesource-setup_24.x.sh"
bash "$TEMP_DIR/nodesource-setup_24.x.sh"
DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
NODE_VERSION=$(node --version)
readonly NODE_VERSION
[[ $NODE_VERSION =~ ^v24\. ]] || fail "Node.js 24 is required; installed $NODE_VERSION"

npm install --global pnpm@11.7.0
PNPM_VERSION=$(pnpm --version)
readonly PNPM_VERSION
[[ $PNPM_VERSION == 11.7.0 ]] || fail "pnpm 11.7.0 is required; installed $PNPM_VERSION"

curl --fail --silent --show-error --location https://dl.cloudsmith.io/public/caddy/stable/gpg.key --output "$TEMP_DIR/caddy-stable.gpg.key"
gpg --dearmor --yes --output "$TEMP_DIR/caddy-stable-archive-keyring.gpg" "$TEMP_DIR/caddy-stable.gpg.key"
install -o root -g root -m 0644 "$TEMP_DIR/caddy-stable-archive-keyring.gpg" /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl --fail --silent --show-error --location https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt --output "$TEMP_DIR/caddy-stable.list"
install -o root -g root -m 0644 "$TEMP_DIR/caddy-stable.list" /etc/apt/sources.list.d/caddy-stable.list
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y caddy

if ! id mydsh >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/mydsh --shell /usr/sbin/nologin --user-group mydsh
fi
[[ $(id -u mydsh) != 0 ]] || fail 'the mydsh service account must not be root'

install -d -o root -g root -m 0755 /opt/mydsh/releases /etc/mydsh
install -d -o mydsh -g mydsh -m 0700 /var/lib/mydsh
install -d -o mydsh -g mydsh -m 0750 /srv/mydsh/workspace /var/cache/mydsh-pnpm
install -d -o root -g root -m 0755 /etc/systemd/system/caddy.service.d

public_env_tmp=$(mktemp /etc/mydsh/.public.env.XXXXXX)
TEMP_OUTPUTS+=("$public_env_tmp")
printf 'DSH_PUBLIC_HOST=%s\n' "$PUBLIC_HOST" >"$public_env_tmp"
chown root:root "$public_env_tmp"
chmod 0644 "$public_env_tmp"
mv -f -- "$public_env_tmp" /etc/mydsh/public.env

if [[ ! -e /etc/mydsh/mydsh.env ]]; then
  private_env_tmp=$(mktemp /etc/mydsh/.mydsh.env.XXXXXX)
  TEMP_OUTPUTS+=("$private_env_tmp")
  invite_code=$(openssl rand -hex 16)
  session_secret=$(openssl rand -hex 32)
  {
    printf 'DSH_HOME=/var/lib/mydsh\n'
    printf 'DSH_INVITE_CODE_SECRET=%s\n' "$invite_code"
    printf 'DSH_INVITE_SESSION_SECRET=%s\n' "$session_secret"
  } >"$private_env_tmp"
  unset invite_code session_secret
  chown root:root "$private_env_tmp"
  chmod 0600 "$private_env_tmp"
  mv -n -- "$private_env_tmp" /etc/mydsh/mydsh.env
fi
chown root:root /etc/mydsh/mydsh.env
chmod 0600 /etc/mydsh/mydsh.env

install_managed_file "$SCRIPT_DIR/Caddyfile" /etc/caddy/Caddyfile 0644
install_managed_file "$SCRIPT_DIR/mydsh.service" /etc/systemd/system/mydsh.service 0644
install_managed_file "$SCRIPT_DIR/caddy-mydsh.conf" /etc/systemd/system/caddy.service.d/mydsh.conf 0644

systemctl daemon-reload
set -a
# shellcheck disable=SC1091 -- this script creates the root-owned file above.
source /etc/mydsh/public.env
set +a
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy
systemctl restart caddy
printf 'Host bootstrap complete for %s. Deploy a release before starting mydsh.\n' "$PUBLIC_HOST"
