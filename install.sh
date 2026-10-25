#!/usr/bin/env bash
#
# TamsuiShore QQ Agent · 一键安装脚本（Ubuntu 22.04/24.04）
#
# 做的事：
#   1. 安装 Node.js 20、Docker、ffmpeg、git
#   2. 创建 qqagent 用户与 /opt/qq-agent
#   3. 安装依赖、生成 data/config.json（DeepSeek Key / QQ 号）
#   4. 启动 NapCat 容器（QQ 协议端，端口只绑定 127.0.0.1）
#   5. 注册 systemd 服务并启动
#
# 用法：
#   sudo bash install.sh
# 或非交互：
#   sudo QQ_ACCOUNT=123456 DEEPSEEK_API_KEY=sk-xxx bash install.sh
#
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/tamsuishore-star/qq-agent-linux-public.git}"
BRANCH="${BRANCH:-v1.1.0}"
INSTALL_DIR="${INSTALL_DIR:-/opt/qq-agent}"
PORT="${PORT:-3210}"
MODEL="${MODEL:-deepseek-chat}"
NAPCAT_IMAGE="${NAPCAT_IMAGE:-mlikiowa/napcat-docker:latest}"

log()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash install.sh"
command -v apt-get >/dev/null || die "目前只支持 Debian/Ubuntu（需要 apt-get）"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 1. 交互参数 ────────────────────────────────────────────────────────────
if [ -z "${QQ_ACCOUNT:-}" ]; then
  read -r -p "机器人 QQ 号（例如 123456789）: " QQ_ACCOUNT
fi
[[ "$QQ_ACCOUNT" =~ ^[0-9]{5,12}$ ]] || die "QQ 号格式不对：$QQ_ACCOUNT"

if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  read -r -s -p "DeepSeek API Key（回车可跳过，稍后填 data/config.json）: " DEEPSEEK_API_KEY || true
  echo
fi

# ── 2. 基础软件 ────────────────────────────────────────────────────────────
log "安装基础软件（curl/git/ffmpeg/docker）..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git ffmpeg docker.io >/dev/null
systemctl enable --now docker >/dev/null 2>&1 || true

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 20 ]; then
  log "安装 Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
NODE_BIN="$(command -v node)"
log "Node: $($NODE_BIN -v)"

# ── 3. 用户与代码 ──────────────────────────────────────────────────────────
id qqagent >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin qqagent
mkdir -p "$INSTALL_DIR"

if [ -f "$SCRIPT_DIR/src/server.js" ]; then
  SRC="$SCRIPT_DIR"
  log "使用当前目录的代码：$SRC"
else
  SRC="$(mktemp -d)"
  log "拉取代码：$REPO_URL ($BRANCH)"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC"
fi

log "复制代码到 $INSTALL_DIR（保留已有 data/）"
if [ "$SRC" != "$INSTALL_DIR" ]; then
  cp -a "$SRC"/. "$INSTALL_DIR"/
else
  log "当前目录就是 $INSTALL_DIR，跳过复制"
fi
mkdir -p "$INSTALL_DIR/data"
chmod 700 "$INSTALL_DIR/data"

log "安装 Node 依赖..."
cd "$INSTALL_DIR"
npm install --omit=dev --no-audit --no-fund

# ── 4. 生成配置 ───────────────────────────────────────────────────────────
if [ -f "$INSTALL_DIR/data/config.json" ]; then
  warn "检测到已有 data/config.json，保留不覆盖。"
else
  if [ ! -f "$INSTALL_DIR/config/config.example.json" ]; then
    die "缺少 config/config.example.json，发行包不完整"
  fi
  QQ_ACCOUNT="$QQ_ACCOUNT" DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" MODEL="$MODEL" PORT="$PORT" INSTALL_DIR="$INSTALL_DIR" \
  "$NODE_BIN" - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.INSTALL_DIR || '/opt/qq-agent';
const base = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'config.example.json'), 'utf8'));
base.api.apiKey = process.env.DEEPSEEK_API_KEY || '';
base.api.model = process.env.MODEL || 'deepseek-chat';
base.snowluma.wsUrl = 'ws://127.0.0.1:3001';
base.snowluma.httpUrl = 'http://127.0.0.1:3000';
base.snowluma.accessToken = '';
base.snowluma.httpAccessToken = '';
base.snowluma.autoLaunch = false;
base.server = { ...(base.server || {}), port: Number(process.env.PORT) || 3210 };
fs.writeFileSync(path.join(dir, 'data', 'config.json'), JSON.stringify(base, null, 2), { mode: 0o600 });
console.log('已生成 data/config.json');
NODE
fi

