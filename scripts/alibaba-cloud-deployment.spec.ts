/** Contract tests for the single-host Alibaba Cloud deployment assets. */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const deploymentRoot = resolve(import.meta.dirname, '../deploy/alibaba-cloud')

function asset(name: string): string {
  return readFileSync(resolve(deploymentRoot, name), 'utf8')
}

function wslPath(path: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path)
  if (match === null) throw new Error(`cannot project Windows path into WSL: ${path}`)
  return `/mnt/${match[1]!.toLowerCase()}/${match[2]!.replaceAll('\\', '/')}`
}

function runBash(body: string): ReturnType<typeof spawnSync> {
  const deploymentScript = resolve(deploymentRoot, 'deploy-release.sh')
  const command = process.platform === 'win32' ? 'wsl.exe' : 'bash'
  const shellPath = process.platform === 'win32' ? wslPath(deploymentScript) : deploymentScript
  const sourceCommand = `source '${shellPath.replaceAll("'", "'\\''")}'\n${body}`
  const args = process.platform === 'win32' ? ['bash', '-s'] : ['-s']
  return spawnSync(command, args, { encoding: 'utf8', input: sourceCommand })
}

function expectBashSuccess(body: string): void {
  const result = runBash(body)
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
    expect(script).toContain('https://deb.nodesource.com/setup_24.x')
    expect(script).toMatch(/bash .*nodesource/)
    expect(script).toContain('https://dl.cloudsmith.io/public/caddy/stable/gpg.key')
    expect(script).toContain('https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt')
    expect(script).toContain('pnpm@11.7.0')
    expect(script).toMatch(/node --version[\s\S]*24/)
    expect(script).toMatch(/pnpm --version[\s\S]*11\.7\.0/)
    expect(script).toContain('openssl rand -hex 16')
    expect(script).toContain('openssl rand -hex 32')
    expect(script).toContain('if [[ ! -e /etc/mydsh/mydsh.env ]]')
    expect(script).toContain('DSH_HOME=/var/lib/mydsh')
    expect(script).toContain('DSH_INVITE_CODE_SECRET=')
    expect(script).toContain('DSH_INVITE_SESSION_SECRET=')
    expect(script).toMatch(/install -d -o root -g root -m 0755 \/opt\/mydsh \/opt\/mydsh\/releases \/etc\/mydsh/)
    expect(script).toContain('install -d -o mydsh -g mydsh -m 0700 /var/lib/mydsh')
    expect(script).toContain('install -d -o mydsh -g mydsh -m 0750 /srv/mydsh/workspace /var/cache/mydsh-pnpm')
    expect(script).toMatch(/caddy validate --config \/etc\/caddy\/Caddyfile --adapter caddyfile/)
    expect(script).toContain('systemctl enable caddy')
    expect(script).toContain('systemctl restart caddy')
    expect(script).not.toMatch(/systemctl (?:enable|start|restart).*mydsh/)
    expect(script).toContain('Managed by DeepSeek Harness Alibaba Cloud deployment')
    expect(script).toContain('.pre-mydsh')
    expect(script).toContain("printf 'DSH_INVITE_CODE_SECRET=%s\\n' \"$invite_code\"")
    expect(script).toMatch(/printf 'DSH_INVITE_SESSION_SECRET=%s\\n' "\$session_secret"\n  \} >"\$private_env_tmp"/)
    expect(script).not.toMatch(/(?:invite_code|session_secret)[^\n]*(?:\/dev\/stdout|>&2)/i)
  })

  it('publishes immutable releases and rolls back failed health checks', () => {
    const script = asset('deploy-release.sh')

    expect(script).toMatch(/^#!\/usr\/bin\/env bash\nset -euo pipefail\n/)
    expect(script).toMatch(/\[\[ \$# -eq 2 \]\]/)
    expect(script).not.toContain('set -x')
    expect(script).toContain('realpath -e --')
    expect(script).toContain('git bundle verify')
    expect(script).toContain('git check-ref-format --branch')
    expect(script).toContain('/opt/mydsh/releases/.staging.XXXXXX')
    expect(script).toContain('staged_bundle="$STAGING_ROOT/release.bundle"')
    expect(script).toMatch(/install .*"\$bundle_path" "\$staged_bundle"/)
    expect(script).toMatch(/runuser -u mydsh -- git clone --branch .* --single-branch "\$staged_bundle"/)
    expect(script).toMatch(/git .*rev-parse HEAD/)
    expect(script).toContain('pnpm install --frozen-lockfile --store-dir /var/cache/mydsh-pnpm')
    expect(script).toMatch(/vitest run packages\/host\/invite-auth\/tests/)
    expect(script).toContain('pnpm run build')
    expect(script).toContain('--dump-config')
    expect(script).toContain('chown -R root:root')
    expect(script).toContain('chmod -R go-w')
    expect(script).toContain('caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile')
    expect(script).toContain('local next_path="${current_path}.next"')
    expect(script).toContain('ln -s -- "$target" "$next_path"')
    expect(script).toContain('mv -Tf -- "$next_path" "$current_path"')
    expect(script).toMatch(/for .* in \{1\.\.30\}/)
    expect(script).toContain('http://127.0.0.1:3080/__invite/login')
    expect(script).toMatch(/if health_check; then/)
    expect(script).toMatch(/recover_activation[\s\S]*systemctl restart mydsh/)
    expect(script).toContain('systemctl reload caddy')
    expect(script).toContain('/etc/systemd/system/caddy.service.d/mydsh.conf')
    expect(script).toContain('mydsh_uid=$(id -u mydsh)')
    expect(script).toContain('[[ $mydsh_uid != 0 ]]')
    expect(script).toContain('getent passwd mydsh')
    expect(script).toContain('nologin')
    expect(script).toContain('if [[ ${BASH_SOURCE[0]} == "$0" ]]')
    expect(script).not.toMatch(/rm -rf -- \/opt\/mydsh\/releases(?:\s|$)/m)
    expect(script).not.toMatch(/(?:echo|printf)[^\n]*DSH_INVITE_(?:CODE|SESSION)_SECRET/)
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

  it('activates Caddy only after the switched DSH release is healthy', () => {
    const script = asset('deploy-release.sh')
    const start = script.indexOf('activate_release() {')
    const end = script.indexOf('\nrollback_to_commit()', start)
    const activation = script.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(activation.indexOf('atomic_replace_link "$CURRENT_LINK" "$target"')).toBeLessThan(activation.indexOf('systemctl restart mydsh'))
    expect(activation.indexOf('systemctl restart mydsh')).toBeLessThan(activation.indexOf('health_check'))
    expect(activation.indexOf('health_check')).toBeLessThan(activation.indexOf('caddy validate'))
    expect(activation.indexOf('caddy validate')).toBeLessThan(activation.indexOf('systemctl reload caddy'))
    expect(activation).toMatch(/if caddy validate[\s\S]*if systemctl reload caddy[\s\S]*recover_activation/)
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
      expect(readme).toContain('deploy-release.sh --rollback "$commit"')
    }
  })
})
