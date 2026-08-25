# 在阿里云上部署 DeepSeek Harness

[English](README.md) | 中文

本教程在一台阿里云 ECS 主机上部署一个受邀请码保护的 DeepSeek Harness Web 进程。Caddy 是唯一的公开入口；每位已认证访问者共享相同的会话、工作区、凭据和命令权限。

## 前置条件

使用一台全新的 Linux amd64 Ubuntu 22.04 或 24.04 ECS 实例，并准备公网地址、可执行 sudo 的 SSH 账户，以及 A 或 AAAA 记录指向该实例的全小写 DNS 主机名。bootstrap 会在获取锁或执行任何网络和文件系统变更前检查 `dpkg --print-architecture`，并拒绝 `amd64` 之外的架构。在阿里云安全组中，仅允许管理员地址访问 TCP 22，并允许预期客户端访问 TCP 80 和 443。绝不能开放 TCP 3080：访问该端口会绕过 Caddy 认证。

宿主 bootstrap 只从 [NodeSource 官方软件源](https://github.com/nodesource/distributions)安装 Node.js 24 运行时，并从 [Caddy 官方稳定版 Debian 软件源](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)安装 Caddy；它不安装 Git。打包需要开发机安装 Git 和 Docker，并在官方 Node 24 Linux 镜像内验证 pnpm 11.7.0 的固定 SHA-512 integrity。脚本要求 NodeSource 指纹为 `6F71F525282841EEDAF851B42F59B5F99B1BE0B4`、Caddy 指纹为 `65760C51EDEA2017CEA2CA15155B6D79CA56EA34`；已签名软件源中的补丁版本可能前进。在长期运行的主机上执行 root 脚本前，请先检查这两个软件源的操作说明。

打包编排必须在 Linux 或 WSL 上运行，并提供 Bash、Python 3、GNU coreutils（`realpath`、`stat`、`sync`、`timeout` 和 `mktemp`）、GNU tar、Git 与 Docker。不支持单独使用 Windows PowerShell 或 macOS。Docker 只隔离构建，不能取代用于验证并原子发布 artifact set 的 Linux/GNU 宿主工具。

下列示例使用 `dsh.example.com`、`ecs-admin@203.0.113.10`，并将经过评审的具名 ref 存入 `DEPLOY_REF`。请将这三个值替换为本次部署选择的 DNS 名称、SSH 目标和已评审 ref；如果条件允许，优先使用已验证的签名 tag。`DEPLOY_REF` 必须是已存在且完整的 `refs/heads/*` 或 `refs/tags/*` 名称；脚本会拒绝简写和有歧义的 revision。

## 准备并上传 release

在开发机的仓库根目录运行以下命令。打包脚本本身来自选定 ref，且只读取该 ref 的 Git 对象。脚本固定使用 `node:24-bookworm@sha256:ffeee58a257b390b80b9b656cba440bbc3116c1bc03139c31318f9d9c29a8975`，把容器限制为 4 个 CPU、8 GiB 内存、1,024 个进程和 45 分钟，并以全新状态执行安装、测试、构建和配置验证。容器的网络和磁盘使用量不受限制。Docker 是强制依赖，不存在宿主构建回退。

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

第一个 `scp` 将全部 5 个初始化文件上传到一个不可预测、由 SSH 用户拥有的目录，并在旁边上传一个原子发布的 artifact-set 目录，其中包含 tarball 和 SHA-256 sidecar。sidecar 能发现传输损坏，但不能证明签名者身份。信任来自精确的已评审本地 ref；使用签名 tag 或 commit 时，还来自打包前对签名的验证。artifact 包含 overlay、构建产物、依赖、release manifest 和 release 配置，不包含宿主绝对路径或生产密钥。

## 初始化主机

只在首次设置宿主时从上传目录运行 bootstrap。脚本会将经过评审的控制平面 helper 安装到 `/usr/local/sbin/mydsh-deploy-release`；部署和回滚绝不会从 release 目录执行 root 控制流。`current` 存在后，逐字节一致的再次运行是无操作，任何 hostname、helper、unit、Caddyfile 或 drop-in 差异都会被拒绝。更改 hostname 或稳定 helper 需要执行本教程范围外的单独评审维护流程。

```bash
ssh -t "$REMOTE" "cd '$REMOTE_STAGE' && sudo bash ./bootstrap-host.sh dsh.example.com"
```

脚本创建不可登录的 `mydsh` 运行时账户、持久化目录和 release 目录、`/etc/mydsh/public.env`，以及只有 root 可读的私有环境文件。Ubuntu 22.04 和 24.04 为系统账户分配小于 1000 的 UID；bootstrap 要求该范围和非 root UID。服务器上不存在 builder 账户、pnpm 安装、候选生命周期脚本执行或构建缓存。存在活动 release 时，bootstrap 只允许逐字节一致的无操作；文件缺失、字节变化、所有者错误、私有环境文件权限过宽、helper 可写或目录模式漂移都会在变更前被拒绝。

## 部署 release

通过 root 安装的稳定 helper 部署预构建 artifact set。在部署锁保护下，它先只删除中断操作留下的规范、root 所有 `.upload.*` 与 `.extract.*` 目录，并拒绝不安全的匹配项。helper 要求以 commit 命名的目录中恰好只有 tarball 和 sidecar，先检查承载 `/var/lib/mydsh-deploy/uploads` 的 `/var` 文件系统能否容纳完整的 1 GiB 压缩文件上限、1 GiB 预留空间，以及 1 MiB checksum 与 metadata 开销，再把两个文件复制到持久的 root-private 新 inode。该固定最坏情况预算不信任可变上传文件的当前大小。helper 验证严格 sidecar 与 SHA-256 值，并执行 1 GiB 压缩大小、500,000 个 member、每个 member 512 MiB 和 8 GiB 展开大小限制。解压前还会为每个 member 预算 4,096 字节文件系统 metadata、保留 10,000 个 inode，并保留既有 1 GiB release 余量。它拒绝 sparse 或特殊 member、不安全路径、重复名称、越界链接和不足的 release 空间。本地 packager 也会在原子发布前应用相同 artifact 限制。它还验证 manifest 格式 `1`、固定构建镜像 digest、helper journal 兼容版本 `1`、commit、平台、运行时输出和 overlay。manifest ref 使用 `refs/heads/` 或 `refs/tags/` 下的严格常用子集；不安装 Git 的服务器会拒绝空格、控制字符、生僻标点、点开头的 component、`.lock` 后缀和有歧义的分隔符。候选 unit、Caddyfile 与 Caddy drop-in 必须和已安装、受管理的控制平面逐字节相同；任何漂移都会在激活前失败，并要求单独评审的控制平面维护。helper 绝不会运行 Git、pnpm、hook、测试、构建命令、配置脚本或 release 内的控制流。

```bash
ssh -t "$REMOTE" "cd '$REMOTE_STAGE' && sudo /usr/local/sbin/mydsh-deploy-release './$ARTIFACT_SET_NAME'; status=\$?; if [[ \$status == 0 ]]; then if rm -rf -- '$REMOTE_STAGE'; then exit 0; else printf 'Deployment passed but staging cleanup failed at %s\\n' '$REMOTE_STAGE' >&2; exit 1; fi; else printf 'Deployment failed; upload retained at %s\\n' '$REMOTE_STAGE' >&2; exit \$status; fi"
```

远程命令只在成功后删除上传目录。激活只改变不可变 release 链接和服务启用状态；已安装的 unit 与 Caddy 文件保持不变。更新失败时，它会保留确切的 artifact set，恢复上一个 `current` 目标和启用状态并将其重启；首次部署失败时，它会保留上传目录和失败的不可变 release，只删除新建且已验证的符号链接，禁用并停止 `mydsh`，并保留任何未完成的恢复 journal。

## 验证 HTTPS 和登录

检查两项服务、监听地址、公开证书和未认证登录页。监听输出必须显示 Caddy 位于端口 80 和 443，而 DSH 恰好只有一个 `127.0.0.1:3080` listener；绝不能存在 IPv6 通配、IPv4 通配、公网地址或重复 listener。部署 helper 会在提交前强制执行同一条件。

```bash
sudo systemctl status --no-pager caddy mydsh
sudo ss -ltnp '( sport = :80 or sport = :443 or sport = :3080 )'
curl --fail --silent --show-error --output /dev/null https://dsh.example.com/__invite/login
openssl s_client -connect dsh.example.com:443 -servername dsh.example.com </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates
```

管理员可以直接通过 SSH 获取初始邀请码。请自行运行此命令；不要将输出粘贴到 issue、agent 对话、shell 历史注释或日志中。

```bash
sudo sed -n 's/^DSH_INVITE_CODE_SECRET=//p' /etc/mydsh/mydsh.env
```

打开 `https://dsh.example.com`，输入该邀请码，并确认 DSH 页面加载成功。关闭全部浏览器窗口，重新打开站点，并确认 30 天 cookie 仍能认证浏览器；随后退出登录，并确认登录页再次出现。以下服务端冒烟测试会检查相同的验收路径，同时不打印密钥、响应正文、响应头或 cookie 值：未认证 HTML 返回 `303`，未认证 API 流量返回 `401`，登录返回 `303`，新客户端进程复用有效期至少还剩 29 天的 cookie，篡改会被拒绝，退出登录后访问也会再次被拒绝。

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

## 配置 Kimi

在 Web UI 中打开 **Settings → Models**，添加自定义 OpenAI-compatible 提供方，然后输入 Kimi 签发的 API base URL、模型标识符和 API key。按照最新的 [Kimi API 文档](https://platform.moonshot.cn/docs/guide/start-using-kimi-api)填写账户对应的值，保存提供方，选择其模型，并发送一条测试对话。

将模型 key 保存在 DSH 凭据存储中。绝不能将其加入此目录、release artifact、`/etc/mydsh/public.env`、shell tracing、部署输出或仓库日志。

## 升级和回滚

升级时，为新的已评审 ref 运行 `package-release.sh`，创建新的远程 staging 目录，上传一个包含 tarball 和 checksum 的原子 artifact-set 目录，再把该目录作为唯一参数调用 `/usr/local/sbin/mydsh-deploy-release`。升级时不要上传或替换 bootstrap 文件。每个完整 commit 在 `/opt/mydsh/releases` 下占用一个目录；helper 拒绝覆盖已有 release，`/opt/mydsh/current` 指向当前使用的 release。`/var/lib/mydsh` 和 `/srv/mydsh/workspace` 位于 release 之外，不随代码回滚。

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

升级成功通过验收后，只删除经过精确验证且不可预测的远程 staging 目录。升级失败时保留该目录，并打印其非秘密路径供诊断。

已安装 helper 拥有两个带版本的格式 1 journal：`/var/lib/mydsh-deploy/activation` 负责代码激活，`/var/lib/mydsh-deploy/rotation` 负责密钥轮换。helper 拒绝未知格式，并在每次部署、回滚、清理或轮换前协调两个 journal。处于 `prepared` 的轮换会恢复并同步旧环境、重启 DSH 并重新验收；处于 `committed` 的轮换保留新密钥并清理 journal。恢复失败会保留 journal 并阻止下一项操作。helper、journal 格式、unit 或 Caddy 变更需要在 DSH 停止时执行单独评审的维护流程；本教程不自动处理该控制平面变更。冻结字节比较会让使用旧模板打包的 release 在维护后失去资格，因此必须先使用新模板打包并保留一个经过测试的已知良好 release；回滚只能选择携带新控制平面字节的 release。

重启、监听检查或公开与已认证验收失败时，deploy helper 会自动回滚。如果操作员要主动回滚，请从 `sudo ls -1 /opt/mydsh/releases` 中选择一个确认可用的完整 commit。以下预检要求 40 个小写十六进制字符，解析目录的规范化真实路径，并在 helper 执行相同的逐字节比较、原子切换、重启和验收检查之前，证明目录的父路径和 basename 完全匹配。

```bash
set -euo pipefail
commit=0123456789abcdef0123456789abcdef01234567
[[ $commit =~ ^[0-9a-f]{40}$ ]]
target=$(sudo realpath -e -- "/opt/mydsh/releases/$commit")
[[ ${target%/*} == /opt/mydsh/releases ]]
[[ ${target##*/} == "$commit" ]]
sudo /usr/local/sbin/mydsh-deploy-release --rollback "$commit"
```

清理前先使用 `sudo du -sh /opt/mydsh/releases/*` 检查磁盘占用。绝不能选择活动 commit 或为操作员选定回滚保留的 release。root helper 会获取同一个部署锁，要求一个完整的小写 commit，证明其规范化真实路径受限于 release 根目录，拒绝活动目标，并且只删除该精确的非活动 release；保留选定的回滚 release 仍由操作员负责。

```bash
set -euo pipefail
candidate=0123456789abcdef0123456789abcdef01234567
[[ $candidate =~ ^[0-9a-f]{40}$ ]]
# Confirm that $candidate is not the selected rollback release, then run:
sudo /usr/local/sbin/mydsh-deploy-release --prune "$candidate"
```

## 轮换认证密钥

更改邀请密钥会影响后续登录，但现有的 30 天 cookie 仍然有效。更改会话密钥会立即使全部 cookie 失效。稳定的 root helper 会获取部署锁，在服务器上生成新值，原子更新并同步私有环境文件，重启 DSH，并在验收失败时回滚文件和进程。两个命令都不会打印密钥。

轮换要求现有且健康的活动 release。全新 bootstrap 必须先部署第一个 release，才能运行任一命令。

```bash
sudo /usr/local/sbin/mydsh-deploy-release --rotate-invite
# Use this instead to revoke every cookie:
sudo /usr/local/sbin/mydsh-deploy-release --rotate-session
```

轮换邀请密钥后，使用前文的 `sudo sed` 命令直接在管理员终端读取新邀请码；不要让 agent 或日志转发其输出。

## 故障排查

- 使用 `sudo journalctl -u mydsh -n 200 --no-pager` 读取近期服务日志，并使用 `sudo journalctl -u caddy -n 200 --no-pager` 读取 Caddy 日志；不要将环境文件或 cookie 复制到报告中。
- 公开端点返回 `502`，表示 Caddy 无法连接已就绪的 DSH 进程。检查 `systemctl status mydsh`、该服务的 journal、`/opt/mydsh/current` 和 loopback 监听地址。
- 登录返回 `403`，通常表示公开主机名、HTTPS origin 或代理请求头不一致。请验证 DNS，并运行 `sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`；活动宿主的 hostname 或控制平面变更需要单独评审的维护流程，不能使用 bootstrap。
- 登录返回 `429`，表示源地址超过进程内失败限制。等待已配置的时间窗口；只有在调查重复失败后才重启 `mydsh`，因为重启会清除全部速率限制 bucket。

## 限制

Caddy 的授权检查保护所有非 invite 路由，而 overlay 的就绪依赖防止 frontend fallback 在 invite 路由存在前响应请求。开放端口 3080 会绕过这两项保护。

此部署运行一个 DSH 进程，适用于一小组受信任用户。速率限制属于单进程状态；邀请码认证不提供独立身份、工作区隔离、会话所有权或按用户划分的命令权限。授予访问权限前，请阅读 [invite-auth 包约定](../../packages/host/invite-auth/README.zh.md)。
