#!/usr/bin/env bash
set -euo pipefail

readonly NODE_IMAGE='node:24-bookworm@sha256:ffeee58a257b390b80b9b656cba440bbc3116c1bc03139c31318f9d9c29a8975'
readonly PNPM_TARBALL=https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz
readonly PNPM_INTEGRITY='sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA=='
PACKAGE_ROOT=''
PAIR_STAGING=''
PAIR_PARENT=''
CIDFILE=''

usage() {
  printf 'Usage: %s <named-reviewed-git-ref> <output-directory>\n' "${0##*/}" >&2
}

fail() {
  printf 'package-release: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  local container_id
  if [[ -n "$CIDFILE" && -f "$CIDFILE" && ! -L "$CIDFILE" ]]; then
    container_id=$(<"$CIDFILE") || container_id=''
    if [[ $container_id =~ ^[0-9a-f]{64}$ ]]; then docker rm -f "$container_id" >/dev/null 2>&1 || true; fi
  fi
  if [[ -n "$PAIR_STAGING" && -n "$PAIR_PARENT" && "$PAIR_STAGING" == "$PAIR_PARENT"/.mydsh-release-*.new.* ]]; then rm -rf -- "$PAIR_STAGING" || true; fi
  if [[ -n "$PACKAGE_ROOT" && "$PACKAGE_ROOT" == /tmp/mydsh-package.* ]]; then rm -rf -- "$PACKAGE_ROOT" || true; fi
}

verify_static_inputs() {
  local trusted=$1
  local built=$2
  local name
  for name in Caddyfile mydsh.service caddy-mydsh.conf invite-auth.cordis.yml; do
    cmp -- "$trusted/deploy/alibaba-cloud/$name" "$built/deploy/alibaba-cloud/$name" || return 1
  done
}

validate_manifest_ref() {
  local ref=$1
  local remainder
  local component
  local components=()
  case "$ref" in
    refs/heads/*) remainder=${ref#refs/heads/} ;;
    refs/tags/*) remainder=${ref#refs/tags/} ;;
    *) return 1 ;;
  esac
  [[ -n "$remainder" && $ref =~ ^refs/(heads|tags)/[A-Za-z0-9._/-]+$ ]] || return 1
  [[ $remainder != /* && $remainder != */ && $remainder != *..* && $remainder != *//* && $remainder != *'@{'* ]] || return 1
  IFS=/ read -r -a components <<<"$remainder"
  for component in "${components[@]}"; do
    [[ -n "$component" && $component != .* && $component != *. && $component != *.lock ]] || return 1
  done
}

