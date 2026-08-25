# Deploy DeepSeek Harness on Alibaba Cloud

English | [中文](README.zh.md)

This tutorial deploys one invite-protected DeepSeek Harness Web process on an Alibaba Cloud ECS host. Caddy is the only public entry point; every authenticated visitor shares the same sessions, workspace, credentials, and command authority.

## Prerequisites

Use a fresh Ubuntu 22.04 or 24.04 ECS instance with a public address, a sudo-capable SSH account, and a lowercase DNS hostname whose A or AAAA record points to the instance. In the Alibaba Cloud security group, allow TCP 22 only from administrator addresses and TCP 80 and 443 from intended clients. Never allow TCP 3080: reaching that port bypasses Caddy authentication.

The bootstrap installs Node.js 24 from the [official NodeSource repository](https://github.com/nodesource/distributions), pnpm 11.7.0, and Caddy from the [official stable Debian repository](https://caddyserver.com/docs/install#debian-ubuntu-raspbian). Review both repository procedures before running a root script on a long-lived host.

The examples use `dsh.example.com`, `ecs-admin@203.0.113.10`, and branch `feat/invite-auth-deployment`. Replace the hostname and SSH destination, but pass the exact branch placed in the bundle.

## Prepare and upload a release

Run these commands from the repository root on your development machine. The bundle contains the named branch and its reachable commits without copying your working tree or untracked files.

```bash
git status --short
git bundle create mydsh.bundle feat/invite-auth-deployment
git bundle verify mydsh.bundle
ssh ecs-admin@203.0.113.10 'sudo install -d -o "$USER" -g "$(id -gn)" -m 0700 /tmp/mydsh-deploy'
scp deploy/alibaba-cloud/{Caddyfile,mydsh.service,caddy-mydsh.conf,bootstrap-host.sh,deploy-release.sh} ecs-admin@203.0.113.10:/tmp/mydsh-deploy/
scp mydsh.bundle ecs-admin@203.0.113.10:/tmp/mydsh-deploy/
```

The first `scp` uploads all five bootstrap and deployment assets to the same private temporary directory. The overlay stays in the Git bundle and is validated from the checked-out release.

## Bootstrap the host

Connect to the instance and run the bootstrap once. Re-running it updates the public hostname, managed service files, package sources, and runtimes while preserving `/etc/mydsh/mydsh.env` and its secrets.

```bash
ssh ecs-admin@203.0.113.10
cd /tmp/mydsh-deploy
sudo bash ./bootstrap-host.sh dsh.example.com
```

The script creates the `mydsh` system account, persistent and release directories, `/etc/mydsh/public.env`, and a root-readable-only private environment file. It validates Caddy and starts Caddy, but it does not start `mydsh` before a release exists. A pre-existing unmanaged target is backed up once with suffix `.pre-mydsh`; a later unmanaged collision fails instead of overwriting that backup.

## Deploy the release

Deploy the exact branch carried by the bundle. The script verifies the bundle, installs frozen dependencies as `mydsh`, runs the invite-auth tests, builds the repository, dumps the composed configuration, publishes a commit-named immutable directory, switches `/opt/mydsh/current` atomically, restarts DSH, waits for a bounded local health check, then validates and reloads Caddy. Failure in any activation step restores the previous release.

```bash
sudo bash ./deploy-release.sh ./mydsh.bundle feat/invite-auth-deployment
```

Do not remove the uploaded bundle until the command returns successfully. A failed update restores the previous `current` target and restarts it; a failed first deployment removes only the new validated symlink and stops `mydsh`. The failed immutable release remains available for diagnosis.

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

Create a new bundle from a reviewed deployment branch, upload it beside the five assets, and run `deploy-release.sh` with that bundle and its exact branch. Each full commit receives one directory under `/opt/mydsh/releases`; the script refuses to overwrite an existing release, and `/opt/mydsh/current` names the active one. `/var/lib/mydsh` and `/srv/mydsh/workspace` remain outside releases and do not roll back with code.

The deploy script rolls back automatically when restart, health acceptance, Caddy validation, or Caddy reload fails. For an operator-directed rollback, choose a known-good full commit from `sudo ls -1 /opt/mydsh/releases`. The preflight below requires 40 lowercase hexadecimal characters, resolves the directory canonically, and proves that its parent and basename are exact before the script performs the same validation, atomic switch, restart, health check, and Caddy activation.

```bash
set -euo pipefail
commit=0123456789abcdef0123456789abcdef01234567
[[ $commit =~ ^[0-9a-f]{40}$ ]]
target=$(sudo realpath -e -- "/opt/mydsh/releases/$commit")
[[ ${target%/*} == /opt/mydsh/releases ]]
[[ ${target##*/} == "$commit" ]]
sudo bash /opt/mydsh/current/deploy/alibaba-cloud/deploy-release.sh --rollback "$commit"
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
