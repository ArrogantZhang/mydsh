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
readonly UPLOADS_DIR=/var/lib/mydsh-deploy/uploads
readonly ACTIVATION_DIR=/var/lib/mydsh-deploy/activation
readonly MAX_COMPRESSED_BYTES=1073741824
readonly MAX_ARCHIVE_MEMBERS=500000
readonly MAX_MEMBER_BYTES=536870912
readonly MAX_EXPANDED_BYTES=8589934592
readonly RELEASE_FORMAT=1
readonly HELPER_JOURNAL_FORMAT=1
readonly NODE_IMAGE_DIGEST=sha256:ffeee58a257b390b80b9b656cba440bbc3116c1bc03139c31318f9d9c29a8975
DEPLOY_LOCK_FD=''
TRUST_ROOT=''
CREATED_TEMP_FILE=''
REGISTERED_TEMP_FILES=()
OPERATION_ROOT=''
MANIFEST_COMMIT=''
MANIFEST_REF=''

usage() {
  printf 'Usage: sudo %s <atomic-artifact-set-directory>\n' "${0##*/}" >&2
  printf '       sudo %s --rollback <40-character-lowercase-commit>\n' "${0##*/}" >&2
  printf '       sudo %s --prune <40-character-lowercase-commit>\n' "${0##*/}" >&2
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
      "$UPLOADS_DIR"/.upload.*) rm -rf -- "$TRUST_ROOT" || true ;;
      *) printf 'mydsh-deploy-release: refusing unsafe trust-root cleanup: %s\n' "$TRUST_ROOT" >&2 ;;
    esac
  fi
  if [[ -n "$OPERATION_ROOT" && "$OPERATION_ROOT" == "$RELEASES_DIR/.extract."* ]]; then rm -rf -- "$OPERATION_ROOT" || true; fi
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
  for tool in awk bash caddy cmp curl df flock getent head install node python3 realpath sed sha256sum ss stat sync systemctl systemd-analyze tar uname; do
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
  validate_host_directory "$UPLOADS_DIR" root:root 700
  validate_host_directory /etc/mydsh root:root 755
  validate_existing_managed_file "$PUBLIC_ENV" || fail "unsafe or unmanaged host file: $PUBLIC_ENV"
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
  [[ $(uname -m) == x86_64 ]] || fail 'prebuilt artifacts require an x86_64 host'
  [[ $(node --version) == v24.* ]] || fail 'prebuilt artifacts require the Node.js 24 runtime'
  validate_host_directory /opt/mydsh root:root 755
  validate_host_directory "$RELEASES_DIR" root:root 755
  validate_host_directory /srv/mydsh root:root 755
  validate_host_directory /srv/mydsh/workspace mydsh:mydsh 750
  validate_host_directory /var/lib/mydsh mydsh:mydsh 700
  validate_host_directory "$DEPLOY_STATE_ROOT" root:root 700
  validate_host_directory /etc/mydsh root:root 755
  validate_system_account mydsh /var/lib/mydsh
  for path in "$PUBLIC_ENV" "$PRIVATE_ENV" "$CADDY_CONFIG" "$DSH_UNIT" "$CADDY_DROPIN" "$ROOT_HELPER"; do
    validate_existing_managed_file "$path" || fail "unsafe or unmanaged host file: $path"
  done
}

