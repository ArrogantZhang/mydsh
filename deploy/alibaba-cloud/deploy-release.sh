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
readonly ROOT_HELPER=/usr/local/sbin/mydsh-deploy-release
readonly DEPLOY_STATE_ROOT=/var/lib/mydsh-deploy
readonly ACTIVATION_DIR=/var/lib/mydsh-deploy/activation
DEPLOY_LOCK_FD=''
TRUST_ROOT=''
CREATED_TEMP_FILE=''
REGISTERED_TEMP_FILES=()
OPERATION_ROOT=''
PUBLISH_ROOT=''

usage() {
  printf 'Usage: sudo %s <git-bundle-file> <ref>\n' "${0##*/}" >&2
  printf '       sudo %s --rollback <40-character-lowercase-commit>\n' "${0##*/}" >&2
  printf '       sudo %s --prune <40-character-lowercase-commit>\n' "${0##*/}" >&2
}

fail() {
  printf 'mydsh-deploy-release: %s\n' "$1" >&2
  exit 1
}

trusted_git() {
  env -i PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git "$@"
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

cleanup_operation() {
  cleanup_registered_temp_files
  if [[ -n "$TRUST_ROOT" ]]; then
    case "$TRUST_ROOT" in
      /run/mydsh-bundle.*) rm -rf -- "$TRUST_ROOT" || true ;;
      *) printf 'mydsh-deploy-release: refusing unsafe trust-root cleanup: %s\n' "$TRUST_ROOT" >&2 ;;
    esac
  fi
  if [[ -n "$OPERATION_ROOT" && "$OPERATION_ROOT" == "$RELEASES_DIR/.build."* ]]; then rm -rf -- "$OPERATION_ROOT" || true; fi
  if [[ -n "$PUBLISH_ROOT" && "$PUBLISH_ROOT" == /opt/mydsh/releases/.publish.* ]]; then rm -rf -- "$PUBLISH_ROOT" || true; fi
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
    if (umask 077; set -o noclobber; : >"$candidate") 2>/dev/null; then CREATED_TEMP_FILE=$candidate; return 0; fi
    unregister_temp_file "$candidate"
  done
  CREATED_TEMP_FILE=''
  return 1
}

