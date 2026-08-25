#!/usr/bin/env bash
set -euo pipefail

readonly RELEASES_DIR=/opt/mydsh/releases
readonly CURRENT_LINK=/opt/mydsh/current
STAGING_ROOT=''

usage() {
  printf 'Usage: sudo %s <git-bundle-file> <branch>\n' "${0##*/}" >&2
  printf '       sudo %s --rollback <full-commit>\n' "${0##*/}" >&2
}

fail() {
  printf 'deploy-release: %s\n' "$1" >&2
  exit 1
}

cleanup_staging() {
  if [[ -n "$STAGING_ROOT" ]]; then
    case "$STAGING_ROOT" in
      /opt/mydsh/releases/.staging.*)
        rm -rf -- "$STAGING_ROOT" || return 1
        ;;
      *)
        printf 'deploy-release: refusing unsafe staging cleanup: %s\n' "$STAGING_ROOT" >&2
        return 1
        ;;
    esac
  fi
}

health_check() {
  local attempt
  for attempt in {1..30}; do
    if curl --fail --silent --show-error --output /dev/null --max-time 2 http://127.0.0.1:3080/__invite/login; then
      return 0
    fi
    sleep 1
  done
  return 1
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

validate_mydsh_account() {
  local account_name
  local entries=()
  local gecos
  local gid
  local home
  local mydsh_shell
  local mydsh_uid
  local passwd_uid
  local password

  mapfile -t entries < <(getent passwd mydsh)
  [[ ${#entries[@]} -eq 1 ]] || fail 'getent must resolve exactly one mydsh account'
  IFS=: read -r account_name password passwd_uid gid gecos home mydsh_shell <<<"${entries[0]}"
  [[ $account_name == mydsh && $passwd_uid =~ ^[0-9]+$ ]] || fail 'the mydsh passwd entry is malformed'
  mydsh_uid=$(id -u mydsh) || fail 'id cannot resolve the mydsh account'
  [[ $mydsh_uid == "$passwd_uid" ]] || fail 'id and getent disagree about the mydsh uid'
  [[ $mydsh_uid != 0 && $mydsh_uid -lt 1000 ]] || fail 'the mydsh account must be a non-root Ubuntu system account'
  [[ $mydsh_shell == /usr/sbin/nologin || $mydsh_shell == /sbin/nologin ]] || fail 'the mydsh account must use the Ubuntu nologin shell'
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
    if [[ -e "$next_path" || -L "$next_path" ]]; then
      rm -f -- "$next_path" || return 1
    fi
    return 1
  }
  mv -Tf -- "$next_path" "$current_path" || {
    rm -f -- "$next_path" || return 1
    return 1
  }
}

remove_failed_first_link() {
  local failed_target=$1
  local active_target
  local resolved_failed

  if [[ -L "$CURRENT_LINK" ]]; then
    active_target=$(realpath -e -- "$CURRENT_LINK") || return 1
    resolved_failed=$(realpath -e -- "$failed_target") || return 1
    if [[ "$active_target" == "$resolved_failed" ]]; then
      rm -f -- "$CURRENT_LINK" || return 1
    fi
  elif [[ -e "$CURRENT_LINK" ]]; then
    return 1
  fi
}

recover_activation() {
  local previous=$1
  local failed_target=$2

  if [[ -n "$previous" ]]; then
    if atomic_replace_link "$CURRENT_LINK" "$previous" && systemctl restart mydsh; then
      if health_check; then
        printf 'Deployment failed; restored release %s.\n' "${previous##*/}" >&2
        return 0
      fi
    fi
    printf 'Deployment failed and the previous release did not recover; inspect mydsh.service.\n' >&2
    return 1
  fi

  if remove_failed_first_link "$failed_target"; then
    if ! systemctl disable mydsh; then
      printf 'Could not disable mydsh after the failed first deployment.\n' >&2
    fi
    if systemctl stop mydsh; then
      printf 'First deployment failed; stopped mydsh and preserved release %s.\n' "${failed_target##*/}" >&2
      return 0
    fi
  fi
  printf 'First deployment failed and cleanup could not safely stop the service.\n' >&2
  return 1
}

current_release() {
  local current

  if [[ ! -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]; then
    return 0
  fi
  [[ -L "$CURRENT_LINK" ]] || return 1
  current=$(realpath -e -- "$CURRENT_LINK") || return 1
  validate_release_target "$current" "$RELEASES_DIR" || return 1
  printf '%s\n' "$current"
}

load_public_environment() {
  set -a
  # shellcheck disable=SC1091 -- bootstrap-host.sh owns this root-controlled file.
  source /etc/mydsh/public.env
  set +a
}

validate_host() {
  local tool

  for tool in caddy curl getent git node pnpm realpath runuser systemctl; do
    command -v "$tool" >/dev/null 2>&1 || fail "required tool is unavailable: $tool"
  done
  [[ -d /opt/mydsh && -d "$RELEASES_DIR" && -d /srv/mydsh/workspace && -d /var/lib/mydsh && -d /var/cache/mydsh-pnpm ]] || fail 'host directories are missing; run bootstrap-host.sh first'
  [[ -r /etc/mydsh/public.env && -r /etc/mydsh/mydsh.env && -r /etc/caddy/Caddyfile && -r /etc/systemd/system/mydsh.service && -r /etc/systemd/system/caddy.service.d/mydsh.conf ]] || fail 'host configuration is incomplete; run bootstrap-host.sh first'
  validate_mydsh_account
}

activate_release() {
  local target=$1
  local previous=$2

  if atomic_replace_link "$CURRENT_LINK" "$target"; then
    if systemctl restart mydsh; then
      if health_check; then
        if caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
          if systemctl reload caddy; then
            if systemctl enable mydsh; then
              return 0
            fi
          fi
        fi
      fi
    fi
  fi

  recover_activation "$previous" "$target" || true
  return 1
}

rollback_to_commit() {
  local commit=$1
  local previous
  local target

  [[ $commit =~ ^[0-9a-f]{40}$ ]] || fail 'rollback commit must be 40 lowercase hexadecimal characters'
  target="$RELEASES_DIR/$commit"
  validate_release_target "$target" "$RELEASES_DIR" || fail 'rollback target is not a canonical commit directory under the releases root'
  previous=$(current_release) || fail "$CURRENT_LINK is not a safe release symlink"
  load_public_environment
  if activate_release "$target" "$previous"; then
    printf 'Rolled back to release %s and reloaded Caddy.\n' "$commit"
    return 0
  fi
  return 1
}

deploy_bundle() {
  local branch=$2
  local bundle_path
  local checkout
  local commit
  local previous
  local staged_bundle
  local target
  local verify_repository

  bundle_path=$(realpath -e -- "$1") || fail 'bundle path does not exist'
  [[ -f "$bundle_path" && -r "$bundle_path" ]] || fail 'bundle must resolve to a readable regular file'
  git check-ref-format --branch "$branch" >/dev/null || fail 'invalid branch name'

  STAGING_ROOT=$(mktemp -d /opt/mydsh/releases/.staging.XXXXXX)
  trap cleanup_staging EXIT
  verify_repository="$STAGING_ROOT/verify.git"
  checkout="$STAGING_ROOT/release"
  staged_bundle="$STAGING_ROOT/release.bundle"
  install -o root -g root -m 0644 -- "$bundle_path" "$staged_bundle"
  git init --bare --quiet "$verify_repository"
  (
    cd -- "$verify_repository"
    git bundle verify "$staged_bundle"
  )
  chown -R mydsh:mydsh "$STAGING_ROOT"
  runuser -u mydsh -- git clone --branch "$branch" --single-branch "$staged_bundle" "$checkout"

  commit=$(runuser -u mydsh -- git -C "$checkout" rev-parse HEAD) || fail 'could not resolve the cloned commit'
  [[ $commit =~ ^[0-9a-f]{40}$ ]] || fail 'cloned release did not resolve to a full commit hash'
  target="$RELEASES_DIR/$commit"
  [[ ! -e "$target" && ! -L "$target" ]] || fail "release already exists: $commit"

  (
    cd -- "$checkout"
    runuser -u mydsh -- pnpm install --frozen-lockfile --store-dir /var/cache/mydsh-pnpm
    runuser -u mydsh -- pnpm exec vitest run packages/host/invite-auth/tests
    runuser -u mydsh -- pnpm run build
    runuser -u mydsh -- env DSH_HOME=/var/lib/mydsh /usr/bin/node apps/cli/lib/bin.js web --patch deploy/alibaba-cloud/invite-auth.cordis.yml --dump-config >/dev/null
  )

  chown -R root:root "$checkout"
  chmod -R go-w "$checkout"
  mv -- "$checkout" "$target"
  cleanup_staging
  STAGING_ROOT=''

  validate_release_target "$target" "$RELEASES_DIR" || fail 'published release failed canonical-path validation'
  previous=$(current_release) || fail "$CURRENT_LINK is not a safe release symlink"
  load_public_environment
  if activate_release "$target" "$previous"; then
    printf 'Deployed release %s and reloaded Caddy.\n' "$commit"
    return 0
  fi
  return 1
}

main() {
  [[ $EUID -eq 0 ]] || fail 'run this script as root'
  [[ $# -eq 2 ]] || {
    usage
    return 64
  }
  validate_host
  if [[ $1 == --rollback ]]; then
    rollback_to_commit "$2"
    return
  fi
  deploy_bundle "$1" "$2"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
