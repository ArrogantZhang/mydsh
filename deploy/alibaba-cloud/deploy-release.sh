#!/usr/bin/env bash
# Managed by DeepSeek Harness Alibaba Cloud deployment
set -euo pipefail

readonly MANAGED_MARKER='# Managed by DeepSeek Harness Alibaba Cloud deployment'
readonly DEPLOY_LOCK=/run/lock/mydsh-deploy.lock
readonly RELEASES_DIR=/opt/mydsh/releases
readonly CURRENT_LINK=/opt/mydsh/current
readonly CADDY_CONFIG=/etc/caddy/Caddyfile
readonly DSH_UNIT=/etc/systemd/system/mydsh.service
readonly CADDY_DROPIN=/etc/systemd/system/caddy.service.d/mydsh.conf
readonly PUBLIC_ENV=/etc/mydsh/public.env
readonly PRIVATE_ENV=/etc/mydsh/mydsh.env
DEPLOY_LOCK_FD=''
STAGING_ROOT=''
TRUST_ROOT=''

usage() {
  printf 'Usage: sudo %s <git-bundle-file> <ref>\n' "${0##*/}" >&2
  printf '       sudo %s --rollback <full-commit>\n' "${0##*/}" >&2
}

fail() {
  printf 'mydsh-deploy-release: %s\n' "$1" >&2
  exit 1
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

cleanup_staging() {
  if [[ -n "$STAGING_ROOT" ]]; then
    case "$STAGING_ROOT" in
      /opt/mydsh/releases/.staging.*)
        rm -rf -- "$STAGING_ROOT" || return 1
        ;;
      *)
        printf 'mydsh-deploy-release: refusing unsafe staging cleanup: %s\n' "$STAGING_ROOT" >&2
        return 1
        ;;
    esac
  fi
}

cleanup_operation() {
  cleanup_staging || true
  if [[ -n "$TRUST_ROOT" ]]; then
    case "$TRUST_ROOT" in
      /run/mydsh-bundle.*) rm -rf -- "$TRUST_ROOT" || true ;;
      *) printf 'mydsh-deploy-release: refusing unsafe trust-root cleanup: %s\n' "$TRUST_ROOT" >&2 ;;
    esac
  fi
}

