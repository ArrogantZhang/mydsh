# 在阿里云上部署 DeepSeek Harness

[English](README.md) | 中文

本教程在一台阿里云 ECS 主机上部署一个受邀请码保护的 DeepSeek Harness Web 进程。Caddy 是唯一的公开入口；每位已认证访问者共享相同的会话、工作区、凭据和命令权限。

## 前置条件

使用一台全新的 Ubuntu 22.04 或 24.04 ECS 实例，并准备公网地址、可执行 sudo 的 SSH 账户，以及 A 或 AAAA 记录指向该实例的全小写 DNS 主机名。在阿里云安全组中，仅允许管理员地址访问 TCP 22，并允许预期客户端访问 TCP 80 和 443。绝不能开放 TCP 3080：访问该端口会绕过 Caddy 认证。

bootstrap 脚本从 [NodeSource 官方软件源](https://github.com/nodesource/distributions)安装 Node.js 24，同时安装 pnpm 11.7.0，并从 [Caddy 官方稳定版 Debian 软件源](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)安装 Caddy。在长期运行的主机上执行 root 脚本前，请先检查这两个软件源的操作说明。

下列示例使用 `dsh.example.com`、`ecs-admin@203.0.113.10` 和分支 `feat/invite-auth-deployment`。请替换主机名和 SSH 目标，但必须传入 bundle 中包含的确切分支。

## 准备并上传 release

在开发机的仓库根目录运行以下命令。bundle 包含指定分支及其可达 commit，不会复制工作树或未跟踪文件。

```bash
git status --short
git bundle create mydsh.bundle feat/invite-auth-deployment
git bundle verify mydsh.bundle
ssh ecs-admin@203.0.113.10 'sudo install -d -o "$USER" -g "$(id -gn)" -m 0700 /tmp/mydsh-deploy'
scp deploy/alibaba-cloud/{Caddyfile,mydsh.service,caddy-mydsh.conf,bootstrap-host.sh,deploy-release.sh} ecs-admin@203.0.113.10:/tmp/mydsh-deploy/
scp mydsh.bundle ecs-admin@203.0.113.10:/tmp/mydsh-deploy/
```

第一个 `scp` 将全部 5 个 bootstrap 和部署文件上传到同一个私有临时目录。overlay 保留在 Git bundle 中，并从检出的 release 内接受验证。

## 初始化主机

连接实例并运行一次 bootstrap。再次运行会更新公开主机名、托管的服务文件、软件源和运行时，同时保留 `/etc/mydsh/mydsh.env` 及其中的密钥。

```bash
ssh ecs-admin@203.0.113.10
cd /tmp/mydsh-deploy
sudo bash ./bootstrap-host.sh dsh.example.com
```

脚本创建 `mydsh` 系统账户、持久化目录和 release 目录、`/etc/mydsh/public.env`，以及只有 root 可读的私有环境文件。它会验证并启动 Caddy，但在 release 存在之前不会启动 `mydsh`。脚本为已有且不受管理的目标创建一次 `.pre-mydsh` 后缀备份；如果之后再次出现不受管理的冲突，脚本会失败，不会覆盖该备份。

## 部署 release

部署 bundle 携带的确切分支。脚本会验证 bundle，以 `mydsh` 身份安装锁定依赖并运行 invite-auth 测试，构建仓库，转储组合配置，发布以 commit 命名的不可变目录，原子切换 `/opt/mydsh/current`，重启 DSH，等待有界的本机健康检查，然后验证并重新加载 Caddy。任何激活步骤失败都会恢复上一个 release。

```bash
sudo bash ./deploy-release.sh ./mydsh.bundle feat/invite-auth-deployment
```

命令成功返回前不要删除上传的 bundle。更新失败时，脚本会恢复上一个 `current` 目标并将其重启；首次部署失败时，脚本只删除新建且已验证的符号链接并停止 `mydsh`。失败的不可变 release 会保留以供诊断。

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

从经过评审的部署分支创建新 bundle，将其上传到 5 个部署文件所在目录，然后使用该 bundle 及其确切分支运行 `deploy-release.sh`。每个完整 commit 在 `/opt/mydsh/releases` 下占用一个目录；脚本拒绝覆盖已有 release，`/opt/mydsh/current` 指向当前使用的 release。`/var/lib/mydsh` 和 `/srv/mydsh/workspace` 位于 release 之外，不随代码回滚。

重启、健康检查验收、Caddy 验证或 Caddy 重新加载失败时，deploy 脚本会自动回滚。如果操作员要主动回滚，请从 `sudo ls -1 /opt/mydsh/releases` 中选择一个确认可用的完整 commit。以下预检要求 40 个小写十六进制字符，以 canonical 路径解析目录，并在脚本执行相同的验证、原子切换、重启、健康检查和 Caddy 激活之前，证明目录的父路径和 basename 完全匹配。

```bash
set -euo pipefail
commit=0123456789abcdef0123456789abcdef01234567
[[ $commit =~ ^[0-9a-f]{40}$ ]]
target=$(sudo realpath -e -- "/opt/mydsh/releases/$commit")
[[ ${target%/*} == /opt/mydsh/releases ]]
[[ ${target##*/} == "$commit" ]]
sudo bash /opt/mydsh/current/deploy/alibaba-cloud/deploy-release.sh --rollback "$commit"
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
