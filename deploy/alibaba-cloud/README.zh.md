# 在阿里云上部署 DeepSeek Harness

[English](README.md) | 中文

本教程在一台阿里云 ECS 主机上部署一个受邀请码保护的 DeepSeek Harness Web 进程。Caddy 是唯一的公开入口；每位已认证访问者共享相同的会话、工作区、凭据和命令权限。

## 前置条件

使用一台全新的 Ubuntu 22.04 或 24.04 ECS 实例，并准备公网地址、可执行 sudo 的 SSH 账户，以及 A 或 AAAA 记录指向该实例的全小写 DNS 主机名。在阿里云安全组中，仅允许管理员地址访问 TCP 22，并允许预期客户端访问 TCP 80 和 443。绝不能开放 TCP 3080：访问该端口会绕过 Caddy 认证。

bootstrap 脚本从 [NodeSource 官方软件源](https://github.com/nodesource/distributions)安装 Node.js 24，同时安装 pnpm 11.7.0，并从 [Caddy 官方稳定版 Debian 软件源](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)安装 Caddy。脚本只会在 NodeSource 指纹为 `6F71F525282841EEDAF851B42F59B5F99B1BE0B4` 且 Caddy 指纹为 `65760C51EDEA2017CEA2CA15155B6D79CA56EA34` 时写入相应 APT 软件源；软件包签名用于认证软件源输出，而 Node.js 和 Caddy 的具体补丁版本可能在这些已签名软件源中前进。在长期运行的主机上执行 root 脚本前，请先检查这两个软件源的操作说明。

下列示例使用 `dsh.example.com`、`ecs-admin@203.0.113.10`，并将经过评审的 release tag 存入 `DEPLOY_REF`。请将这三个值替换为本次部署选择的 DNS 名称、SSH 目标，以及经过评审的分支或签名 tag。

## 准备并上传 release

在开发机的仓库根目录运行以下命令。bundle 包含指定分支及其可达 commit，不会复制工作树或未跟踪文件。

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

第一个 `scp` 将全部 5 个 bootstrap 和部署文件上传到同一个不可预测、由 SSH 用户拥有的目录。overlay 保留在 Git bundle 中，并从检出的 release 内接受验证。`git bundle verify` 检查 bundle 结构、前置对象和对象连通性，但不证明真实性。信任来自经过评审的本地 checkout；使用签名 tag 或 commit 时，还来自创建 bundle 前对所选签名的验证。

## 初始化主机

从上传目录运行 bootstrap。脚本会将经过评审的控制平面 helper 安装到 `/usr/local/sbin/mydsh-deploy-release`；部署和回滚绝不会从 release 目录执行 root 控制流。再次运行时，bootstrap 只更新带有稳定托管标记的文件；遇到符号链接、错误文件类型、非 root 所有权或不受管理的目标时会拒绝替换。

```bash
ssh -t "$REMOTE" "cd '$REMOTE_STAGE' && sudo bash ./bootstrap-host.sh dsh.example.com"
```

脚本创建相互独立的 `mydsh` 运行时账户和 `mydsh-build` 构建账户、持久化目录和 release 目录、`/etc/mydsh/public.env`，以及只有 root 可读的私有环境文件。Ubuntu 22.04 和 24.04 为系统账户分配小于 1000 的 UID；bootstrap 在更改目录所有权前，要求该范围、非 root UID、不同的 group，以及 `/usr/sbin/nologin` 或等价的 `/sbin/nologin`。构建账户只能访问自己的 home、临时 `DSH_HOME`、包缓存和候选 staging tree；运行时数据、工作区、环境文件和密钥保持不可访问。bootstrap 会验证并启动 Caddy，但在 release 存在之前不会启动 `mydsh`。

## 部署 release

通过 root 安装的 helper 部署 bundle 携带的确切 ref。helper 以 `mydsh-build` 身份在空白的最小环境和临时 `DSH_HOME` 下执行 clone、依赖生命周期脚本、测试、构建和配置转储，然后将完成的 release 设为 root 所有且不可变。激活会验证候选 unit 和 Caddy 配置，将全部宿主变更与 bootstrap 和回滚串行化，安装候选 unit 和代理文件，切换 `/opt/mydsh/current`，验证运行时进程以及公开和认证行为，并仅在全部检查通过后接受 release。任何失败都会恢复上一个代码链接和全部 3 个宿主配置文件；首次部署失败会恢复 bootstrap 配置并停止 DSH。

```bash
ssh -t "$REMOTE" "cd '$REMOTE_STAGE' && sudo /usr/local/sbin/mydsh-deploy-release ./mydsh.bundle '$DEPLOY_REF'; status=\$?; if [[ \$status == 0 ]]; then rm -rf -- '$REMOTE_STAGE'; else printf 'Deployment failed; upload retained at %s\\n' '$REMOTE_STAGE' >&2; fi; exit \$status"
```

远程命令只在成功后删除上传目录。更新失败时，它会保留确切的 bundle 和上传文件，恢复上一个 `current` 目标并将其重启；首次部署失败时，它会保留上传目录和失败的不可变 release，只删除新建且已验证的符号链接并停止 `mydsh`。

## 验证 HTTPS 和登录

检查两项服务、监听地址、公开证书和未认证登录页。监听输出必须显示 Caddy 位于端口 80 和 443，而 DSH 只能位于 `127.0.0.1:3080` 或 `[::1]:3080`，绝不能位于通配地址或公网地址。

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

将模型 key 保存在 DSH 凭据存储中。绝不能将其加入此目录、Git bundle、`/etc/mydsh/public.env`、shell tracing、部署输出或仓库日志。

## 升级和回滚

从经过评审的部署 ref 创建新 bundle，将其上传到 5 个部署文件所在目录，然后使用该 bundle 及其确切 ref 调用 `/usr/local/sbin/mydsh-deploy-release`。每个完整 commit 在 `/opt/mydsh/releases` 下占用一个目录；helper 拒绝覆盖已有 release，`/opt/mydsh/current` 指向当前使用的 release。`/var/lib/mydsh` 和 `/srv/mydsh/workspace` 位于 release 之外，不随代码回滚。

重启、健康检查验收、Caddy 验证或 Caddy 重新加载失败时，deploy helper 会自动回滚。如果操作员要主动回滚，请从 `sudo ls -1 /opt/mydsh/releases` 中选择一个确认可用的完整 commit。以下预检要求 40 个小写十六进制字符，解析目录的规范化真实路径，并在 helper 执行相同的验证、原子切换、重启、健康检查和 Caddy 激活之前，证明目录的父路径和 basename 完全匹配。

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

更改 `DSH_INVITE_CODE_SECRET` 会影响后续登录，但现有的 30 天 cookie 仍然有效。更改 `DSH_INVITE_SESSION_SECRET` 会立即使全部 cookie 失效。以下 root-only helper 会原子替换一个值且不打印它；运行其中一行 `rotate`，然后重启服务。

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

## 故障排查

- 使用 `sudo journalctl -u mydsh -n 200 --no-pager` 读取近期服务日志，并使用 `sudo journalctl -u caddy -n 200 --no-pager` 读取 Caddy 日志；不要将环境文件或 cookie 复制到报告中。
- 公开端点返回 `502`，表示 Caddy 无法连接已就绪的 DSH 进程。检查 `systemctl status mydsh`、该服务的 journal、`/opt/mydsh/current` 和 loopback 监听地址。
- 登录返回 `403`，通常表示公开主机名、HTTPS origin 或代理请求头不一致。使用确切的全小写 DNS 主机名重新运行 bootstrap，验证 DNS，然后运行 `sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`。
- 登录返回 `429`，表示源地址超过进程内失败限制。等待已配置的时间窗口；只有在调查重复失败后才重启 `mydsh`，因为重启会清除全部速率限制 bucket。

## 限制

Caddy 的授权检查保护所有非 invite 路由，而 overlay 的就绪依赖防止 frontend fallback 在 invite 路由存在前响应请求。开放端口 3080 会绕过这两项保护。

此部署运行一个 DSH 进程，适用于一小组受信任用户。速率限制属于单进程状态；邀请码认证不提供独立身份、工作区隔离、会话所有权或按用户划分的命令权限。授予访问权限前，请阅读 [invite-auth 包约定](../../packages/host/invite-auth/README.zh.md)。
