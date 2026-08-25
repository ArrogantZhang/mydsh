/** Contract tests for the single-host Alibaba Cloud deployment assets. */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const deploymentRoot = resolve(import.meta.dirname, '../deploy/alibaba-cloud')
const linuxFilesystemTestsEnabled = process.platform === 'linux'

function asset(name: string): string {
  return readFileSync(resolve(deploymentRoot, name), 'utf8')
}

function runBash(body: string, assetName = 'deploy-release.sh'): ReturnType<typeof spawnSync> {
  if (!linuxFilesystemTestsEnabled) throw new Error('real Bash filesystem tests run only on Linux CI')
  const deploymentScript = resolve(deploymentRoot, assetName)
  const sourceCommand = `source '${deploymentScript.replaceAll("'", "'\\''")}'\n${body}`
  return spawnSync('bash', ['-s'], { encoding: 'utf8', input: sourceCommand })
}

function expectBashSuccess(body: string, assetName?: string): void {
  const result = runBash(body, assetName)
  const stderr = typeof result.stderr === 'string' ? result.stderr : result.stderr?.toString()
  expect(result.error).toBeUndefined()
  expect(result.status, stderr).toBe(0)
}

describe('Alibaba Cloud deployment assets', () => {
  it('keeps Caddy as the only public entry point', () => {
    const caddyfile = asset('Caddyfile')

    expect(caddyfile).toMatch(/^\{\$DSH_PUBLIC_HOST\} \{/m)
    expect(caddyfile).toContain('Strict-Transport-Security "max-age=15552000"')
    expect(caddyfile).toMatch(/@invite\s+path \/__invite \/__invite\/\*/)
    expect(caddyfile).toMatch(/handle @invite \{[\s\S]*?reverse_proxy 127\.0\.0\.1:3080/)
    const guardedHandle = caddyfile.slice(caddyfile.indexOf('\thandle {\n'))
    expect(guardedHandle).toMatch(/forward_auth 127\.0\.0\.1:3080 \{/)
    expect(guardedHandle).toContain('uri /__invite/check')
    expect(guardedHandle.indexOf('forward_auth')).toBeLessThan(guardedHandle.indexOf('reverse_proxy'))
    expect(caddyfile.match(/header_up X-DSH-Invite-Client-IP \{remote_host\}/g)).toHaveLength(2)
    expect(caddyfile.match(/header_up X-Forwarded-Proto \{scheme\}/g)).toHaveLength(2)
    expect(caddyfile.match(/header_up X-Forwarded-Host \{host\}/g)).toHaveLength(2)
    expect(caddyfile).not.toMatch(/(?:^|\s):3080(?:\s|$)/m)
    expect(caddyfile).not.toContain(';')
  })

  it('runs one hardened loopback-only DSH service', () => {
    const unit = asset('mydsh.service')

    expect(unit).toContain('Wants=network-online.target')
    expect(unit).toContain('After=network-online.target')
    expect(unit).toContain('StartLimitIntervalSec=60')
    expect(unit).toContain('StartLimitBurst=5')
    expect(unit).toContain('Type=simple')
    expect(unit).toContain('User=mydsh')
    expect(unit).toContain('Group=mydsh')
    expect(unit).toContain('WorkingDirectory=/srv/mydsh/workspace')
    expect(unit).toContain('Environment=NODE_ENV=production')
    expect(unit).toContain('EnvironmentFile=/etc/mydsh/public.env')
    expect(unit).toContain('EnvironmentFile=/etc/mydsh/mydsh.env')
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/mydsh/current/apps/cli/lib/bin.js web --patch /opt/mydsh/current/deploy/alibaba-cloud/invite-auth.cordis.yml --no-open --trusted-host ${DSH_PUBLIC_HOST}')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('RestartSec=5s')
    expect(unit).toContain('TimeoutStopSec=30s')
    expect(unit).toContain('UMask=0077')
    expect(unit).toContain('NoNewPrivileges=true')
    expect(unit).toContain('PrivateTmp=true')
    expect(unit).toContain('ProtectSystem=strict')
    expect(unit).toContain('ProtectHome=true')
    expect(unit).toContain('ReadWritePaths=/var/lib/mydsh /srv/mydsh/workspace')
    expect(unit).toContain('WantedBy=multi-user.target')
    expect(unit).not.toMatch(/SystemCallFilter|IPAddressDeny|RestrictAddressFamilies/)
  })

  it('shares only the public hostname with Caddy', () => {
    const dropIn = asset('caddy-mydsh.conf')

    expect(dropIn).toContain('[Service]')
    expect(dropIn).toContain('EnvironmentFile=/etc/mydsh/public.env')
    expect(dropIn).not.toContain('mydsh.env')
    expect(dropIn).not.toMatch(/DSH_INVITE_(?:CODE|SESSION)_SECRET/)
  })

  it('bootstraps the host without accepting or printing secrets', () => {
    const script = asset('bootstrap-host.sh')

    expect(script).toMatch(/^#!\/usr\/bin\/env bash\nset -euo pipefail\n/)
    expect(script).toMatch(/\[\[ \$# -eq 1 \]\]/)
    expect(script).toMatch(/\^\(\[a-z0-9\]/)
    expect(script).toContain('mktemp -d')
    expect(script).toContain('trap cleanup EXIT')
    expect(script).not.toContain('set -x')
    expect(script).toContain('https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key')
    expect(script).toContain('6F71F525282841EEDAF851B42F59B5F99B1BE0B4')
    expect(script).toContain('https://deb.nodesource.com/node_24.x nodistro main')
    expect(script).not.toContain('setup_24.x')
    expect(script).not.toMatch(/curl[^\n]*\|[^\n]*(?:bash|sh)|bash[^\n]*nodesource/i)
    expect(script).toContain('https://dl.cloudsmith.io/public/caddy/stable/gpg.key')
    expect(script).toContain('65760C51EDEA2017CEA2CA15155B6D79CA56EA34')
    expect(script).toContain('[[ ${#fingerprints[@]} -eq 1 ]]')
    expect(script).toContain('https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main')
    expect(script).toContain('npm install --global --ignore-scripts "$tarball"')
    expect(script).toContain('sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA==')
    expect(script).toContain('https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz')
    expect(script).toContain('mydsh-nodesource.gpg')
    expect(script).toContain('mydsh-caddy-stable.gpg')
    expect(script).toMatch(/node --version[\s\S]*24/)
    expect(script).toMatch(/pnpm --version[\s\S]*11\.7\.0/)
    expect(script).toContain('openssl rand -hex 16')
    expect(script).toContain('openssl rand -hex 32')
    expect(script).toContain('if [[ -e /etc/mydsh/mydsh.env || -L /etc/mydsh/mydsh.env ]]')
    expect(script).toContain('DSH_HOME=/var/lib/mydsh')
    expect(script).toContain('DSH_INVITE_CODE_SECRET=')
    expect(script).toContain('DSH_INVITE_SESSION_SECRET=')
    expect(script).toContain('ensure_managed_directory /opt/mydsh root root 0755')
    expect(script).toContain('ensure_managed_directory /opt/mydsh/releases root root 0755')
    expect(script).toContain('ensure_managed_directory /var/lib/mydsh mydsh mydsh 0700')
    expect(script).toContain('ensure_managed_directory /srv/mydsh/workspace mydsh mydsh 0750')
    expect(script).toContain('mydsh-build')
    expect(script).not.toContain('ensure_managed_directory /var/lib/mydsh-build')
    expect(script).not.toContain('ensure_managed_directory /var/cache/mydsh-build')
    expect(script).toContain('ensure_managed_directory /var/lib/mydsh-deploy root root 0700')
    expect(script).toContain('ensure_managed_directory /srv/mydsh root root 0755')
    expect(script).toContain('validate_ancestor_chain')
    expect(script).toContain('preflight_managed_paths')
    expect(script).toContain('active_bootstrap_matches')
    expect(script).toContain('resolved_current=$(realpath -e -- "$current_path")')
    expect(script).toContain('[[ $resolved_current == "$releases_root/$commit" ]]')
    expect(script).toContain('/usr/local/sbin/mydsh-deploy-release')
    expect(script).toMatch(/install_managed_file .*deploy-release\.sh.*\/usr\/local\/sbin\/mydsh-deploy-release 0755/)
    expect(script).toContain('/run/lock/mydsh-deploy.lock')
    expect(script).toContain('flock -n')
    expect(script).toContain('validate_lock_path')
    expect(script).toContain('ensure_managed_directory')
    expect(script).toContain('validate_existing_managed_file')
    expect(script).toContain('create_registered_temp_file')
    expect(script).toContain('cleanup_registered_temp_files')
    expect(script).toMatch(/caddy validate --config \/etc\/caddy\/Caddyfile --adapter caddyfile/)
    expect(script).toContain('systemctl enable caddy')
    expect(script).toContain('systemctl restart caddy')
    expect(script).not.toMatch(/systemctl (?:enable|start|restart).*mydsh/)
    expect(script).toContain('Managed by DeepSeek Harness Alibaba Cloud deployment')
    expect(script).not.toContain('.pre-mydsh')
    expect(script).toMatch(/mapfile -t entries < <\(getent passwd "\$name"\)/)
    expect(script).toContain('[[ ${#entries[@]} -eq 1 ]]')
    expect(script).toContain('$uid != 0 && $uid -lt 1000')
    expect(script).toMatch(/\/usr\/sbin\/nologin.*\/sbin\/nologin/)
    expect(script).toMatch(/if ! id mydsh[\s\S]*?\n  fi\n  validate_system_account mydsh \/var\/lib\/mydsh/)
    expect(script).toContain("printf 'DSH_INVITE_CODE_SECRET=%s\\n' \"$invite_code\"")
    expect(script).toContain("printf 'DSH_INVITE_SESSION_SECRET=%s\\n' \"$session_secret\"")
    expect(script).toContain('} >"$private_tmp"')
    expect(script).not.toMatch(/(?:invite_code|session_secret)[^\n]*(?:\/dev\/stdout|>&2)/i)
    const bootstrapMain = script.slice(script.indexOf('\nmain() {'))
    expect(bootstrapMain.indexOf('preflight_managed_paths')).toBeLessThan(bootstrapMain.indexOf('TEMP_DIR=$(mktemp'))
    expect(bootstrapMain.indexOf('preflight_managed_paths')).toBeLessThan(bootstrapMain.indexOf('apt-get update'))
  })

  it('isolates candidate builds and transacts release activation', () => {
    const script = asset('deploy-release.sh')

    expect(script).toMatch(/^#!\/usr\/bin\/env bash\n# Managed by DeepSeek Harness Alibaba Cloud deployment\nset -euo pipefail\n/)
    expect(script).toContain('Usage: sudo %s <git-bundle-file> <ref>')
    expect(script).toContain('sudo %s --rollback <40-character-lowercase-commit>')
    expect(script).toContain('sudo %s --prune <40-character-lowercase-commit>')
    expect(script).toMatch(/\[\[ \$# -eq 2 \]\]/)
    expect(script).not.toContain('set -x')
    expect(script).toContain('realpath -e --')
    expect(script).toContain('trusted_git -C "$trusted_repository" bundle verify "$trusted_bundle"')
    expect(script).toContain('env -i PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git "$@"')
    expect(script).toContain('git check-ref-format --branch')
    expect(script).toContain('$RELEASES_DIR/.build.XXXXXX')
    expect(script).not.toContain('$DEPLOY_STATE_ROOT/build.XXXXXX')
    expect(script).toContain('staged_bundle="$operation_root/release.bundle"')
    expect(script).toMatch(/install .*"\$trusted_bundle" "\$staged_bundle"/)
    expect(script).toContain('git clone --branch "$ref" --single-branch "$bundle" "$checkout"')
    expect(script).toContain("rev-parse 'FETCH_HEAD^{commit}'")
    expect(script).toContain('builder_commit=$(env -i')
    expect(script).toContain('GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -C "$checkout" rev-parse HEAD')
    expect(script).toContain('[[ $builder_commit == "$trusted_commit" ]]')
    expect(script).toContain('install --frozen-lockfile --store-dir "$cache"')
    expect(script).toMatch(/vitest run packages\/host\/invite-auth\/tests/)
    expect(script).toContain('pnpm --dir "$checkout" run build')
    expect(script).toContain('--dump-config')
    expect(script).toContain('chown -R root:root')
    expect(script).toContain('chmod 0755 "$publish_root"')
    expect(script).toContain('chmod -R go-w')
    expect(script).toContain('caddy validate --config "$installed_caddy" --adapter caddyfile')
    expect(script).toContain('local next_path="${current_path}.next"')
    expect(script).toContain('ln -s -- "$target" "$next_path"')
    expect(script).toContain('mv -Tf -- "$next_path" "$current_path"')
    expect(script).toMatch(/for .* in \{1\.\.30\}/)
    expect(script).toContain('http://127.0.0.1:3080/__invite/login')
    expect(script).toMatch(/if health_check "\$target"; then/)
    expect(script).toMatch(/recover_activation_journal[\s\S]*systemctl restart mydsh/)
    expect(script).toContain('systemctl reload caddy')
    expect(script).toContain('/etc/systemd/system/caddy.service.d/mydsh.conf')
    expect(script).toContain('uid=$(id -u "$name")')
    expect(script).toContain('$uid != 0 && $uid -lt 1000')
    expect(script).toContain('getent passwd "$name"')
    expect(script).toContain('[[ ${#entries[@]} -eq 1 ]]')
    expect(script).toContain('nologin')
    expect(script).toContain('if [[ ${BASH_SOURCE[0]} == "$0" ]]')
    expect(script).toContain('/run/lock/mydsh-deploy.lock')
    expect(script).toContain('flock -n')
    expect(script).toContain('validate_lock_path')
    expect(script).toContain('run_builder')
    expect(script).toContain('systemd-run --wait --collect --pipe')
    expect(script).toContain('KillMode=control-group')
    expect(script).toContain('HOME="$operation_root/home"')
    expect(script).toContain('XDG_CONFIG_HOME="$operation_root/xdg-config"')
    expect(script).toContain('XDG_CACHE_HOME="$operation_root/xdg-cache"')
    expect(script).toContain('NPM_CONFIG_USERCONFIG=/dev/null')
    expect(script).toContain('NPM_CONFIG_GLOBALCONFIG=/dev/null')
    expect(script).toContain('GIT_CONFIG_NOSYSTEM=1')
    expect(script).toContain('GIT_CONFIG_GLOBAL=/dev/null')
    expect(script).toContain('cp -a --reflink=never')
    expect(script).toContain('install_trusted_release_assets')
    expect(script).toContain('/var/lib/mydsh-deploy/activation')
    expect(script).toContain('recover_activation_journal')
    expect(script).toContain('write_journal_state "$journal" prepared')
    expect(script).toContain('write_journal_state "$journal" committed')
    expect(script).toContain('root-helper')
    expect(script).not.toMatch(/runuser -u mydsh -- (?:git|pnpm|env|node)/)
    expect(script).not.toContain('DSH_HOME=/var/lib/mydsh /usr/bin/node')
    expect(script).toContain('systemd-analyze')
    expect(script).toContain('bash -n "$helper_candidate"')
    expect(script).toContain('stage_candidate_configs')
    expect(script).toContain('restore_host_configs')
    expect(script).toContain('systemctl is-active --quiet mydsh')
    expect(script).toContain('MainPID')
    expect(script).toContain('stat -c %U "/proc/$main_pid"')
    expect(script).toContain('public_acceptance')
    expect(script).toContain('authenticated_acceptance')
    expect(script).toContain('cmp -- "$trusted_assets/$candidate_path"')
    expect(script).toContain('create_registered_temp_file')
    expect(script).toContain('cleanup_registered_temp_files')
    expect(script).toContain('activation accepted but committed journal cleanup was not durable')
    expect(script).toContain('[[ $1 == --prune ]]')
    expect(script).toContain('prune_release')
    expect(script).not.toMatch(/rm -rf -- \/opt\/mydsh\/releases(?:\s|$)/m)
    expect(script).not.toMatch(/DSH_INVITE_(?:CODE|SESSION)_SECRET[^\n]*(?:>&2|\/dev\/stdout)/)
    const main = script.slice(script.indexOf('\nmain() {'))
    expect(main.indexOf('recover_activation_journal "$ACTIVATION_DIR"')).toBeLessThan(main.indexOf('\n  validate_host'))
    const deploy = script.slice(script.indexOf('\ndeploy_bundle() {'), script.indexOf('\nmain() {'))
    expect(deploy.indexOf('validate_candidate_configs "$trusted_assets"')).toBeLessThan(deploy.indexOf('publish_builder_checkout'))
  })

  it('limits GNU filesystem integration to Linux CI', () => {
    expect(linuxFilesystemTestsEnabled).toBe(process.platform === 'linux')
    if (!linuxFilesystemTestsEnabled) expect(() => runBash('true')).toThrow('only on Linux CI')
  })

  // atomic_replace_link uses GNU mv -T. Linux CI executes these tests; Windows
  // keeps static coverage without requiring WSL, and macOS avoids BSD mv.
  describe.runIf(linuxFilesystemTestsEnabled)('Linux release-link helpers', () => {
    it('atomically replaces the current link with an adjacent next link', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
old="$root/${'a'.repeat(40)}"
new="$root/${'b'.repeat(40)}"
mkdir "$old" "$new"
ln -s "$old" "$root/current"
atomic_replace_link "$root/current" "$new"
[[ $(readlink "$root/current") == "$new" ]]
[[ ! -e "$root/current.next" && ! -L "$root/current.next" ]]
`)
    })

    it('refuses a non-symlink next path without changing current', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
old="$root/${'a'.repeat(40)}"
new="$root/${'b'.repeat(40)}"
mkdir "$old" "$new" "$root/current.next"
ln -s "$old" "$root/current"
if atomic_replace_link "$root/current" "$new"; then exit 90; fi
[[ $(readlink "$root/current") == "$old" ]]
[[ -d "$root/current.next" ]]
`)
    })

    it('leaves current unchanged and cleans next when link creation fails', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
old="$root/${'a'.repeat(40)}"
new="$root/${'b'.repeat(40)}"
mkdir "$old" "$new"
ln -s "$old" "$root/current"
ln() { return 42; }
if atomic_replace_link "$root/current" "$new"; then exit 90; fi
[[ $(readlink "$root/current") == "$old" ]]
[[ ! -e "$root/current.next" && ! -L "$root/current.next" ]]
`)
    })

    it('rejects a commit directory outside the canonical releases root', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
commit=${'c'.repeat(40)}
mkdir -p "$root/releases/$commit" "$root/outside/$commit"
validate_release_target "$root/releases/$commit" "$root/releases"
if validate_release_target "$root/outside/$commit" "$root/releases"; then exit 90; fi
`)
    })

    it('documents every helper form and rejects commit-named release symlinks', () => {
      expectBashSuccess(`
set -euo pipefail
usage_output=$(usage 2>&1)
grep -F -- '<git-bundle-file> <ref>' <<<"$usage_output"
grep -F -- '--rollback <40-character-lowercase-commit>' <<<"$usage_output"
grep -F -- '--prune <40-character-lowercase-commit>' <<<"$usage_output"
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
real=${'1'.repeat(40)}
alias=${'2'.repeat(40)}
mkdir -p "$root/releases/$real"
ln -s "$root/releases/$real" "$root/releases/$alias"
ln -s "$root/releases/$real" "$root/current"
if validate_release_target "$root/releases/$alias" "$root/releases"; then exit 90; fi
if prune_release "$alias" "$root/releases" "$root/current"; then exit 91; fi
[[ -L "$root/releases/$alias" && -d "$root/releases/$real" ]]
activate_transaction() { touch "$root/activated"; return 0; }
if (rollback_to_commit "$alias" "$root/releases" "$root/current"); then exit 92; fi
[[ ! -e "$root/activated" && -d "$root/releases/$real" ]]
`)
    })

    it('rejects directory symlinks and unsafe managed files', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
mkdir "$root/real"
ln -s "$root/real" "$root/managed"
if (ensure_managed_directory "$root/managed" "$(id -un)" "$(id -gn)" 0700); then exit 90; fi
mkdir "$root/outside"
ln -s "$root/outside" "$root/ancestor"
if (ensure_managed_directory "$root/ancestor/child" "$(id -un)" "$(id -gn)" 0700); then exit 93; fi
[[ ! -e "$root/outside/child" ]]
printf 'private\n' >"$root/private-real"
ln -s "$root/private-real" "$root/private.env"
if (validate_existing_managed_file "$root/private.env"); then exit 91; fi
printf 'unmanaged\n' >"$root/unmanaged"
stat() { printf 'root:root\n'; }
if (validate_existing_managed_file "$root/unmanaged"); then exit 92; fi
`, 'bootstrap-host.sh')
    })

    it('preflights all managed ancestors before directory mutation', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
mkdir "$root/outside"
ln -s "$root/outside" "$root/late-ancestor"
install() { printf 'mutated\n' >"$root/mutated"; }
if (preflight_managed_paths "$root/early/child" "$root/late-ancestor/child"); then exit 90; fi
[[ ! -e "$root/mutated" && ! -e "$root/outside/child" ]]
`, 'bootstrap-host.sh')
    })

    it('copies builder output to new root-private inodes and rejects invalid checkout types', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
mkdir -p "$root/releases" "$root/checkout"
printf '{}\n' >"$root/checkout/package.json"
commit=${'3'.repeat(40)}
chown() { return 0; }
publish_builder_checkout "$root/checkout" "$root/releases/$commit" "$root/releases"
[[ $(stat -c %i "$root/checkout/package.json") != "$(stat -c %i "$root/releases/$commit/package.json")" ]]
[[ $(stat -c %a "$root/releases/$commit") == 755 ]]
alias=${'4'.repeat(40)}
ln -s "$root/checkout" "$root/aliased-checkout"
if publish_builder_checkout "$root/aliased-checkout" "$root/releases/$alias" "$root/releases"; then exit 90; fi
[[ ! -e "$root/releases/$alias" ]]
file=${'5'.repeat(40)}
printf 'not a directory\n' >"$root/not-directory"
if publish_builder_checkout "$root/not-directory" "$root/releases/$file" "$root/releases"; then exit 91; fi
[[ ! -e "$root/releases/$file" ]]
`)
    })

    it('removes a poisoned new publication without following its trusted-asset alias', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
commit=${'a'.repeat(39)}b
target="$root/releases/$commit"
assets="$root/assets"
outside="$root/outside"
mkdir -p "$target" "$assets" "$outside"
for name in Caddyfile mydsh.service caddy-mydsh.conf deploy-release.sh; do printf '%s\n' "$MANAGED_MARKER" >"$assets/$name"; done
printf 'untouched\n' >"$outside/sentinel"
ln -s "$outside" "$target/.mydsh-trusted-deploy"
if install_trusted_release_assets "$target" "$assets" "$root/releases"; then exit 90; fi
[[ ! -e "$target" && ! -L "$target" ]]
grep -Fx untouched "$outside/sentinel"
`)
    })

    it('refuses active bootstrap drift without changing host files', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
source_dir="$root/source"; host="$root/host"; current="$root/current"; releases="$root/releases"; commit=${'8'.repeat(40)}
mkdir -p "$source_dir" "$host/etc/caddy" "$host/etc/systemd/system/caddy.service.d" "$host/usr/local/sbin" "$host/etc/mydsh" "$releases/$commit"
for spec in 'Caddyfile:etc/caddy/Caddyfile' 'mydsh.service:etc/systemd/system/mydsh.service' 'caddy-mydsh.conf:etc/systemd/system/caddy.service.d/mydsh.conf' 'deploy-release.sh:usr/local/sbin/mydsh-deploy-release'; do
  name=\${spec%%:*}; path=\${spec#*:}; printf '%s\nmatch\n' "$MANAGED_MARKER" >"$source_dir/$name"; cp "$source_dir/$name" "$host/$path"
done
printf '%s\nDSH_PUBLIC_HOST=dsh.example.com\n' "$MANAGED_MARKER" >"$host/etc/mydsh/public.env"
ln -s "$releases/$commit" "$current"
validate_existing_managed_file() { grep -Fqx "$MANAGED_MARKER" "$1"; }
active_bootstrap_matches dsh.example.com "$source_dir" "$host" "$current" "$releases"
before=$(sha256sum "$host/etc/caddy/Caddyfile")
printf '%s\ndrift\n' "$MANAGED_MARKER" >"$source_dir/Caddyfile"
if active_bootstrap_matches dsh.example.com "$source_dir" "$host" "$current" "$releases"; then exit 90; fi
after=$(sha256sum "$host/etc/caddy/Caddyfile")
[[ $before == "$after" ]]
`,'bootstrap-host.sh')
    })

    it('removes registered target-directory temps when atomic rename fails', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
chown() { return 0; }
chmod() { return 0; }
mv() { return 1; }
if write_managed_file "$root/private.env" 0600 'DSH_INVITE_CODE_SECRET=not-a-real-secret'; then exit 90; fi
if compgen -G "$root/.mydsh-tmp.*" >/dev/null; then exit 91; fi
if grep -R -F 'not-a-real-secret' "$root" >/dev/null 2>&1; then exit 92; fi
`, 'bootstrap-host.sh')
    })

    it('refuses a second operation while the shared lock is held', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
touch "$root/victim"
ln -s "$root/victim" "$root/symlink-lock"
if (acquire_operation_lock "$root/symlink-lock" "$(id -un):$(id -gn)"); then exit 89; fi
(
  exec 9>"$root/lock"
  flock -n 9
  touch "$root/held"
  sleep 2
) &
holder=$!
for attempt in {1..20}; do [[ -e "$root/held" ]] && break; sleep 0.05; done
[[ -e "$root/held" ]]
if (acquire_operation_lock "$root/lock" "$(id -un):$(id -gn)"); then exit 90; fi
wait "$holder"
`)
    })

    it('constructs a sanitized builder command', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
operation_root="$root/operation"; mkdir -p "$operation_root"
systemd-run() { printf '%s\n' "$*" >"$root/argv"; }
systemctl() { return 1; }
run_builder "$operation_root" "$root/bundle" reviewed-ref "$operation_root/checkout"
grep -F -- '--wait --collect --pipe' "$root/argv"
grep -F -- '--uid=mydsh-build --gid=mydsh-build' "$root/argv"
grep -F -- 'KillMode=control-group' "$root/argv"
grep -F -- "HOME=$operation_root/home" "$root/argv"
grep -F -- 'NPM_CONFIG_USERCONFIG=/dev/null' "$root/argv"
grep -F -- 'NPM_CONFIG_GLOBALCONFIG=/dev/null' "$root/argv"
grep -F -- 'GIT_CONFIG_NOSYSTEM=1' "$root/argv"
if grep -F -- 'DSH_HOME=/var/lib/mydsh ' "$root/argv"; then exit 90; fi
if grep -E -- 'DSH_INVITE_|/srv/mydsh/workspace' "$root/argv"; then exit 91; fi
`)
    })

    it('waits for a controlled build group to quiesce before returning', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
mkdir -p "$root/operation/checkout"
printf 'builder-output\n' >"$root/operation/checkout/artifact"
systemd-run() {
  bash -c 'exec 9>>"$1"; printf "%s\n" "$BASHPID" >"$2"; sleep 300' proof-child "$root/operation/checkout/artifact" "$root/child.pid" &
  child=$!
  for _attempt in {1..100}; do [[ -s "$root/child.pid" ]] && break; sleep 0.01; done
  kill "$child"
  wait "$child" 2>/dev/null || true
  printf 'quiesced\n' >"$root/quiesced"
}
systemctl() { return 1; }
run_builder "$root/operation" "$root/bundle" reviewed-ref "$root/operation/checkout"
child=$(<"$root/child.pid")
[[ -f "$root/quiesced" ]]
if kill -0 "$child" 2>/dev/null; then exit 90; fi
`)
    })

    it('restores update and first-deploy configuration transactions', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
host="$root/host"
candidate="$root/candidate"
previous="$root/${'a'.repeat(40)}"
mkdir -p "$host/etc/caddy" "$host/etc/systemd/system/caddy.service.d" "$host/usr/local/sbin" "$candidate/deploy/alibaba-cloud" "$previous"
for spec in 'Caddyfile:etc/caddy/Caddyfile' 'mydsh.service:etc/systemd/system/mydsh.service' 'caddy-mydsh.conf:etc/systemd/system/caddy.service.d/mydsh.conf'; do
  name=\${spec%%:*}; path=\${spec#*:}
  printf '%s\nold\n' "$MANAGED_MARKER" >"$host/$path"
  printf '%s\nnew\n' "$MANAGED_MARKER" >"$candidate/deploy/alibaba-cloud/$name"
done
printf '%s\nold\n' "$MANAGED_MARKER" >"$host/usr/local/sbin/mydsh-deploy-release"
printf '%s\nnew\n' "$MANAGED_MARKER" >"$candidate/deploy/alibaba-cloud/deploy-release.sh"
validate_candidate_configs() { return 0; }
validate_existing_managed_file() { grep -Fqx "$MANAGED_MARKER" "$1"; }
install() {
  if [[ " $* " == *' -d '* ]]; then mkdir -p "\${@: -1}"; else cp -- "\${@: -2:1}" "\${@: -1}"; fi
}
systemctl() { return 0; }
caddy() { return 0; }
health_check() { return 0; }
authenticated_acceptance() { return 0; }
public_acceptance() { return 0; }
ln -s "$previous" "$root/current"
activate_transaction "$candidate" "$previous" "$candidate/deploy/alibaba-cloud" "$host" "$root/current" "$root/activation"
[[ $(readlink "$root/current") == "$candidate" ]]
grep -Fx new "$host/etc/caddy/Caddyfile"
rm -f "$root/current"
ln -s "$previous" "$root/current"
for spec in 'Caddyfile:etc/caddy/Caddyfile' 'mydsh.service:etc/systemd/system/mydsh.service' 'caddy-mydsh.conf:etc/systemd/system/caddy.service.d/mydsh.conf'; do
  path=\${spec#*:}; printf '%s\nold\n' "$MANAGED_MARKER" >"$host/$path"
done
public_acceptance() { return 1; }
if activate_transaction "$candidate" "$previous" "$candidate/deploy/alibaba-cloud" "$host" "$root/current" "$root/activation"; then exit 90; fi
[[ $(readlink "$root/current") == "$previous" ]]
grep -Fx old "$host/etc/caddy/Caddyfile"
grep -Fx old "$host/etc/systemd/system/mydsh.service"
grep -Fx old "$host/etc/systemd/system/caddy.service.d/mydsh.conf"
rm -f "$root/current"
if activate_transaction "$candidate" '' "$candidate/deploy/alibaba-cloud" "$host" "$root/current" "$root/activation"; then exit 91; fi
[[ ! -e "$root/current" && ! -L "$root/current" ]]
grep -Fx old "$host/etc/caddy/Caddyfile"
`)
    })

    it('keeps an accepted activation successful when backup cleanup fails', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'command rm -rf -- "$root"' EXIT
host="$root/host"
candidate="$root/candidate"
previous="$root/${'a'.repeat(40)}"
mkdir -p "$host/etc/caddy" "$host/etc/systemd/system/caddy.service.d" "$host/usr/local/sbin" "$candidate/deploy/alibaba-cloud" "$previous"
for spec in 'Caddyfile:etc/caddy/Caddyfile' 'mydsh.service:etc/systemd/system/mydsh.service' 'caddy-mydsh.conf:etc/systemd/system/caddy.service.d/mydsh.conf'; do
  name=\${spec%%:*}; path=\${spec#*:}
  printf '%s\nold\n' "$MANAGED_MARKER" >"$host/$path"
  printf '%s\nnew\n' "$MANAGED_MARKER" >"$candidate/deploy/alibaba-cloud/$name"
done
printf '%s\nold\n' "$MANAGED_MARKER" >"$host/usr/local/sbin/mydsh-deploy-release"
printf '%s\nnew\n' "$MANAGED_MARKER" >"$candidate/deploy/alibaba-cloud/deploy-release.sh"
validate_candidate_configs() { return 0; }
validate_existing_managed_file() { grep -Fqx "$MANAGED_MARKER" "$1"; }
install() { if [[ " $* " == *' -d '* ]]; then mkdir -p "\${@: -1}"; else cp -- "\${@: -2:1}" "\${@: -1}"; fi; }
systemctl() { return 0; }
caddy() { return 0; }
health_check() { return 0; }
public_acceptance() { return 0; }
authenticated_acceptance() { return 0; }
rm() { [[ "\${*: -1}" == */activation ]] && return 1; command rm "$@"; }
ln -s "$previous" "$root/current"
activate_transaction "$candidate" "$previous" "$candidate/deploy/alibaba-cloud" "$host" "$root/current" "$root/activation" 2>"$root/warning"
[[ $(readlink "$root/current") == "$candidate" ]]
grep -Fx new "$host/etc/caddy/Caddyfile"
grep -F 'activation accepted but committed journal cleanup was not durable' "$root/warning"
`)
    })

    it('retains and recovers durable prepared and committed journals', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
host="$root/host"; assets="$root/assets"; previous="$root/${'a'.repeat(40)}"; candidate="$root/${'b'.repeat(40)}"; journal="$root/activation"
mkdir -p "$host/etc/caddy" "$host/etc/systemd/system/caddy.service.d" "$host/usr/local/sbin" "$assets" "$previous" "$candidate"
for spec in 'Caddyfile:etc/caddy/Caddyfile' 'mydsh.service:etc/systemd/system/mydsh.service' 'caddy-mydsh.conf:etc/systemd/system/caddy.service.d/mydsh.conf' 'deploy-release.sh:usr/local/sbin/mydsh-deploy-release'; do
  name=\${spec%%:*}; path=\${spec#*:}; printf '%s\nold\n' "$MANAGED_MARKER" >"$host/$path"; printf '%s\nnew\n' "$MANAGED_MARKER" >"$assets/$name"
done
validate_existing_managed_file() { grep -Fqx "$MANAGED_MARKER" "$1"; }
install() { if [[ " $* " == *' -d '* ]]; then mkdir -p "\${@: -1}"; else cp -- "\${@: -2:1}" "\${@: -1}"; fi; }
systemctl() { return 0; }; caddy() { return 0; }; health_check() { return 0; }; sync() { return 0; }
ln -s "$previous" "$root/current"
prepare_activation_journal "$journal" "$candidate" "$previous" "$assets" "$host"
stage_candidate_configs "$assets" "$host"
atomic_replace_link "$root/current" "$candidate"
restore_host_configs_real=$(declare -f restore_host_configs)
restore_host_configs() { return 1; }
if recover_activation_journal "$journal" "$host" "$root/current"; then exit 90; fi
[[ -d "$journal" && $(readlink "$root/current") == "$candidate" ]]
eval "$restore_host_configs_real"
recover_activation_journal "$journal" "$host" "$root/current"
[[ ! -e "$journal" && $(readlink "$root/current") == "$previous" ]]
prepare_activation_journal "$journal" "$candidate" "$previous" "$assets" "$host"
write_journal_state "$journal" committed
rm() { return 1; }
if recover_activation_journal "$journal" "$host" "$root/current"; then exit 91; fi
[[ -d "$journal" && $(readlink "$root/current") == "$previous" ]]
unset -f rm
recover_activation_journal "$journal" "$host" "$root/current"
[[ ! -e "$journal" && $(readlink "$root/current") == "$previous" ]]
`)
    })

    it('rolls back when the accepted state cannot be journaled', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
host="$root/host"; assets="$root/assets"; previous="$root/${'6'.repeat(40)}"; candidate="$root/${'7'.repeat(40)}"; journal="$root/activation"
mkdir -p "$host/etc/caddy" "$host/etc/systemd/system/caddy.service.d" "$host/usr/local/sbin" "$assets" "$previous" "$candidate"
for spec in 'Caddyfile:etc/caddy/Caddyfile' 'mydsh.service:etc/systemd/system/mydsh.service' 'caddy-mydsh.conf:etc/systemd/system/caddy.service.d/mydsh.conf' 'deploy-release.sh:usr/local/sbin/mydsh-deploy-release'; do
  name=\${spec%%:*}; path=\${spec#*:}; printf '%s\nold\n' "$MANAGED_MARKER" >"$host/$path"; printf '%s\nnew\n' "$MANAGED_MARKER" >"$assets/$name"
done
validate_candidate_configs() { return 0; }
validate_existing_managed_file() { grep -Fqx "$MANAGED_MARKER" "$1"; }
install() { if [[ " $* " == *' -d '* ]]; then mkdir -p "\${@: -1}"; else cp -- "\${@: -2:1}" "\${@: -1}"; fi; }
systemctl() { return 0; }; caddy() { return 0; }; health_check() { return 0; }; public_acceptance() { return 0; }; authenticated_acceptance() { return 0; }; sync() { return 0; }
eval "$(declare -f write_journal_state | sed '1s/write_journal_state/write_journal_state_real/')"
write_journal_state() { [[ $2 != committed ]] || return 1; write_journal_state_real "$@"; }
ln -s "$previous" "$root/current"
if activate_transaction "$candidate" "$previous" "$assets" "$host" "$root/current" "$journal"; then exit 90; fi
[[ $(readlink "$root/current") == "$previous" ]]
grep -Fx old "$host/etc/caddy/Caddyfile"
[[ ! -e "$journal" ]]
`)
    })

    it('fails safely when transaction temp creation fails', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
candidate="$root/candidate"
mkdir -p "$candidate/deploy/alibaba-cloud"
for name in Caddyfile mydsh.service caddy-mydsh.conf; do printf '%s\n' "$MANAGED_MARKER" >"$candidate/deploy/alibaba-cloud/$name"; done
caddy() { return 0; }
mktemp() { return 1; }
mkdir() { printf 'touched\n' >>"$root/commands"; return 0; }
install() { printf 'touched\n' >>"$root/commands"; return 0; }
if validate_candidate_configs "$candidate"; then exit 90; fi
[[ ! -e "$root/commands" ]]
validate_candidate_configs() { return 0; }
stage_candidate_configs() { printf 'touched\n' >>"$root/commands"; return 0; }
prepare_activation_journal() { return 1; }
if activate_transaction "$candidate" '' "$candidate/deploy/alibaba-cloud" "$root/host" "$root/current" "$root/activation"; then exit 91; fi
[[ ! -e "$root/commands" ]]
`)
    })

    it('prunes only an inactive exact release under the operation lock', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
active=${'e'.repeat(40)}
inactive=${'f'.repeat(40)}
mkdir -p "$root/releases/$active" "$root/releases/$inactive"
ln -s "$root/releases/$active" "$root/current"
if prune_release "$active" "$root/releases" "$root/current"; then exit 90; fi
[[ -d "$root/releases/$active" ]]
(exec 9>"$root/lock"; flock -n 9; touch "$root/held"; sleep 2) &
holder=$!
for attempt in {1..20}; do [[ -e "$root/held" ]] && break; sleep 0.05; done
if (acquire_operation_lock "$root/lock" "$(id -un):$(id -gn)"; prune_release "$inactive" "$root/releases" "$root/current"); then exit 91; fi
[[ -d "$root/releases/$inactive" ]]
wait "$holder"
(acquire_operation_lock "$root/lock" "$(id -un):$(id -gn)"; prune_release "$inactive" "$root/releases" "$root/current")
[[ ! -e "$root/releases/$inactive" ]]
`)
    })
  })

  it('validates and reloads Caddy only after the switched DSH release is healthy', () => {
    const script = asset('deploy-release.sh')
    const start = script.indexOf('activate_transaction() {')
    const end = script.indexOf('\nrollback_to_commit()', start)
    const activation = script.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(activation.indexOf('atomic_replace_link "$current_path" "$target"')).toBeLessThan(activation.indexOf('systemctl restart mydsh'))
    expect(activation.indexOf('systemctl restart mydsh')).toBeLessThan(activation.indexOf('health_check'))
    expect(activation.indexOf('health_check')).toBeLessThan(activation.indexOf('caddy validate'))
    expect(activation.indexOf('caddy validate')).toBeLessThan(activation.indexOf('systemctl reload caddy'))
    expect(activation).toMatch(/if caddy validate[\s\S]*systemctl reload caddy[\s\S]*recover_activation_journal/)
  })

  it('documents complete acceptance and a confined rollback command', () => {
    for (const name of ['README.md', 'README.zh.md']) {
      const readme = asset(name)
      expect(readme).toContain('home_unauth_status')
      expect(readme).toContain('[[ $home_unauth_status == 303 ]]')
      expect(readme).toContain('/api/events.mux')
      expect(readme).toContain('[[ $api_unauth_status == 401 ]]')
      expect(readme).toContain('cookie_expiry')
      expect(readme).toContain('tampered_jar')
      expect(readme).toContain('[[ $tampered_status == 303 ]]')
      expect(readme).toContain('/__invite/logout')
      expect(readme).toContain('[[ $after_logout_status == 303 ]]')
      expect(readme).toContain('[[ $commit =~ ^[0-9a-f]{40}$ ]]')
      expect(readme).toContain('target=$(sudo realpath -e -- "/opt/mydsh/releases/$commit")')
      expect(readme).toContain('[[ ${target%/*} == /opt/mydsh/releases ]]')
      expect(readme).toContain('[[ ${target##*/} == "$commit" ]]')
      expect(readme).toContain('/usr/local/sbin/mydsh-deploy-release --rollback "$commit"')
      expect(readme).not.toContain('/opt/mydsh/current/deploy/alibaba-cloud/deploy-release.sh')
      expect(readme).toContain('DEPLOY_REF=')
      expect(readme).toContain('git archive "$DEPLOY_REF"')
      expect(readme).not.toContain('scp deploy/alibaba-cloud/{Caddyfile')
      expect(readme).not.toContain('feat/invite-auth-deployment')
      expect(readme).toContain('mktemp -d "$HOME/mydsh-deploy.XXXXXX"')
      expect(readme).toContain('git bundle verify')
      expect(readme).toMatch(/(?:does not|不).*authentic|真实性/i)
      expect(readme).toMatch(/selected rollback|选定的回滚/)
      expect(readme).toContain('rm -rf')
      expect(readme).toContain('if [[ \\$status == 0 ]]')
      expect(readme).toContain('/usr/local/sbin/mydsh-deploy-release --prune "$candidate"')
      expect(readme).not.toContain('sudo rm -rf -- "$target"')
    }
  })

  it('records the deployment trust and activation decision', () => {
    const noteRoot = resolve(import.meta.dirname, '../.agents/notes/implemented/feature')
    for (const name of [
      '2026-08-24-invite-code-web-authentication.md',
      '2026-08-24-invite-code-web-authentication.zh.md',
    ]) {
      const note = readFileSync(resolve(noteRoot, name), 'utf8')
      expect(note).toContain('/usr/local/sbin/mydsh-deploy-release')
      expect(note).toContain('mydsh-build')
      expect(note).toContain('transient service')
      expect(note).toContain('/var/lib/mydsh-deploy/activation')
      expect(note).toMatch(/serialized|串行/)
      expect(note).toContain('Git bundle')
      expect(note).toMatch(/release-contained|release 中的|release 内/)
      expect(note).toMatch(/runtime-user|运行时用户/)
      expect(note).toMatch(/code-only rollback|仅代码回滚/)
    }
  })

  it('keeps the deployment design aligned with the trusted control plane', () => {
    const designRoot = resolve(import.meta.dirname, '../docs/superpowers/specs')
    for (const name of [
      '2026-08-24-dsh-invite-auth-deployment-design.md',
      '2026-08-24-dsh-invite-auth-deployment-design.zh.md',
    ]) {
      const design = readFileSync(resolve(designRoot, name), 'utf8')
      expect(design).toContain('/usr/local/sbin/mydsh-deploy-release')
      expect(design).toContain('mydsh-build')
      expect(design).toContain('transient service')
      expect(design).toContain('/var/lib/mydsh-deploy/activation')
      expect(design).toContain('/run/lock/mydsh-deploy.lock')
      expect(design).toMatch(/systemd.*Caddy|systemd.*Caddy/)
      expect(design).toMatch(/public.*authenticated|公开.*认证/)
      expect(design).not.toMatch(/builds? as `mydsh`|以 `mydsh` 身份.*构建/)
    }
  })
})
