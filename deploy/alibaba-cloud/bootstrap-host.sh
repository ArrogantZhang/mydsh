#!/usr/bin/env bash
set -euo pipefail

readonly MANAGED_MARKER='# Managed by DeepSeek Harness Alibaba Cloud deployment'
readonly DEPLOY_LOCK=/run/lock/mydsh-deploy.lock
readonly NODESOURCE_FINGERPRINT=6F71F525282841EEDAF851B42F59B5F99B1BE0B4
readonly CADDY_FINGERPRINT=65760C51EDEA2017CEA2CA15155B6D79CA56EA34
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEPLOY_LOCK_FD=''
TEMP_DIR=''

usage() {
  printf 'Usage: sudo %s <lowercase-dns-hostname>\n' "${0##*/}" >&2
}

fail() {
  printf 'bootstrap-host: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [[ -n "$TEMP_DIR" && "$TEMP_DIR" == /tmp/mydsh-bootstrap.* ]]; then
    rm -rf -- "$TEMP_DIR" || true
  fi
}

acquire_operation_lock() {
  local lock_path=${1:-$DEPLOY_LOCK}
  local expected_owner=${2:-root:root}
  command -v flock >/dev/null 2>&1 || fail 'flock is required for deployment serialization'
  validate_lock_path "$lock_path" "$expected_owner"
  exec {DEPLOY_LOCK_FD}>"$lock_path" || fail "cannot open deployment lock: $lock_path"
  chmod 0600 "$lock_path"
  validate_lock_path "$lock_path" "$expected_owner"
  flock -n "$DEPLOY_LOCK_FD" || fail "another bootstrap, deployment, or rollback holds $lock_path"
}

