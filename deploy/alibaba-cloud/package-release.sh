#!/usr/bin/env bash
set -euo pipefail

readonly NODE_IMAGE=node:24-bookworm
readonly PNPM_TARBALL=https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz
readonly PNPM_INTEGRITY='sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA=='
PACKAGE_ROOT=''
PAIR_STAGING=''
PAIR_PARENT=''

usage() {
  printf 'Usage: %s <named-reviewed-git-ref> <output-directory>\n' "${0##*/}" >&2
}

fail() {
  printf 'package-release: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [[ -n "$PAIR_STAGING" && -n "$PAIR_PARENT" && "$PAIR_STAGING" == "$PAIR_PARENT"/.mydsh-release-*.new.* ]]; then rm -rf -- "$PAIR_STAGING" || true; fi
  if [[ -n "$PACKAGE_ROOT" && "$PACKAGE_ROOT" == /tmp/mydsh-package.* ]]; then rm -rf -- "$PACKAGE_ROOT" || true; fi
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
  local named_ref
  local source_root

  [[ $# -eq 2 ]] || { usage; return 64; }
  ref=$1
  output_dir=$(realpath -e -- "$2") || fail 'output directory does not exist'
  [[ -d "$output_dir" && ! -L "$output_dir" && -w "$output_dir" ]] || fail 'output directory must be a writable real directory'
  [[ $(realpath -e -- "$output_dir") == "$output_dir" ]] || fail 'output directory must be canonical'
  for tool in docker git gzip realpath sha256sum tar; do command -v "$tool" >/dev/null 2>&1 || fail "required tool is unavailable: $tool"; done
  docker info >/dev/null 2>&1 || fail 'Docker is required; no host-build fallback is available'
  git check-ref-format --branch "$ref" >/dev/null || git check-ref-format "$ref" >/dev/null || fail 'deployment ref must be a named Git ref'
  repository=$(git rev-parse --show-toplevel) || fail 'run from a Git worktree'
  named_ref=$(git -C "$repository" rev-parse --symbolic-full-name "$ref") || fail 'deployment ref must resolve to a named branch or tag'
  [[ $named_ref == refs/heads/* || $named_ref == refs/tags/* ]] || fail 'deployment ref must resolve to a named branch or tag'
  commit=$(git -C "$repository" rev-parse --verify "$ref^{commit}") || fail 'cannot resolve deployment ref'
  [[ $commit =~ ^[0-9a-f]{40}$ ]] || fail 'deployment ref did not resolve to one full commit'

  final_dir="$output_dir/mydsh-release-$commit"
  [[ ! -e "$final_dir" && ! -L "$final_dir" ]] || fail "refusing to overwrite ${final_dir##*/}"
  PAIR_PARENT=$output_dir
  PAIR_STAGING=$(mktemp -d "$output_dir/.mydsh-release-$commit.new.XXXXXX") || fail 'cannot create private artifact-set staging directory'
  trap cleanup EXIT
  [[ "$PAIR_STAGING" == "$output_dir/.mydsh-release-$commit.new."* && ! -L "$PAIR_STAGING" && $(realpath -e -- "$PAIR_STAGING") == "$PAIR_STAGING" ]] || fail 'unsafe artifact-set staging directory'
  chmod 0700 "$PAIR_STAGING" || fail 'cannot secure artifact-set staging directory'

  PACKAGE_ROOT=$(mktemp -d /tmp/mydsh-package.XXXXXX) || fail 'cannot create packaging directory'
  [[ -n "$PACKAGE_ROOT" && "$PACKAGE_ROOT" == /tmp/mydsh-package.* && ! -L "$PACKAGE_ROOT" && $(realpath -e -- "$PACKAGE_ROOT") == "$PACKAGE_ROOT" ]] || fail 'unsafe packaging directory'
  source_root="$PACKAGE_ROOT/source"
  install -d -m 0755 "$source_root"
  git -C "$repository" archive "$commit" | tar -x -C "$source_root"
  printf 'format=1\ncommit=%s\nref=%s\nplatform=linux-amd64\nnode_major=24\npnpm_version=11.7.0\nhelper_journal_format=1\n' "$commit" "$named_ref" >"$source_root/.mydsh-release-manifest"
  chmod 0644 "$source_root/.mydsh-release-manifest"
  install -d -m 0700 "$source_root/.builder/home" "$source_root/.builder/xdg-config" "$source_root/.builder/xdg-cache" "$source_root/.builder/tmp" "$source_root/.builder/store" "$source_root/.builder/dsh-home" "$source_root/.builder/npm-prefix"
  uid=$(id -u)
  gid=$(id -g)

  docker run --rm --platform linux/amd64 \
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
    --env ARTIFACT_TEMP=/output/mydsh-linux-amd64.tar.gz \
    --env CHECKSUM_TEMP=/output/mydsh-linux-amd64.tar.gz.sha256 \
    --env ARTIFACT_NAME=mydsh-linux-amd64.tar.gz \
    --env EXPECTED_COMMIT="$commit" \
    --mount "type=bind,src=$source_root,dst=/workspace" \
    --mount "type=bind,src=$PAIR_STAGING,dst=/output" \
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
      tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --exclude=./.builder -C /workspace -cf - . | gzip -n >"$ARTIFACT_TEMP"
      digest=$(sha256sum "$ARTIFACT_TEMP")
      digest=${digest%% *}
      printf "%s  %s\n" "$digest" "$ARTIFACT_NAME" >"$CHECKSUM_TEMP"
    '

  publish_artifact_set "$PAIR_STAGING" "$final_dir" "$output_dir" || fail 'artifact-set validation or atomic publication failed'
  printf 'Packaged commit %s as atomic artifact set %s.\n' "$commit" "${final_dir##*/}"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