resolve_named_ref_commit() {
  local ref=$1
  local repository=${2:-.}
  local commit
  validate_manifest_ref "$ref" || return 1
  git check-ref-format "$ref" >/dev/null || return 1
  git -C "$repository" show-ref --verify --quiet "$ref" || return 1
  commit=$(git -C "$repository" rev-parse --verify "${ref}^{commit}") || return 1
  [[ $commit =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '%s\n' "$commit"
}

verify_staged_artifact_set() (
  local staging=$1
  local artifact="$staging/mydsh-linux-amd64.tar.gz"
  local checksum="$artifact.sha256"
  local actual
  local digest
  local entries=()
  local line
  [[ -d "$staging" && ! -L "$staging" && $(realpath -e -- "$staging") == "$staging" ]] || return 1
  shopt -s dotglob nullglob
  entries=("$staging"/*)
  [[ ${#entries[@]} -eq 2 ]] || return 1
  [[ -f "$artifact" && ! -L "$artifact" && -f "$checksum" && ! -L "$checksum" ]] || return 1
  line=$(<"$checksum") || return 1
  [[ $line =~ ^([0-9a-f]{64})[[:space:]][[:space:]]mydsh-linux-amd64\.tar\.gz$ ]] || return 1
  digest=${BASH_REMATCH[1]}
  actual=$(sha256sum "$artifact") || return 1
  actual=${actual%% *}
  [[ $actual == "$digest" ]]
)

publish_artifact_set() {
  local staging=$1
  local final_dir=$2
  local output_dir=$3
  local commit=${final_dir##*/mydsh-release-}
  [[ $commit =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ -d "$output_dir" && ! -L "$output_dir" && $(realpath -e -- "$output_dir") == "$output_dir" ]] || return 1
  [[ "$staging" == "$output_dir/.mydsh-release-$commit.new."* ]] || return 1
  [[ "$final_dir" == "$output_dir/mydsh-release-$commit" && ! -e "$final_dir" && ! -L "$final_dir" ]] || return 1
  verify_staged_artifact_set "$staging" || return 1
  sync -f "$staging/mydsh-linux-amd64.tar.gz" || return 1
  sync -f "$staging/mydsh-linux-amd64.tar.gz.sha256" || return 1
  sync -f "$staging" || return 1
  mv -T -- "$staging" "$final_dir" || return 1
  if ! sync -f "$output_dir"; then
    if mv -T -- "$final_dir" "$staging"; then sync -f "$output_dir" || true; fi
    return 1
  fi
  PAIR_STAGING=''
}

main() {
  local commit
  local final_dir
  local output_dir
  local ref
  local repository
  local uid
  local gid
  local source_root
  local trusted_root
  local self_from_git
  local digest
  local name

  [[ $# -eq 2 ]] || { usage; return 64; }
  ref=$1
  output_dir=$(realpath -e -- "$2") || fail 'output directory does not exist'
  [[ -d "$output_dir" && ! -L "$output_dir" && -w "$output_dir" ]] || fail 'output directory must be a writable real directory'
  [[ $(realpath -e -- "$output_dir") == "$output_dir" ]] || fail 'output directory must be canonical'
  for tool in cmp docker git gzip realpath sha256sum sync tar timeout; do command -v "$tool" >/dev/null 2>&1 || fail "required tool is unavailable: $tool"; done
  repository=$(git rev-parse --show-toplevel) || fail 'run from a Git worktree'
  commit=$(resolve_named_ref_commit "$ref" "$repository") || fail 'deployment ref must be an existing fully qualified refs/heads/* or refs/tags/* name'
  docker info >/dev/null 2>&1 || fail 'Docker is required; no host-build fallback is available'
  final_dir="$output_dir/mydsh-release-$commit"
  [[ ! -e "$final_dir" && ! -L "$final_dir" ]] || fail "refusing to overwrite ${final_dir##*/}"
  PAIR_PARENT=$output_dir
  PAIR_STAGING=$(mktemp -d "$output_dir/.mydsh-release-$commit.new.XXXXXX") || fail 'cannot create private artifact-set staging directory'
  trap cleanup EXIT
  [[ "$PAIR_STAGING" == "$output_dir/.mydsh-release-$commit.new."* && ! -L "$PAIR_STAGING" && $(realpath -e -- "$PAIR_STAGING") == "$PAIR_STAGING" ]] || fail 'unsafe artifact-set staging directory'
  chmod 0700 "$PAIR_STAGING" || fail 'cannot secure artifact-set staging directory'

  PACKAGE_ROOT=$(mktemp -d /tmp/mydsh-package.XXXXXX) || fail 'cannot create packaging directory'
  [[ -n "$PACKAGE_ROOT" && "$PACKAGE_ROOT" == /tmp/mydsh-package.* && ! -L "$PACKAGE_ROOT" && $(realpath -e -- "$PACKAGE_ROOT") == "$PACKAGE_ROOT" ]] || fail 'unsafe packaging directory'
  self_from_git="$PACKAGE_ROOT/package-release.ref"
  git -C "$repository" show "$commit:deploy/alibaba-cloud/package-release.sh" >"$self_from_git" || fail 'selected ref lacks package-release.sh'
  cmp -- "$self_from_git" "${BASH_SOURCE[0]}" || fail 'run package-release.sh extracted from the selected ref'
  trusted_root="$PACKAGE_ROOT/trusted"
  source_root="$PACKAGE_ROOT/source"
  install -d -m 0755 "$trusted_root" "$source_root"
  git -C "$repository" archive "$commit" | tar -x -C "$trusted_root"
  cp -a --reflink=never "$trusted_root/." "$source_root/"
  install -d -m 0700 "$source_root/.builder/home" "$source_root/.builder/xdg-config" "$source_root/.builder/xdg-cache" "$source_root/.builder/tmp" "$source_root/.builder/store" "$source_root/.builder/dsh-home" "$source_root/.builder/npm-prefix"
  uid=$(id -u)
  gid=$(id -g)
  CIDFILE=$(mktemp "$PACKAGE_ROOT/container.XXXXXX.cid") || fail 'cannot create Docker cidfile'
  rm -f -- "$CIDFILE"

  # The container Bash, not the packaging shell, expands this command body.
  # shellcheck disable=SC2016
  timeout --signal=TERM --kill-after=30s 45m docker run --rm --platform linux/amd64 --cidfile "$CIDFILE" \
    --memory=8g --pids-limit=1024 --cpus=4 \
    --user "$uid:$gid" \
    --env HOME=/workspace/.builder/home \
    --env TMPDIR=/workspace/.builder/tmp \
    --env XDG_CONFIG_HOME=/workspace/.builder/xdg-config \
    --env XDG_CACHE_HOME=/workspace/.builder/xdg-cache \
    --env NPM_CONFIG_USERCONFIG=/dev/null \
    --env NPM_CONFIG_PREFIX=/workspace/.builder/npm-prefix \
    --env DSH_HOME=/workspace/.builder/dsh-home \
    --env PNPM_TARBALL="$PNPM_TARBALL" \
    --env PNPM_INTEGRITY="$PNPM_INTEGRITY" \
    --env EXPECTED_COMMIT="$commit" \
    --mount "type=bind,src=$source_root,dst=/workspace" \
    --workdir /workspace \
    "$NODE_IMAGE" bash -euo pipefail -c '
      git init --quiet
      git symbolic-ref HEAD refs/heads/artifact
      mkdir -p .git/refs/heads
      printf "%s\n" "$EXPECTED_COMMIT" >.git/refs/heads/artifact
      test "$(git rev-parse HEAD)" = "$EXPECTED_COMMIT"
      for attempt in 1 2 3 4; do
        if node --input-type=module -e '\''import { createHash } from "node:crypto"; import { writeFile } from "node:fs/promises"; const response = await fetch(process.env.PNPM_TARBALL); if (!response.ok) throw new Error(`pnpm download failed: ${response.status}`); const bytes = Buffer.from(await response.arrayBuffer()); const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`; if (integrity !== process.env.PNPM_INTEGRITY) throw new Error("pnpm integrity mismatch"); await writeFile("/workspace/.builder/pnpm-11.7.0.tgz", bytes);'\''; then break; fi
        [[ $attempt -lt 4 ]] || exit 1
        sleep 2
      done
      npm install --global --ignore-scripts /workspace/.builder/pnpm-11.7.0.tgz
      export PATH=/workspace/.builder/npm-prefix/bin:/usr/local/bin:/usr/bin:/bin
      test "$(node --version)" = "v24.${NODE_VERSION#24.}"
      test "$(pnpm --version)" = 11.7.0
      for attempt in 1 2 3; do
        if pnpm install --frozen-lockfile --store-dir /workspace/.builder/store; then break; fi
        [[ $attempt -lt 3 ]] || exit 1
        sleep 5
      done
      pnpm exec vitest run packages/host/invite-auth/tests
      pnpm run build
      node apps/cli/lib/bin.js web --patch deploy/alibaba-cloud/invite-auth.cordis.yml --dump-config >/dev/null
      test -f apps/cli/lib/bin.js
      test -f apps/web/dist/index.html
      test -d node_modules
      rm -rf -- /workspace/.git
     '

  CIDFILE=''
  verify_static_inputs "$trusted_root" "$source_root" || fail 'container modified a static security input'
  for name in Caddyfile mydsh.service caddy-mydsh.conf invite-auth.cordis.yml; do cp -- "$trusted_root/deploy/alibaba-cloud/$name" "$source_root/deploy/alibaba-cloud/$name"; done
  printf 'format=1\ncommit=%s\nref=%s\nplatform=linux-amd64\nnode_major=24\npnpm_version=11.7.0\nhelper_journal_format=1\nnode_image_digest=sha256:ffeee58a257b390b80b9b656cba440bbc3116c1bc03139c31318f9d9c29a8975\n' "$commit" "$ref" >"$source_root/.mydsh-release-manifest"
  chmod 0644 "$source_root/.mydsh-release-manifest" || fail 'cannot secure release manifest'
  tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --exclude=./.builder -C "$source_root" -cf - . | gzip -n >"$PAIR_STAGING/mydsh-linux-amd64.tar.gz"
  digest=$(sha256sum "$PAIR_STAGING/mydsh-linux-amd64.tar.gz"); digest=${digest%% *}
  printf '%s  mydsh-linux-amd64.tar.gz\n' "$digest" >"$PAIR_STAGING/mydsh-linux-amd64.tar.gz.sha256"
  publish_artifact_set "$PAIR_STAGING" "$final_dir" "$output_dir" || fail 'artifact-set validation or atomic publication failed'
  printf 'Packaged commit %s as atomic artifact set %s.\n' "$commit" "${final_dir##*/}"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