chown -R qqagent:qqagent "$INSTALL_DIR"
chmod 700 "$INSTALL_DIR/data"
chmod 600 "$INSTALL_DIR/data/config.json" 2>/dev/null || true

# ── 5. NapCat（QQ 协议端）─────────────────────────────────────────────────
log "准备 NapCat 容器..."
mkdir -p /opt/napcat/config /opt/napcat/plugins /opt/napcat/qq/bili-media
chown -R qqagent:qqagent /opt/napcat/qq/bili-media 2>/dev/null || true
if docker ps -a --format '{{.Names}}' | grep -qx napcat; then
  warn "已存在 napcat 容器，跳过创建（如需重建：docker rm -f napcat 后重跑）"
else
  if ! docker image inspect "$NAPCAT_IMAGE" >/dev/null 2>&1; then
    docker pull "$NAPCAT_IMAGE" || {
      warn "拉取 $NAPCAT_IMAGE 失败，尝试国内镜像..."
      MIRROR="docker.m.daocloud.io/${NAPCAT_IMAGE}"
      docker pull "$MIRROR" && docker tag "$MIRROR" "$NAPCAT_IMAGE"
    }
  fi
  docker run -d --name napcat --restart unless-stopped \
    -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 -p 127.0.0.1:6099:6099 \
    -e ACCOUNT="$QQ_ACCOUNT" -e TZ=Asia/Shanghai \
    -v /opt/napcat/qq:/app/.config/QQ \
    -v /opt/napcat/config:/app/napcat/config \
    -v /opt/napcat/plugins:/app/napcat/plugins \
    "$NAPCAT_IMAGE" >/dev/null
fi

# ── 6. systemd ────────────────────────────────────────────────────────────
log "注册 systemd 服务..."
cp "$INSTALL_DIR/deploy/qq-agent.service" /etc/systemd/system/qq-agent.service
sed -i "s#^ExecStart=.*#ExecStart=$NODE_BIN src/server.js#" /etc/systemd/system/qq-agent.service
sed -i "s#^Environment=QQ_AGENT_PORT=.*#Environment=QQ_AGENT_PORT=$PORT#" /etc/systemd/system/qq-agent.service
mkdir -p /etc/systemd/system/qq-agent.service.d
cat >/etc/systemd/system/qq-agent.service.d/limits.conf <<'EOF'
[Service]
UMask=0077
Environment=NODE_OPTIONS=--max-old-space-size=768
EOF
systemctl daemon-reload
systemctl enable qq-agent >/dev/null 2>&1 || true
systemctl restart qq-agent

log "等待服务启动..."
for i in $(seq 1 30); do
  code="$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)"
  [ "$code" = "200" ] && break
  sleep 1
done
code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)"
if [ "$code" != "200" ]; then
  warn "控制台未在 30 秒内就绪，请查看：journalctl -u qq-agent -n 80 --no-pager"
else
  log "控制台已就绪：http://127.0.0.1:$PORT/"
fi

# ── 7. 后续步骤 ───────────────────────────────────────────────────────────
cat <<EOF

============================================================
 安装完成，最后两步（首次必须做）：

 1) 登录 QQ（NapCat 首次需要扫码）
    在你自己电脑上开 SSH 隧道：
      ssh -L 6099:127.0.0.1:6099 -L $PORT:127.0.0.1:$PORT root@<服务器IP>
    浏览器打开：http://127.0.0.1:6099/webui
    也可以用：docker logs -f napcat 查看二维码/登录提示

 2) 打开控制台
    浏览器：http://127.0.0.1:$PORT/
    在「设置 → 模型 API」确认 DeepSeek Key 和模型；
    在「设置 → OneBot」确认 ws://127.0.0.1:3001。

 常用命令：
   systemctl status qq-agent
   journalctl -u qq-agent -f
   docker ps | grep napcat
   systemctl restart qq-agent

 配置文件：$INSTALL_DIR/data/config.json
 数据目录：$INSTALL_DIR/data（权限 700）
 卸载：systemctl disable --now qq-agent && rm -rf $INSTALL_DIR
============================================================
EOF