validate_release_target() {
  local target=$1
  local releases_root=${2:-$RELEASES_DIR}
  local resolved_root
  local resolved_target
  local commit

  [[ -d "$releases_root" && -d "$target" ]] || return 1
  resolved_root=$(realpath -e -- "$releases_root") || return 1
  resolved_target=$(realpath -e -- "$target") || return 1
  commit=${resolved_target##*/}
  [[ $commit =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ ${resolved_target%/*} == "$resolved_root" ]] || return 1
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

validate_existing_managed_file() {
  local path=$1
  local resolved
  local owner

  [[ ! -L "$path" && -f "$path" ]] || return 1
  resolved=$(realpath -e -- "$path") || return 1
  [[ $resolved == "$path" ]] || return 1
  owner=$(stat -c '%U:%G' -- "$path") || return 1
  [[ $owner == root:root ]] || return 1
  grep -Fqx "$MANAGED_MARKER" "$path" || return 1
}

install_managed_file() {
  local source=$1
  local target=$2
  local mode=$3
  local temporary

  [[ -f "$source" && ! -L "$source" ]] || return 1
  if [[ -e "$target" || -L "$target" ]]; then
    validate_existing_managed_file "$target" || return 1
  fi
  temporary=$(mktemp "$(dirname -- "$target")/.${target##*/}.XXXXXX")
  install -o root -g root -m "$mode" -- "$source" "$temporary" || return 1
  mv -f -- "$temporary" "$target" || {
    rm -f -- "$temporary" || true
    return 1
  }
}

atomic_replace_link() {
  local current_path=$1
  local target=$2
  local next_path="${current_path}.next"

  [[ -d "$target" ]] || return 1
  if [[ -e "$next_path" || -L "$next_path" ]]; then
    [[ -L "$next_path" ]] || return 1
    rm -f -- "$next_path" || return 1
  fi
  ln -s -- "$target" "$next_path" || {
    if [[ -e "$next_path" || -L "$next_path" ]]; then rm -f -- "$next_path" || return 1; fi
    return 1
  }
  mv -Tf -- "$next_path" "$current_path" || {
    rm -f -- "$next_path" || return 1
    return 1
  }
}

run_builder() {
  runuser -u mydsh-build -- env -i \
    HOME=/var/lib/mydsh-build \
    PATH=/usr/local/bin:/usr/bin:/bin \
    DSH_HOME=/var/lib/mydsh-build/dsh-home \
    "$@"
}

load_public_environment() {
  set -a
  # shellcheck disable=SC1091 -- bootstrap owns this root-controlled file.
  source "$PUBLIC_ENV"
  set +a
}

current_release() {
  local current
  if [[ ! -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]; then return 0; fi
  [[ -L "$CURRENT_LINK" ]] || return 1
  current=$(realpath -e -- "$CURRENT_LINK") || return 1
  validate_release_target "$current" || return 1
  printf '%s\n' "$current"
}

validate_host() {
  local tool
  for tool in caddy cmp curl flock getent git node pnpm realpath runuser systemctl systemd-analyze; do
    command -v "$tool" >/dev/null 2>&1 || fail "required tool is unavailable: $tool"
  done
  [[ -d "$RELEASES_DIR" && -d /srv/mydsh/workspace && -d /var/lib/mydsh && -d /var/lib/mydsh-build/dsh-home && -d /var/cache/mydsh-build/pnpm ]] || fail 'host directories are incomplete; run bootstrap-host.sh'
  validate_system_account mydsh /var/lib/mydsh
  validate_system_account mydsh-build /var/lib/mydsh-build
  [[ $(id -u mydsh) != "$(id -u mydsh-build)" && $(id -g mydsh) != "$(id -g mydsh-build)" ]] || fail 'runtime and builder identities must be distinct'
  for path in "$PUBLIC_ENV" "$PRIVATE_ENV" "$CADDY_CONFIG" "$DSH_UNIT" "$CADDY_DROPIN" /usr/local/sbin/mydsh-deploy-release; do
    validate_existing_managed_file "$path" || fail "unsafe or unmanaged host file: $path"
  done
}

validate_candidate_configs() {
  local target=$1
  local caddy_candidate="$target/deploy/alibaba-cloud/Caddyfile"
  local unit_candidate="$target/deploy/alibaba-cloud/mydsh.service"
  local dropin_candidate="$target/deploy/alibaba-cloud/caddy-mydsh.conf"
  local candidate
  local resolved
  local verify_root

  for candidate in "$caddy_candidate" "$unit_candidate" "$dropin_candidate"; do
    [[ -f "$candidate" && ! -L "$candidate" ]] || return 1
    resolved=$(realpath -e -- "$candidate") || return 1
    [[ $resolved == "$candidate" ]] || return 1
  done
  grep -Fqx "$MANAGED_MARKER" "$caddy_candidate" || return 1
  grep -Fqx "$MANAGED_MARKER" "$unit_candidate" || return 1
  grep -Fqx "$MANAGED_MARKER" "$dropin_candidate" || return 1
  caddy validate --config "$caddy_candidate" --adapter caddyfile || return 1
  verify_root=$(mktemp -d /run/mydsh-systemd-verify.XXXXXX)
  mkdir -p "$verify_root/etc/systemd/system/caddy.service.d" "$verify_root/usr/bin" "$verify_root/srv/mydsh/workspace" "$verify_root/var/lib/mydsh" "$verify_root/etc/mydsh" "$verify_root/opt/mydsh/current/apps/cli/lib"
  install -m 0644 "$unit_candidate" "$verify_root/etc/systemd/system/mydsh.service"
  install -m 0644 "$dropin_candidate" "$verify_root/etc/systemd/system/caddy.service.d/mydsh.conf"
  printf '[Service]\nExecStart=/usr/bin/caddy\n' >"$verify_root/etc/systemd/system/caddy.service"
  touch "$verify_root/usr/bin/node" "$verify_root/usr/bin/caddy" "$verify_root/opt/mydsh/current/apps/cli/lib/bin.js" "$verify_root/etc/mydsh/public.env" "$verify_root/etc/mydsh/mydsh.env"
  chmod 0755 "$verify_root/usr/bin/node" "$verify_root/usr/bin/caddy" "$verify_root/opt/mydsh/current/apps/cli/lib/bin.js"
  if ! systemd-analyze --root="$verify_root" verify --recursive-errors=no mydsh.service caddy.service; then
    rm -rf -- "$verify_root" || true
    return 1
  fi
  rm -rf -- "$verify_root" || return 1
}

host_path() {
  local root=$1
  local absolute=$2
  printf '%s%s\n' "$root" "$absolute"
}

backup_host_configs() {
  local backup=$1
  local host_root=${2:-}
  install -d -o root -g root -m 0700 "$backup"
  cp -a -- "$(host_path "$host_root" "$CADDY_CONFIG")" "$backup/Caddyfile" || return 1
  cp -a -- "$(host_path "$host_root" "$DSH_UNIT")" "$backup/mydsh.service" || return 1
  cp -a -- "$(host_path "$host_root" "$CADDY_DROPIN")" "$backup/caddy-mydsh.conf" || return 1
}

stage_candidate_configs() {
  local target=$1
  local host_root=${2:-}
  install_managed_file "$target/deploy/alibaba-cloud/Caddyfile" "$(host_path "$host_root" "$CADDY_CONFIG")" 0644 || return 1
  install_managed_file "$target/deploy/alibaba-cloud/mydsh.service" "$(host_path "$host_root" "$DSH_UNIT")" 0644 || return 1
  install_managed_file "$target/deploy/alibaba-cloud/caddy-mydsh.conf" "$(host_path "$host_root" "$CADDY_DROPIN")" 0644 || return 1
}

restore_host_configs() {
  local backup=$1
  local host_root=${2:-}
  install_managed_file "$backup/Caddyfile" "$(host_path "$host_root" "$CADDY_CONFIG")" 0644 || return 1
  install_managed_file "$backup/mydsh.service" "$(host_path "$host_root" "$DSH_UNIT")" 0644 || return 1
  install_managed_file "$backup/caddy-mydsh.conf" "$(host_path "$host_root" "$CADDY_DROPIN")" 0644 || return 1
}

health_check() {
  local target=$1
  local attempt
  local main_pid
  local owner
  local active

  for attempt in {1..30}; do
    if systemctl is-active --quiet mydsh; then
      main_pid=$(systemctl show --property MainPID --value mydsh) || main_pid=0
      if [[ $main_pid =~ ^[1-9][0-9]*$ && -d "/proc/$main_pid" ]]; then
        owner=$(stat -c %U "/proc/$main_pid") || owner=''
        active=$(realpath -e -- "$CURRENT_LINK") || active=''
        if [[ $owner == mydsh && $active == "$target" ]] && curl --fail --silent --show-error --output /dev/null --max-time 2 http://127.0.0.1:3080/__invite/login; then
          return 0
        fi
      fi
    fi
    sleep 1
  done
  return 1
}

public_acceptance() {
  local base="https://$DSH_PUBLIC_HOST"
  local resolve="$DSH_PUBLIC_HOST:443:127.0.0.1"
  local html_status
  local api_status
  html_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10 --resolve "$resolve" --header 'Accept: text/html' "$base/") || return 1
  [[ $html_status == 303 ]] || return 1
  api_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10 --resolve "$resolve" "$base/api/events.mux") || return 1
  [[ $api_status == 401 ]] || return 1
}

authenticated_acceptance() (
  local cookie_jar
  local base="https://$DSH_PUBLIC_HOST"
  local resolve="$DSH_PUBLIC_HOST:443:127.0.0.1"
  local post_status
  local get_status

  # shellcheck disable=SC1090 -- bootstrap owns this root-controlled file.
  source "$PRIVATE_ENV"
  cookie_jar=$(mktemp /run/mydsh-cookie.XXXXXX)
  trap 'rm -f -- "$cookie_jar"' EXIT
  if ! post_status=$(printf 'inviteCode=%s' "$DSH_INVITE_CODE_SECRET" | curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10 --resolve "$resolve" --cookie-jar "$cookie_jar" --header "Origin: $base" --header 'Content-Type: application/x-www-form-urlencoded' --data-binary @- "$base/__invite/login"); then
    return 1
  fi
  [[ $post_status == 303 ]] || return 1
  get_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10 --resolve "$resolve" --cookie "$cookie_jar" "$base/") || get_status=000
  [[ $get_status == 200 ]]
)

remove_first_link() {
  local target=$1
  local current_path=${2:-$CURRENT_LINK}
  local active
  if [[ -L "$current_path" ]]; then
    active=$(realpath -e -- "$current_path") || return 1
    [[ $active == "$target" ]] || return 1
    rm -f -- "$current_path" || return 1
  elif [[ -e "$current_path" ]]; then
    return 1
  fi
}

restore_failed_activation() {
  local previous=$1
  local target=$2
  local backup=$3
  local host_root=${4:-}
  local current_path=${5:-$CURRENT_LINK}
  local restored=0
  local installed_caddy

  installed_caddy=$(host_path "$host_root" "$CADDY_CONFIG")

  if restore_host_configs "$backup" "$host_root" && systemctl daemon-reload; then
    if [[ -n "$previous" ]]; then
      if atomic_replace_link "$current_path" "$previous" && systemctl restart mydsh && health_check "$previous"; then restored=1; fi
    else
      if remove_first_link "$target" "$current_path" && systemctl stop mydsh; then restored=1; fi
    fi
    if caddy validate --config "$installed_caddy" --adapter caddyfile && systemctl reload caddy; then :; else restored=0; fi
  fi
  [[ $restored == 1 ]]
}

activate_transaction() {
  local target=$1
  local previous=$2
  local host_root=${3:-}
  local current_path=${4:-$CURRENT_LINK}
  local backup_parent=${5:-/run}
  local backup
  local installed_caddy

  validate_candidate_configs "$target" || return 1
  installed_caddy=$(host_path "$host_root" "$CADDY_CONFIG")
  backup=$(mktemp -d "$backup_parent/mydsh-activation.XXXXXX")
  backup_host_configs "$backup" "$host_root" || { rm -rf -- "$backup" || true; return 1; }
  if stage_candidate_configs "$target" "$host_root" && systemctl daemon-reload; then
    if atomic_replace_link "$current_path" "$target" && systemctl restart mydsh; then
      if health_check "$target"; then
        if caddy validate --config "$installed_caddy" --adapter caddyfile && systemctl reload caddy; then
          if public_acceptance && authenticated_acceptance && systemctl enable mydsh; then
            rm -rf -- "$backup" || return 1
            return 0
          fi
        fi
      fi
    fi
  fi
  restore_failed_activation "$previous" "$target" "$backup" "$host_root" "$current_path" || true
  rm -rf -- "$backup" || true
  return 1
}

rollback_to_commit() {
  local commit=$1
  local previous
  local target
  [[ $commit =~ ^[0-9a-f]{40}$ ]] || fail 'rollback commit must be 40 lowercase hexadecimal characters'
  target="$RELEASES_DIR/$commit"
  validate_release_target "$target" || fail 'rollback target is outside the canonical release directory'
  previous=$(current_release) || fail 'current release link is unsafe'
  load_public_environment
  activate_transaction "$target" "$previous" || return 1
  printf 'Rolled back to release %s after public and authenticated acceptance.\n' "$commit"
}

deploy_bundle() {
  local bundle_path
  local ref=$2
  local checkout
  local clone_ref
  local commit
  local previous
  local staged_bundle
  local target
  local trusted_bundle
  local trusted_commit
  local trusted_repository
  local verify_repository
  local candidate_path

  bundle_path=$(realpath -e -- "$1") || fail 'bundle path does not exist'
  [[ -f "$bundle_path" && -r "$bundle_path" ]] || fail 'bundle must be a readable regular file'
  git check-ref-format --branch "$ref" >/dev/null || git check-ref-format "$ref" >/dev/null || fail 'invalid deployment ref'
  clone_ref=${ref#refs/heads/}
  clone_ref=${clone_ref#refs/tags/}
  TRUST_ROOT=$(mktemp -d /run/mydsh-bundle.XXXXXX)
  trap cleanup_operation EXIT
  trusted_bundle="$TRUST_ROOT/release.bundle"
  trusted_repository="$TRUST_ROOT/repository.git"
  install -o root -g root -m 0400 -- "$bundle_path" "$trusted_bundle"
  git init --bare --quiet "$trusted_repository"
  git -C "$trusted_repository" bundle verify "$trusted_bundle"
  git -C "$trusted_repository" fetch --quiet "$trusted_bundle" "$ref"
  trusted_commit=$(git -C "$trusted_repository" rev-parse 'FETCH_HEAD^{commit}') || fail 'cannot resolve the trusted bundle ref'
  STAGING_ROOT=$(mktemp -d /opt/mydsh/releases/.staging.XXXXXX)
  chown mydsh-build:mydsh-build "$STAGING_ROOT"
  chmod 0700 "$STAGING_ROOT"
  verify_repository="$STAGING_ROOT/verify.git"
  checkout="$STAGING_ROOT/release"
  staged_bundle="$STAGING_ROOT/release.bundle"
  install -o mydsh-build -g mydsh-build -m 0400 -- "$trusted_bundle" "$staged_bundle"
  install -d -o mydsh-build -g mydsh-build -m 0700 "$verify_repository"
  run_builder git -C "$verify_repository" init --bare --quiet
  run_builder git -C "$verify_repository" bundle verify "$staged_bundle"
  run_builder git clone --branch "$clone_ref" --single-branch "$staged_bundle" "$checkout"
  commit=$(run_builder git -C "$checkout" rev-parse HEAD) || fail 'cannot resolve candidate commit'
  [[ $commit =~ ^[0-9a-f]{40}$ && $commit == "$trusted_commit" ]] || fail 'candidate commit does not match the trusted bundle ref'
  target="$RELEASES_DIR/$commit"
  [[ ! -e "$target" && ! -L "$target" ]] || fail "release already exists: $commit"
  run_builder pnpm --dir "$checkout" install --frozen-lockfile --store-dir /var/cache/mydsh-build/pnpm
  run_builder pnpm --dir "$checkout" exec vitest run packages/host/invite-auth/tests
  run_builder pnpm --dir "$checkout" run build
  run_builder /usr/bin/node "$checkout/apps/cli/lib/bin.js" web --patch "$checkout/deploy/alibaba-cloud/invite-auth.cordis.yml" --dump-config >/dev/null
  for candidate_path in Caddyfile mydsh.service caddy-mydsh.conf invite-auth.cordis.yml; do
    git -C "$trusted_repository" show "$trusted_commit:deploy/alibaba-cloud/$candidate_path" >"$TRUST_ROOT/$candidate_path"
    cmp -- "$TRUST_ROOT/$candidate_path" "$checkout/deploy/alibaba-cloud/$candidate_path" || fail "builder modified deployment asset: $candidate_path"
  done
  chown -R root:root "$checkout"
  chmod -R go-w "$checkout"
  mv -- "$checkout" "$target"
  cleanup_staging
  STAGING_ROOT=''
  rm -rf -- "$TRUST_ROOT"
  TRUST_ROOT=''
  validate_release_target "$target" || fail 'published release failed canonical validation'
  previous=$(current_release) || fail 'current release link is unsafe'
  load_public_environment
  activate_transaction "$target" "$previous" || return 1
  printf 'Deployed release %s after public and authenticated acceptance.\n' "$commit"
}

main() {
  [[ $EUID -eq 0 ]] || fail 'run this script as root'
  [[ $# -eq 2 ]] || { usage; return 64; }
  [[ $(realpath -e -- "$0") == /usr/local/sbin/mydsh-deploy-release ]] || fail 'run the root-installed deployment helper'
  acquire_operation_lock
  validate_host
  if [[ $1 == --rollback ]]; then rollback_to_commit "$2"; else deploy_bundle "$1" "$2"; fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