validate_lock_path() {
  local lock_path=$1
  local expected_owner=${2:-root:root}
  local parent
  local parent_owner
  local parent_mode
  local file_owner
  local resolved

  parent=$(dirname -- "$lock_path")
  resolved=$(realpath -e -- "$parent") || fail "cannot resolve deployment lock directory: $parent"
  parent_owner=$(stat -c '%U:%G' -- "$parent") || fail "cannot read deployment lock directory ownership: $parent"
  parent_mode=$(stat -c '%a' -- "$parent") || fail "cannot read deployment lock directory mode: $parent"
  [[ $resolved == "$parent" && $parent_owner == "$expected_owner" ]] || fail "deployment lock directory is unsafe: $parent"
  (( (8#$parent_mode & 0002) == 0 )) || fail "deployment lock directory is writable by other users: $parent"
  if [[ -e "$lock_path" || -L "$lock_path" ]]; then
    [[ ! -L "$lock_path" && -f "$lock_path" ]] || fail "deployment lock must be a regular non-symlink file: $lock_path"
    resolved=$(realpath -e -- "$lock_path") || fail "cannot resolve deployment lock: $lock_path"
    file_owner=$(stat -c '%U:%G' -- "$lock_path") || fail "cannot read deployment lock ownership: $lock_path"
    [[ $resolved == "$lock_path" && $file_owner == "$expected_owner" ]] || fail "deployment lock ownership is unsafe: $lock_path"
  fi
}

ensure_managed_directory() {
  local path=$1
  local owner=$2
  local group=$3
  local mode=$4
  local resolved

  [[ $path == /* && $path != / ]] || fail "unsafe managed directory path: $path"
  [[ ! -L "$path" ]] || fail "managed directory must not be a symlink: $path"
  [[ ! -e "$path" || -d "$path" ]] || fail "managed directory path has the wrong type: $path"
  install -d -o "$owner" -g "$group" -m "$mode" -- "$path"
  resolved=$(realpath -e -- "$path") || fail "cannot resolve managed directory: $path"
  [[ $resolved == "$path" ]] || fail "managed directory escapes its literal path: $path -> $resolved"
}

validate_existing_managed_file() {
  local path=$1
  local resolved
  local owner

  [[ ! -L "$path" ]] || fail "managed file must not be a symlink: $path"
  [[ -f "$path" ]] || fail "managed file must be a regular file: $path"
  resolved=$(realpath -e -- "$path") || fail "cannot resolve managed file: $path"
  [[ $resolved == "$path" ]] || fail "managed file escapes its literal path: $path -> $resolved"
  owner=$(stat -c '%U:%G' -- "$path") || fail "cannot read managed file ownership: $path"
  [[ $owner == root:root ]] || fail "managed file must be owned by root:root: $path"
  grep -Fqx "$MANAGED_MARKER" "$path" || fail "refusing to replace or preserve unmanaged file: $path"
}

install_managed_file() {
  local source=$1
  local target=$2
  local mode=$3
  local target_dir
  local temporary

  [[ -f "$source" && ! -L "$source" ]] || fail "missing or unsafe deployment asset: $source"
  target_dir=$(dirname -- "$target")
  [[ $(realpath -e -- "$target_dir") == "$target_dir" ]] || fail "managed file parent is not canonical: $target_dir"
  if [[ -e "$target" || -L "$target" ]]; then
    validate_existing_managed_file "$target"
  fi
  temporary=$(mktemp "${target_dir}/.${target##*/}.XXXXXX")
  install -o root -g root -m "$mode" -- "$source" "$temporary"
  mv -f -- "$temporary" "$target" || {
    rm -f -- "$temporary" || true
    return 1
  }
}

write_managed_file() {
  local target=$1
  local mode=$2
  local content=$3
  local target_dir
  local temporary

  target_dir=$(dirname -- "$target")
  [[ $(realpath -e -- "$target_dir") == "$target_dir" ]] || fail "managed file parent is not canonical: $target_dir"
  if [[ -e "$target" || -L "$target" ]]; then
    validate_existing_managed_file "$target"
  fi
  temporary=$(mktemp "${target_dir}/.${target##*/}.XXXXXX")
  printf '%s\n' "$MANAGED_MARKER" "$content" >"$temporary"
  chown root:root "$temporary"
  chmod "$mode" "$temporary"
  mv -f -- "$temporary" "$target" || {
    rm -f -- "$temporary" || true
    return 1
  }
}

install_root_data_file() {
  local source=$1
  local target=$2
  local temporary
  local resolved
  local owner

  [[ $(realpath -e -- "$(dirname -- "$target")") == "$(dirname -- "$target")" ]] || fail "repository key parent is not canonical: $target"
  if [[ -e "$target" || -L "$target" ]]; then
    [[ ! -L "$target" && -f "$target" ]] || fail "repository key target has an unsafe type: $target"
    resolved=$(realpath -e -- "$target") || fail "cannot resolve repository key target: $target"
    owner=$(stat -c '%U:%G' -- "$target") || fail "cannot read repository key ownership: $target"
    [[ $resolved == "$target" && $owner == root:root ]] || fail "repository key target is not a root-owned canonical file: $target"
  fi
  temporary=$(mktemp "$(dirname -- "$target")/.${target##*/}.XXXXXX")
  install -o root -g root -m 0644 -- "$source" "$temporary"
  mv -f -- "$temporary" "$target" || {
    rm -f -- "$temporary" || true
    return 1
  }
}

key_fingerprints() {
  local key_file=$1
  gpg --batch --with-colons --import-options show-only --import "$key_file" 2>/dev/null |
    awk -F: '$1 == "pub" { want = 1; next } want && $1 == "fpr" { print $10; want = 0 }'
}

install_repository_key() {
  local url=$1
  local expected=$2
  local target=$3
  local name=$4
  local armored="$TEMP_DIR/$name.asc"
  local binary="$TEMP_DIR/$name.gpg"
  local fingerprints=()

  curl --fail --silent --show-error --location "$url" --output "$armored"
  mapfile -t fingerprints < <(key_fingerprints "$armored")
  [[ ${#fingerprints[@]} -eq 1 ]] || fail "$name signing key download must contain exactly one primary key"
  [[ ${fingerprints[0]} == "$expected" ]] || fail "$name signing key fingerprint changed: ${fingerprints[0]}"
  gpg --batch --yes --dearmor --output "$binary" "$armored"
  install_root_data_file "$binary" "$target"
}

validate_system_account() {
  local name=$1
  local expected_home=$2
  local account_name
  local entries=()
  local gecos
  local gid
  local home
  local passwd_uid
  local password
  local shell
  local uid

  mapfile -t entries < <(getent passwd "$name")
  [[ ${#entries[@]} -eq 1 ]] || fail "getent must resolve exactly one $name account"
  IFS=: read -r account_name password passwd_uid gid gecos home shell <<<"${entries[0]}"
  [[ $account_name == "$name" && $passwd_uid =~ ^[0-9]+$ ]] || fail "$name passwd entry is malformed"
  uid=$(id -u "$name") || fail "id cannot resolve $name"
  [[ $uid == "$passwd_uid" && $uid != 0 && $uid -lt 1000 ]] || fail "$name must be a non-root Ubuntu system account"
  [[ $home == "$expected_home" ]] || fail "$name must use home $expected_home"
  [[ $shell == /usr/sbin/nologin || $shell == /sbin/nologin ]] || fail "$name must use the Ubuntu nologin shell"
}

create_accounts_and_directories() {
  if ! id mydsh >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/mydsh --shell /usr/sbin/nologin --user-group mydsh
  fi
  validate_system_account mydsh /var/lib/mydsh
  if ! id mydsh-build >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/mydsh-build --shell /usr/sbin/nologin --user-group mydsh-build
  fi
  validate_system_account mydsh-build /var/lib/mydsh-build
  [[ $(id -u mydsh) != "$(id -u mydsh-build)" ]] || fail 'runtime and builder accounts must be distinct'
  [[ $(id -g mydsh) != "$(id -g mydsh-build)" ]] || fail 'runtime and builder groups must be distinct'

  ensure_managed_directory /opt/mydsh root root 0755
  ensure_managed_directory /opt/mydsh/releases root root 0755
  ensure_managed_directory /etc/mydsh root root 0755
  ensure_managed_directory /var/lib/mydsh mydsh mydsh 0700
  ensure_managed_directory /srv/mydsh/workspace mydsh mydsh 0750
  ensure_managed_directory /var/lib/mydsh-build mydsh-build mydsh-build 0700
  ensure_managed_directory /var/lib/mydsh-build/dsh-home mydsh-build mydsh-build 0700
  ensure_managed_directory /var/cache/mydsh-build root root 0755
  ensure_managed_directory /var/cache/mydsh-build/pnpm mydsh-build mydsh-build 0700
  ensure_managed_directory /etc/caddy root root 0755
  ensure_managed_directory /etc/systemd/system/caddy.service.d root root 0755
}

write_environment_files() {
  local public_host=$1
  local private_tmp
  local invite_code
  local session_secret

  write_managed_file /etc/mydsh/public.env 0644 "DSH_PUBLIC_HOST=$public_host"
  if [[ -e /etc/mydsh/mydsh.env || -L /etc/mydsh/mydsh.env ]]; then
    validate_existing_managed_file /etc/mydsh/mydsh.env
    chmod 0600 /etc/mydsh/mydsh.env
  else
    private_tmp=$(mktemp /etc/mydsh/.mydsh.env.XXXXXX)
    invite_code=$(openssl rand -hex 16)
    session_secret=$(openssl rand -hex 32)
    {
      printf '%s\n' "$MANAGED_MARKER"
      printf 'DSH_HOME=/var/lib/mydsh\n'
      printf 'DSH_INVITE_CODE_SECRET=%s\n' "$invite_code"
      printf 'DSH_INVITE_SESSION_SECRET=%s\n' "$session_secret"
    } >"$private_tmp"
    unset invite_code session_secret
    chown root:root "$private_tmp"
    chmod 0600 "$private_tmp"
    mv -n -- "$private_tmp" /etc/mydsh/mydsh.env || {
      rm -f -- "$private_tmp" || true
      return 1
    }
  fi
}

configure_package_repositories() {
  install_repository_key https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key "$NODESOURCE_FINGERPRINT" /usr/share/keyrings/nodesource.gpg nodesource
  write_managed_file /etc/apt/sources.list.d/nodesource.list 0644 'deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main'
  install_repository_key https://dl.cloudsmith.io/public/caddy/stable/gpg.key "$CADDY_FINGERPRINT" /usr/share/keyrings/caddy-stable-archive-keyring.gpg caddy-stable
  write_managed_file /etc/apt/sources.list.d/caddy-stable.list 0644 'deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main'
}

main() {
  local public_host
  local node_version
  local pnpm_version
  readonly HOST_PATTERN='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'

  [[ $EUID -eq 0 ]] || fail 'run this script as root'
  [[ $# -eq 1 ]] || {
    usage
    return 64
  }
  public_host=$1
  [[ ${#public_host} -le 253 && $public_host =~ $HOST_PATTERN ]] || fail 'hostname must be one lowercase DNS name such as dsh.example.com'
  acquire_operation_lock
  TEMP_DIR=$(mktemp -d /tmp/mydsh-bootstrap.XXXXXX)
  trap cleanup EXIT

  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y apt-transport-https build-essential ca-certificates curl debian-archive-keyring debian-keyring git gnupg openssl python3
  create_accounts_and_directories
  configure_package_repositories
  install_managed_file "$SCRIPT_DIR/Caddyfile" /etc/caddy/Caddyfile 0644
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get -o Dpkg::Options::=--force-confold install -y nodejs caddy
  node_version=$(node --version)
  [[ $node_version =~ ^v24\. ]] || fail "Node.js 24 is required; installed $node_version"
  npm install --global --ignore-scripts pnpm@11.7.0
  pnpm_version=$(pnpm --version)
  [[ $pnpm_version == 11.7.0 ]] || fail "pnpm 11.7.0 is required; installed $pnpm_version"

  write_environment_files "$public_host"
  install_managed_file "$SCRIPT_DIR/mydsh.service" /etc/systemd/system/mydsh.service 0644
  install_managed_file "$SCRIPT_DIR/caddy-mydsh.conf" /etc/systemd/system/caddy.service.d/mydsh.conf 0644
  install_managed_file "$SCRIPT_DIR/deploy-release.sh" /usr/local/sbin/mydsh-deploy-release 0755
  systemctl daemon-reload
  set -a
  # shellcheck disable=SC1091 -- write_environment_files owns this root-controlled file.
  source /etc/mydsh/public.env
  set +a
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  systemctl enable caddy
  systemctl restart caddy
  printf 'Host bootstrap complete for %s. Deploy a release before starting mydsh.\n' "$public_host"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