validate_candidate_configs() {
  local asset_root=$1
  local caddy_candidate="$asset_root/Caddyfile"
  local unit_candidate="$asset_root/mydsh.service"
  local dropin_candidate="$asset_root/caddy-mydsh.conf"
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
  validate_control_plane_match "$asset_root" "$CADDY_CONFIG" "$DSH_UNIT" "$CADDY_DROPIN" || return 1
  validate_candidate_unit_contract "$unit_candidate" || return 1
  [[ $(grep -Fvc "$MANAGED_MARKER" "$dropin_candidate") == 2 ]] || return 1
  grep -Fqx '[Service]' "$dropin_candidate" || return 1
  grep -Fqx 'EnvironmentFile=/etc/mydsh/public.env' "$dropin_candidate" || return 1
  caddy validate --config "$CADDY_CONFIG" --adapter caddyfile || return 1
  verify_root=$(mktemp -d /run/mydsh-systemd-verify.XXXXXX) || return 1
  validate_temp_directory "$verify_root" /run mydsh-systemd-verify. || return 1
  mkdir -p "$verify_root/etc/systemd/system/caddy.service.d" "$verify_root/usr/bin" "$verify_root/srv/mydsh/workspace" "$verify_root/var/lib/mydsh" "$verify_root/etc/mydsh" "$verify_root/opt/mydsh/current/apps/cli/lib" || { rm -rf -- "$verify_root" || true; return 1; }
  install -m 0644 "$DSH_UNIT" "$verify_root/etc/systemd/system/mydsh.service" || { rm -rf -- "$verify_root" || true; return 1; }
  install -m 0644 "$CADDY_DROPIN" "$verify_root/etc/systemd/system/caddy.service.d/mydsh.conf" || { rm -rf -- "$verify_root" || true; return 1; }
  printf '[Service]\nExecStart=/usr/bin/caddy\n' >"$verify_root/etc/systemd/system/caddy.service" || { rm -rf -- "$verify_root" || true; return 1; }
  touch "$verify_root/usr/bin/node" "$verify_root/usr/bin/caddy" "$verify_root/opt/mydsh/current/apps/cli/lib/bin.js" "$verify_root/etc/mydsh/public.env" "$verify_root/etc/mydsh/mydsh.env" || { rm -rf -- "$verify_root" || true; return 1; }
  chmod 0755 "$verify_root/usr/bin/node" "$verify_root/usr/bin/caddy" "$verify_root/opt/mydsh/current/apps/cli/lib/bin.js" || { rm -rf -- "$verify_root" || true; return 1; }
  if ! systemd-analyze --root="$verify_root" verify --recursive-errors=no mydsh.service caddy.service; then
    rm -rf -- "$verify_root" || true
    return 1
  fi
  rm -rf -- "$verify_root" || return 1
}

validate_control_plane_match() {
  local asset_root=$1
  local installed_caddy=$2
  local installed_unit=$3
  local installed_dropin=$4
  cmp -- "$asset_root/Caddyfile" "$installed_caddy" || return 1
  cmp -- "$asset_root/mydsh.service" "$installed_unit" || return 1
  cmp -- "$asset_root/caddy-mydsh.conf" "$installed_dropin" || return 1
}

