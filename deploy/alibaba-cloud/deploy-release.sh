#!/usr/bin/env bash
set -euo pipefail

readonly RELEASES_DIR=/opt/mydsh/releases
readonly CURRENT_LINK=/opt/mydsh/current
readonly NEXT_LINK=/opt/mydsh/current.next
STAGING_ROOT=''

usage() {
  printf 'Usage: sudo %s <git-bundle-file> <branch>\n' "${0##*/}" >&2
}

fail() {
  printf 'deploy-release: %s\n' "$1" >&2
  exit 1
}

cleanup_staging() {
  if [[ -n "$STAGING_ROOT" ]]; then
    case "$STAGING_ROOT" in
      /opt/mydsh/releases/.staging.*)
        rm -rf -- "$STAGING_ROOT"
        ;;
      *)
        printf 'deploy-release: refusing unsafe staging cleanup: %s\n' "$STAGING_ROOT" >&2
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
  [[ -d "$target" ]] || return 1
  [[ $target =~ ^/opt/mydsh/releases/[0-9a-f]{40}$ ]]
}

replace_current() {
  local target=$1
  validate_release_target "$target" || return 1
  if [[ -e "$NEXT_LINK" || -L "$NEXT_LINK" ]]; then
    [[ -L "$NEXT_LINK" ]] || return 1
    rm -f -- "$NEXT_LINK"
  fi
  ln -s "$target" /opt/mydsh/current.next
  mv -Tf /opt/mydsh/current.next /opt/mydsh/current
}

remove_failed_first_link() {
  local failed_target=$1
  local active_target
  if [[ -L "$CURRENT_LINK" ]]; then
    active_target=$(realpath -e -- "$CURRENT_LINK") || return 1
    if [[ "$active_target" == "$failed_target" ]]; then
      rm -f -- "$CURRENT_LINK"
    fi
  fi
}

rollback() {
  local previous=$1
  local failed_target=$2

  if [[ -n "$previous" ]]; then
    if replace_current "$previous" && systemctl restart mydsh; then
      if health_check; then
        printf 'Deployment failed; restored release %s.\n' "${previous##*/}" >&2
        return 0
      fi
    fi
    printf 'Deployment failed and the previous release did not recover; inspect mydsh.service.\n' >&2
    return 1
  fi

  if remove_failed_first_link "$failed_target"; then
    if systemctl disable mydsh; then
      :
    else
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

[[ $EUID -eq 0 ]] || fail 'run this script as root'
[[ $# -eq 2 ]] || {
  usage
  exit 64
}

for tool in caddy curl git node pnpm realpath runuser systemctl; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool is unavailable: $tool"
done
[[ -d "$RELEASES_DIR" && -d /srv/mydsh/workspace && -d /var/lib/mydsh && -d /var/cache/mydsh-pnpm ]] || fail 'host directories are missing; run bootstrap-host.sh first'
[[ -r /etc/mydsh/public.env && -r /etc/mydsh/mydsh.env && -r /etc/caddy/Caddyfile && -r /etc/systemd/system/mydsh.service ]] || fail 'host configuration is incomplete; run bootstrap-host.sh first'
id mydsh >/dev/null 2>&1 || fail 'the mydsh service account is missing'

BUNDLE_PATH=$(realpath -e -- "$1") || fail 'bundle path does not exist'
readonly BUNDLE_PATH
[[ -f "$BUNDLE_PATH" && -r "$BUNDLE_PATH" ]] || fail 'bundle must resolve to a readable regular file'
readonly BRANCH=$2
git check-ref-format --branch "$BRANCH" >/dev/null || fail 'invalid branch name'

STAGING_ROOT=$(mktemp -d /opt/mydsh/releases/.staging.XXXXXX)
trap cleanup_staging EXIT
readonly VERIFY_REPOSITORY="$STAGING_ROOT/verify.git"
readonly CHECKOUT="$STAGING_ROOT/release"
readonly STAGED_BUNDLE="$STAGING_ROOT/release.bundle"
install -o root -g root -m 0644 -- "$BUNDLE_PATH" "$STAGED_BUNDLE"
git init --bare --quiet "$VERIFY_REPOSITORY"
(
  cd -- "$VERIFY_REPOSITORY"
  git bundle verify "$STAGED_BUNDLE"
)
chown -R mydsh:mydsh "$STAGING_ROOT"
runuser -u mydsh -- git clone --branch "$BRANCH" --single-branch "$STAGED_BUNDLE" "$CHECKOUT"

COMMIT=$(runuser -u mydsh -- git -C "$CHECKOUT" rev-parse HEAD) || fail 'could not resolve the cloned commit'
readonly COMMIT
[[ $COMMIT =~ ^[0-9a-f]{40}$ ]] || fail 'cloned release did not resolve to a full commit hash'
readonly TARGET="$RELEASES_DIR/$COMMIT"
[[ ! -e "$TARGET" && ! -L "$TARGET" ]] || fail "release already exists: $COMMIT"

(
  cd -- "$CHECKOUT"
  runuser -u mydsh -- pnpm install --frozen-lockfile --store-dir /var/cache/mydsh-pnpm
  runuser -u mydsh -- pnpm exec vitest run packages/host/invite-auth/tests
  runuser -u mydsh -- pnpm run build
  runuser -u mydsh -- env DSH_HOME=/var/lib/mydsh /usr/bin/node apps/cli/lib/bin.js web --patch deploy/alibaba-cloud/invite-auth.cordis.yml --dump-config >/dev/null
)

chown -R root:root "$CHECKOUT"
chmod -R go-w "$CHECKOUT"
mv -- "$CHECKOUT" "$TARGET"
cleanup_staging
STAGING_ROOT=''

set -a
# shellcheck disable=SC1091 -- bootstrap-host.sh owns this root-controlled file.
source /etc/mydsh/public.env
set +a
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

previous=''
if [[ -e "$CURRENT_LINK" || -L "$CURRENT_LINK" ]]; then
  [[ -L "$CURRENT_LINK" ]] || fail "$CURRENT_LINK must be a symlink"
  previous=$(realpath -e -- "$CURRENT_LINK") || fail "$CURRENT_LINK is a broken symlink"
  validate_release_target "$previous" || fail "$CURRENT_LINK points outside $RELEASES_DIR"
fi

replace_current "$TARGET" || fail 'could not switch the current release safely'
if systemctl restart mydsh; then
  if health_check; then
    if systemctl enable mydsh; then
      if systemctl reload caddy; then
        printf 'Deployed release %s and reloaded Caddy.\n' "$COMMIT"
        exit 0
      fi
    fi
  fi
fi

rollback "$previous" "$TARGET" || true
exit 1
