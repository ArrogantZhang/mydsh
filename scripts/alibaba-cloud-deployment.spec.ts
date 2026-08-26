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

  it('uses one root-owned runtime lock for bootstrap and release operations', () => {
    for (const name of ['bootstrap-host.sh', 'deploy-release.sh']) {
      const script = asset(name)

      expect(script).toContain('readonly DEPLOY_LOCK=/run/mydsh-deploy.lock')
      expect(script).not.toContain('/run/lock/mydsh-deploy.lock')
    }
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
    expect(script).toContain('/run/mydsh-deploy.lock')
    expect(script).toContain('flock -n')
    expect(script).toContain('validate_lock_path')
    expect(script).toContain('ensure_managed_directory')
    expect(script).toContain('validate_existing_managed_file')
    expect(script).toContain('validate_active_managed_state')
    expect(script).toContain('validate_existing_managed_file "$host_root/etc/mydsh/mydsh.env" 600')
    expect(script).toContain('validate_existing_managed_file "$host_root/usr/local/sbin/mydsh-deploy-release" 755')
    expect(script).not.toMatch(/apt-get install -y[^\n]*\bgit\b/)
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
    expect(bootstrapMain).toContain('dpkg --print-architecture')
    expect(bootstrapMain).toContain('architecture == amd64')
    expect(bootstrapMain.indexOf('dpkg --print-architecture')).toBeLessThan(bootstrapMain.indexOf('acquire_operation_lock'))
    expect(bootstrapMain.indexOf('preflight_managed_paths')).toBeLessThan(bootstrapMain.indexOf('TEMP_DIR=$(mktemp'))
    expect(bootstrapMain.indexOf('preflight_managed_paths')).toBeLessThan(bootstrapMain.indexOf('apt-get update'))
  })

  it('validates prebuilt artifacts and transacts release activation', () => {
    const script = asset('deploy-release.sh')

    expect(script).toMatch(/^#!\/usr\/bin\/env bash\n# Managed by DeepSeek Harness Alibaba Cloud deployment\nset -euo pipefail\n/)
    expect(script).toContain('Usage: sudo %s <atomic-artifact-set-directory>')
    expect(script).toContain('sudo %s --rollback <40-character-lowercase-commit>')
    expect(script).toContain('sudo %s --prune <40-character-lowercase-commit>')
    expect(script).toContain('sudo %s --rotate-invite')
    expect(script).toContain('sudo %s --rotate-session')
    expect(script).toMatch(/\[\[ \$# -eq 2 \]\]/)
    expect(script).not.toContain('set -x')
    expect(script).toContain('realpath -e --')
    expect(script).toContain('$RELEASES_DIR/.extract.XXXXXX')
    expect(script).toContain('verify_artifact_checksum')
    expect(script).toContain('validate_archive_members')
    expect(script).toContain('/var/lib/mydsh-deploy/uploads')
    expect(script).toContain('MAX_COMPRESSED_BYTES')
    expect(script).toContain('MAX_ARCHIVE_MEMBERS')
    expect(script).toContain('MAX_MEMBER_BYTES')
    expect(script).toContain('MAX_EXPANDED_BYTES')
    expect(script).toContain('FILESYSTEM_BYTES_PER_MEMBER')
    expect(script).toContain('INODE_SAFETY_MARGIN')
    expect(script).toContain('copy_bounded_upload')
    expect(script).toContain('head -c "$((limit + 1))"')
    expect(script).toContain('validate_extraction_space')
    expect(script).toContain('validate_extraction_inodes')
    expect(script).toContain('cleanup_abandoned_operation_directories')
    expect(script).toContain('rotate_authentication_secret')
    expect(script).toContain('/var/lib/mydsh-deploy/rotation')
    expect(script).toContain('ROTATION_FORMAT=1')
    expect(script).toContain('prepare_rotation_journal')
    expect(script).toContain('recover_rotation_journal')
    expect(script).not.toContain('mktemp "$state_root/.rotate-backup.')
    expect(script).toContain('validate_upload_space')
    expect(script).toContain('UPLOAD_METADATA_BYTES')
    expect(script).toContain('validate_managed_host_state')
    expect(script).toContain('validate_existing_managed_file "$(host_path "$host_root" "$PRIVATE_ENV")" 600')
    expect(script).toContain('validate_existing_managed_file "$(host_path "$host_root" "$ROOT_HELPER")" 755')
    expect(script).toContain('validate_release_manifest')
    expect(script).toContain('validate_manifest_ref')
    expect(script).not.toMatch(/command -v git|git check-ref-format/)
    expect(script).toContain('validate_candidate_unit_contract')
    expect(script).toContain('cmp -- "$asset_root/Caddyfile" "$installed_caddy"')
    expect(script).toContain('cmp -- "$asset_root/mydsh.service" "$installed_unit"')
    expect(script).toContain('cmp -- "$asset_root/caddy-mydsh.conf" "$installed_dropin"')
    expect(script).toContain('After network-online.target')
    expect(script).toContain('Wants network-online.target')
    expect(script).toContain('StartLimitIntervalSec 60')
    expect(script).toContain('StartLimitBurst 5')
    expect(script).toMatch(/SystemCallFilter\|IPAddressDeny\|RestrictAddressFamilies/)
    expect(script).toContain('helper_journal_format=1')
    expect(script).toContain('apps/cli/lib/bin.js')
    expect(script).toContain('apps/web/dist/index.html')
    expect(script).toContain('node_modules')
    expect(script).not.toMatch(/systemd-run|pnpm (?:install|run|exec)|git clone|--internal-build|mydsh-build/)
    expect(script).toContain('chown -R root:root')
    expect(script).toContain('chmod 0755 "$extract_root"')
    expect(script).toContain('chmod -R go-w')
    expect(script).toContain('caddy validate --config "$CADDY_CONFIG" --adapter caddyfile')
    expect(script).toContain('local next_path="${current_path}.next"')
    expect(script).toContain('ln -s -- "$target" "$next_path"')
    expect(script).toContain('mv -Tf -- "$next_path" "$current_path"')
    expect(script).toMatch(/for .* in \{1\.\.30\}/)
    expect(script).toContain('http://127.0.0.1:3080/__invite/login')
    expect(script).toContain('health_check "$target" && public_acceptance')
    expect(script).toMatch(/recover_activation_journal[\s\S]*systemctl restart mydsh/)
    expect(script).not.toContain('systemctl reload caddy')
    expect(script).toContain('/etc/systemd/system/caddy.service.d/mydsh.conf')
    expect(script).toContain('uid=$(id -u "$name")')
    expect(script).toContain('$uid != 0 && $uid -lt 1000')
    expect(script).toContain('getent passwd "$name"')
    expect(script).toContain('[[ ${#entries[@]} -eq 1 ]]')
    expect(script).toContain('nologin')
    expect(script).toContain('if [[ ${BASH_SOURCE[0]} == "$0" ]]')
    expect(script).toContain('/run/mydsh-deploy.lock')
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
    expect(script).toContain('systemctl is-active --quiet mydsh')
    expect(script).toContain('MainPID')
    expect(script).toContain('stat -c %U "/proc/$main_pid"')
    expect(script).toContain('public_acceptance')
    expect(script).toContain('authenticated_acceptance')
    expect(script).not.toContain('install_managed_file "$asset_root/deploy-release.sh"')
    expect(script).not.toContain('stage_candidate_configs')
    expect(script).not.toContain('restore_host_configs')
    expect(script).toContain('create_registered_temp_file')
    expect(script).toContain('cleanup_registered_temp_files')
    expect(script).toContain('activation accepted but committed journal cleanup was not durable')
    expect(script).toContain('[[ $1 == --prune ]]')
    expect(script).toContain('prune_release')
    expect(script).not.toMatch(/rm -rf -- \/opt\/mydsh\/releases(?:\s|$)/m)
    expect(script).not.toMatch(/DSH_INVITE_(?:CODE|SESSION)_SECRET[^\n]*(?:>&2|\/dev\/stdout)/)
    const main = script.slice(script.indexOf('\nmain() {'))
    expect(main.indexOf('recover_activation_journal "$ACTIVATION_DIR"')).toBeLessThan(main.indexOf('\n  validate_host'))
    expect(main.indexOf('acquire_operation_lock')).toBeLessThan(main.indexOf('cleanup_abandoned_operation_directories "$UPLOADS_DIR"'))
    expect(main.indexOf('cleanup_abandoned_operation_directories "$UPLOADS_DIR"')).toBeLessThan(main.indexOf('deploy_artifact "$1"'))
    expect(main.indexOf('recover_rotation_journal "$ROTATION_DIR"')).toBeLessThan(main.indexOf('deploy_artifact "$1"'))
    const rotation = script.slice(script.indexOf('\nrotate_authentication_secret() {'), script.indexOf('\ndeploy_artifact() {'))
    expect(rotation.indexOf('active=$(current_release)')).toBeLessThan(rotation.indexOf('prepare_rotation_journal'))
    const deploy = script.slice(script.indexOf('\ndeploy_artifact() {'), script.indexOf('\nmain() {'))
    expect(deploy.indexOf('validate_upload_space')).toBeLessThan(deploy.indexOf('TRUST_ROOT=$(mktemp'))
    expect(deploy.indexOf('validate_upload_space')).toBeLessThan(deploy.indexOf('copy_bounded_upload'))
    expect(deploy).toContain('validate_upload_space "$UPLOADS_DIR"')
    expect(deploy).not.toContain('validate_upload_space "$UPLOADS_DIR" "$compressed_bytes"')
    expect(deploy.indexOf('validate_archive_members')).toBeLessThan(deploy.indexOf('tar -xzf'))
    expect(deploy.indexOf('validate_candidate_configs')).toBeLessThan(deploy.indexOf('publish_extracted_release'))
  })

  it('packages an exact reviewed ref in a bounded Node 24 container', () => {
    const script = asset('package-release.sh')

    expect(script).toMatch(/^#!\/usr\/bin\/env bash\nset -euo pipefail\n/)
    expect(script).toContain('node:24-bookworm')
    expect(script).toContain('node:24-bookworm@sha256:ffeee58a257b390b80b9b656cba440bbc3116c1bc03139c31318f9d9c29a8975')
    expect(script).toContain('verify_static_inputs')
    expect(script).toContain('resolve_named_ref_commit')
    expect(script).toContain('validate_manifest_ref')
    expect(script).toContain('git check-ref-format "$ref"')
    expect(script).toContain('"${ref}^{commit}"')
    expect(script).not.toContain('check-ref-format --branch')
    expect(script).toContain('show "$commit:deploy/alibaba-cloud/package-release.sh"')
    expect(script).toContain('timeout --signal=TERM --kill-after=30s 45m docker run')
    expect(script).toContain('--cidfile')
    expect(script).toContain('docker rm -f')
    expect(script).toContain('show-ref --verify --quiet "$ref"')
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
    expect(script).toContain('publish_artifact_set')
    expect(script).toContain('validate_archive_members')
    expect(script).toContain('MAX_COMPRESSED_BYTES')
    expect(script).toContain('mydsh-release-$commit')
    expect(script).toContain('.new.XXXXXX')
    expect(script).toContain('mv -T -- "$staging" "$final_dir"')
    expect(script).not.toContain('src=$output_dir,dst=/output')
    expect(script).not.toContain('dst=/output')
    const packageMain = script.slice(script.indexOf('\nmain() {'))
    expect(packageMain.indexOf('validate_compressed_size')).toBeLessThan(packageMain.indexOf('publish_artifact_set'))
    expect(packageMain.indexOf('validate_archive_members')).toBeLessThan(packageMain.indexOf('publish_artifact_set'))
    expect(script).not.toContain('.mydsh-release.$$.tmp')
    expect(script).not.toMatch(/runuser|systemd-run|DSH_INVITE_(?:CODE|SESSION)_SECRET/)
  })

  it('limits GNU filesystem integration to Linux CI', () => {
    expect(linuxFilesystemTestsEnabled).toBe(process.platform === 'linux')
    if (!linuxFilesystemTestsEnabled) expect(() => runBash('true')).toThrow('only on Linux CI')
  })

  // atomic_replace_link uses GNU mv -T. Linux CI executes these tests; Windows
  // keeps static coverage without requiring WSL, and macOS avoids BSD mv.
  describe.runIf(linuxFilesystemTestsEnabled)('Linux release-link helpers', () => {
    it('accepts the root-owned runtime directory and rejects world-writable lock parents', () => {
      for (const name of ['bootstrap-host.sh', 'deploy-release.sh']) {
        expectBashSuccess(`
set -euo pipefail
[[ $DEPLOY_LOCK == /run/mydsh-deploy.lock ]]
validate_lock_path "$DEPLOY_LOCK" root:root
root=$(mktemp -d)
trap 'chmod 0700 "$root"; rm -rf -- "$root"' EXIT
chmod 0777 "$root"
if (validate_lock_path "$root/mydsh-deploy.lock" "$(id -un):$(id -gn)"); then exit 90; fi
`, name)
      }
    })

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
grep -F -- '<atomic-artifact-set-directory>' <<<"$usage_output"
grep -F -- '--rollback <40-character-lowercase-commit>' <<<"$usage_output"
grep -F -- '--prune <40-character-lowercase-commit>' <<<"$usage_output"
grep -F -- '--rotate-invite' <<<"$usage_output"
grep -F -- '--rotate-session' <<<"$usage_output"
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
if (validate_existing_managed_file "$root/private.env" 600); then exit 91; fi
printf 'unmanaged\n' >"$root/unmanaged"
stat() { printf 'root:root\n'; }
if (validate_existing_managed_file "$root/unmanaged" 600); then exit 92; fi
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

    it('cleans only safe abandoned operation directories', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
mkdir -m 0700 "$root/.upload.abc123" "$root/.upload.def456"
cleanup_abandoned_operation_directories "$root" .upload.
[[ -z $(find "$root" -mindepth 1 -print -quit) ]]
mkdir "$root/outside"
ln -s "$root/outside" "$root/.upload.bad123"
if cleanup_abandoned_operation_directories "$root" .upload.; then exit 90; fi
[[ -L "$root/.upload.bad123" && -d "$root/outside" ]]
rm "$root/.upload.bad123"
printf file >"$root/.upload.file12"
if cleanup_abandoned_operation_directories "$root" .upload.; then exit 91; fi
[[ -f "$root/.upload.file12" ]]
rm "$root/.upload.file12"
mkdir "$root/.extract.own123"
stat() { if [[ "\${*: -1}" == "$root/.extract.own123" ]]; then printf 'nobody:nogroup\n'; else command stat "$@"; fi; }
if cleanup_abandoned_operation_directories "$root" .extract.; then exit 92; fi
[[ -d "$root/.extract.own123" ]]
`)
    })

    it('rejects bounded archive and disk-space violations before extraction', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
mkdir "$root/tree"
printf a >"$root/tree/a"; printf b >"$root/tree/b"; printf c >"$root/tree/c"
tar -czf "$root/three.tar.gz" -C "$root/tree" .
if validate_archive_members "$root/three.tar.gz" 2 1024 4096; then exit 90; fi
if validate_archive_members "$root/three.tar.gz" 100 0 4096; then exit 91; fi
if validate_archive_members "$root/three.tar.gz" 100 1024 2; then exit 92; fi
stat() { printf '1073741825\n'; }
if validate_compressed_size "$root/three.tar.gz" 1073741824; then exit 93; fi
df() { printf 'Filesystem 1-blocks Used Available Use%% Mounted on\nproof 100 99 1 99%% /\n'; }
if validate_extraction_space "$root" 1024 1024 0 1024 4096; then exit 94; fi
`)
    })

    it('reserves worst-case persistent upload space before any copy', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
mkdir "$root/var" "$root/opt"
df() {
  if [[ "\${*: -1}" == "$root/var" ]]; then
    printf 'Filesystem 1-blocks Used Available Use%% Mounted on\nproof 4096 1025 3071 26%% /var\n'
  else
    printf 'Filesystem 1-blocks Used Available Use%% Mounted on\nproof 100000 1 99999 1%% /opt\n'
  fi
}
printf small >"$root/source"
copy_bounded_upload() { touch "$root/copied"; }
if validate_upload_space "$root/var" 1024 1024 1024; then
  truncate -s 1024 "$root/source"
  copy_bounded_upload "$root/source" "$root/copied" 1024
fi
[[ ! -e "$root/copied" ]]
[[ -z $(find "$root/var" -mindepth 1 -print -quit) ]]
validate_extraction_space "$root/opt" 1024 1024 0 1024 4096
`)
    })

    it('accounts for extraction inodes and per-member metadata', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
df() {
  if [[ "$1" == -Pi ]]; then
    printf 'Filesystem Inodes IUsed IFree IUse%% Mounted on\nproof 600000 100000 500000 17%% /\n'
  else
    printf 'Filesystem 1-blocks Used Available Use%% Mounted on\nproof 9999999999 1 9999999998 1%% /\n'
  fi
}
if validate_extraction_inodes "$root" 500000 10000; then exit 90; fi
validate_extraction_space "$root" 0 1 500000 1 4096
`)
    })

    it('rotates exactly one secret and rolls back failed activation', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
env_file="$root/mydsh.env"
printf '%s\nDSH_HOME=/var/lib/mydsh\nDSH_INVITE_CODE_SECRET=old-invite\nDSH_INVITE_SESSION_SECRET=old-session\n' "$MANAGED_MARKER" >"$env_file"
chmod 0600 "$env_file"
stat() { if [[ "$1" == -c && "$2" == %U:%G ]]; then printf 'root:root\n'; else command stat "$@"; fi; }
openssl() { printf '11111111111111111111111111111111\n'; }
systemctl() { return 0; }
health_check() { return 0; }
public_acceptance() { return 0; }
authenticated_acceptance() { return 0; }
current_release() { printf '/opt/mydsh/releases/${'a'.repeat(40)}\n'; }
sync() { return 0; }
rotate_authentication_secret invite "$env_file" "$root"
grep -Fx 'DSH_INVITE_CODE_SECRET=11111111111111111111111111111111' "$env_file"
grep -Fx 'DSH_INVITE_SESSION_SECRET=old-session' "$env_file"
before=$(sha256sum "$env_file")
sync() { if [[ "\${*: -1}" == "$env_file" ]] && grep -Fq 'DSH_INVITE_SESSION_SECRET=11111111111111111111111111111111' "$env_file"; then return 1; fi; return 0; }
if rotate_authentication_secret session "$env_file" "$root"; then exit 90; fi
[[ $(sha256sum "$env_file") == "$before" ]]
sync() { return 0; }
systemctl() { return 1; }
if rotate_authentication_secret session "$env_file" "$root"; then exit 91; fi
[[ $(sha256sum "$env_file") == "$before" ]]
`)
    })

    it('recovers prepared and committed rotation journals durably', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
env_file="$root/mydsh.env"; journal="$root/rotation"
printf '%s\nDSH_HOME=/var/lib/mydsh\nDSH_INVITE_CODE_SECRET=old-invite\nDSH_INVITE_SESSION_SECRET=old-session\n' "$MANAGED_MARKER" >"$env_file"
chmod 0600 "$env_file"
stat() { if [[ "$1" == -c && "$2" == %U:%G ]]; then printf 'root:root\n'; else command stat "$@"; fi; }
systemctl() { return 0; }; health_check() { return 0; }; public_acceptance() { return 0; }; authenticated_acceptance() { return 0; }; current_release() { printf '/opt/mydsh/releases/${'a'.repeat(40)}\n'; }; sync() { return 0; }
prepare_rotation_journal "$journal" invite "$env_file"
sed -i 's/old-invite/interrupted-invite/' "$env_file"
recover_rotation_journal "$journal" "$env_file"
grep -Fx 'DSH_INVITE_CODE_SECRET=old-invite' "$env_file"
[[ ! -e "$journal" ]]
prepare_rotation_journal "$journal" session "$env_file"
sed -i 's/old-session/accepted-session/' "$env_file"
write_journal_state "$journal" committed
recover_rotation_journal "$journal" "$env_file"
grep -Fx 'DSH_INVITE_SESSION_SECRET=accepted-session' "$env_file"
[[ ! -e "$journal" ]]
prepare_rotation_journal "$journal" invite "$env_file"
sed -i 's/old-invite/broken-invite/' "$env_file"
restore_definition=$(declare -f restore_secret_backup)
restore_secret_backup() { return 1; }
if recover_rotation_journal "$journal" "$env_file"; then exit 90; fi
[[ -d "$journal" ]]
eval "$restore_definition"
recover_rotation_journal "$journal" "$env_file"
grep -Fx 'DSH_INVITE_CODE_SECRET=old-invite' "$env_file"
touch "$root/.rotate-backup.abc123"
cleanup_rotation_residue "$root"
[[ ! -e "$root/.rotate-backup.abc123" ]]
`)
    })

    it('refuses rotation before the first release without leaving state', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
env_file="$root/mydsh.env"
printf '%s\nDSH_HOME=/var/lib/mydsh\nDSH_INVITE_CODE_SECRET=old-invite\nDSH_INVITE_SESSION_SECRET=old-session\n' "$MANAGED_MARKER" >"$env_file"
chmod 0600 "$env_file"
stat() { if [[ "$1" == -c && "$2" == %U:%G ]]; then printf 'root:root\n'; else command stat "$@"; fi; }
current_release() { return 0; }
systemctl() { touch "$root/restarted"; return 0; }
if rotate_authentication_secret invite "$env_file" "$root"; then exit 90; fi
[[ ! -e "$root/rotation" && ! -e "$root/restarted" ]]
if compgen -G "$root/.mydsh-tmp.*" >/dev/null; then exit 91; fi
recover_rotation_journal "$root/rotation" "$env_file"
[[ ! -e "$root/restarted" ]]
`)
    })

    it('accepts only fully qualified existing branch or tag refs', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
git init -q "$root/repo"
git -C "$root/repo" config user.email test@example.invalid
git -C "$root/repo" config user.name Test
printf 'reviewed\n' >"$root/repo/file"
git -C "$root/repo" add file
git -C "$root/repo" commit -qm reviewed
git -C "$root/repo" branch reviewed
git -C "$root/repo" tag reviewed
git -C "$root/repo" branch feature-x
git -C "$root/repo" tag v1.2.3
branch_commit=$(resolve_named_ref_commit refs/heads/reviewed "$root/repo")
tag_commit=$(resolve_named_ref_commit refs/tags/reviewed "$root/repo")
[[ $branch_commit =~ ^[0-9a-f]{40}$ && $tag_commit == "$branch_commit" ]]
resolve_named_ref_commit refs/heads/feature-x "$root/repo" >/dev/null
resolve_named_ref_commit refs/tags/v1.2.3 "$root/repo" >/dev/null
invalid_refs=(reviewed HEAD refs/tags/foo..bar 'refs/heads/@{bad}' refs/heads/.hidden refs/tags/release.lock 'refs/heads/what?' 'refs/tags/back\\slash' refs/heads/foo@bar refs/tags/v1+build)
for invalid in "\${invalid_refs[@]}"; do
  if resolve_named_ref_commit "$invalid" "$root/repo" >/dev/null 2>&1; then exit 90; fi
done
`, 'package-release.sh')
    })

    it('uses the same ordinary ref grammar in producer and consumer', () => {
      expectBashSuccess(`
set -euo pipefail
consumer_body=$(sed -n '/^validate_manifest_ref() {$/,/^}$/p' "${resolve(deploymentRoot, 'deploy-release.sh').replaceAll('\\', '/')}")
producer_body=$(sed -n '/^validate_manifest_ref() {$/,/^}$/p' "${resolve(deploymentRoot, 'package-release.sh').replaceAll('\\', '/')}")
[[ $producer_body == "$consumer_body" ]]
consumer_archive=$(sed -n '/^validate_archive_members() {$/,/^}$/p' "${resolve(deploymentRoot, 'deploy-release.sh').replaceAll('\\', '/')}")
producer_archive=$(sed -n '/^validate_archive_members() {$/,/^}$/p' "${resolve(deploymentRoot, 'package-release.sh').replaceAll('\\', '/')}")
[[ $producer_archive == "$consumer_archive" ]]
valid_refs=(refs/heads/feature-x refs/tags/v1.2.3)
invalid_refs=(refs/heads/foo@bar refs/tags/v1+build refs/tags/foo..bar 'refs/heads/@{bad}' refs/heads/.hidden refs/tags/release.lock 'refs/heads/what?' 'refs/tags/back\\slash')
for ref in "\${valid_refs[@]}"; do validate_manifest_ref "$ref"; done
for ref in "\${invalid_refs[@]}"; do
  if validate_manifest_ref "$ref"; then exit 90; fi
done
`)
    })

    it('caps the root-private upload copy even when the caller file grows', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
head -c 2048 /dev/zero >"$root/input"
if copy_bounded_upload "$root/input" "$root/oversized" 1024; then exit 90; fi
[[ $(stat -c %s "$root/oversized") -le 1025 ]]
printf 'small\n' >"$root/input"
copy_bounded_upload "$root/input" "$root/copied" 1024
cmp "$root/input" "$root/copied"
[[ $(stat -c '%d:%i' "$root/input") != "$(stat -c '%d:%i' "$root/copied")" ]]
[[ $(stat -c %a "$root/copied") == 400 ]]
`)
    })

    it('refuses active bootstrap drift without changing host files', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
source_dir="$root/source"; host="$root/host"; current="$host/opt/mydsh/current"; releases="$host/opt/mydsh/releases"; commit=${'8'.repeat(40)}
mkdir -p "$source_dir" "$host/etc/caddy" "$host/etc/systemd/system/caddy.service.d" "$host/usr/local/sbin" "$host/etc/mydsh" "$releases/$commit" "$host/var/lib/mydsh" "$host/var/lib/mydsh-deploy/uploads" "$host/srv/mydsh/workspace"
for spec in 'Caddyfile:etc/caddy/Caddyfile' 'mydsh.service:etc/systemd/system/mydsh.service' 'caddy-mydsh.conf:etc/systemd/system/caddy.service.d/mydsh.conf' 'deploy-release.sh:usr/local/sbin/mydsh-deploy-release'; do
  name=\${spec%%:*}; path=\${spec#*:}; printf '%s\nmatch\n' "$MANAGED_MARKER" >"$source_dir/$name"; cp "$source_dir/$name" "$host/$path"
done
printf '%s\nDSH_PUBLIC_HOST=dsh.example.com\n' "$MANAGED_MARKER" >"$host/etc/mydsh/public.env"
printf '%s\nDSH_HOME=/var/lib/mydsh\n' "$MANAGED_MARKER" >"$host/etc/mydsh/mydsh.env"
chmod 0644 "$host/etc/caddy/Caddyfile" "$host/etc/systemd/system/mydsh.service" "$host/etc/systemd/system/caddy.service.d/mydsh.conf" "$host/etc/mydsh/public.env"
chmod 0600 "$host/etc/mydsh/mydsh.env"
chmod 0755 "$host/usr/local/sbin/mydsh-deploy-release" "$host/opt/mydsh" "$releases" "$host/srv/mydsh" "$host/etc/mydsh" "$host/etc/caddy" "$host/etc/systemd/system/caddy.service.d"
chmod 0700 "$host/var/lib/mydsh" "$host/var/lib/mydsh-deploy" "$host/var/lib/mydsh-deploy/uploads"
chmod 0750 "$host/srv/mydsh/workspace"
ln -s "$releases/$commit" "$current"
stat() {
  if [[ "$1" == -c && "$2" == %U:%G ]]; then
    case "\${*: -1}" in
      */var/lib/mydsh|*/srv/mydsh/workspace) printf 'mydsh:mydsh\n' ;;
      *) printf 'root:root\n' ;;
    esac
  else
    command stat "$@"
  fi
}
active_bootstrap_matches dsh.example.com "$source_dir" "$host" "$current" "$releases"
before=$(sha256sum "$host/etc/caddy/Caddyfile")
printf '%s\ndrift\n' "$MANAGED_MARKER" >"$source_dir/Caddyfile"
if active_bootstrap_matches dsh.example.com "$source_dir" "$host" "$current" "$releases"; then exit 90; fi
after=$(sha256sum "$host/etc/caddy/Caddyfile")
[[ $before == "$after" ]]
cp "$host/etc/caddy/Caddyfile" "$source_dir/Caddyfile"
chmod 0644 "$host/etc/mydsh/mydsh.env"
if active_bootstrap_matches dsh.example.com "$source_dir" "$host" "$current" "$releases"; then exit 91; fi
chmod 0600 "$host/etc/mydsh/mydsh.env"
chmod 0775 "$host/usr/local/sbin/mydsh-deploy-release"
if active_bootstrap_matches dsh.example.com "$source_dir" "$host" "$current" "$releases"; then exit 92; fi
chmod 0755 "$host/usr/local/sbin/mydsh-deploy-release"
rm "$host/etc/mydsh/mydsh.env"
if active_bootstrap_matches dsh.example.com "$source_dir" "$host" "$current" "$releases"; then exit 93; fi
`,'bootstrap-host.sh')
    })

    it('rejects incomplete or over-permissive deployed host state', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
host="$root/host"
mkdir -p "$host/opt/mydsh/releases" "$host/srv/mydsh/workspace" "$host/var/lib/mydsh" "$host/var/lib/mydsh-deploy/uploads" "$host/etc/mydsh" "$host/etc/caddy" "$host/etc/systemd/system/caddy.service.d" "$host/usr/local/sbin"
for path in etc/mydsh/public.env etc/mydsh/mydsh.env etc/caddy/Caddyfile etc/systemd/system/mydsh.service etc/systemd/system/caddy.service.d/mydsh.conf usr/local/sbin/mydsh-deploy-release; do
  printf '%s\nmanaged\n' "$MANAGED_MARKER" >"$host/$path"
done
chmod 0644 "$host/etc/mydsh/public.env" "$host/etc/caddy/Caddyfile" "$host/etc/systemd/system/mydsh.service" "$host/etc/systemd/system/caddy.service.d/mydsh.conf"
chmod 0600 "$host/etc/mydsh/mydsh.env"
chmod 0755 "$host/usr/local/sbin/mydsh-deploy-release" "$host/opt/mydsh" "$host/opt/mydsh/releases" "$host/srv/mydsh" "$host/etc/mydsh" "$host/etc/caddy" "$host/etc/systemd/system/caddy.service.d" "$host/usr/local/sbin"
chmod 0700 "$host/var/lib/mydsh" "$host/var/lib/mydsh-deploy" "$host/var/lib/mydsh-deploy/uploads"
chmod 0750 "$host/srv/mydsh/workspace"
stat() {
  if [[ "$1" == -c && "$2" == %U:%G ]]; then
    case "\${*: -1}" in
      */var/lib/mydsh|*/srv/mydsh/workspace) printf 'mydsh:mydsh\n' ;;
      *) printf 'root:root\n' ;;
    esac
  else
    command stat "$@"
  fi
}
validate_managed_host_state "$host"
chmod 0644 "$host/etc/mydsh/mydsh.env"
if validate_managed_host_state "$host"; then exit 90; fi
chmod 0600 "$host/etc/mydsh/mydsh.env"
chmod 0775 "$host/usr/local/sbin/mydsh-deploy-release"
if validate_managed_host_state "$host"; then exit 91; fi
chmod 0755 "$host/usr/local/sbin/mydsh-deploy-release"
rm "$host/etc/systemd/system/caddy.service.d/mydsh.conf"
if validate_managed_host_state "$host"; then exit 92; fi
`)
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

    it('makes the synthetic systemd root traversable and removes it after every verification result', () => {
      expectBashSuccess(`
