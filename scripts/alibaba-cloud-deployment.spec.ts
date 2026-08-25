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
    expect(script).not.toContain('npm install --global')
    expect(script).not.toContain('PNPM_INTEGRITY')
    expect(script).toContain('mydsh-nodesource.gpg')
    expect(script).toContain('mydsh-caddy-stable.gpg')
    expect(script).toMatch(/node --version[\s\S]*24/)
    expect(script).not.toMatch(/\bpnpm\b/)
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
    expect(script).not.toContain('mydsh-build')
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

  it('validates prebuilt artifacts and transacts release activation', () => {
    const script = asset('deploy-release.sh')

    expect(script).toMatch(/^#!\/usr\/bin\/env bash\n# Managed by DeepSeek Harness Alibaba Cloud deployment\nset -euo pipefail\n/)
    expect(script).toContain('Usage: sudo %s <prebuilt-linux-artifact.tar.gz> <sha256-sidecar>')
    expect(script).toContain('sudo %s --rollback <40-character-lowercase-commit>')
    expect(script).toContain('sudo %s --prune <40-character-lowercase-commit>')
    expect(script).toMatch(/\[\[ \$# -eq 2 \]\]/)
    expect(script).not.toContain('set -x')
    expect(script).toContain('realpath -e --')
    expect(script).toContain('$RELEASES_DIR/.extract.XXXXXX')
    expect(script).toContain('verify_artifact_checksum')
    expect(script).toContain('validate_archive_members')
    expect(script).toContain('validate_release_manifest')
    expect(script).toContain('helper_journal_format=1')
    expect(script).toContain('apps/cli/lib/bin.js')
    expect(script).toContain('apps/web/dist/index.html')
    expect(script).toContain('node_modules')
    expect(script).not.toMatch(/systemd-run|pnpm (?:install|run|exec)|git clone|--internal-build|mydsh-build/)
    expect(script).toContain('chown -R root:root')
    expect(script).toContain('chmod 0755 "$extract_root"')
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
    expect(script).toContain('sha256sum')
    expect(script).toContain('sync_activated_state')
    expect(script).toContain('listener_check')
    expect(script).toContain('/var/lib/mydsh-deploy/activation')
    expect(script).toContain('activation.new.XXXXXX')
    expect(script).toContain('mv -T -- "$staging" "$journal"')
    expect(script).toContain('cleanup_abandoned_journal_staging')
    expect(script).toContain('recover_activation_journal')
    expect(script).toContain('write_journal_state "$staging" prepared')
    expect(script).toContain('write_journal_state "$journal" committed')
    expect(script).toContain('rollback-required')
    expect(script).toContain('finalize_committed_journal')
    expect(script).toContain('recover_activation_journal "$journal" "$host_root" "$current_path" force')
    expect(script).not.toContain('activation accepted with committed journal retained')
    expect(script).toContain('service-enabled')
    expect(script).toContain('restore_service_enable_state')
    expect(script).not.toContain('root-helper')
    expect(script).not.toMatch(/runuser -u mydsh -- (?:git|pnpm|env|node)/)
    expect(script).not.toContain('DSH_HOME=/var/lib/mydsh /usr/bin/node')
    expect(script).toContain('systemd-analyze')
    expect(script).toContain('stage_candidate_configs')
    expect(script).toContain('restore_host_configs')
    expect(script).toContain('systemctl is-active --quiet mydsh')
    expect(script).toContain('MainPID')
    expect(script).toContain('stat -c %U "/proc/$main_pid"')
    expect(script).toContain('public_acceptance')
    expect(script).toContain('authenticated_acceptance')
    expect(script).not.toContain('install_managed_file "$asset_root/deploy-release.sh"')
    expect(script).toContain('create_registered_temp_file')
    expect(script).toContain('cleanup_registered_temp_files')
    expect(script).toContain('activation accepted but committed journal cleanup was not durable')
    expect(script).toContain('[[ $1 == --prune ]]')
    expect(script).toContain('prune_release')
    expect(script).not.toMatch(/rm -rf -- \/opt\/mydsh\/releases(?:\s|$)/m)
    expect(script).not.toMatch(/DSH_INVITE_(?:CODE|SESSION)_SECRET[^\n]*(?:>&2|\/dev\/stdout)/)
    const main = script.slice(script.indexOf('\nmain() {'))
    expect(main.indexOf('recover_activation_journal "$ACTIVATION_DIR"')).toBeLessThan(main.indexOf('\n  validate_host'))
    const deploy = script.slice(script.indexOf('\ndeploy_artifact() {'), script.indexOf('\nmain() {'))
    expect(deploy.indexOf('validate_archive_members')).toBeLessThan(deploy.indexOf('tar -xzf'))
    expect(deploy.indexOf('validate_candidate_configs')).toBeLessThan(deploy.indexOf('publish_extracted_release'))
  })

  it('packages an exact reviewed ref in a bounded Node 24 container', () => {
    const script = asset('package-release.sh')

    expect(script).toMatch(/^#!\/usr\/bin\/env bash\nset -euo pipefail\n/)
    expect(script).toContain('node:24-bookworm')
    expect(script).toContain('rev-parse --symbolic-full-name')
    expect(script).toContain('archive "$commit"')
    expect(script).toContain('--memory=')
    expect(script).toContain('--pids-limit=')
    expect(script).toContain('--cpus=')
    expect(script).toContain('pnpm-11.7.0.tgz')
    expect(script).toContain('sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA==')
    expect(script).toContain('--frozen-lockfile')
    expect(script).toContain('vitest run packages/host/invite-auth/tests')
    expect(script).toContain('run build')
    expect(script).toContain('--dump-config')
    expect(script).toContain('format=1')
    expect(script).toContain('helper_journal_format=1')
    expect(script).toContain('sha256sum')
    expect(script).not.toMatch(/runuser|systemd-run|DSH_INVITE_(?:CODE|SESSION)_SECRET/)
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
grep -F -- '<prebuilt-linux-artifact.tar.gz> <sha256-sidecar>' <<<"$usage_output"
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

    it('publishes only canonical extracted release directories', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
mkdir -p "$root/releases" "$root/extracted"
printf '{}\n' >"$root/extracted/package.json"
commit=${'3'.repeat(40)}
chown() { return 0; }
publish_extracted_release "$root/extracted" "$root/releases/$commit" "$root/releases"
[[ ! -e "$root/extracted" && -f "$root/releases/$commit/package.json" ]]
[[ $(stat -c %a "$root/releases/$commit") == 755 ]]
alias=${'4'.repeat(40)}
ln -s "$root/releases/$commit" "$root/aliased-extract"
if publish_extracted_release "$root/aliased-extract" "$root/releases/$alias" "$root/releases"; then exit 90; fi
[[ ! -e "$root/releases/$alias" ]]
file=${'5'.repeat(40)}
printf 'not a directory\n' >"$root/not-directory"
if publish_extracted_release "$root/not-directory" "$root/releases/$file" "$root/releases"; then exit 91; fi
[[ ! -e "$root/releases/$file" ]]
`)
    })

    it('rejects archive members and links that escape extraction', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
outside="$root/outside"
mkdir -p "$root/tree" "$outside"
ln -s ../../outside "$root/tree/escape"
tar -czf "$root/escape.tar.gz" -C "$root/tree" .
if validate_archive_members "$root/escape.tar.gz"; then exit 90; fi
printf 'safe\n' >"$root/tree/file"
rm "$root/tree/escape"
tar -czf "$root/safe.tar.gz" -C "$root/tree" .
validate_archive_members "$root/safe.tar.gz"
python3 - "$root/traversal.tar.gz" <<'PY'
import io
import sys
import tarfile
with tarfile.open(sys.argv[1], 'w:gz') as stream:
    member = tarfile.TarInfo('../escape')
    member.size = 1
    stream.addfile(member, io.BytesIO(b'x'))
PY
if validate_archive_members "$root/traversal.tar.gz"; then exit 91; fi
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

    it('validates checksum, manifest, required outputs, listeners, and sync paths', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
artifact="$root/mydsh-${'d'.repeat(40)}-linux-amd64.tar.gz"
printf 'artifact\n' >"$artifact"
digest=$(sha256sum "$artifact" | awk '{print $1}')
printf '%s  %s\n' "$digest" "\${artifact##*/}" >"$artifact.sha256"
verify_artifact_checksum "$artifact" "$artifact.sha256"
printf '0%.0s' {1..64} >"$root/bad.sha256"; printf '  %s\n' "\${artifact##*/}" >>"$root/bad.sha256"
if verify_artifact_checksum "$artifact" "$root/bad.sha256"; then exit 90; fi
release="$root/release"
mkdir -p "$release/apps/cli/lib" "$release/apps/web/dist" "$release/deploy/alibaba-cloud" "$release/node_modules"
touch "$release/apps/cli/lib/bin.js"
touch "$release/apps/web/dist/index.html"
for name in Caddyfile mydsh.service caddy-mydsh.conf invite-auth.cordis.yml; do touch "$release/deploy/alibaba-cloud/$name"; done
printf 'format=1\ncommit=%s\nref=refs/tags/reviewed\nplatform=linux-amd64\nnode_major=24\npnpm_version=11.7.0\nhelper_journal_format=1\n' "${'d'.repeat(40)}" >"$release/.mydsh-release-manifest"
validate_release_manifest "$release"
validate_required_release_outputs "$release"
rm "$release/apps/cli/lib/bin.js"
if validate_required_release_outputs "$release"; then exit 91; fi
ss() { printf 'LISTEN 0 511 127.0.0.1:3080 0.0.0.0:*\n'; }
listener_check
ss() { printf 'LISTEN 0 511 0.0.0.0:3080 0.0.0.0:*\n'; }
if listener_check; then exit 92; fi
host="$root/host"; journal="$root/activation"; current="$root/current"; active="$root/active"
mkdir -p "$host/etc/caddy" "$host/etc/systemd/system/caddy.service.d" "$host/etc/systemd/system/multi-user.target.wants" "$active" "$journal"
touch "$host/etc/caddy/Caddyfile" "$host/etc/systemd/system/mydsh.service" "$host/etc/systemd/system/caddy.service.d/mydsh.conf"
sync() { printf '%s\n' "\${*: -1}" >>"$root/synced"; }
sync_activated_state "$active" "$journal" "$host" "$current"
grep -Fx "$active" "$root/synced"
grep -Fx "\${current%/*}" "$root/synced"
grep -Fx "$host/etc/caddy/Caddyfile" "$root/synced"
grep -Fx "$host/etc/systemd/system/mydsh.service" "$root/synced"
grep -Fx "$host/etc/systemd/system/caddy.service.d/mydsh.conf" "$root/synced"
grep -Fx "$host/etc/systemd/system/multi-user.target.wants" "$root/synced"
grep -Fx "$journal" "$root/synced"
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
enable_state=enabled
service_enable_state() { printf '%s\n' "$enable_state"; }
systemctl() {
  case "\${1:-} \${2:-}" in
    'enable mydsh') enable_state=enabled ;;
    'disable mydsh') enable_state=disabled ;;
  esac
  return 0
}
caddy() { return 0; }
health_check() { return 0; }
sync_activated_state() { return 0; }
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
sync_activated_state() { if [[ ! -e "$root/sync-failed" ]]; then touch "$root/sync-failed"; return 1; fi; return 0; }
if activate_transaction "$candidate" "$previous" "$candidate/deploy/alibaba-cloud" "$host" "$root/current" "$root/activation"; then exit 90; fi
[[ $(readlink "$root/current") == "$previous" ]]
[[ $enable_state == enabled ]]
grep -Fx old "$host/etc/caddy/Caddyfile"
grep -Fx old "$host/etc/systemd/system/mydsh.service"
grep -Fx old "$host/etc/systemd/system/caddy.service.d/mydsh.conf"
rm -f "$root/current"
enable_state=disabled
rm -f "$root/sync-failed"
if activate_transaction "$candidate" '' "$candidate/deploy/alibaba-cloud" "$host" "$root/current" "$root/activation"; then exit 91; fi
[[ ! -e "$root/current" && ! -L "$root/current" ]]
[[ $enable_state == disabled ]]
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
service_enable_state() { printf 'enabled\n'; }
systemctl() { return 0; }
caddy() { return 0; }
health_check() { return 0; }
sync_activated_state() { return 0; }
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
systemctl() { return 0; }; caddy() { return 0; }; health_check() { return 0; }; sync_activated_state() { return 0; }; sync() { return 0; }
ln -s "$previous" "$root/current"
prepare_activation_journal "$journal" "$candidate" "$previous" "$assets" "$host" enabled
stage_candidate_configs "$assets" "$host"
atomic_replace_link "$root/current" "$candidate"
restore_host_configs_real=$(declare -f restore_host_configs)
restore_host_configs() { return 1; }
if recover_activation_journal "$journal" "$host" "$root/current"; then exit 90; fi
[[ -d "$journal" && $(readlink "$root/current") == "$candidate" ]]
eval "$restore_host_configs_real"
recover_activation_journal "$journal" "$host" "$root/current"
[[ ! -e "$journal" && $(readlink "$root/current") == "$previous" ]]
prepare_activation_journal "$journal" "$candidate" "$previous" "$assets" "$host" enabled
write_journal_state "$journal" committed
finalize_committed_journal "$journal"
rm() { return 1; }
if recover_activation_journal "$journal" "$host" "$root/current"; then exit 91; fi
[[ -d "$journal" && $(readlink "$root/current") == "$previous" ]]
unset -f rm
recover_activation_journal "$journal" "$host" "$root/current"
[[ ! -e "$journal" && $(readlink "$root/current") == "$previous" ]]
`)
    })

    it('publishes only complete prepared journals and clears safe abandoned staging', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
host="$root/host"; assets="$root/assets"; journal="$root/activation"; candidate="$root/${'c'.repeat(40)}"
mkdir -p "$host/etc/caddy" "$host/etc/systemd/system/caddy.service.d" "$host/usr/local/sbin" "$assets" "$candidate"
for spec in 'Caddyfile:etc/caddy/Caddyfile' 'mydsh.service:etc/systemd/system/mydsh.service' 'caddy-mydsh.conf:etc/systemd/system/caddy.service.d/mydsh.conf' 'deploy-release.sh:usr/local/sbin/mydsh-deploy-release'; do
  name=\${spec%%:*}; path=\${spec#*:}; printf '%s\nold\n' "$MANAGED_MARKER" >"$host/$path"; printf '%s\nnew\n' "$MANAGED_MARKER" >"$assets/$name"
done
install() { if [[ " $* " == *' -d '* ]]; then mkdir -p "\${@: -1}"; else cp -- "\${@: -2:1}" "\${@: -1}"; fi; }
sync() { return 0; }
copy_definition=$(declare -f copy_durable_file)
copy_durable_file() { return 1; }
if prepare_activation_journal "$journal" "$candidate" '' "$assets" "$host" disabled; then exit 90; fi
[[ ! -e "$journal" && ! -L "$journal" ]]
if compgen -G "$root/activation.new.*" >/dev/null; then exit 91; fi
eval "$copy_definition"
state_definition=$(declare -f write_journal_state)
write_journal_state() { return 1; }
if prepare_activation_journal "$journal" "$candidate" '' "$assets" "$host" disabled; then exit 92; fi
[[ ! -e "$journal" && ! -L "$journal" ]]
if compgen -G "$root/activation.new.*" >/dev/null; then exit 93; fi
eval "$state_definition"
sync() { return 1; }
if prepare_activation_journal "$journal" "$candidate" '' "$assets" "$host" disabled; then exit 94; fi
[[ ! -e "$journal" && ! -L "$journal" ]]
if compgen -G "$root/activation.new.*" >/dev/null; then exit 95; fi
unset -f sync
mkdir "$root/activation.new.abandoned"
mkdir "$root/outside"
ln -s "$root/outside" "$root/activation.new.aliased"
cleanup_abandoned_journal_staging "$root"
[[ ! -e "$root/activation.new.abandoned" ]]
[[ -L "$root/activation.new.aliased" && -d "$root/outside" ]]
rm -f "$root/activation.new.aliased"
mkdir "$journal"
printf 'state=prepared\n' >"$journal/state"
sync() { if [[ "\${*: -1}" == "$journal" && $(<"$journal/state") == state=committed ]]; then return 1; fi; return 0; }
if write_journal_state "$journal" committed; then exit 96; fi
grep -Fx 'state=prepared' "$journal/state"
`)
    })

    it('rolls back when the accepted state cannot be journaled', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
host="$root/host"; assets="$root/assets"; candidate="$root/${'7'.repeat(40)}"; journal="$root/activation"
mkdir -p "$host/etc/caddy" "$host/etc/systemd/system/caddy.service.d" "$host/usr/local/sbin" "$assets" "$candidate"
for spec in 'Caddyfile:etc/caddy/Caddyfile' 'mydsh.service:etc/systemd/system/mydsh.service' 'caddy-mydsh.conf:etc/systemd/system/caddy.service.d/mydsh.conf' 'deploy-release.sh:usr/local/sbin/mydsh-deploy-release'; do
  name=\${spec%%:*}; path=\${spec#*:}; printf '%s\nold\n' "$MANAGED_MARKER" >"$host/$path"; printf '%s\nnew\n' "$MANAGED_MARKER" >"$assets/$name"
done
validate_candidate_configs() { return 0; }
validate_existing_managed_file() { grep -Fqx "$MANAGED_MARKER" "$1"; }
install() { if [[ " $* " == *' -d '* ]]; then mkdir -p "\${@: -1}"; else cp -- "\${@: -2:1}" "\${@: -1}"; fi; }
enable_state=disabled
service_enable_state() { printf '%s\n' "$enable_state"; }
systemctl() { case "\${1:-} \${2:-}" in 'enable mydsh') enable_state=enabled ;; 'disable mydsh') enable_state=disabled ;; esac; return 0; }
caddy() { return 0; }; health_check() { return 0; }; public_acceptance() { return 0; }; authenticated_acceptance() { return 0; }; sync_activated_state() { return 0; }; sync() { return 0; }
eval "$(declare -f write_journal_state | sed '1s/write_journal_state/write_journal_state_real/')"
write_journal_state() { if [[ $2 == committed ]]; then printf 'state=committed\n' >"$1/state"; return 2; fi; write_journal_state_real "$@"; }
if activate_transaction "$candidate" '' "$assets" "$host" "$root/current" "$journal" >"$root/first-output" 2>&1; then exit 90; fi
[[ ! -e "$root/current" && ! -L "$root/current" ]]
[[ $enable_state == disabled ]]
grep -Fx old "$host/etc/caddy/Caddyfile"
[[ ! -e "$journal" ]]
if grep -F 'activation accepted' "$root/first-output"; then exit 91; fi
restore_definition=$(declare -f restore_host_configs)
restore_host_configs() { return 1; }
if activate_transaction "$candidate" '' "$assets" "$host" "$root/current" "$journal" >"$root/second-output" 2>&1; then exit 92; fi
[[ -d "$journal" && -f "$journal/rollback-required" ]]
grep -Fx 'state=committed' "$journal/state"
[[ $(readlink "$root/current") == "$candidate" && $enable_state == enabled ]]
if grep -F 'activation accepted' "$root/second-output"; then exit 93; fi
grep -F 'forced rollback incomplete; recovery required' "$root/second-output"
eval "$restore_definition"
recover_activation_journal "$journal" "$host" "$root/current"
[[ ! -e "$root/current" && ! -L "$root/current" && ! -e "$journal" ]]
[[ $enable_state == disabled ]]
grep -Fx old "$host/etc/caddy/Caddyfile"
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
    expect(activation.indexOf('systemctl enable mydsh')).toBeLessThan(activation.indexOf('write_journal_state "$journal" committed'))
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
      expect(readme).toContain('package-release.sh "$DEPLOY_REF"')
      expect(readme).toContain('node:24-bookworm')
      expect(readme).not.toContain('scp deploy/alibaba-cloud/{Caddyfile')
      expect(readme).not.toContain('feat/invite-auth-deployment')
      expect(readme).toContain('mktemp -d "$HOME/mydsh-deploy.XXXXXX"')
      expect(readme).not.toContain('git bundle verify')
      expect(readme).toContain('SHA-256')
      expect(readme).toMatch(/does not establish signer identity|不能证明签名者身份|真实性/i)
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
      expect(note).not.toContain('mydsh-build')
      expect(note).toContain('package-release.sh')
      expect(note).toContain('Node 24 Linux')
      expect(note).toContain('/var/lib/mydsh-deploy/activation')
      expect(note).toMatch(/serialized|串行/)
      expect(note).toContain('SHA-256')
      expect(note).toMatch(/release-contained|release 中的|release 内/)
      expect(note).toMatch(/production host|生产宿主/)
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
      expect(design).not.toContain('mydsh-build')
      expect(design).toContain('package-release.sh')
      expect(design).toMatch(/official Node 24|官方 Node 24/)
      expect(design).toContain('/var/lib/mydsh-deploy/activation')
      expect(design).toContain('/run/lock/mydsh-deploy.lock')
      expect(design).toMatch(/systemd.*Caddy|systemd.*Caddy/)
      expect(design).toMatch(/public.*authenticated|公开.*认证/)
      expect(design).not.toMatch(/builds? as `mydsh`|以 `mydsh` 身份.*构建/)
    }
  })

  it('keeps the implementation plan aligned with prebuilt artifact deployment', () => {
    const planRoot = resolve(import.meta.dirname, '../docs/superpowers/plans')
    for (const name of [
      '2026-08-24-dsh-invite-auth-deployment.md',
      '2026-08-24-dsh-invite-auth-deployment.zh.md',
    ]) {
      const plan = readFileSync(resolve(planRoot, name), 'utf8')
      expect(plan).toContain('deploy/alibaba-cloud/package-release.sh')
      expect(plan).toMatch(/prebuilt Linux artifact|预构建 Linux artifact/)
      expect(plan).toContain('SHA-256')
      expect(plan).not.toMatch(/mydsh-build|mydsh-release\.bundle|runuser -u mydsh|var\/cache\/mydsh-pnpm/)
    }
  })
})
