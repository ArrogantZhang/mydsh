# Deploy DeepSeek Harness on Alibaba Cloud

English | [中文](README.zh.md)

This tutorial deploys one invite-protected DeepSeek Harness Web process on an Alibaba Cloud ECS host. Caddy is the only public entry point; every authenticated visitor shares the same sessions, workspace, credentials, and command authority.

## Prerequisites

Use a fresh Ubuntu 22.04 or 24.04 ECS instance with a public address, a sudo-capable SSH account, and a lowercase DNS hostname whose A or AAAA record points to the instance. In the Alibaba Cloud security group, allow TCP 22 only from administrator addresses and TCP 80 and 443 from intended clients. Never allow TCP 3080: reaching that port bypasses Caddy authentication.

The bootstrap installs Node.js 24 from the [official NodeSource repository](https://github.com/nodesource/distributions), pnpm 11.7.0, and Caddy from the [official stable Debian repository](https://caddyserver.com/docs/install#debian-ubuntu-raspbian). It requires NodeSource fingerprint `6F71F525282841EEDAF851B42F59B5F99B1BE0B4` and Caddy fingerprint `65760C51EDEA2017CEA2CA15155B6D79CA56EA34` before authoring either APT source; package signatures authenticate repository output, while the exact Node.js and Caddy patch versions may advance within those signed repositories. Review both repository procedures before running a root script on a long-lived host.

The examples use `dsh.example.com`, `ecs-admin@203.0.113.10`, and a reviewed release tag stored in `DEPLOY_REF`. Replace all three values with the DNS name, SSH destination, and reviewed branch or signed tag selected for this deployment.

## Prepare and upload a release

Run these commands from the repository root on your development machine. The bundle contains the named branch and its reachable commits without copying your working tree or untracked files.

```bash
set -euo pipefail
DEPLOY_REF=refs/tags/dsh-reviewed-YYYYMMDD
REMOTE=ecs-admin@203.0.113.10
git status --short
git bundle create mydsh.bundle "$DEPLOY_REF"
git bundle verify mydsh.bundle
REMOTE_STAGE=$(ssh "$REMOTE" 'mktemp -d "$HOME/mydsh-deploy.XXXXXX"')
[[ $REMOTE_STAGE == */mydsh-deploy.* ]]
scp deploy/alibaba-cloud/{Caddyfile,mydsh.service,caddy-mydsh.conf,bootstrap-host.sh,deploy-release.sh} "$REMOTE:$REMOTE_STAGE/"
scp mydsh.bundle "$REMOTE:$REMOTE_STAGE/"
```

The first `scp` uploads all five bootstrap and deployment assets to the same unpredictable, SSH-user-owned directory. The overlay stays in the Git bundle and is validated from the checked-out release. `git bundle verify` checks bundle structure, prerequisites, and object connectivity; it does not prove authenticity. Trust comes from the reviewed local checkout and, when used, verification of the selected signed tag or commit before bundle creation.

## Bootstrap the host

Run bootstrap from the uploaded directory. It installs the reviewed control-plane helper at `/usr/local/sbin/mydsh-deploy-release`; deployments and rollbacks never execute root control flow from a release directory. Re-running bootstrap updates files carrying the stable managed marker and refuses symlinks, wrong file types, non-root ownership, or unmanaged targets instead of replacing them.

```bash
ssh -t "$REMOTE" "cd '$REMOTE_STAGE' && sudo bash ./bootstrap-host.sh dsh.example.com"
```

The script creates separate `mydsh` runtime and `mydsh-build` builder accounts, persistent and release directories, `/etc/mydsh/public.env`, and a root-readable-only private environment file. Ubuntu 22.04 and 24.04 assign system accounts a UID below 1000; bootstrap requires that range, a non-root UID, distinct groups, and `/usr/sbin/nologin` or its `/sbin/nologin` equivalent before changing directory ownership. The builder receives only its private home, scratch `DSH_HOME`, package cache, and candidate staging tree; runtime data, workspace, environment files, and secrets remain inaccessible. Bootstrap validates and starts Caddy, but does not start `mydsh` before a release exists.

## Deploy the release

Deploy the exact ref carried by the bundle through the root-installed helper. It runs clone, dependency lifecycle scripts, tests, build, and config dump as `mydsh-build` under an empty, minimal environment and scratch `DSH_HOME`, then makes the completed release root-owned and immutable. Activation validates the candidate unit and Caddy configuration, serializes all host changes with bootstrap and rollback, installs the candidate unit and proxy files, switches `/opt/mydsh/current`, verifies the runtime process and public/authenticated behavior, and accepts the release only after every check passes. Any failure restores the previous code link and all three host configuration files; first-deployment failure restores bootstrap configuration and stops DSH.

```bash
ssh -t "$REMOTE" "cd '$REMOTE_STAGE' && sudo /usr/local/sbin/mydsh-deploy-release ./mydsh.bundle '$DEPLOY_REF'; status=\$?; if [[ \$status == 0 ]]; then rm -rf -- '$REMOTE_STAGE'; else printf 'Deployment failed; upload retained at %s\\n' '$REMOTE_STAGE' >&2; fi; exit \$status"
```

The remote command removes the upload only after success. A failed update retains the exact bundle and uploaded assets, restores the previous `current` target, and restarts it; a failed first deployment retains the upload and failed immutable release, removes only the new validated symlink, and stops `mydsh`.

## Verify HTTPS and login

Check both services, listeners, the public certificate, and the unauthenticated login page. The listener output must show Caddy on ports 80 and 443 and DSH only on `127.0.0.1:3080` or `[::1]:3080`, never a wildcard or public address.

```bash
sudo systemctl status --no-pager caddy mydsh
sudo ss -ltnp '( sport = :80 or sport = :443 or sport = :3080 )'
curl --fail --silent --show-error --output /dev/null https://dsh.example.com/__invite/login
openssl s_client -connect dsh.example.com:443 -servername dsh.example.com </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates
```

An administrator may retrieve the initial invite code directly over SSH. Run this command yourself; do not paste its output into an issue, agent conversation, shell history annotation, or log.

```bash
sudo sed -n 's/^DSH_INVITE_CODE_SECRET=//p' /etc/mydsh/mydsh.env
```

Open `https://dsh.example.com`, enter that code, and confirm the DSH page loads. Close every browser window, reopen the site, and confirm the 30-day cookie still authenticates the browser; then log out and confirm the login page returns. The following server-side smoke test exercises the same acceptance path without printing secrets, response bodies, headers, or cookie values: unauthenticated HTML receives `303`, unauthenticated API traffic receives `401`, login receives `303`, a new client process reuses a cookie whose expiry is at least 29 days away, tampering is rejected, and logout denies access again.

```bash
sudo bash -c '
set -euo pipefail
source /etc/mydsh/public.env
source /etc/mydsh/mydsh.env
cookie_jar=$(mktemp)
tampered_jar=$(mktemp)
trap '\''rm -f -- "$cookie_jar" "$tampered_jar"'\'' EXIT
base="https://$DSH_PUBLIC_HOST"
resolve="$DSH_PUBLIC_HOST:443:127.0.0.1"
home_unauth_status=$(curl --silent --show-error --output /dev/null --write-out "%{http_code}" --max-time 10 --resolve "$resolve" --header "Accept: text/html" "$base/")
[[ $home_unauth_status == 303 ]]
api_unauth_status=$(curl --silent --show-error --output /dev/null --write-out "%{http_code}" --max-time 10 --resolve "$resolve" "$base/api/events.mux")
[[ $api_unauth_status == 401 ]]
post_status=$(printf "inviteCode=%s" "$DSH_INVITE_CODE_SECRET" | curl --silent --show-error --output /dev/null --write-out "%{http_code}" --max-time 10 --resolve "$resolve" --cookie-jar "$cookie_jar" --header "Origin: $base" --header "Content-Type: application/x-www-form-urlencoded" --data-binary @- "$base/__invite/login")
[[ $post_status == 303 ]]
get_status=$(curl --fail --silent --show-error --output /dev/null --write-out "%{http_code}" --max-time 10 --resolve "$resolve" --cookie "$cookie_jar" "$base/")
[[ $get_status == 200 ]]
cookie_expiry=$(awk -F "\t" '\''$6 == "__Host-dsh_invite" { print $5 }'\'' "$cookie_jar")
[[ $cookie_expiry =~ ^[0-9]+$ ]]
(( cookie_expiry >= $(date +%s) + 2505600 ))
awk -F "\t" '\''BEGIN { OFS="\t" } NF == 7 { $7=$7 "x" } { print }'\'' "$cookie_jar" >"$tampered_jar"
tampered_status=$(curl --silent --show-error --output /dev/null --write-out "%{http_code}" --max-time 10 --resolve "$resolve" --cookie "$tampered_jar" --header "Accept: text/html" "$base/")
[[ $tampered_status == 303 ]]
logout_status=$(curl --silent --show-error --output /dev/null --write-out "%{http_code}" --max-time 10 --resolve "$resolve" --cookie "$cookie_jar" --cookie-jar "$cookie_jar" --header "Origin: $base" --data "" "$base/__invite/logout")
[[ $logout_status == 303 ]]
after_logout_status=$(curl --silent --show-error --output /dev/null --write-out "%{http_code}" --max-time 10 --resolve "$resolve" --cookie "$cookie_jar" --header "Accept: text/html" "$base/")
[[ $after_logout_status == 303 ]]
printf "Authenticated smoke passed.\n"
'
```

## Configure Kimi

In the Web UI, open **Settings → Models**, add a custom OpenAI-compatible provider, and enter the API base URL, model identifier, and API key issued by Kimi. Follow the current [Kimi API documentation](https://platform.moonshot.cn/docs/guide/start-using-kimi-api) for account-specific values, save the provider, select its model, and send one test conversation.

Keep model keys in the DSH credential store. Never add them to this directory, a Git bundle, `/etc/mydsh/public.env`, shell tracing, deployment output, or repository logs.

## Upgrade and roll back

Create a new bundle from a reviewed deployment ref, upload it beside the five assets, and invoke `/usr/local/sbin/mydsh-deploy-release` with that bundle and exact ref. Each full commit receives one directory under `/opt/mydsh/releases`; the helper refuses to overwrite an existing release, and `/opt/mydsh/current` names the active one. `/var/lib/mydsh` and `/srv/mydsh/workspace` remain outside releases and do not roll back with code.

The deploy script rolls back automatically when restart, health acceptance, Caddy validation, or Caddy reload fails. For an operator-directed rollback, choose a known-good full commit from `sudo ls -1 /opt/mydsh/releases`. The preflight below requires 40 lowercase hexadecimal characters, resolves the directory canonically, and proves that its parent and basename are exact before the script performs the same validation, atomic switch, restart, health check, and Caddy activation.

```bash
set -euo pipefail
commit=0123456789abcdef0123456789abcdef01234567
[[ $commit =~ ^[0-9a-f]{40}$ ]]
target=$(sudo realpath -e -- "/opt/mydsh/releases/$commit")
[[ ${target%/*} == /opt/mydsh/releases ]]
[[ ${target##*/} == "$commit" ]]
sudo /usr/local/sbin/mydsh-deploy-release --rollback "$commit"
```

Inspect disk usage with `sudo du -sh /opt/mydsh/releases/*` before pruning. Never choose the active commit or the release retained for operator-selected rollback. The root helper takes the same deployment lock, requires one full lowercase commit, proves canonical confinement, refuses the active target, and removes only that exact inactive release; retaining the selected rollback remains the operator's responsibility.

```bash
set -euo pipefail
candidate=0123456789abcdef0123456789abcdef01234567
[[ $candidate =~ ^[0-9a-f]{40}$ ]]
# Confirm that $candidate is not the selected rollback release, then run:
sudo /usr/local/sbin/mydsh-deploy-release --prune "$candidate"
```

## Rotate authentication secrets

Changing `DSH_INVITE_CODE_SECRET` changes later logins but leaves existing 30-day cookies valid. Changing `DSH_INVITE_SESSION_SECRET` immediately invalidates every cookie. The following root-only helper atomically replaces one value without printing it; run one `rotate` line, then restart the service.

```bash
sudo bash -c '
set -euo pipefail
umask 077
rotate() {
  key=$1
  bytes=$2
  value=$(openssl rand -hex "$bytes")
  temporary=$(mktemp /etc/mydsh/.mydsh.env.XXXXXX)
  trap '\''rm -f -- "$temporary"'\'' EXIT
  found=0
  while IFS= read -r line; do
    case "$line" in
      "$key="*) printf "%s=%s\n" "$key" "$value"; found=1 ;;
      *) printf "%s\n" "$line" ;;
    esac
  done </etc/mydsh/mydsh.env >"$temporary"
  [[ $found == 1 ]]
  chown root:root "$temporary"
  chmod 0600 "$temporary"
  mv -f -- "$temporary" /etc/mydsh/mydsh.env
  trap - EXIT
  unset value
}
rotate DSH_INVITE_CODE_SECRET 16
# Use this instead to revoke every cookie:
# rotate DSH_INVITE_SESSION_SECRET 32
systemctl restart mydsh
'
```

## Troubleshoot

- Read recent service logs with `sudo journalctl -u mydsh -n 200 --no-pager` and Caddy logs with `sudo journalctl -u caddy -n 200 --no-pager`; do not copy environment files or cookies into reports.
- A public `502` means Caddy cannot reach a ready DSH process. Inspect `systemctl status mydsh`, its journal, `/opt/mydsh/current`, and the loopback listener.
- A login `403` usually means the public hostname, HTTPS origin, or proxy headers disagree. Re-run bootstrap with the exact lowercase DNS hostname, validate DNS, then run `sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`.
- A login `429` means the source address exceeded the in-process failure limit. Wait for the configured window or restart `mydsh` only after investigating repeated failures; restart clears every rate-limit bucket.

## Limitations

Caddy's authorization check protects every non-invite route, and the overlay's readiness dependency prevents the frontend fallback from answering before the invite route exists. Exposing port 3080 bypasses both protections.

This deployment runs one DSH process and is intended for a small trusted group. Rate limits are process-local, and invite authentication does not provide individual identity, workspace isolation, session ownership, or per-user command permissions. See the [invite-auth package contract](../../packages/host/invite-auth/README.md) before granting access.