set -euo pipefail
fixture_parent=$(command mktemp -d)
trap 'rm -rf -- "$fixture_parent"' EXIT
asset_root="$fixture_parent/assets"
synthetic_root="$fixture_parent/mydsh-systemd-verify.test"
mkdir "$asset_root"
for name in Caddyfile mydsh.service caddy-mydsh.conf; do printf '%s\n' "$MANAGED_MARKER" >"$asset_root/$name"; done
printf '[Service]\nEnvironmentFile=/etc/mydsh/public.env\n' >>"$asset_root/caddy-mydsh.conf"
validate_control_plane_match() { return 0; }
validate_candidate_unit_contract() { return 0; }
validate_temp_directory() { return 0; }
caddy() { return 0; }
mktemp() {
  [[ $1 == -d && $2 == /run/mydsh-systemd-verify.XXXXXX ]] || return 91
  command mkdir -m 0700 "$synthetic_root"
  printf '%s\n' "$synthetic_root"
}
install() {
  [[ $# -eq 4 && $1 == -m && $2 == 0644 ]] || return 92
  case $4 in
    */mydsh.service) command cp "$asset_root/mydsh.service" "$4" ;;
    */mydsh.conf) command cp "$asset_root/caddy-mydsh.conf" "$4" ;;
    *) return 93 ;;
  esac
  command chmod 0644 "$4"
}
systemd_should_fail=false
systemd_calls=0
systemd-analyze() {
  [[ $# -eq 5 && $1 == --root=* && $2 == verify && $3 == --recursive-errors=no && $4 == mydsh.service && $5 == caddy.service ]] || return 94
  local root_path=\${1#--root=}
  local path
  local mode
  local directories=(
    '' /etc /etc/systemd /etc/systemd/system /etc/systemd/system/caddy.service.d /etc/mydsh
    /usr /usr/bin /srv /srv/mydsh /srv/mydsh/workspace /var /var/lib /var/lib/mydsh
    /opt /opt/mydsh /opt/mydsh/current /opt/mydsh/current/apps /opt/mydsh/current/apps/cli /opt/mydsh/current/apps/cli/lib
  )
  for path in "\${directories[@]}"; do
    mode=$(command stat -c %a -- "$root_path$path")
    if [[ $mode != 755 ]]; then
      printf '%s: Permission denied (directory %s mode %s)\n' "$root_path/usr/bin/node" "$root_path$path" "$mode" >&2
      return 1
    fi
  done
  for spec in \
    /etc/systemd/system/mydsh.service:644 \
    /etc/systemd/system/caddy.service.d/mydsh.conf:644 \
    /etc/systemd/system/caddy.service:644 \
    /usr/bin/node:755 \
    /usr/bin/caddy:755 \
    /opt/mydsh/current/apps/cli/lib/bin.js:755 \
    /etc/mydsh/public.env:644 \
    /etc/mydsh/mydsh.env:600; do
    path=\${spec%:*}
    mode=$(command stat -c %a -- "$root_path$path")
    [[ $mode == "\${spec##*:}" ]] || return 95
  done
  [[ ! -s "$root_path/etc/mydsh/public.env" && ! -s "$root_path/etc/mydsh/mydsh.env" ]] || return 96
  systemd_calls=$((systemd_calls + 1))
  [[ $systemd_should_fail == false ]]
}
umask 077
validate_candidate_configs "$asset_root"
[[ $systemd_calls == 1 && ! -e "$synthetic_root" && ! -L "$synthetic_root" ]]
systemd_should_fail=true
if validate_candidate_configs "$asset_root"; then exit 97; fi
[[ $systemd_calls == 2 && ! -e "$synthetic_root" && ! -L "$synthetic_root" ]]
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
printf 'format=1\ncommit=%s\nref=refs/tags/reviewed\nplatform=linux-amd64\nnode_major=24\npnpm_version=11.7.0\nhelper_journal_format=1\nnode_image_digest=%s\n' "${'d'.repeat(40)}" "$NODE_IMAGE_DIGEST" >"$release/.mydsh-release-manifest"
validate_release_manifest "$release"
validate_manifest_ref refs/heads/release/v1
validate_manifest_ref refs/tags/release-1.2.3
invalid_refs=(
  reviewed
  refs/tags/foo..bar
  'refs/heads/@{bad}'
  refs/heads/.hidden
  refs/tags/release.lock
  refs/heads/trailing.
  refs/heads//double
  refs/heads/trailing/
  'refs/heads/has space'
  'refs/heads/til~de'
  'refs/heads/caret^'
  'refs/heads/co:lon'
  'refs/heads/what?'
  'refs/heads/star*'
  'refs/heads/open['
  'refs/heads/close]'
  'refs/tags/back\\slash'
  $'refs/heads/control\\001'
)
for invalid_ref in "\${invalid_refs[@]}"; do
  if validate_manifest_ref "$invalid_ref"; then exit 88; fi
done
for invalid_ref in reviewed refs/tags/foo..bar 'refs/heads/@{bad}' refs/heads/.hidden refs/tags/release.lock 'refs/heads/what?'; do
  sed -i "s#^ref=.*#ref=$invalid_ref#" "$release/.mydsh-release-manifest"
  if validate_release_manifest "$release"; then exit 89; fi
done
sed -i 's#^ref=.*#ref=refs/heads/reviewed#' "$release/.mydsh-release-manifest"
sed -i 's#node_image_digest=.*#node_image_digest=sha256:0000#' "$release/.mydsh-release-manifest"
if validate_release_manifest "$release"; then exit 90; fi
sed -i "s#node_image_digest=.*#node_image_digest=$NODE_IMAGE_DIGEST#" "$release/.mydsh-release-manifest"
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

    it('publishes an artifact set with one directory rename and preserves unrelated output', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
output="$root/output"; mkdir "$output"; printf 'untouched\n' >"$output/sentinel"
staging=$(mktemp -d "$output/.mydsh-release-${'a'.repeat(40)}.new.XXXXXX")
final="$output/mydsh-release-${'a'.repeat(40)}"
printf 'artifact\n' >"$staging/mydsh-linux-amd64.tar.gz"
if publish_artifact_set "$staging" "$final" "$output"; then exit 90; fi
[[ ! -e "$final" && $(<"$output/sentinel") == untouched ]]
digest=$(sha256sum "$staging/mydsh-linux-amd64.tar.gz" | awk '{print $1}')
printf '%s  mydsh-linux-amd64.tar.gz\n' "$digest" >"$staging/mydsh-linux-amd64.tar.gz.sha256"
sync() { return 1; }
if publish_artifact_set "$staging" "$final" "$output"; then exit 91; fi
[[ ! -e "$final" && -d "$staging" && $(<"$output/sentinel") == untouched ]]
unset -f sync
publish_artifact_set "$staging" "$final" "$output"
[[ -d "$final" && ! -e "$staging" ]]
[[ -f "$final/mydsh-linux-amd64.tar.gz" && -f "$final/mydsh-linux-amd64.tar.gz.sha256" ]]
[[ $(<"$output/sentinel") == untouched ]]
`,'package-release.sh')
    })

    it('detects container mutation of every static security input', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
trusted="$root/trusted"; built="$root/built"; mkdir -p "$trusted/deploy/alibaba-cloud" "$built/deploy/alibaba-cloud"
for name in Caddyfile mydsh.service caddy-mydsh.conf invite-auth.cordis.yml; do printf '%s\n' "$name" >"$trusted/deploy/alibaba-cloud/$name"; done
cp -a "$trusted/." "$built/"
verify_static_inputs "$trusted" "$built"
for name in Caddyfile mydsh.service caddy-mydsh.conf invite-auth.cordis.yml; do
  cp -a "$trusted/." "$built/"
  printf 'mutated\n' >>"$built/deploy/alibaba-cloud/$name"
  if verify_static_inputs "$trusted" "$built"; then exit 90; fi
done
`,'package-release.sh')
    })

    it('rejects weakened or duplicated candidate systemd settings', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
unit="$root/mydsh.service"
cp "${resolve(deploymentRoot, 'mydsh.service').replaceAll('\\', '/')}" "$unit"
validate_candidate_unit_contract "$unit"
sed -i 's/^User=mydsh$/User=root/' "$unit"
if validate_candidate_unit_contract "$unit"; then exit 90; fi
cp "${resolve(deploymentRoot, 'mydsh.service').replaceAll('\\', '/')}" "$unit"
sed -i '/^ProtectSystem=strict$/d' "$unit"
if validate_candidate_unit_contract "$unit"; then exit 91; fi
cp "${resolve(deploymentRoot, 'mydsh.service').replaceAll('\\', '/')}" "$unit"
printf 'ExecStart=/bin/sh\n' >>"$unit"
if validate_candidate_unit_contract "$unit"; then exit 92; fi
cp "${resolve(deploymentRoot, 'mydsh.service').replaceAll('\\', '/')}" "$unit"
sed -i 's#^ReadWritePaths=.*#ReadWritePaths=/var/lib/mydsh /tmp#' "$unit"
if validate_candidate_unit_contract "$unit"; then exit 93; fi
cp "${resolve(deploymentRoot, 'mydsh.service').replaceAll('\\', '/')}" "$unit"
sed -i '/^After=network-online.target$/d' "$unit"
if validate_candidate_unit_contract "$unit"; then exit 94; fi
cp "${resolve(deploymentRoot, 'mydsh.service').replaceAll('\\', '/')}" "$unit"
printf 'StartLimitBurst=5\n' >>"$unit"
if validate_candidate_unit_contract "$unit"; then exit 95; fi
cp "${resolve(deploymentRoot, 'mydsh.service').replaceAll('\\', '/')}" "$unit"
printf 'SystemCallFilter=@system-service\n' >>"$unit"
if validate_candidate_unit_contract "$unit"; then exit 96; fi
cp "${resolve(deploymentRoot, 'mydsh.service').replaceAll('\\', '/')}" "$unit"
printf 'IPAddressDeny=any\n' >>"$unit"
if validate_candidate_unit_contract "$unit"; then exit 97; fi
cp "${resolve(deploymentRoot, 'mydsh.service').replaceAll('\\', '/')}" "$unit"
printf 'RestrictAddressFamilies=AF_UNIX\n' >>"$unit"
if validate_candidate_unit_contract "$unit"; then exit 98; fi
`)
    })

    it('rejects any candidate control-plane byte drift', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
installed="$root/installed"; candidate="$root/candidate"; mkdir "$installed" "$candidate"
cp "${resolve(deploymentRoot, 'Caddyfile').replaceAll('\\', '/')}" "$installed/Caddyfile"
cp "${resolve(deploymentRoot, 'mydsh.service').replaceAll('\\', '/')}" "$installed/mydsh.service"
cp "${resolve(deploymentRoot, 'caddy-mydsh.conf').replaceAll('\\', '/')}" "$installed/caddy-mydsh.conf"
cp -a "$installed/." "$candidate/"
validate_control_plane_match "$candidate" "$installed/Caddyfile" "$installed/mydsh.service" "$installed/caddy-mydsh.conf"
printf 'ExecStartPre=+/bin/sh\n' >>"$candidate/mydsh.service"
if validate_control_plane_match "$candidate" "$installed/Caddyfile" "$installed/mydsh.service" "$installed/caddy-mydsh.conf"; then exit 90; fi
cp "$installed/mydsh.service" "$candidate/mydsh.service"
printf '\n[Socket]\nListenStream=0.0.0.0:3080\n' >>"$candidate/mydsh.service"
if validate_control_plane_match "$candidate" "$installed/Caddyfile" "$installed/mydsh.service" "$installed/caddy-mydsh.conf"; then exit 91; fi
cp "$installed/mydsh.service" "$candidate/mydsh.service"
printf '\n:443 { reverse_proxy 127.0.0.1:3080 }\n' >>"$candidate/Caddyfile"
if validate_control_plane_match "$candidate" "$installed/Caddyfile" "$installed/mydsh.service" "$installed/caddy-mydsh.conf"; then exit 92; fi
`)
    })

    it('activates code without modifying the stable control plane', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
candidate="$root/candidate"
previous="$root/${'a'.repeat(40)}"
control="$root/control"
mkdir -p "$candidate/deploy/alibaba-cloud" "$previous" "$control"
for name in Caddyfile mydsh.service caddy-mydsh.conf; do printf 'stable-%s\n' "$name" >"$control/$name"; done
before=$(sha256sum "$control"/*)
validate_candidate_configs() { return 0; }
enable_state=enabled
service_enable_state() { printf '%s\n' "$enable_state"; }
systemctl() {
  case "\${1:-} \${2:-}" in
    'enable mydsh') enable_state=enabled ;;
    'disable mydsh') enable_state=disabled ;;
  esac
  return 0
}
health_check() { return 0; }
sync_activated_state() { return 0; }
authenticated_acceptance() { return 0; }
public_acceptance() { return 0; }
ln -s "$previous" "$root/current"
activate_transaction "$candidate" "$previous" "$candidate/deploy/alibaba-cloud" '' "$root/current" "$root/activation"
[[ $(readlink "$root/current") == "$candidate" ]]
[[ $enable_state == enabled ]]
[[ $(sha256sum "$control"/*) == "$before" ]]
rm -f "$root/current"
ln -s "$previous" "$root/current"
sync_activated_state() { if [[ ! -e "$root/sync-failed" ]]; then touch "$root/sync-failed"; return 1; fi; return 0; }
if activate_transaction "$candidate" "$previous" "$candidate/deploy/alibaba-cloud" '' "$root/current" "$root/activation"; then exit 90; fi
[[ $(readlink "$root/current") == "$previous" ]]
[[ $enable_state == enabled ]]
[[ $(sha256sum "$control"/*) == "$before" ]]
rm -f "$root/current"
enable_state=disabled
rm -f "$root/sync-failed"
if activate_transaction "$candidate" '' "$candidate/deploy/alibaba-cloud" '' "$root/current" "$root/activation"; then exit 91; fi
[[ ! -e "$root/current" && ! -L "$root/current" ]]
[[ $enable_state == disabled ]]
[[ $(sha256sum "$control"/*) == "$before" ]]
`)
    })

    it('keeps an accepted code activation successful when journal cleanup fails', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'command rm -rf -- "$root"' EXIT
candidate="$root/candidate"
previous="$root/${'a'.repeat(40)}"
mkdir -p "$candidate/deploy/alibaba-cloud" "$previous"
validate_candidate_configs() { return 0; }
service_enable_state() { printf 'enabled\n'; }
systemctl() { return 0; }
health_check() { return 0; }
sync_activated_state() { return 0; }
public_acceptance() { return 0; }
authenticated_acceptance() { return 0; }
rm() { [[ "\${*: -1}" == */activation ]] && return 1; command rm "$@"; }
ln -s "$previous" "$root/current"
activate_transaction "$candidate" "$previous" "$candidate/deploy/alibaba-cloud" '' "$root/current" "$root/activation" 2>"$root/warning"
[[ $(readlink "$root/current") == "$candidate" ]]
grep -F 'activation accepted but committed journal cleanup was not durable' "$root/warning"
`)
    })

    it('retains and recovers durable prepared and committed journals', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
previous="$root/${'a'.repeat(40)}"; candidate="$root/${'b'.repeat(40)}"; journal="$root/activation"
mkdir -p "$previous" "$candidate"
systemctl() { return 0; }; health_check() { return 0; }; sync_activated_state() { return 0; }; sync() { return 0; }
ln -s "$previous" "$root/current"
prepare_activation_journal "$journal" "$candidate" "$previous" '' '' enabled
atomic_replace_link "$root/current" "$candidate"
atomic_definition=$(declare -f atomic_replace_link)
atomic_replace_link() { return 1; }
if recover_activation_journal "$journal" '' "$root/current"; then exit 90; fi
[[ -d "$journal" && $(readlink "$root/current") == "$candidate" ]]
eval "$atomic_definition"
recover_activation_journal "$journal" '' "$root/current"
[[ ! -e "$journal" && $(readlink "$root/current") == "$previous" ]]
prepare_activation_journal "$journal" "$candidate" "$previous" '' '' enabled
write_journal_state "$journal" committed
finalize_committed_journal "$journal"
rm() { return 1; }
if recover_activation_journal "$journal" '' "$root/current"; then exit 91; fi
[[ -d "$journal" && $(readlink "$root/current") == "$previous" ]]
unset -f rm
recover_activation_journal "$journal" '' "$root/current"
[[ ! -e "$journal" && $(readlink "$root/current") == "$previous" ]]
`)
    })

    it('publishes only complete prepared journals and clears safe abandoned staging', () => {
      expectBashSuccess(`
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT
journal="$root/activation"; candidate="$root/${'c'.repeat(40)}"
mkdir -p "$candidate"
sync() { return 0; }
value_definition=$(declare -f write_journal_value)
write_journal_value() { return 1; }
if prepare_activation_journal "$journal" "$candidate" '' '' '' disabled; then exit 90; fi
[[ ! -e "$journal" && ! -L "$journal" ]]
if compgen -G "$root/activation.new.*" >/dev/null; then exit 91; fi
eval "$value_definition"
state_definition=$(declare -f write_journal_state)
write_journal_state() { return 1; }
if prepare_activation_journal "$journal" "$candidate" '' '' '' disabled; then exit 92; fi
[[ ! -e "$journal" && ! -L "$journal" ]]
if compgen -G "$root/activation.new.*" >/dev/null; then exit 93; fi
eval "$state_definition"
sync() { return 1; }
if prepare_activation_journal "$journal" "$candidate" '' '' '' disabled; then exit 94; fi
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
assets="$root/assets"; candidate="$root/${'7'.repeat(40)}"; journal="$root/activation"
mkdir -p "$assets" "$candidate"
validate_candidate_configs() { return 0; }
enable_state=disabled
service_enable_state() { printf '%s\n' "$enable_state"; }
systemctl() { case "\${1:-} \${2:-}" in 'enable mydsh') enable_state=enabled ;; 'disable mydsh') enable_state=disabled ;; esac; return 0; }
health_check() { return 0; }; public_acceptance() { return 0; }; authenticated_acceptance() { return 0; }; sync_activated_state() { return 0; }; sync() { return 0; }
eval "$(declare -f write_journal_state | sed '1s/write_journal_state/write_journal_state_real/')"
write_journal_state() { if [[ $2 == committed ]]; then printf 'state=committed\n' >"$1/state"; return 2; fi; write_journal_state_real "$@"; }
if activate_transaction "$candidate" '' "$assets" '' "$root/current" "$journal" >"$root/first-output" 2>&1; then exit 90; fi
[[ ! -e "$root/current" && ! -L "$root/current" ]]
[[ $enable_state == disabled ]]
[[ ! -e "$journal" ]]
if grep -F 'activation accepted' "$root/first-output"; then exit 91; fi
remove_definition=$(declare -f remove_first_link)
remove_first_link() { return 1; }
if activate_transaction "$candidate" '' "$assets" '' "$root/current" "$journal" >"$root/second-output" 2>&1; then exit 92; fi
[[ -d "$journal" && -f "$journal/rollback-required" ]]
grep -Fx 'state=committed' "$journal/state"
[[ $(readlink "$root/current") == "$candidate" && $enable_state == enabled ]]
if grep -F 'activation accepted' "$root/second-output"; then exit 93; fi
grep -F 'forced rollback incomplete; recovery required' "$root/second-output"
eval "$remove_definition"
recover_activation_journal "$journal" '' "$root/current"
[[ ! -e "$root/current" && ! -L "$root/current" && ! -e "$journal" ]]
[[ $enable_state == disabled ]]
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

  it('activates code only after validating the frozen control plane', () => {
    const script = asset('deploy-release.sh')
    const start = script.indexOf('activate_transaction() {')
    const end = script.indexOf('\nrollback_to_commit()', start)
    const activation = script.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(activation.indexOf('atomic_replace_link "$current_path" "$target"')).toBeLessThan(activation.indexOf('systemctl restart mydsh'))
    expect(activation.indexOf('systemctl restart mydsh')).toBeLessThan(activation.indexOf('health_check'))
    expect(activation.indexOf('validate_candidate_configs')).toBeLessThan(activation.indexOf('atomic_replace_link'))
    expect(activation).not.toContain('caddy validate')
    expect(activation).not.toContain('systemctl reload caddy')
    expect(activation.indexOf('systemctl enable mydsh')).toBeLessThan(activation.indexOf('write_journal_state "$journal" committed'))
    expect(activation).not.toMatch(/install_managed_file|stage_candidate_configs|restore_host_configs/)
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
      expect(readme).toContain('PACKAGER_STAGE/deploy/alibaba-cloud/package-release.sh')
      expect(readme).toContain('node:24-bookworm@sha256:ffeee58a257b390b80b9b656cba440bbc3116c1bc03139c31318f9d9c29a8975')
      expect(readme).toContain('/var/lib/mydsh-deploy/uploads')
      expect(readme).toMatch(/1 GiB.*500,000.*512 MiB.*8 GiB|1 GiB.*500,000.*512 MiB.*8 GiB/)
      expect(readme).toMatch(/byte-for-byte identical|逐字节相同/)
      expect(readme).toMatch(/network and disk.*not bounded|网络和磁盘.*不受限制/)
      expect(readme).toContain("mydsh-deploy-release './${UPGRADE_SET##*/}'")
      expect(readme).not.toMatch(/with those two files|这两个文件调用/)
      expect(readme).not.toContain('scp deploy/alibaba-cloud/{Caddyfile')
      expect(readme).not.toContain('feat/invite-auth-deployment')
      expect(readme).toContain('mktemp -d "$HOME/mydsh-deploy.XXXXXX"')
      expect(readme.split('[[ $REMOTE_STAGE =~ ^/[A-Za-z0-9._/-]+/mydsh-deploy\\.[A-Za-z0-9]{6}$ ]]').length - 1).toBe(2)
      expect(readme.split("if [[ \\$status == 0 ]]; then if rm -rf -- '$REMOTE_STAGE'").length - 1).toBe(2)
      expect(readme).toContain('Upgrade failed; upload retained')
      expect(readme).not.toContain('git bundle verify')
      expect(readme).toContain('SHA-256')
      expect(readme).toMatch(/does not establish signer identity|不能证明签名者身份|真实性/i)
      expect(readme).toMatch(/selected rollback|选定的回滚/)
      expect(readme).toContain('rm -rf')
      expect(readme).toContain('if [[ \\$status == 0 ]]')
      expect(readme).toContain('/usr/local/sbin/mydsh-deploy-release --prune "$candidate"')
      expect(readme).not.toContain('sudo rm -rf -- "$target"')
      expect(readme).toContain('mydsh-deploy-release --rotate-invite')
      expect(readme).toContain('mydsh-deploy-release --rotate-session')
      expect(readme).toMatch(/existing active healthy release|现有且健康的活动 release/)
      expect(readme).toMatch(/fresh bootstrap.*deploy|全新 bootstrap.*部署/)
      expect(readme).not.toContain("sudo bash -c '\nset -euo pipefail\numask 077\nrotate()")
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
      expect(note).toMatch(/serializes|串行/)
      expect(note).toContain('SHA-256')
      expect(note).toMatch(/release-contained|release 中的|release 内/)
      expect(note).toMatch(/production host|生产宿主/)
      expect(note).toMatch(/frozen control-plane|冻结的控制平面/)
      expect(note).toMatch(/byte-identical|逐字节相同/)
      expect(note).not.toMatch(/resource-bounded|受资源限制/)
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
      expect(design).toContain('node:24-bookworm@sha256:ffeee58a257b390b80b9b656cba440bbc3116c1bc03139c31318f9d9c29a8975')
      expect(design).toContain('/var/lib/mydsh-deploy/activation')
      expect(design).toContain('/var/lib/mydsh-deploy/uploads')
      expect(design).toContain('/run/mydsh-deploy.lock')
      expect(design).toMatch(/systemd.*Caddy|systemd.*Caddy/)
      expect(design).toMatch(/public.*authenticated|公开.*认证/)
      expect(design).toMatch(/byte for byte|逐字节相同/)
      expect(design).not.toMatch(/host-file backups|宿主文件备份|resource-bounded|受资源限制/)
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
      expect(plan).toContain('PACKAGER_STAGE/deploy/alibaba-cloud/package-release.sh')
      expect(plan).toMatch(/byte-identical|逐字节相同/)
      for (const stale of [
        'mydsh-build',
        'mydsh-release.bundle',
        'runuser -u mydsh',
        'var/cache/mydsh-pnpm',
        'node_setup',
        'bash deploy/alibaba-cloud/package-release.sh',
      ]) expect(plan).not.toContain(stale)
    }
  })
})