require_unit_value_once() {
  local unit=$1
  local key=$2
  local expected=$3
  local lines=()
  mapfile -t lines < <(grep -E "^${key}=" "$unit")
  [[ ${#lines[@]} -eq 1 && ${lines[0]} == "$key=$expected" ]]
}

validate_candidate_unit_contract() {
  local unit=$1
  local environment_files=()
  [[ -f "$unit" && ! -L "$unit" ]] || return 1
  require_unit_value_once "$unit" After network-online.target || return 1
  require_unit_value_once "$unit" Wants network-online.target || return 1
  require_unit_value_once "$unit" StartLimitIntervalSec 60 || return 1
  require_unit_value_once "$unit" StartLimitBurst 5 || return 1
  require_unit_value_once "$unit" Type simple || return 1
  require_unit_value_once "$unit" User mydsh || return 1
  require_unit_value_once "$unit" Group mydsh || return 1
  require_unit_value_once "$unit" WorkingDirectory /srv/mydsh/workspace || return 1
  require_unit_value_once "$unit" Environment NODE_ENV=production || return 1
  mapfile -t environment_files < <(grep -E '^EnvironmentFile=' "$unit")
  [[ ${#environment_files[@]} -eq 2 ]] || return 1
  [[ $(printf '%s\n' "${environment_files[@]}" | grep -Fxc 'EnvironmentFile=/etc/mydsh/public.env') == 1 ]] || return 1
  [[ $(printf '%s\n' "${environment_files[@]}" | grep -Fxc 'EnvironmentFile=/etc/mydsh/mydsh.env') == 1 ]] || return 1
  # systemd, not this validation shell, expands the public-host variable.
  # shellcheck disable=SC2016
  require_unit_value_once "$unit" ExecStart '/usr/bin/node /opt/mydsh/current/apps/cli/lib/bin.js web --patch /opt/mydsh/current/deploy/alibaba-cloud/invite-auth.cordis.yml --no-open --trusted-host ${DSH_PUBLIC_HOST}' || return 1
  require_unit_value_once "$unit" Restart on-failure || return 1
  require_unit_value_once "$unit" RestartSec 5s || return 1
  require_unit_value_once "$unit" TimeoutStopSec 30s || return 1
  require_unit_value_once "$unit" UMask 0077 || return 1
  require_unit_value_once "$unit" NoNewPrivileges true || return 1
  require_unit_value_once "$unit" PrivateTmp true || return 1
  require_unit_value_once "$unit" ProtectSystem strict || return 1
  require_unit_value_once "$unit" ProtectHome true || return 1
  require_unit_value_once "$unit" ReadWritePaths '/var/lib/mydsh /srv/mydsh/workspace' || return 1
  require_unit_value_once "$unit" WantedBy multi-user.target || return 1
  if grep -Eq '^(SystemCallFilter|IPAddressDeny|RestrictAddressFamilies)=' "$unit"; then return 1; fi
}

validate_temp_directory() {
  local path=$1
  local parent=$2
  local prefix=$3
  [[ -n "$path" && "$path" == "$parent/$prefix"* && -d "$path" && ! -L "$path" ]] || return 1
  [[ $(realpath -e -- "$path") == "$path" ]] || return 1
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

verify_artifact_checksum() {
  local artifact=$1
  local sidecar=$2
  local expected_name=${artifact##*/}
  local digest
  local listed_name
  local line
  local actual
  [[ -f "$artifact" && ! -L "$artifact" && -f "$sidecar" && ! -L "$sidecar" ]] || return 1
  line=$(<"$sidecar") || return 1
  [[ $line =~ ^([0-9a-f]{64})[[:space:]][[:space:]]([A-Za-z0-9._-]+)$ ]] || return 1
  digest=${BASH_REMATCH[1]}
  listed_name=${BASH_REMATCH[2]}
  [[ $listed_name == "$expected_name" ]] || return 1
  actual=$(sha256sum "$artifact") || return 1
  actual=${actual%% *}
  [[ $actual == "$digest" ]] || return 1
}

validate_artifact_set_directory() (
  local artifact_set=$1
  local entries=()
  [[ -d "$artifact_set" && ! -L "$artifact_set" && $(realpath -e -- "$artifact_set") == "$artifact_set" ]] || return 1
  shopt -s dotglob nullglob
  entries=("$artifact_set"/*)
  [[ ${#entries[@]} -eq 2 ]]
)

validate_archive_members() {
  local artifact=$1
  local max_members=${2:-$MAX_ARCHIVE_MEMBERS}
  local max_member=${3:-$MAX_MEMBER_BYTES}
  local max_total=${4:-$MAX_EXPANDED_BYTES}
  python3 - "$artifact" "$max_members" "$max_member" "$max_total" <<'PY'
import posixpath
import sys
import tarfile
from pathlib import PurePosixPath

archive = sys.argv[1]
max_members, max_member, max_total = map(int, sys.argv[2:])
seen = set()
count = total = 0
with tarfile.open(archive, "r:gz") as stream:
    for member in stream:
        count += 1
        if count > max_members:
            raise SystemExit("archive member limit exceeded")
        if member.size > max_member:
            raise SystemExit(f"archive member too large: {member.name}")
        total += member.size
        if total > max_total:
            raise SystemExit("archive expanded-size limit exceeded")
        if getattr(member, "sparse", None):
            raise SystemExit(f"sparse archive member: {member.name}")
        path = PurePosixPath(member.name)
        normalized = posixpath.normpath(member.name)
        if path.is_absolute() or normalized == ".." or normalized.startswith("../"):
            raise SystemExit(f"unsafe archive path: {member.name}")
        key = normalized.removeprefix("./")
        if key in seen:
            raise SystemExit(f"duplicate archive path: {member.name}")
        seen.add(key)
        if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise SystemExit(f"unsupported archive member: {member.name}")
        if member.issym() or member.islnk():
            link = PurePosixPath(member.linkname)
            if link.is_absolute():
                raise SystemExit(f"absolute archive link: {member.name}")
            base = path.parent if member.issym() else PurePosixPath(".")
            resolved = posixpath.normpath(str(base / link))
            if resolved == ".." or resolved.startswith("../"):
                raise SystemExit(f"escaping archive link: {member.name}")
print(count, total)
PY
}

validate_compressed_size() {
  local artifact=$1
  local limit=${2:-$MAX_COMPRESSED_BYTES}
  local size
  size=$(stat -c %s "$artifact") || return 1
  [[ $size =~ ^[0-9]+$ && $size -le $limit ]]
}

copy_bounded_upload() {
  local source=$1
  local target=$2
  local limit=$3
  local size
  [[ -f "$source" && ! -L "$source" && ! -e "$target" && ! -L "$target" ]] || return 1
  (umask 077; set -o noclobber; : >"$target") 2>/dev/null || return 1
  head -c "$((limit + 1))" -- "$source" >"$target" || { rm -f -- "$target" || true; return 1; }
  chmod 0400 "$target" || { rm -f -- "$target" || true; return 1; }
  size=$(stat -c %s "$target") || { rm -f -- "$target" || true; return 1; }
  [[ $size =~ ^[0-9]+$ && $size -le $limit ]]
}

validate_extraction_space() {
  local path=$1
  local expanded=$2
  local compressed=$3
  local reserve=${4:-1073741824}
  local available
  available=$(df -PB1 "$path" | awk 'NR == 2 { print $4 }') || return 1
  [[ $available =~ ^[0-9]+$ ]] || return 1
  (( available >= expanded + compressed + reserve ))
}

validate_release_manifest() {
  local release_root=$1
  local manifest="$release_root/.mydsh-release-manifest"
  local key
  local value
  local line_count
  declare -A fields=()
  [[ -f "$manifest" && ! -L "$manifest" && $(realpath -e -- "$manifest") == "$manifest" ]] || return 1
  while IFS='=' read -r key value; do
    [[ $key =~ ^[a-z_]+$ && -n "$value" && -z ${fields[$key]+present} ]] || return 1
    fields[$key]=$value
  done <"$manifest"
  line_count=$(wc -l <"$manifest") || return 1
  [[ $line_count == 8 ]] || return 1
  grep -Fqx 'format=1' "$manifest" || return 1
  grep -Fqx 'helper_journal_format=1' "$manifest" || return 1
  [[ ${fields[format]:-} == "$RELEASE_FORMAT" ]] || return 1
  [[ ${fields[helper_journal_format]:-} == "$HELPER_JOURNAL_FORMAT" ]] || return 1
  [[ ${fields[commit]:-} =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ ${fields[ref]:-} =~ ^refs/(heads|tags)/[A-Za-z0-9._/-]+$ ]] || return 1
  [[ ${fields[platform]:-} == linux-amd64 && ${fields[node_major]:-} == 24 && ${fields[pnpm_version]:-} == 11.7.0 ]] || return 1
  [[ ${fields[node_image_digest]:-} == "$NODE_IMAGE_DIGEST" ]] || return 1
  MANIFEST_COMMIT=${fields[commit]}
  MANIFEST_REF=${fields[ref]}
}

validate_required_release_outputs() {
  local release_root=$1
  local path
  for path in \
    apps/cli/lib/bin.js \
    apps/web/dist/index.html \
    deploy/alibaba-cloud/Caddyfile \
    deploy/alibaba-cloud/mydsh.service \
    deploy/alibaba-cloud/caddy-mydsh.conf \
    deploy/alibaba-cloud/invite-auth.cordis.yml; do
    [[ -f "$release_root/$path" && ! -L "$release_root/$path" && $(realpath -e -- "$release_root/$path") == "$release_root/$path" ]] || return 1
  done
  [[ -d "$release_root/node_modules" && ! -L "$release_root/node_modules" && $(realpath -e -- "$release_root/node_modules") == "$release_root/node_modules" ]] || return 1
}

publish_extracted_release() {
  local extract_root=$1
  local target=$2
  local releases_root=${3:-$RELEASES_DIR}
  [[ -d "$extract_root" && ! -L "$extract_root" && $(realpath -e -- "$extract_root") == "$extract_root" ]] || return 1
  [[ ! -e "$target" && ! -L "$target" && ${target%/*} == "$releases_root" ]] || return 1
  chown -R root:root "$extract_root" || return 1
  chmod 0755 "$extract_root" || return 1
  chmod -R u-s,g-s "$extract_root" || return 1
  chmod -R go-w "$extract_root" || return 1
  mv -- "$extract_root" "$target" || return 1
  OPERATION_ROOT=''
  if ! validate_release_target "$target" "$releases_root"; then remove_new_publication "$target" "$releases_root" || true; return 1; fi
}

host_path() {
  local root=$1
  local absolute=$2
  printf '%s%s\n' "$root" "$absolute"
}

write_journal_value() {
  local journal=$1
  local name=$2
  local value=$3
  local temporary
  [[ $name == previous || $name == target || $name == service-enabled || $name == rollback-required || $name == journal-format ]] || return 1
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
  local _asset_root=$4
  local _host_root=${5:-}
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
  write_journal_value "$staging" previous "${previous:-none}" || { discard_journal_staging "$staging" "$parent" || true; return 1; }
  write_journal_value "$staging" target "$target" || { discard_journal_staging "$staging" "$parent" || true; return 1; }
  write_journal_value "$staging" service-enabled "$previous_enabled" || { discard_journal_staging "$staging" "$parent" || true; return 1; }
  write_journal_value "$staging" journal-format "$HELPER_JOURNAL_FORMAT" || { discard_journal_staging "$staging" "$parent" || true; return 1; }
  write_journal_value "$staging" rollback-required 1 || { discard_journal_staging "$staging" "$parent" || true; return 1; }
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
  local mode=${4:-normal}
  local rollback_required=0
  local state
  local previous
  local previous_enabled
  local target
  local journal_format
  local restored_release
  [[ $mode == normal || $mode == force ]] || return 1
  [[ ! -e "$journal" && ! -L "$journal" ]] && return 0
  [[ -d "$journal" && ! -L "$journal" ]] || return 1
  journal_format=$(<"$journal/journal-format") || return 1
  [[ $journal_format == "$HELPER_JOURNAL_FORMAT" ]] || return 1
  state=$(sed -n 's/^state=//p' "$journal/state") || return 1
  if [[ -e "$journal/rollback-required" || -L "$journal/rollback-required" ]]; then
    [[ -f "$journal/rollback-required" && ! -L "$journal/rollback-required" ]] || return 1
    grep -Fqx 1 "$journal/rollback-required" || return 1
    rollback_required=1
  fi
  if [[ $state == committed && $mode == normal && $rollback_required == 0 ]]; then
    remove_activation_journal "$journal" || return 1
    return 0
  fi
  [[ $state == prepared || $state == committed ]] || return 1
  if [[ $mode == normal && $rollback_required != 1 ]]; then return 1; fi
  previous=$(<"$journal/previous") || return 1
  target=$(<"$journal/target") || return 1
  previous_enabled=$(<"$journal/service-enabled") || return 1
  [[ $previous_enabled == enabled || $previous_enabled == disabled ]] || return 1
  if [[ $previous == none ]]; then
    remove_first_link "$target" "$current_path" || return 1
    systemctl stop mydsh || return 1
    restored_release=$target
  else
    atomic_replace_link "$current_path" "$previous" || return 1
    systemctl restart mydsh || return 1
    health_check "$previous" || return 1
    restored_release=$previous
  fi
  restore_service_enable_state "$previous_enabled" || return 1
  sync_activated_state "$restored_release" "$journal" "$host_root" "$current_path" || return 1
  remove_activation_journal "$journal" || return 1
}

finalize_committed_journal() {
  local journal=$1
  [[ -d "$journal" && ! -L "$journal" ]] || return 1
  grep -Fqx 'state=committed' "$journal/state" || return 1
  [[ -f "$journal/rollback-required" && ! -L "$journal/rollback-required" ]] || return 1
  grep -Fqx 1 "$journal/rollback-required" || return 1
  rm -f -- "$journal/rollback-required" || return 1
  if ! sync -f "$journal"; then
    write_journal_value "$journal" rollback-required 1 || true
    return 1
  fi
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
          listener_check || return 1
          return 0
        fi
      fi
    fi
    sleep 1 || return 1
  done
  return 1
}

listener_check() {
  local endpoints=()
  mapfile -t endpoints < <(ss -H -ltn 'sport = :3080' | awk '{ print $4 }')
  [[ ${#endpoints[@]} -eq 1 && ${endpoints[0]} == 127.0.0.1:3080 ]]
}

sync_activated_state() {
  local release=$1
  local journal=$2
  local host_root=${3:-}
  local current_path=${4:-$CURRENT_LINK}
  local path
  local paths=(
    "$release"
    "$(dirname -- "$release")"
    "$(dirname -- "$current_path")"
    "$(host_path "$host_root" "$CADDY_CONFIG")"
    "$(dirname -- "$(host_path "$host_root" "$CADDY_CONFIG")")"
    "$(host_path "$host_root" "$DSH_UNIT")"
    "$(dirname -- "$(host_path "$host_root" "$DSH_UNIT")")"
    "$(host_path "$host_root" "$CADDY_DROPIN")"
    "$(dirname -- "$(host_path "$host_root" "$CADDY_DROPIN")")"
    "$(host_path "$host_root" /etc/systemd/system/multi-user.target.wants)"
    "$journal"
    "$(dirname -- "$journal")"
  )
  for path in "${paths[@]}"; do
    if [[ -e "$path" || -L "$path" ]]; then sync -f "$path" || return 1; else return 1; fi
  done
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
  local previous_enabled

  validate_candidate_configs "$asset_root" || return 1
  previous_enabled=$(service_enable_state) || return 1
  prepare_activation_journal "$journal" "$target" "$previous" "$asset_root" "$host_root" "$previous_enabled" || return 1
  if atomic_replace_link "$current_path" "$target" && systemctl restart mydsh; then
    if health_check "$target" && public_acceptance && authenticated_acceptance && systemctl enable mydsh; then
      if sync_activated_state "$target" "$journal" "$host_root" "$current_path" && write_journal_state "$journal" committed && finalize_committed_journal "$journal"; then
        if ! remove_activation_journal "$journal"; then
          printf 'mydsh-deploy-release: activation accepted but committed journal cleanup was not durable at %s; the next operation will retry if it remains\n' "$journal" >&2
        fi
        return 0
      fi
    fi
  fi
  if ! recover_activation_journal "$journal" "$host_root" "$current_path" force; then
    printf 'mydsh-deploy-release: forced rollback incomplete; recovery required with journal retained at %s\n' "$journal" >&2
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
  validate_release_manifest "$target" || fail 'rollback release manifest is invalid or incompatible'
  [[ $MANIFEST_COMMIT == "$commit" ]] || fail 'rollback release manifest commit does not match its directory'
  validate_required_release_outputs "$target" || fail 'rollback release is missing required runtime outputs'
  previous=$(current_release "$current_path" "$releases_root") || fail 'current release link is unsafe'
  asset_root="$target/deploy/alibaba-cloud"
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

deploy_artifact() {
  local artifact_set_input=$1
  local artifact_set
  local artifact_path
  local checksum_path
  local commit
  local expected_commit
  local expanded_bytes
  local extract_root
  local previous
  local target
  local trusted_artifact
  local trusted_checksum
  local member_count
  local stats

  [[ -d "$artifact_set_input" && ! -L "$artifact_set_input" ]] || fail 'artifact set must be a real directory'
  artifact_set=$(realpath -e -- "$artifact_set_input") || fail 'cannot resolve artifact-set directory'
  expected_commit=${artifact_set##*/mydsh-release-}
  [[ $expected_commit =~ ^[0-9a-f]{40}$ && $artifact_set == "${artifact_set%/*}/mydsh-release-$expected_commit" ]] || fail 'artifact-set directory name must contain one full commit'
  artifact_path="$artifact_set/mydsh-linux-amd64.tar.gz"
  checksum_path="$artifact_path.sha256"
  validate_artifact_set_directory "$artifact_set" || fail 'artifact set must contain exactly the artifact and checksum'
  [[ -f "$artifact_path" && ! -L "$artifact_path" && -r "$artifact_path" ]] || fail 'artifact set is missing its readable regular artifact'
  [[ -f "$checksum_path" && ! -L "$checksum_path" && -r "$checksum_path" ]] || fail 'artifact set is missing its readable regular checksum sidecar'
  validate_compressed_size "$artifact_path" || fail 'compressed artifact exceeds the 1 GiB limit'
  [[ $(stat -c %s "$checksum_path") -le 4096 ]] || fail 'checksum sidecar is too large'
  previous=$(current_release) || fail 'current release link is unsafe'
  TRUST_ROOT=$(mktemp -d "$UPLOADS_DIR/.upload.XXXXXX") || fail 'cannot create persistent root-private artifact directory'
  validate_temp_directory "$TRUST_ROOT" "$UPLOADS_DIR" .upload. || fail 'unsafe root-private artifact directory'
  trap cleanup_operation EXIT
  trusted_artifact="$TRUST_ROOT/${artifact_path##*/}"
  trusted_checksum="$TRUST_ROOT/checksum.sha256"
  copy_bounded_upload "$artifact_path" "$trusted_artifact" "$MAX_COMPRESSED_BYTES" || fail 'artifact changed or exceeded the 1 GiB limit during its root-private copy'
  copy_bounded_upload "$checksum_path" "$trusted_checksum" 4096 || fail 'checksum changed or exceeded 4 KiB during its root-private copy'
  [[ $(stat -c '%d:%i' "$artifact_path") != "$(stat -c '%d:%i' "$trusted_artifact")" ]] || fail 'artifact root-private copy reused the upload inode'
  verify_artifact_checksum "$trusted_artifact" "$trusted_checksum" || fail 'artifact SHA-256 verification failed'
  stats=$(validate_archive_members "$trusted_artifact") || fail 'artifact archive violates path, link, type, or resource limits'
  read -r member_count expanded_bytes <<<"$stats"
  [[ $member_count =~ ^[0-9]+$ && $expanded_bytes =~ ^[0-9]+$ ]] || fail 'artifact archive statistics are invalid'
  validate_extraction_space "$RELEASES_DIR" "$expanded_bytes" "$(stat -c %s "$trusted_artifact")" || fail 'insufficient release filesystem space for safe extraction'
  extract_root=$(mktemp -d "$RELEASES_DIR/.extract.XXXXXX") || fail 'cannot create root-private extraction directory'
  OPERATION_ROOT=$extract_root
  validate_temp_directory "$extract_root" "$RELEASES_DIR" .extract. || fail 'unsafe extraction directory'
  tar -xzf "$trusted_artifact" --no-same-owner -C "$extract_root" || fail 'artifact extraction failed'
  validate_release_manifest "$extract_root" || fail 'release manifest is invalid or incompatible'
  validate_required_release_outputs "$extract_root" || fail 'artifact is missing required built runtime outputs'
  commit=$MANIFEST_COMMIT
  [[ $commit == "$expected_commit" ]] || fail 'artifact-set directory commit does not match its manifest'
  target="$RELEASES_DIR/$commit"
  [[ ! -e "$target" && ! -L "$target" ]] || fail "release already exists: $commit"
  load_public_environment
  validate_candidate_configs "$extract_root/deploy/alibaba-cloud" || fail 'artifact deployment configuration validation failed'
  publish_extracted_release "$extract_root" "$target" "$RELEASES_DIR" || fail 'artifact publication failed safely'
  rm -rf -- "$TRUST_ROOT"
  TRUST_ROOT=''
  activate_transaction "$target" "$previous" "$target/deploy/alibaba-cloud" || return 1
  printf 'Deployed prebuilt release %s (%s) after public and authenticated acceptance.\n' "$commit" "$MANIFEST_REF"
}

main() {
  [[ $EUID -eq 0 ]] || fail 'run this script as root'
  if [[ ${1:-} == --rollback || ${1:-} == --prune ]]; then
    [[ $# -eq 2 ]] || { usage; return 64; }
  else
    [[ $# -eq 1 ]] || { usage; return 64; }
  fi
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
    deploy_artifact "$1"
  fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
