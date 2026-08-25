# Deploy DeepSeek Harness on Alibaba Cloud

English | [中文](README.zh.md)

This tutorial deploys one invite-protected DeepSeek Harness Web process on an Alibaba Cloud ECS host. Caddy is the only public entry point; every authenticated visitor shares the same sessions, workspace, credentials, and command authority.

## Prerequisites

Use a fresh Linux amd64 Ubuntu 22.04 or 24.04 ECS instance with a public address, a sudo-capable SSH account, and a lowercase DNS hostname whose A or AAAA record points to the instance. Bootstrap checks `dpkg --print-architecture` before taking its lock or performing any network or filesystem mutation and rejects anything except `amd64`. In the Alibaba Cloud security group, allow TCP 22 only from administrator addresses and TCP 80 and 443 from intended clients. Never allow TCP 3080: reaching that port bypasses Caddy authentication.

The host bootstrap installs only the Node.js 24 runtime from the [official NodeSource repository](https://github.com/nodesource/distributions) and Caddy from the [official stable Debian repository](https://caddyserver.com/docs/install#debian-ubuntu-raspbian); it does not install Git. It requires NodeSource fingerprint `6F71F525282841EEDAF851B42F59B5F99B1BE0B4` and Caddy fingerprint `65760C51EDEA2017CEA2CA15155B6D79CA56EA34`; signed-repository patch versions may advance. Packaging requires Git and Docker on the development machine and verifies the pinned SHA-512 integrity of pnpm 11.7.0 inside the official Node 24 Linux image. Review both repository procedures before running a root script on a long-lived host.

Run packaging orchestration on Linux or WSL with Bash, Python 3, GNU coreutils (`realpath`, `stat`, `sync`, `timeout`, and `mktemp`), GNU tar, Git, and Docker. Windows PowerShell or macOS alone is unsupported. Docker isolates the build but does not replace the Linux/GNU host tools used to validate and atomically publish the artifact set.

The examples use `dsh.example.com`, `ecs-admin@203.0.113.10`, and a reviewed named ref stored in `DEPLOY_REF`. Replace all three values with the DNS name, SSH destination, and reviewed ref selected for this deployment; a verified signed tag is preferable when available. `DEPLOY_REF` must be a fully qualified existing `refs/heads/*` or `refs/tags/*` name; shorthand and ambiguous revisions are rejected.

## Prepare and upload a release

Run these commands from the repository root on your development machine. The selected ref supplies the packager itself, and the packager reads only Git objects from that ref. It pins `node:24-bookworm@sha256:ffeee58a257b390b80b9b656cba440bbc3116c1bc03139c31318f9d9c29a8975`, bounds the container to 4 CPUs, 8 GiB of memory, 1,024 processes, and 45 minutes, and runs install, tests, build, and config validation with fresh state. Container network and disk use are not bounded. Docker is mandatory; there is no host-build fallback.

```bash
set -euo pipefail
DEPLOY_REF=refs/tags/dsh-reviewed-YYYYMMDD
REMOTE=ecs-admin@203.0.113.10
LOCAL_STAGE=$(mktemp -d)
PACKAGER_STAGE=$(mktemp -d)
trap 'rm -rf -- "$LOCAL_STAGE" "$PACKAGER_STAGE"' EXIT
git archive "$DEPLOY_REF" deploy/alibaba-cloud/package-release.sh | tar -x -C "$PACKAGER_STAGE"
bash "$PACKAGER_STAGE/deploy/alibaba-cloud/package-release.sh" "$DEPLOY_REF" "$LOCAL_STAGE"
ARTIFACT_SET=$(find "$LOCAL_STAGE" -maxdepth 1 -type d -name 'mydsh-release-*')
[[ -d $ARTIFACT_SET ]]
ARTIFACT_SET_NAME=${ARTIFACT_SET##*/}
git archive "$DEPLOY_REF" deploy/alibaba-cloud/{Caddyfile,mydsh.service,caddy-mydsh.conf,bootstrap-host.sh,deploy-release.sh} | tar -x -C "$LOCAL_STAGE"
REMOTE_STAGE=$(ssh "$REMOTE" 'mktemp -d "$HOME/mydsh-deploy.XXXXXX"')
[[ $REMOTE_STAGE =~ ^/[A-Za-z0-9._/-]+/mydsh-deploy\.[A-Za-z0-9]{6}$ ]]
scp "$LOCAL_STAGE"/deploy/alibaba-cloud/{Caddyfile,mydsh.service,caddy-mydsh.conf,bootstrap-host.sh,deploy-release.sh} "$REMOTE:$REMOTE_STAGE/"
scp -r "$ARTIFACT_SET" "$REMOTE:$REMOTE_STAGE/"
```

The first `scp` uploads all five initialization assets beside one atomically published artifact-set directory containing the tarball and SHA-256 sidecar. The sidecar detects corruption during transfer but does not establish signer identity. Trust comes from the exact reviewed local ref and, when used, verification of its signed tag or commit before packaging. The artifact contains the overlay, built outputs, dependencies, release manifest, and release configuration; it contains no host absolute path or production secret.

## Bootstrap the host

Run bootstrap from the uploaded directory only for initial host setup. It installs the reviewed control-plane helper at `/usr/local/sbin/mydsh-deploy-release`; deployments and rollbacks never execute root control flow from a release directory. Once `current` exists, a byte-identical rerun is a no-op and any hostname, helper, unit, Caddyfile, or drop-in difference is refused. Changing the hostname or stable helper requires a separate reviewed maintenance procedure outside this tutorial.

```bash
ssh -t "$REMOTE" "cd '$REMOTE_STAGE' && sudo bash ./bootstrap-host.sh dsh.example.com"
```

The script creates the non-login `mydsh` runtime account, persistent and release directories, `/etc/mydsh/public.env`, and a root-readable-only private environment file. Ubuntu 22.04 and 24.04 assign system accounts a UID below 1000; bootstrap requires that range and a non-root UID. No builder account, pnpm installation, candidate lifecycle script, or build cache exists on the server. With an active release, bootstrap is a byte-for-byte no-op; missing files, changed bytes, wrong owners, an over-readable private environment, a writable helper, or directory-mode drift is refused before mutation.

## Deploy the release

Deploy the prebuilt artifact set through the stable root-installed helper. Under the deployment lock it first removes only canonical root-owned `.upload.*` and `.extract.*` directories left by interrupted operations and refuses unsafe matching entries. It requires the commit-named directory to contain exactly the tarball and sidecar, checks that the `/var` filesystem holding `/var/lib/mydsh-deploy/uploads` has room for the full 1 GiB compressed-file cap, a 1 GiB reserve, and 1 MiB of checksum and metadata overhead, then copies both files into persistent root-private new inodes. This fixed worst-case budget does not trust the mutable uploaded file's current size. The helper verifies the strict sidecar and SHA-256 value and enforces limits of 1 GiB compressed, 500,000 members, 512 MiB per member, and 8 GiB expanded. Before extraction it also budgets 4,096 bytes of filesystem metadata per member, 10,000 spare inodes, and the existing 1 GiB release reserve. It rejects sparse or special members, unsafe paths, duplicate names, escaping links, and insufficient release space. The local packager applies the same artifact bounds before atomic publication. It validates manifest format `1`, the pinned build-image digest, helper journal compatibility `1`, commit, platform, runtime outputs, and overlay. Manifest refs use a strict ordinary subset under `refs/heads/` or `refs/tags/`; the Git-free server rejects spaces, control characters, obscure punctuation, dot-prefixed components, `.lock` suffixes, and ambiguous separators. The candidate unit, Caddyfile, and Caddy drop-in must be byte-for-byte identical to the installed managed control plane; any drift fails with no activation and requires separate reviewed control-plane maintenance. The helper never runs Git, pnpm, hooks, tests, build commands, config scripts, or release-contained control flow.

```bash
ssh -t "$REMOTE" "cd '$REMOTE_STAGE' && sudo /usr/local/sbin/mydsh-deploy-release './$ARTIFACT_SET_NAME'; status=\$?; if [[ \$status == 0 ]]; then if rm -rf -- '$REMOTE_STAGE'; then exit 0; else printf 'Deployment passed but staging cleanup failed at %s\\n' '$REMOTE_STAGE' >&2; exit 1; fi; else printf 'Deployment failed; upload retained at %s\\n' '$REMOTE_STAGE' >&2; exit \$status; fi"
```

The remote command removes the upload only after success. Activation changes only the immutable release link and service enablement; the installed unit and Caddy files remain unchanged. A failed update retains the exact artifact set, restores the previous `current` target and enablement, and restarts it; a failed first deployment retains the upload and failed immutable release, removes only the new validated symlink, disables and stops `mydsh`, and retains any incomplete recovery journal.

## Verify HTTPS and login

Check both services, listeners, the public certificate, and the unauthenticated login page. The listener output must show Caddy on ports 80 and 443 and exactly one DSH listener at `127.0.0.1:3080`, never IPv6 wildcard, IPv4 wildcard, a public address, or a duplicate listener. The deployment helper enforces the same condition before commit.

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

Keep model keys in the DSH credential store. Never add them to this directory, a release artifact, `/etc/mydsh/public.env`, shell tracing, deployment output, or repository logs.

## Upgrade and roll back

For an upgrade, run `package-release.sh` for the new reviewed ref, create a fresh remote staging directory, upload the one atomic artifact-set directory that contains the tarball and checksum, and invoke `/usr/local/sbin/mydsh-deploy-release` with that directory as its single argument. Do not upload or replace bootstrap assets during an upgrade. Each full commit receives one directory under `/opt/mydsh/releases`; the helper refuses to overwrite an existing release, and `/opt/mydsh/current` names the active one. `/var/lib/mydsh` and `/srv/mydsh/workspace` remain outside releases and do not roll back with code.

```bash
UPGRADE_STAGE=$(mktemp -d)
PACKAGER_STAGE=$(mktemp -d)
trap 'rm -rf -- "$UPGRADE_STAGE" "$PACKAGER_STAGE"' EXIT
git archive "$DEPLOY_REF" deploy/alibaba-cloud/package-release.sh | tar -x -C "$PACKAGER_STAGE"
bash "$PACKAGER_STAGE/deploy/alibaba-cloud/package-release.sh" "$DEPLOY_REF" "$UPGRADE_STAGE"
UPGRADE_SET=$(find "$UPGRADE_STAGE" -maxdepth 1 -type d -name 'mydsh-release-*')
REMOTE_STAGE=$(ssh "$REMOTE" 'mktemp -d "$HOME/mydsh-deploy.XXXXXX"')
[[ $REMOTE_STAGE =~ ^/[A-Za-z0-9._/-]+/mydsh-deploy\.[A-Za-z0-9]{6}$ ]]
scp -r "$UPGRADE_SET" "$REMOTE:$REMOTE_STAGE/"
ssh -t "$REMOTE" "cd '$REMOTE_STAGE' && sudo /usr/local/sbin/mydsh-deploy-release './${UPGRADE_SET##*/}'; status=\$?; if [[ \$status == 0 ]]; then if rm -rf -- '$REMOTE_STAGE'; then exit 0; else printf 'Upgrade passed but staging cleanup failed at %s\\n' '$REMOTE_STAGE' >&2; exit 1; fi; else printf 'Upgrade failed; upload retained at %s\\n' '$REMOTE_STAGE' >&2; exit \$status; fi"
```

The upgrade removes only the exact validated, unpredictable remote staging directory after successful acceptance. A failed upgrade retains that directory and prints its non-secret path for diagnosis.

The installed helper owns two versioned format-1 journals: `/var/lib/mydsh-deploy/activation` for code activation and `/var/lib/mydsh-deploy/rotation` for secret rotation. It rejects unknown formats and reconciles both journals before every deploy, rollback, prune, or rotation. A prepared rotation restores the old environment, syncs it, restarts DSH, and repeats acceptance; a committed rotation keeps the new secret and cleans the journal. Failed recovery retains the journal and blocks the next operation. A helper, journal-format, unit, or Caddy change requires a separate reviewed maintenance procedure while DSH is stopped; this tutorial does not automate that control-plane change. Frozen byte comparison makes releases packaged with the old templates ineligible afterward, so package and retain a tested known-good release under the new templates before maintenance; rollback can select only releases carrying the new control-plane bytes.

The deploy script rolls back automatically when restart, listener checks, or public and authenticated acceptance fails. For an operator-directed rollback, choose a known-good full commit from `sudo ls -1 /opt/mydsh/releases`. The preflight below requires 40 lowercase hexadecimal characters, resolves the directory canonically, and proves that its parent and basename are exact before the script performs the same byte comparison, atomic switch, restart, and acceptance checks.

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

Changing the invite secret affects later logins but leaves existing 30-day cookies valid. Changing the session secret immediately invalidates every cookie. The stable root helper takes the deployment lock, generates the value on the server, atomically updates and syncs the private environment, restarts DSH, and rolls back the file and process on failed acceptance. Neither command prints a secret.

```bash
sudo /usr/local/sbin/mydsh-deploy-release --rotate-invite
# Use this instead to revoke every cookie:
sudo /usr/local/sbin/mydsh-deploy-release --rotate-session
```

After invite rotation, retrieve the new invite directly in the administrator terminal with the earlier `sudo sed` command; do not route its output through an agent or log.

## Troubleshoot

- Read recent service logs with `sudo journalctl -u mydsh -n 200 --no-pager` and Caddy logs with `sudo journalctl -u caddy -n 200 --no-pager`; do not copy environment files or cookies into reports.
- A public `502` means Caddy cannot reach a ready DSH process. Inspect `systemctl status mydsh`, its journal, `/opt/mydsh/current`, and the loopback listener.
- A login `403` usually means the public hostname, HTTPS origin, or proxy headers disagree. Validate DNS and run `sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`; an active-host hostname or control-plane change requires the separate reviewed maintenance procedure rather than bootstrap.
- A login `429` means the source address exceeded the in-process failure limit. Wait for the configured window or restart `mydsh` only after investigating repeated failures; restart clears every rate-limit bucket.

## Limitations

Caddy's authorization check protects every non-invite route, and the overlay's readiness dependency prevents the frontend fallback from answering before the invite route exists. Exposing port 3080 bypasses both protections.

This deployment runs one DSH process and is intended for a small trusted group. Rate limits are process-local, and invite authentication does not provide individual identity, workspace isolation, session ownership, or per-user command permissions. See the [invite-auth package contract](../../packages/host/invite-auth/README.md) before granting access.
