#!/usr/bin/env bash
set -euo pipefail

readonly MANAGED_MARKER='# Managed by DeepSeek Harness Alibaba Cloud deployment'
readonly DEPLOY_LOCK=/run/lock/mydsh-deploy.lock
readonly NODESOURCE_FINGERPRINT=6F71F525282841EEDAF851B42F59B5F99B1BE0B4
readonly CADDY_FINGERPRINT=65760C51EDEA2017CEA2CA15155B6D79CA56EA34
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIR
DEPLOY_LOCK_FD=''
TEMP_DIR=''
CREATED_TEMP_FILE=''
REGISTERED_TEMP_FILES=()

usage() {
  printf 'Usage: sudo %s <lowercase-dns-hostname>\n' "${0##*/}" >&2
}

fail() {
  printf 'bootstrap-host: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  cleanup_registered_temp_files
  if [[ -n "$TEMP_DIR" && "$TEMP_DIR" == /tmp/mydsh-bootstrap.* ]]; then
    rm -rf -- "$TEMP_DIR" || true
  fi
}

registered_temp_path_is_safe() {
  local path=$1
  local parent
  local name
  parent=$(dirname -- "$path") || return 1
  name=${path##*/}
  [[ $name =~ ^\.mydsh-tmp\.[0-9]+\.[0-9]+$ ]] || return 1
  [[ $(realpath -e -- "$parent") == "$parent" ]] || return 1
}

unregister_temp_file() {
  local target=$1
  local retained=()
  local path
  for path in "${REGISTERED_TEMP_FILES[@]}"; do [[ $path == "$target" ]] || retained+=("$path"); done
  REGISTERED_TEMP_FILES=("${retained[@]}")
}

discard_registered_temp_file() {
  local path=$1
  registered_temp_path_is_safe "$path" || return 1
  rm -f -- "$path" || return 1
  unregister_temp_file "$path"
}

cleanup_registered_temp_files() {
  local path
  for path in "${REGISTERED_TEMP_FILES[@]}"; do
    if registered_temp_path_is_safe "$path"; then rm -f -- "$path" || true; fi
  done
  REGISTERED_TEMP_FILES=()
}

create_registered_temp_file() {
  local parent=$1
  local _attempt
  local candidate

  [[ $(realpath -e -- "$parent") == "$parent" ]] || return 1
  for _attempt in {1..20}; do
    candidate="$parent/.mydsh-tmp.$$.$RANDOM"
    REGISTERED_TEMP_FILES+=("$candidate")
    if (umask 077; set -o noclobber; : >"$candidate") 2>/dev/null; then
      CREATED_TEMP_FILE=$candidate
      return 0
    fi
    unregister_temp_file "$candidate"
  done
  CREATED_TEMP_FILE=''
  return 1
}

acquire_operation_lock() {
  local lock_path=${1:-$DEPLOY_LOCK}
  local expected_owner=${2:-root:root}
  command -v flock >/dev/null 2>&1 || fail 'flock is required for deployment serialization'
  validate_lock_path "$lock_path" "$expected_owner"
  exec {DEPLOY_LOCK_FD}>"$lock_path" || fail "cannot open deployment lock: $lock_path"
  chmod 0600 "$lock_path" || fail "cannot secure deployment lock: $lock_path"
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

  validate_managed_directory_path "$path"
  install -d -o "$owner" -g "$group" -m "$mode" -- "$path" || fail "cannot create or normalize managed directory: $path"
  resolved=$(realpath -e -- "$path") || fail "cannot resolve managed directory: $path"
  [[ $resolved == "$path" ]] || fail "managed directory escapes its literal path: $path -> $resolved"
}

validate_managed_directory_path() {
  local path=$1
  local resolved
  [[ $path == /* && $path != / ]] || fail "unsafe managed directory path: $path"
  validate_ancestor_chain "$path"
  [[ ! -L "$path" ]] || fail "managed directory must not be a symlink: $path"
  [[ ! -e "$path" || -d "$path" ]] || fail "managed directory path has the wrong type: $path"
  if [[ -d "$path" ]]; then
    resolved=$(realpath -e -- "$path") || fail "cannot resolve managed directory: $path"
    [[ $resolved == "$path" ]] || fail "managed directory escapes its literal path: $path -> $resolved"
  fi
}

validate_ancestor_chain() {
  local path=$1
  local parent
  local current=''
  local component
  local components=()
  parent=$(dirname -- "$path")
  IFS=/ read -r -a components <<<"${parent#/}"
  for component in "${components[@]}"; do
    [[ -n "$component" ]] || continue
    current="$current/$component"
    if [[ -e "$current" || -L "$current" ]]; then
      [[ -d "$current" && ! -L "$current" ]] || fail "managed path ancestor is not a real directory: $current"
      [[ $(realpath -e -- "$current") == "$current" ]] || fail "managed path ancestor is aliased: $current"
    fi
  done
}

preflight_managed_paths() {
  local paths=("$@")
  local path
  for path in "${paths[@]}"; do
    validate_managed_directory_path "$path"
  done
}

managed_directory_matches() {
  local path=$1
  local expected_owner=$2
  local expected_mode=$3
  local owner
  local mode
  local resolved
  [[ -d "$path" && ! -L "$path" ]] || return 1
  resolved=$(realpath -e -- "$path") || return 1
  owner=$(stat -c '%U:%G' -- "$path") || return 1
  mode=$(stat -c '%a' -- "$path") || return 1
  [[ $resolved == "$path" && $owner == "$expected_owner" && $mode == "$expected_mode" ]]
}

validate_active_managed_state() {
  local host_root=${1:-}
  managed_directory_matches "$host_root/opt/mydsh" root:root 755 || return 1
  managed_directory_matches "$host_root/opt/mydsh/releases" root:root 755 || return 1
  managed_directory_matches "$host_root/etc/mydsh" root:root 755 || return 1
  managed_directory_matches "$host_root/var/lib/mydsh" mydsh:mydsh 700 || return 1
  managed_directory_matches "$host_root/srv/mydsh" root:root 755 || return 1
  managed_directory_matches "$host_root/srv/mydsh/workspace" mydsh:mydsh 750 || return 1
  managed_directory_matches "$host_root/var/lib/mydsh-deploy" root:root 700 || return 1
  managed_directory_matches "$host_root/var/lib/mydsh-deploy/uploads" root:root 700 || return 1
  managed_directory_matches "$host_root/etc/caddy" root:root 755 || return 1
  managed_directory_matches "$host_root/etc/systemd/system/caddy.service.d" root:root 755 || return 1
  managed_directory_matches "$host_root/usr/local/sbin" root:root 755 || return 1
  validate_existing_managed_file "$host_root/etc/mydsh/public.env" 644 || return 1
  validate_existing_managed_file "$host_root/etc/mydsh/mydsh.env" 600 || return 1
  validate_existing_managed_file "$host_root/etc/caddy/Caddyfile" 644 || return 1
  validate_existing_managed_file "$host_root/etc/systemd/system/mydsh.service" 644 || return 1
  validate_existing_managed_file "$host_root/etc/systemd/system/caddy.service.d/mydsh.conf" 644 || return 1
  validate_existing_managed_file "$host_root/usr/local/sbin/mydsh-deploy-release" 755 || return 1
}

active_bootstrap_matches() {
  local public_host=$1
  local source_dir=${2:-$SCRIPT_DIR}
  local host_root=${3:-}
  local current_path=${4:-/opt/mydsh/current}
  local releases_root=${5:-/opt/mydsh/releases}
  local commit
  local line_count
  local resolved_current
  local resolved_releases
  local caddy="$host_root/etc/caddy/Caddyfile"
  local unit="$host_root/etc/systemd/system/mydsh.service"
  local dropin="$host_root/etc/systemd/system/caddy.service.d/mydsh.conf"
  local helper="$host_root/usr/local/sbin/mydsh-deploy-release"
  local public_env="$host_root/etc/mydsh/public.env"
  validate_active_managed_state "$host_root" || return 1
  [[ -L "$current_path" ]] || return 1
  [[ -d "$releases_root" && ! -L "$releases_root" ]] || return 1
  resolved_releases=$(realpath -e -- "$releases_root") || return 1
  resolved_current=$(realpath -e -- "$current_path") || return 1
  commit=${resolved_current##*/}
  [[ $resolved_releases == "$releases_root" && $commit =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ $resolved_current == "$releases_root/$commit" ]] || return 1
  managed_directory_matches "$resolved_current" root:root 755 || return 1
  cmp -- "$source_dir/Caddyfile" "$caddy" || return 1
  cmp -- "$source_dir/mydsh.service" "$unit" || return 1
  cmp -- "$source_dir/caddy-mydsh.conf" "$dropin" || return 1
  cmp -- "$source_dir/deploy-release.sh" "$helper" || return 1
  line_count=$(wc -l <"$public_env") || return 1
  [[ $line_count == 2 ]] || return 1
  grep -Fqx "$MANAGED_MARKER" "$public_env" || return 1
  grep -Fqx "DSH_PUBLIC_HOST=$public_host" "$public_env" || return 1
}

validate_existing_managed_file() {
  local path=$1
  local expected_mode=${2#0}
  local resolved
  local owner
  local mode

  [[ ! -L "$path" && -f "$path" ]] || return 1
  resolved=$(realpath -e -- "$path") || return 1
  [[ $resolved == "$path" ]] || return 1
  owner=$(stat -c '%U:%G' -- "$path") || return 1
  mode=$(stat -c '%a' -- "$path") || return 1
  [[ $owner == root:root && $mode == "$expected_mode" ]] || return 1
  grep -Fqx "$MANAGED_MARKER" "$path" || return 1
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
    validate_existing_managed_file "$target" "$mode" || fail "refusing unsafe, unmanaged, or mode-drifted file: $target"
  fi
  create_registered_temp_file "$target_dir" || return 1
  temporary=$CREATED_TEMP_FILE
  install -o root -g root -m "$mode" -- "$source" "$temporary" || { discard_registered_temp_file "$temporary" || true; return 1; }
  mv -f -- "$temporary" "$target" || {
    discard_registered_temp_file "$temporary" || true
    return 1
  }
  unregister_temp_file "$temporary"
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
    validate_existing_managed_file "$target" "$mode" || fail "refusing unsafe, unmanaged, or mode-drifted file: $target"
  fi
  create_registered_temp_file "$target_dir" || return 1
  temporary=$CREATED_TEMP_FILE
  printf '%s\n' "$MANAGED_MARKER" "$content" >"$temporary" || { discard_registered_temp_file "$temporary" || true; return 1; }
  chown root:root "$temporary" || { discard_registered_temp_file "$temporary" || true; return 1; }
  chmod "$mode" "$temporary" || { discard_registered_temp_file "$temporary" || true; return 1; }
  mv -f -- "$temporary" "$target" || {
    discard_registered_temp_file "$temporary" || true
    return 1
  }
  unregister_temp_file "$temporary"
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
  create_registered_temp_file "$(dirname -- "$target")" || return 1
  temporary=$CREATED_TEMP_FILE
  install -o root -g root -m 0644 -- "$source" "$temporary" || { discard_registered_temp_file "$temporary" || true; return 1; }
  mv -f -- "$temporary" "$target" || {
    discard_registered_temp_file "$temporary" || true
    return 1
  }
  unregister_temp_file "$temporary"
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
  if [[ -e "$target" || -L "$target" ]]; then
    validate_existing_root_key "$target" "$expected"
  fi
  gpg --batch --yes --dearmor --output "$binary" "$armored"
  install_root_data_file "$binary" "$target"
}

validate_existing_root_key() {
  local target=$1
  local expected=$2
  local fingerprints=()
  [[ -f "$target" && ! -L "$target" ]] || fail "existing signing key has an unsafe type: $target"
  mapfile -t fingerprints < <(key_fingerprints "$target")
  [[ ${#fingerprints[@]} -eq 1 && ${fingerprints[0]} == "$expected" ]] || fail "existing signing key does not match the pinned fingerprint: $target"
}

validate_system_account() {
  local name=$1
  local expected_home=$2
  local account_name
  local entries=()
  local _gecos
  local _gid
  local home
  local passwd_uid
  local _password
  local shell
  local uid

  mapfile -t entries < <(getent passwd "$name")
  [[ ${#entries[@]} -eq 1 ]] || fail "getent must resolve exactly one $name account"
  IFS=: read -r account_name _password passwd_uid _gid _gecos home shell <<<"${entries[0]}"
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
  ensure_managed_directory /opt/mydsh root root 0755
  ensure_managed_directory /opt/mydsh/releases root root 0755
  ensure_managed_directory /etc/mydsh root root 0755
  ensure_managed_directory /var/lib/mydsh mydsh mydsh 0700
  ensure_managed_directory /srv/mydsh root root 0755
  ensure_managed_directory /srv/mydsh/workspace mydsh mydsh 0750
  ensure_managed_directory /var/lib/mydsh-deploy root root 0700
  ensure_managed_directory /var/lib/mydsh-deploy/uploads root root 0700
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
    validate_existing_managed_file /etc/mydsh/mydsh.env 600 || fail 'existing private environment file has unsafe ownership, mode, type, or content marker'
  else
    create_registered_temp_file /etc/mydsh || return 1
    private_tmp=$CREATED_TEMP_FILE
    invite_code=$(openssl rand -hex 16)
    session_secret=$(openssl rand -hex 32)
    if ! {
      printf '%s\n' "$MANAGED_MARKER"
      printf 'DSH_HOME=/var/lib/mydsh\n'
      printf 'DSH_INVITE_CODE_SECRET=%s\n' "$invite_code"
      printf 'DSH_INVITE_SESSION_SECRET=%s\n' "$session_secret"
    } >"$private_tmp"; then discard_registered_temp_file "$private_tmp" || true; return 1; fi
    unset invite_code session_secret
    chown root:root "$private_tmp" || { discard_registered_temp_file "$private_tmp" || true; return 1; }
    chmod 0600 "$private_tmp" || { discard_registered_temp_file "$private_tmp" || true; return 1; }
    mv -n -- "$private_tmp" /etc/mydsh/mydsh.env || {
      discard_registered_temp_file "$private_tmp" || true
      return 1
    }
    if [[ -e "$private_tmp" || -L "$private_tmp" ]]; then
      discard_registered_temp_file "$private_tmp" || true
      return 1
    fi
    unregister_temp_file "$private_tmp"
  fi
}

configure_package_repositories() {
  install_repository_key https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key "$NODESOURCE_FINGERPRINT" /usr/share/keyrings/mydsh-nodesource.gpg nodesource
  write_managed_file /etc/apt/sources.list.d/nodesource.list 0644 'deb [signed-by=/usr/share/keyrings/mydsh-nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main'
  install_repository_key https://dl.cloudsmith.io/public/caddy/stable/gpg.key "$CADDY_FINGERPRINT" /usr/share/keyrings/mydsh-caddy-stable.gpg caddy-stable
  write_managed_file /etc/apt/sources.list.d/caddy-stable.list 0644 'deb [signed-by=/usr/share/keyrings/mydsh-caddy-stable.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main'
}

main() {
  local architecture
  local public_host
  local node_version
  readonly HOST_PATTERN='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'

  [[ $EUID -eq 0 ]] || fail 'run this script as root'
  [[ $# -eq 1 ]] || {
    usage
    return 64
  }
  public_host=$1
  [[ ${#public_host} -le 253 && $public_host =~ $HOST_PATTERN ]] || fail 'hostname must be one lowercase DNS name such as dsh.example.com'
  command -v dpkg >/dev/null 2>&1 || fail 'dpkg is required to verify the host architecture'
  architecture=$(dpkg --print-architecture) || fail 'cannot determine host architecture'
  [[ $architecture == amd64 ]] || fail "this deployment supports Linux amd64 only; found $architecture"
  acquire_operation_lock
  preflight_managed_paths \
    /opt/mydsh \
    /opt/mydsh/releases \
    /etc/mydsh \
    /var/lib/mydsh \
    /srv/mydsh \
    /srv/mydsh/workspace \
    /var/lib/mydsh-deploy \
    /var/lib/mydsh-deploy/uploads \
    /etc/caddy \
    /etc/systemd/system/caddy.service.d \
    /usr/share/keyrings \
    /etc/apt/sources.list.d \
    /usr/local/sbin
  if [[ -e /opt/mydsh/current || -L /opt/mydsh/current ]]; then
    validate_system_account mydsh /var/lib/mydsh
    active_bootstrap_matches "$public_host" || fail 'active host differs from bootstrap assets; use the separate reviewed control-plane maintenance procedure'
    printf 'Active host already matches reviewed bootstrap assets; no changes applied.\n'
    return 0
  fi
  TEMP_DIR=$(mktemp -d /tmp/mydsh-bootstrap.XXXXXX) || fail 'cannot create bootstrap temporary directory'
  [[ -n "$TEMP_DIR" && "$TEMP_DIR" == /tmp/mydsh-bootstrap.* && $(realpath -e -- "$TEMP_DIR") == "$TEMP_DIR" ]] || fail 'unsafe bootstrap temporary directory'
  trap cleanup EXIT

  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y apt-transport-https ca-certificates curl debian-archive-keyring debian-keyring gnupg gzip iproute2 openssl python3 tar
  create_accounts_and_directories
  configure_package_repositories
  install_managed_file "$SCRIPT_DIR/Caddyfile" /etc/caddy/Caddyfile 0644
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get -o Dpkg::Options::=--force-confold install -y nodejs caddy
  node_version=$(node --version)
  [[ $node_version =~ ^v24\. ]] || fail "Node.js 24 is required; installed $node_version"
  write_environment_files "$public_host"
  install_managed_file "$SCRIPT_DIR/mydsh.service" /etc/systemd/system/mydsh.service 0644
  install_managed_file "$SCRIPT_DIR/caddy-mydsh.conf" /etc/systemd/system/caddy.service.d/mydsh.conf 0644
  install_managed_file "$SCRIPT_DIR/deploy-release.sh" /usr/local/sbin/mydsh-deploy-release 0755
  systemctl daemon-reload
  set -a
  # write_environment_files owns this root-controlled file.
  # shellcheck disable=SC1091
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