validate_release_target() {
  local target=$1
  local releases_root=${2:-$RELEASES_DIR}
  local resolved_root
  local resolved_target
  local commit

  [[ -d "$releases_root" && ! -L "$releases_root" && -d "$target" && ! -L "$target" ]] || return 1
  resolved_root=$(realpath -e -- "$releases_root") || return 1
  resolved_target=$(realpath -e -- "$target") || return 1
  commit=${target##*/}
  [[ $commit =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ $resolved_root == "$releases_root" ]] || return 1
  [[ $target == "$releases_root/$commit" && $resolved_target == "$target" ]] || return 1
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

require_host_tools() {
  local tool
  for tool in bash caddy cmp cp curl flock getent git install node pnpm realpath sed stat sync systemctl systemd-analyze systemd-run; do
    command -v "$tool" >/dev/null 2>&1 || fail "required tool is unavailable: $tool"
  done
}

validate_host_directory() {
  local path=$1
  local expected_owner=$2
  local expected_mode=$3
  local owner
  local mode
  local resolved
  [[ -d "$path" && ! -L "$path" ]] || fail "host directory must be a real directory: $path"
  resolved=$(realpath -e -- "$path") || fail "cannot resolve host directory: $path"
  owner=$(stat -c '%U:%G' -- "$path") || fail "cannot read host directory ownership: $path"
  mode=$(stat -c '%a' -- "$path") || fail "cannot read host directory mode: $path"
  [[ $resolved == "$path" && $owner == "$expected_owner" && $mode == "$expected_mode" ]] || fail "host directory ownership or mode is unsafe: $path"
}

validate_recovery_prerequisites() {
  require_host_tools
  validate_host_directory /var/lib root:root 755
  validate_host_directory "$DEPLOY_STATE_ROOT" root:root 700
  validate_host_directory /etc/mydsh root:root 755
  validate_existing_managed_file "$PUBLIC_ENV" || fail "unsafe or unmanaged host file: $PUBLIC_ENV"
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
  create_registered_temp_file "$(dirname -- "$target")" || return 1
  temporary=$CREATED_TEMP_FILE
  install -o root -g root -m "$mode" -- "$source" "$temporary" || { discard_registered_temp_file "$temporary" || true; return 1; }
  mv -f -- "$temporary" "$target" || {
    discard_registered_temp_file "$temporary" || true
    return 1
  }
  unregister_temp_file "$temporary"
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
  local operation_root=$1
  local bundle=$2
  local ref=$3
  local expected_commit=$4
  local checkout=$5
  local unit="mydsh-build-$$"
  systemd-run --wait --collect --pipe \
    --unit="$unit" \
    --uid=mydsh-build --gid=mydsh-build \
    --property=Type=exec --property=KillMode=control-group --property=PrivateTmp=yes --property=TimeoutStopSec=30s \
    /usr/bin/env -i \
    HOME="$operation_root/home" \
    TMPDIR="$operation_root/tmp" \
    XDG_CONFIG_HOME="$operation_root/xdg-config" \
    XDG_CACHE_HOME="$operation_root/xdg-cache" \
    XDG_RUNTIME_DIR="$operation_root/xdg-runtime" \
    NPM_CONFIG_USERCONFIG=/dev/null \
    NPM_CONFIG_GLOBALCONFIG=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    PATH=/usr/local/bin:/usr/bin:/bin \
    DSH_HOME="$operation_root/dsh-home" \
    /usr/local/sbin/mydsh-deploy-release --internal-build "$bundle" "$ref" "$expected_commit" "$checkout" "$operation_root/cache" "$operation_root/result.commit" || return 1
  if systemctl is-active --quiet "$unit"; then return 1; fi
}

write_builder_commit_marker() {
  local checkout=$1
  local expected_commit=$2
  local marker=$3
  local commit
  local temporary="${marker}.new"
  commit=$(git -C "$checkout" rev-parse HEAD) || return 1
  [[ $commit =~ ^[0-9a-f]{40}$ && $commit == "$expected_commit" ]] || return 1
  [[ ! -e "$marker" && ! -L "$marker" && ! -e "$temporary" && ! -L "$temporary" ]] || return 1
  printf '%s\n' "$commit" >"$temporary" || return 1
  mv -- "$temporary" "$marker" || { rm -f -- "$temporary" || true; return 1; }
}

read_builder_commit_marker() {
  local marker=$1
  local expected_commit=$2
  local commit
  local resolved
  local line_count
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  resolved=$(realpath -e -- "$marker") || return 1
  [[ $resolved == "$marker" ]] || return 1
  line_count=$(wc -l <"$marker") || return 1
  [[ $line_count == 1 ]] || return 1
  commit=$(<"$marker") || return 1
  [[ $commit =~ ^[0-9a-f]{40}$ && $commit == "$expected_commit" ]] || return 1
  printf '%s\n' "$commit"
}

internal_build() {
  local bundle=$1
  local ref=$2
  local expected_commit=$3
  local checkout=$4
  local cache=$5
  local marker=$6
  git clone --branch "$ref" --single-branch "$bundle" "$checkout"
  write_builder_commit_marker "$checkout" "$expected_commit" "$marker"
  pnpm --dir "$checkout" install --frozen-lockfile --store-dir "$cache"
  pnpm --dir "$checkout" exec vitest run packages/host/invite-auth/tests
  pnpm --dir "$checkout" run build
  /usr/bin/node "$checkout/apps/cli/lib/bin.js" web --patch "$checkout/deploy/alibaba-cloud/invite-auth.cordis.yml" --dump-config >/dev/null
}

load_public_environment() {
  set -a
  # Bootstrap owns this root-controlled file.
  # shellcheck disable=SC1090
  source "$PUBLIC_ENV"
  set +a
}

current_release() {
  local current_path=${1:-$CURRENT_LINK}
  local releases_root=${2:-$RELEASES_DIR}
  local current
  if [[ ! -e "$current_path" && ! -L "$current_path" ]]; then return 0; fi
  [[ -L "$current_path" ]] || return 1
  current=$(realpath -e -- "$current_path") || return 1
  validate_release_target "$current" "$releases_root" || return 1
  printf '%s\n' "$current"
}

validate_host() {
  require_host_tools
  validate_host_directory /opt/mydsh root:root 755
  validate_host_directory "$RELEASES_DIR" root:root 755
  validate_host_directory /srv/mydsh root:root 755
  validate_host_directory /srv/mydsh/workspace mydsh:mydsh 750
  validate_host_directory /var/lib/mydsh mydsh:mydsh 700
  validate_host_directory "$DEPLOY_STATE_ROOT" root:root 700
  validate_host_directory /etc/mydsh root:root 755
  validate_system_account mydsh /var/lib/mydsh
  validate_system_account mydsh-build /nonexistent
  [[ $(id -u mydsh) != "$(id -u mydsh-build)" && $(id -g mydsh) != "$(id -g mydsh-build)" ]] || fail 'runtime and builder identities must be distinct'
  for path in "$PUBLIC_ENV" "$PRIVATE_ENV" "$CADDY_CONFIG" "$DSH_UNIT" "$CADDY_DROPIN" "$ROOT_HELPER"; do
    validate_existing_managed_file "$path" || fail "unsafe or unmanaged host file: $path"
  done
}

validate_candidate_configs() {
  local asset_root=$1
  local caddy_candidate="$asset_root/Caddyfile"
  local unit_candidate="$asset_root/mydsh.service"
  local dropin_candidate="$asset_root/caddy-mydsh.conf"
  local helper_candidate="$asset_root/deploy-release.sh"
  local candidate
  local resolved
  local verify_root

  for candidate in "$caddy_candidate" "$unit_candidate" "$dropin_candidate" "$helper_candidate"; do
    [[ -f "$candidate" && ! -L "$candidate" ]] || return 1
    resolved=$(realpath -e -- "$candidate") || return 1
    [[ $resolved == "$candidate" ]] || return 1
  done
  grep -Fqx "$MANAGED_MARKER" "$caddy_candidate" || return 1
  grep -Fqx "$MANAGED_MARKER" "$unit_candidate" || return 1
  grep -Fqx "$MANAGED_MARKER" "$dropin_candidate" || return 1
  grep -Fqx "$MANAGED_MARKER" "$helper_candidate" || return 1
  bash -n "$helper_candidate" || return 1
  caddy validate --config "$caddy_candidate" --adapter caddyfile || return 1
  verify_root=$(mktemp -d /run/mydsh-systemd-verify.XXXXXX) || return 1
  validate_temp_directory "$verify_root" /run mydsh-systemd-verify. || return 1
  mkdir -p "$verify_root/etc/systemd/system/caddy.service.d" "$verify_root/usr/bin" "$verify_root/srv/mydsh/workspace" "$verify_root/var/lib/mydsh" "$verify_root/etc/mydsh" "$verify_root/opt/mydsh/current/apps/cli/lib" || { rm -rf -- "$verify_root" || true; return 1; }
  install -m 0644 "$unit_candidate" "$verify_root/etc/systemd/system/mydsh.service" || { rm -rf -- "$verify_root" || true; return 1; }
  install -m 0644 "$dropin_candidate" "$verify_root/etc/systemd/system/caddy.service.d/mydsh.conf" || { rm -rf -- "$verify_root" || true; return 1; }
  printf '[Service]\nExecStart=/usr/bin/caddy\n' >"$verify_root/etc/systemd/system/caddy.service" || { rm -rf -- "$verify_root" || true; return 1; }
  touch "$verify_root/usr/bin/node" "$verify_root/usr/bin/caddy" "$verify_root/opt/mydsh/current/apps/cli/lib/bin.js" "$verify_root/etc/mydsh/public.env" "$verify_root/etc/mydsh/mydsh.env" || { rm -rf -- "$verify_root" || true; return 1; }
  chmod 0755 "$verify_root/usr/bin/node" "$verify_root/usr/bin/caddy" "$verify_root/opt/mydsh/current/apps/cli/lib/bin.js" || { rm -rf -- "$verify_root" || true; return 1; }
  if ! systemd-analyze --root="$verify_root" verify --recursive-errors=no mydsh.service caddy.service; then
    rm -rf -- "$verify_root" || true
    return 1
  fi
  rm -rf -- "$verify_root" || return 1
}

validate_temp_directory() {
  local path=$1
  local parent=$2
  local prefix=$3
  [[ -n "$path" && "$path" == "$parent/$prefix"* && -d "$path" && ! -L "$path" ]] || return 1
  [[ $(realpath -e -- "$path") == "$path" ]] || return 1
}

publish_builder_checkout() {
  local checkout=$1
  local target=$2
  local releases_root=${3:-$RELEASES_DIR}
  local publish_root
  [[ -d "$checkout" && ! -L "$checkout" && $(realpath -e -- "$checkout") == "$checkout" ]] || return 1
  [[ ! -e "$target" && ! -L "$target" && ${target%/*} == "$releases_root" ]] || return 1
  publish_root=$(mktemp -d "$releases_root/.publish.XXXXXX") || return 1
  validate_temp_directory "$publish_root" "$releases_root" .publish. || return 1
  PUBLISH_ROOT=$publish_root
  cp -a --reflink=never "$checkout/." "$publish_root/" || { rm -rf -- "$publish_root" || true; return 1; }
  [[ $(stat -c %i "$checkout/package.json") != "$(stat -c %i "$publish_root/package.json")" ]] || { rm -rf -- "$publish_root" || true; return 1; }
  chown -R root:root "$publish_root" || { rm -rf -- "$publish_root" || true; return 1; }
  chmod 0755 "$publish_root" || { rm -rf -- "$publish_root" || true; return 1; }
  chmod -R go-w "$publish_root" || { rm -rf -- "$publish_root" || true; return 1; }
  mv -- "$publish_root" "$target" || { rm -rf -- "$publish_root" || true; return 1; }
  PUBLISH_ROOT=''
  if ! validate_release_target "$target" "$releases_root"; then remove_new_publication "$target" "$releases_root" || true; return 1; fi
}

remove_new_publication() {
  local target=$1
  local releases_root=${2:-$RELEASES_DIR}
  local commit=${target##*/}
  [[ -d "$releases_root" && ! -L "$releases_root" ]] || return 1
  [[ $(realpath -e -- "$releases_root") == "$releases_root" ]] || return 1
  [[ $commit =~ ^[0-9a-f]{40}$ && $target == "$releases_root/$commit" ]] || return 1
  if [[ -e "$target" || -L "$target" ]]; then rm -rf -- "$target" || return 1; fi
}

install_trusted_release_assets() {
  local target=$1
  local asset_root=$2
  local releases_root=${3:-$RELEASES_DIR}
  local name
  local trusted_dir="$target/.mydsh-trusted-deploy"
  validate_release_target "$target" "$releases_root" || return 1
  if [[ -e "$trusted_dir" || -L "$trusted_dir" ]]; then remove_new_publication "$target" "$releases_root" || true; return 1; fi
  install -d -o root -g root -m 0700 "$trusted_dir" || { remove_new_publication "$target" "$releases_root" || true; return 1; }
  [[ -d "$trusted_dir" && ! -L "$trusted_dir" && $(realpath -e -- "$trusted_dir") == "$trusted_dir" ]] || { remove_new_publication "$target" "$releases_root" || true; return 1; }
  for name in Caddyfile mydsh.service caddy-mydsh.conf invite-auth.cordis.yml deploy-release.sh; do
    copy_durable_file "$asset_root/$name" "$trusted_dir/$name" || { remove_new_publication "$target" "$releases_root" || true; return 1; }
  done
  chown -R root:root "$trusted_dir" || { remove_new_publication "$target" "$releases_root" || true; return 1; }
  chmod -R go-rwx "$trusted_dir" || { remove_new_publication "$target" "$releases_root" || true; return 1; }
  sync -f "$trusted_dir" "$target" "$releases_root" || { remove_new_publication "$target" "$releases_root" || true; return 1; }
}

host_path() {
  local root=$1
  local absolute=$2
  printf '%s%s\n' "$root" "$absolute"
}

backup_host_configs() {
  local backup=$1
  local host_root=${2:-}
  install -d -o root -g root -m 0700 "$backup" || return 1
  copy_durable_file "$(host_path "$host_root" "$CADDY_CONFIG")" "$backup/Caddyfile" || return 1
  copy_durable_file "$(host_path "$host_root" "$DSH_UNIT")" "$backup/mydsh.service" || return 1
  copy_durable_file "$(host_path "$host_root" "$CADDY_DROPIN")" "$backup/caddy-mydsh.conf" || return 1
  copy_durable_file "$(host_path "$host_root" "$ROOT_HELPER")" "$backup/root-helper" || return 1
  sync -f "$backup" || return 1
}

copy_durable_file() {
  local source=$1
  local target=$2
  [[ -f "$source" && ! -L "$source" ]] || return 1
  cp -a --reflink=never -- "$source" "$target" || return 1
  [[ -f "$target" && ! -L "$target" ]] || return 1
  sync -f "$target" || return 1
}

write_journal_value() {
  local journal=$1
  local name=$2
  local value=$3
  local temporary
  [[ $name == previous || $name == target || $name == service-enabled ]] || return 1
  create_registered_temp_file "$journal" || return 1
  temporary=$CREATED_TEMP_FILE
  printf '%s\n' "$value" >"$temporary" || { discard_registered_temp_file "$temporary" || true; return 1; }
  sync -f "$temporary" || { discard_registered_temp_file "$temporary" || true; return 1; }
  mv -f -- "$temporary" "$journal/$name" || { discard_registered_temp_file "$temporary" || true; return 1; }
  unregister_temp_file "$temporary"
  sync -f "$journal" || return 1
}

write_journal_state() {
  local journal=$1
  local state=$2
  local temporary
  if [[ $state == committed ]]; then grep -Fqx 'state=prepared' "$journal/state" || return 1; fi
  create_registered_temp_file "$journal" || return 1
  temporary=$CREATED_TEMP_FILE
  printf 'state=%s\n' "$state" >"$temporary" || { discard_registered_temp_file "$temporary" || true; return 1; }
  sync -f "$temporary" || { discard_registered_temp_file "$temporary" || true; return 1; }
  mv -f -- "$temporary" "$journal/state" || { discard_registered_temp_file "$temporary" || true; return 1; }
  unregister_temp_file "$temporary"
  if ! sync -f "$journal"; then
    if [[ $state == committed ]]; then restore_prepared_journal_state "$journal" || return 2; fi
    return 1
  fi
}

restore_prepared_journal_state() {
  local journal=$1
  local temporary
  create_registered_temp_file "$journal" || return 1
  temporary=$CREATED_TEMP_FILE
  printf 'state=prepared\n' >"$temporary" || { discard_registered_temp_file "$temporary" || true; return 1; }
  sync -f "$temporary" || { discard_registered_temp_file "$temporary" || true; return 1; }
  mv -f -- "$temporary" "$journal/state" || { discard_registered_temp_file "$temporary" || true; return 1; }
  unregister_temp_file "$temporary"
  sync -f "$journal" || return 1
}

discard_journal_staging() {
  local staging=$1
  local parent=$2
  validate_temp_directory "$staging" "$parent" activation.new. || return 1
  rm -rf -- "$staging" || return 1
}

cleanup_abandoned_journal_staging() (
  local parent=$1
  local staging
  [[ -d "$parent" && ! -L "$parent" && $(realpath -e -- "$parent") == "$parent" ]] || return 1
  shopt -s nullglob
  for staging in "$parent"/activation.new.*; do
    if validate_temp_directory "$staging" "$parent" activation.new.; then
      if ! rm -rf -- "$staging"; then
        printf 'mydsh-deploy-release: abandoned journal staging retained for inspection at %s\n' "$staging" >&2
      fi
    else
      printf 'mydsh-deploy-release: unsafe journal staging retained for inspection at %s\n' "$staging" >&2
    fi
  done
  return 0
)

prepare_activation_journal() {
  local journal=$1
  local target=$2
  local previous=$3
  local asset_root=$4
  local host_root=${5:-}
  local previous_enabled=$6
  local parent
  local staging
  [[ $previous_enabled == enabled || $previous_enabled == disabled ]] || return 1
  parent=$(dirname -- "$journal") || return 1
  [[ $journal == "$parent/activation" && -d "$parent" && ! -L "$parent" && $(realpath -e -- "$parent") == "$parent" ]] || return 1
  [[ ! -e "$journal" && ! -L "$journal" ]] || return 1
  staging=$(mktemp -d "$parent/activation.new.XXXXXX") || return 1
  validate_temp_directory "$staging" "$parent" activation.new. || return 1
  chmod 0700 "$staging" || { discard_journal_staging "$staging" "$parent" || true; return 1; }
  backup_host_configs "$staging/backup" "$host_root" || { discard_journal_staging "$staging" "$parent" || true; return 1; }
  install -d -o root -g root -m 0700 "$staging/candidate" || { discard_journal_staging "$staging" "$parent" || true; return 1; }
  copy_durable_file "$asset_root/Caddyfile" "$staging/candidate/Caddyfile" || { discard_journal_staging "$staging" "$parent" || true; return 1; }
  copy_durable_file "$asset_root/mydsh.service" "$staging/candidate/mydsh.service" || { discard_journal_staging "$staging" "$parent" || true; return 1; }
  copy_durable_file "$asset_root/caddy-mydsh.conf" "$staging/candidate/caddy-mydsh.conf" || { discard_journal_staging "$staging" "$parent" || true; return 1; }
  copy_durable_file "$asset_root/deploy-release.sh" "$staging/candidate/deploy-release.sh" || { discard_journal_staging "$staging" "$parent" || true; return 1; }
  sync -f "$staging/candidate" || { discard_journal_staging "$staging" "$parent" || true; return 1; }
  write_journal_value "$staging" previous "${previous:-none}" || { discard_journal_staging "$staging" "$parent" || true; return 1; }
  write_journal_value "$staging" target "$target" || { discard_journal_staging "$staging" "$parent" || true; return 1; }
  write_journal_value "$staging" service-enabled "$previous_enabled" || { discard_journal_staging "$staging" "$parent" || true; return 1; }
  write_journal_state "$staging" prepared || { discard_journal_staging "$staging" "$parent" || true; return 1; }
  sync -f "$staging" || { discard_journal_staging "$staging" "$parent" || true; return 1; }
  mv -T -- "$staging" "$journal" || { discard_journal_staging "$staging" "$parent" || true; return 1; }
  if ! sync -f "$parent"; then
    if mv -T -- "$journal" "$staging"; then discard_journal_staging "$staging" "$parent" || true; fi
    return 1
  fi
}

remove_activation_journal() {
  local journal=$1
  local parent
  parent=$(dirname -- "$journal")
  [[ $journal == "$parent/activation" && -d "$journal" && ! -L "$journal" ]] || return 1
  rm -rf -- "$journal" || return 1
}

recover_activation_journal() {
  local journal=${1:-$ACTIVATION_DIR}
  local host_root=${2:-}
  local current_path=${3:-$CURRENT_LINK}
  local state
  local previous
  local previous_enabled
  local target
  local installed_caddy
  [[ ! -e "$journal" && ! -L "$journal" ]] && return 0
  [[ -d "$journal" && ! -L "$journal" ]] || return 1
  state=$(sed -n 's/^state=//p' "$journal/state") || return 1
  if [[ $state == committed ]]; then
    remove_activation_journal "$journal" || return 1
    return 0
  fi
  [[ $state == prepared ]] || return 1
  previous=$(<"$journal/previous") || return 1
  target=$(<"$journal/target") || return 1
  previous_enabled=$(<"$journal/service-enabled") || return 1
  [[ $previous_enabled == enabled || $previous_enabled == disabled ]] || return 1
  installed_caddy=$(host_path "$host_root" "$CADDY_CONFIG") || return 1
  if ! restore_host_configs "$journal/backup" "$host_root" || ! systemctl daemon-reload; then
    printf 'mydsh-deploy-release: recovery failed; journal retained at %s\n' "$journal" >&2
    return 1
  fi
  if [[ $previous == none ]]; then
    remove_first_link "$target" "$current_path" || return 1
    systemctl stop mydsh || return 1
  else
    atomic_replace_link "$current_path" "$previous" || return 1
    systemctl restart mydsh || return 1
    health_check "$previous" || return 1
  fi
  restore_service_enable_state "$previous_enabled" || return 1
  caddy validate --config "$installed_caddy" --adapter caddyfile || return 1
  systemctl reload caddy || return 1
  remove_activation_journal "$journal" || return 1
}

service_enable_state() {
  local state
  if state=$(systemctl is-enabled mydsh 2>/dev/null); then
    [[ $state == enabled ]] || return 1
    printf 'enabled\n'
  else
    [[ $state == disabled ]] || return 1
    printf 'disabled\n'
  fi
}

restore_service_enable_state() {
  local state=$1
  if [[ $state == enabled ]]; then
    systemctl enable mydsh || return 1
  elif [[ $state == disabled ]]; then
    systemctl disable mydsh || return 1
  else
    return 1
  fi
}

stage_candidate_configs() {
  local asset_root=$1
  local host_root=${2:-}
  install_managed_file "$asset_root/Caddyfile" "$(host_path "$host_root" "$CADDY_CONFIG")" 0644 || return 1
  install_managed_file "$asset_root/mydsh.service" "$(host_path "$host_root" "$DSH_UNIT")" 0644 || return 1
  install_managed_file "$asset_root/caddy-mydsh.conf" "$(host_path "$host_root" "$CADDY_DROPIN")" 0644 || return 1
  install_managed_file "$asset_root/deploy-release.sh" "$(host_path "$host_root" "$ROOT_HELPER")" 0755 || return 1
}

restore_host_configs() {
  local backup=$1
  local host_root=${2:-}
  install_managed_file "$backup/Caddyfile" "$(host_path "$host_root" "$CADDY_CONFIG")" 0644 || return 1
  install_managed_file "$backup/mydsh.service" "$(host_path "$host_root" "$DSH_UNIT")" 0644 || return 1
  install_managed_file "$backup/caddy-mydsh.conf" "$(host_path "$host_root" "$CADDY_DROPIN")" 0644 || return 1
  install_managed_file "$backup/root-helper" "$(host_path "$host_root" "$ROOT_HELPER")" 0755 || return 1
}

health_check() {
  local target=$1
  local _attempt
  local main_pid
  local owner
  local active

  for _attempt in {1..30}; do
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
    sleep 1 || return 1
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

  # Bootstrap owns this dynamically selected root-controlled file.
  # shellcheck disable=SC1090
  source "$PRIVATE_ENV" || return 1
  cookie_jar=$(mktemp /run/mydsh-cookie.XXXXXX) || return 1
  [[ -n "$cookie_jar" && "$cookie_jar" == /run/mydsh-cookie.* && -f "$cookie_jar" && ! -L "$cookie_jar" ]] || return 1
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

activate_transaction() {
  local target=$1
  local previous=$2
  local asset_root=$3
  local host_root=${4:-}
  local current_path=${5:-$CURRENT_LINK}
  local journal=${6:-$ACTIVATION_DIR}
  local installed_caddy
  local previous_enabled

  validate_candidate_configs "$asset_root" || return 1
  installed_caddy=$(host_path "$host_root" "$CADDY_CONFIG") || return 1
  previous_enabled=$(service_enable_state) || return 1
  prepare_activation_journal "$journal" "$target" "$previous" "$asset_root" "$host_root" "$previous_enabled" || return 1
  if stage_candidate_configs "$journal/candidate" "$host_root" && systemctl daemon-reload; then
    if atomic_replace_link "$current_path" "$target" && systemctl restart mydsh; then
      if health_check "$target"; then
        if caddy validate --config "$installed_caddy" --adapter caddyfile && systemctl reload caddy; then
          if public_acceptance && authenticated_acceptance && systemctl enable mydsh; then
            if write_journal_state "$journal" committed; then
              if ! remove_activation_journal "$journal"; then
                printf 'mydsh-deploy-release: activation accepted but committed journal cleanup was not durable at %s; the next operation will retry if it remains\n' "$journal" >&2
              fi
              return 0
            elif grep -Fqx 'state=committed' "$journal/state"; then
              printf 'mydsh-deploy-release: activation accepted with committed journal retained at %s; cleanup will retry next operation\n' "$journal" >&2
              return 0
            fi
          fi
        fi
      fi
    fi
  fi
  if ! recover_activation_journal "$journal" "$host_root" "$current_path"; then
    printf 'mydsh-deploy-release: activation recovery incomplete; retry with journal %s intact\n' "$journal" >&2
  fi
  return 1
}

rollback_to_commit() {
  local commit=$1
  local releases_root=${2:-$RELEASES_DIR}
  local current_path=${3:-$CURRENT_LINK}
  local previous
  local target
  local asset_root
  [[ $commit =~ ^[0-9a-f]{40}$ ]] || fail 'rollback commit must be 40 lowercase hexadecimal characters'
  target="$releases_root/$commit"
  validate_release_target "$target" "$releases_root" || fail 'rollback target is outside the canonical release directory'
  previous=$(current_release "$current_path" "$releases_root") || fail 'current release link is unsafe'
  asset_root="$target/.mydsh-trusted-deploy"
  [[ -d "$asset_root" && ! -L "$asset_root" ]] || fail 'rollback release lacks root-trusted deployment assets'
  load_public_environment
  activate_transaction "$target" "$previous" "$asset_root" '' "$current_path" || return 1
  printf 'Rolled back to release %s after public and authenticated acceptance.\n' "$commit"
}

prune_release() {
  local commit=$1
  local releases_root=${2:-$RELEASES_DIR}
  local current_path=${3:-$CURRENT_LINK}
  local target
  local active=''

  [[ $commit =~ ^[0-9a-f]{40}$ ]] || return 1
  target="$releases_root/$commit"
  validate_release_target "$target" "$releases_root" || return 1
  active=$(current_release "$current_path" "$releases_root") || return 1
  [[ $target != "$active" ]] || return 1
  rm -rf -- "$target" || return 1
  printf 'Pruned inactive release %s.\n' "$commit"
}

deploy_bundle() {
  local bundle_path
  local ref=$2
  local checkout
  local clone_ref
  local commit
  local operation_root
  local trusted_assets
  local previous
  local staged_bundle
  local target
  local trusted_bundle
  local trusted_commit
  local trusted_repository
  local candidate_path

  bundle_path=$(realpath -e -- "$1") || fail 'bundle path does not exist'
  [[ -f "$bundle_path" && -r "$bundle_path" ]] || fail 'bundle must be a readable regular file'
  git check-ref-format --branch "$ref" >/dev/null || git check-ref-format "$ref" >/dev/null || fail 'invalid deployment ref'
  previous=$(current_release) || fail 'current release link is unsafe'
  clone_ref=${ref#refs/heads/}
  clone_ref=${clone_ref#refs/tags/}
  TRUST_ROOT=$(mktemp -d /run/mydsh-bundle.XXXXXX) || fail 'cannot create trusted bundle directory'
  validate_temp_directory "$TRUST_ROOT" /run mydsh-bundle. || fail 'unsafe trusted bundle directory'
  trap cleanup_operation EXIT
  trusted_bundle="$TRUST_ROOT/release.bundle"
  trusted_repository="$TRUST_ROOT/repository.git"
  install -o root -g root -m 0400 -- "$bundle_path" "$trusted_bundle"
  trusted_git init --bare --quiet "$trusted_repository"
  trusted_git -C "$trusted_repository" bundle verify "$trusted_bundle"
  trusted_git -C "$trusted_repository" fetch --quiet "$trusted_bundle" "$ref"
  trusted_commit=$(trusted_git -C "$trusted_repository" rev-parse 'FETCH_HEAD^{commit}') || fail 'cannot resolve the trusted bundle ref'
  trusted_assets="$TRUST_ROOT/assets"
  install -d -o root -g root -m 0700 "$trusted_assets"
  for candidate_path in Caddyfile mydsh.service caddy-mydsh.conf invite-auth.cordis.yml deploy-release.sh; do
    trusted_git -C "$trusted_repository" show "$trusted_commit:deploy/alibaba-cloud/$candidate_path" >"$trusted_assets/$candidate_path"
    chmod 0600 "$trusted_assets/$candidate_path"
  done
  operation_root=$(mktemp -d "$RELEASES_DIR/.build.XXXXXX") || fail 'cannot create per-operation builder root'
  OPERATION_ROOT=$operation_root
  validate_temp_directory "$operation_root" "$RELEASES_DIR" .build. || fail 'unsafe per-operation builder root'
  checkout="$operation_root/checkout"
  staged_bundle="$operation_root/release.bundle"
  for candidate_path in home tmp xdg-config xdg-cache xdg-runtime dsh-home cache; do install -d -o mydsh-build -g mydsh-build -m 0700 "$operation_root/$candidate_path"; done
  chown mydsh-build:mydsh-build "$operation_root"
  chmod 0700 "$operation_root"
  install -o mydsh-build -g mydsh-build -m 0400 -- "$trusted_bundle" "$staged_bundle"
  run_builder "$operation_root" "$staged_bundle" "$clone_ref" "$trusted_commit" "$checkout" || fail 'transient builder service failed or did not quiesce'
  [[ -d "$checkout" && ! -L "$checkout" && $(realpath -e -- "$checkout") == "$checkout" ]] || fail 'builder checkout is not a canonical real directory'
  read_builder_commit_marker "$operation_root/result.commit" "$trusted_commit" >/dev/null || fail 'builder commit marker does not match the trusted bundle ref'
  commit=$trusted_commit
  [[ $commit =~ ^[0-9a-f]{40}$ && $commit == "$trusted_commit" ]] || fail 'candidate commit does not match the trusted bundle ref'
  target="$RELEASES_DIR/$commit"
  [[ ! -e "$target" && ! -L "$target" ]] || fail "release already exists: $commit"
  for candidate_path in Caddyfile mydsh.service caddy-mydsh.conf invite-auth.cordis.yml; do
    cmp -- "$trusted_assets/$candidate_path" "$checkout/deploy/alibaba-cloud/$candidate_path" || fail "builder modified deployment asset: $candidate_path"
  done
  load_public_environment
  validate_candidate_configs "$trusted_assets" || fail 'trusted candidate deployment assets failed validation before publication'
  publish_builder_checkout "$checkout" "$target" "$RELEASES_DIR" || fail 'candidate publication failed safely'
  install_trusted_release_assets "$target" "$trusted_assets" "$RELEASES_DIR" || fail 'trusted deployment asset publication failed safely'
  rm -rf -- "$operation_root"
  OPERATION_ROOT=''
  rm -rf -- "$TRUST_ROOT"
  TRUST_ROOT=''
  activate_transaction "$target" "$previous" "$target/.mydsh-trusted-deploy" || return 1
  printf 'Deployed release %s after public and authenticated acceptance.\n' "$commit"
}

main() {
  if [[ ${1:-} == --internal-build ]]; then
    [[ $# -eq 7 ]] || return 64
    [[ $(id -un) == mydsh-build ]] || fail '--internal-build requires the mydsh-build identity'
    internal_build "$2" "$3" "$4" "$5" "$6" "$7"
    return
  fi
  [[ $EUID -eq 0 ]] || fail 'run this script as root'
  [[ $# -eq 2 ]] || { usage; return 64; }
  [[ $(realpath -e -- "$0") == /usr/local/sbin/mydsh-deploy-release ]] || fail 'run the root-installed deployment helper'
  acquire_operation_lock
  trap cleanup_operation EXIT
  validate_recovery_prerequisites
  load_public_environment
  cleanup_abandoned_journal_staging "$(dirname -- "$ACTIVATION_DIR")" || fail 'cannot inspect abandoned activation journal staging'
  recover_activation_journal "$ACTIVATION_DIR" || fail "activation recovery failed; inspect $ACTIVATION_DIR"
  validate_host
  if [[ $1 == --rollback ]]; then
    rollback_to_commit "$2"
  elif [[ $1 == --prune ]]; then
    prune_release "$2"
  else
    deploy_bundle "$1" "$2"
  fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
