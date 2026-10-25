# TamsuiShore QQ Agent v1.1.0 发布说明

- 发布日期：2026-10-25
- 版本：`v1.1.0`
- 仓库：<https://github.com/tamsuishore-star/qq-agent-linux-public>
- 适用系统：Ubuntu 22.04 / 24.04（Linux 无界面）
- 运行方式：Node.js + NapCat（Docker）+ systemd

---

## 1. 这个版本是什么

这是本项目第一个**公开、可被其他人直接下载安装**的 Linux 发行版。

与之前私有开发仓库不同，这个仓库：

- 只保留**生产环境实际运行的 48 个模块**，不包含开发过程中的重复/废弃扩展；
- 不包含 `data/`（API Key、聊天记录、记忆、配置）；
- 不包含 `node_modules/`、日志、备份文件；
- 清除了服务器 IP、个人 Windows 路径、个人 QQ/群号、群二维码、个人知识库数据；
- 附带一键安装脚本、配置模板、systemd 服务、安装文档。

---

## 2. 包含的功能

### 核心

- QQ 私聊 / 群聊自动回复
- 会话、消息存档、长期记忆、跨群认人
- Token / 成本统计，按群报表
- Web 工作台：总览、会话、存档、记忆、用量、技能、插件、日志、设置
- 多模型 / OpenAI 兼容接口 / 备选模型
- peak-guard 高峰期节流

### 技能（节选）

- 记账（`ledger`）
- 点歌 / 唱歌（`sing-aloud`，VoxCPM + 程序化伴奏）
- B 站视频转发（`plugins/bili-video`）
- 语音转文字、视频抽帧、分享卡片
- 群活跃榜、热梗、欢迎新人、QZone、点赞、表情包
- 知识库、联网搜索、图片生成/编辑

### 插件（节选）

- `peak-guard`、`token-ledger`、`group-reports`
- `conversation-memory`、`cross-chat-link`
- `bili-video`、`video-frames`、`speech-to-text-qq`
- `welcome-newcomer`、`silence-ping`、`affinity-proactive`
- `share-card`、`sticker-memory`、`typo-sim`

> 不同 Skill/插件可能有各自的第三方依赖与内容版权，使用前请阅读对应目录的 README。

---

## 3. 下载方式

### 方式 A：GitHub Release（推荐）

<https://github.com/tamsuishore-star/qq-agent-linux-public/releases/latest>

下载：

- `qq-agent-linux-v1.1.0.tar.gz`
- `qq-agent-linux-v1.1.0.zip`

上传到服务器后：

```bash
tar xzf qq-agent-linux-v1.1.0.tar.gz
cd qq-agent-linux-v1.1.0
sudo bash install.sh
```

### 方式 B：git clone

```bash
git clone --branch v1.1.0 --depth 1 \
  https://github.com/tamsuishore-star/qq-agent-linux-public.git
cd qq-agent-linux-public
sudo bash install.sh
```

### 方式 C：只下安装脚本

```bash
curl -fsSL https://raw.githubusercontent.com/tamsuishore-star/qq-agent-linux-public/v1.1.0/install.sh -o install.sh
sudo bash install.sh
```

> 方式 C 会自动 clone 仓库；国内网络慢时建议用方式 A 的 Release 包。

---

## 4. 一键安装做了什么

`install.sh` 会：

1. 安装 Node.js 20、Docker、ffmpeg、git；
2. 创建 `qqagent` 用户与 `/opt/qq-agent`；
3. 安装依赖（`js-yaml` / `undici` / `ws`）；
4. 生成 `data/config.json`（交互输入机器人 QQ 号和 DeepSeek Key）；
5. 启动 NapCat 容器（3000/3001/6099 只绑定 `127.0.0.1`）；
6. 注册 systemd 服务并启动；
7. 打印 SSH 隧道、扫码登录、控制台地址。

非交互：

```bash
sudo QQ_ACCOUNT=123456789 DEEPSEEK_API_KEY=sk-xxxx bash install.sh
```

安装完成后必须做一次 QQ 扫码登录：

```bash
ssh -L 6099:127.0.0.1:6099 -L 3210:127.0.0.1:3210 root@<服务器IP>
```

浏览器打开 `http://127.0.0.1:6099/webui` 扫码；  
再打开 `http://127.0.0.1:3210/` 检查模型和 OneBot 配置。

详细步骤见 [INSTALL.md](INSTALL.md)。

---

## 5. 本次修复与改进

### B 站视频转发

- 云服务器 IP 请求 B 站 `view` 接口会返回 **HTTP 412**；已加入匿名 `buvid3` Cookie，实测恢复 200；
- 视频下载成功后，NapCat 在 Docker 中读不到宿主机路径，报“识别URL失败”；发送逻辑改为：
  1. 先发宿主机 `file://`；
  2. 失败则复制到 NapCat 挂载目录 `/opt/napcat/qq/bili-media`，发容器内路径；
  3. 再失败用 `base64://` 兜底。

### 唱歌

- VoxCPM 公共 Space 返回 503 时自动重试 3 次；
- 每次成功唱歌缓存一段到 `data/fallback-song.wav`；
- 服务不可用时先发缓存片段，并如实说明“这是之前的片段”；
- 语音发送增加 `base64://` 兜底，绕过 Docker 路径问题。

### 安全 / 运维

- `data/` 700、`config.json` 600；
- systemd `UMask=0077`；
- NapCat / 工作台端口只绑定本机；
- 安装脚本自动写入 systemd 服务与内存上限。

---

## 6. 公开前的清理清单

已从发行包移除：

- `data/`、`node_modules/`、日志、`.git`
- `config.json` 真实 Key / Token
- 个人 Windows 路径
- 个人 QQ 号、群号、群二维码
- 生产备份文件（`*.bak-*`）
- 个人知识库 `kb-data.jsonl`（12.5MB）
- 服务器 IP、SSH 出口 IP、部署密钥名
- 个人化文案

保留的都是可复现的代码、配置模板、文档和公开素材。

---

## 7. 验证记录

在干净的 Ubuntu 服务器目录中：

```bash
tar xzf qq-agent-linux-v1.1.0.tar.gz
cd qq-agent-linux-v1.1.0
npm install --omit=dev    # 4 packages in 3s
node src/server.js        # HTTP 200
```

结果：

- 工作台 `/` 返回 **200**
- `/api/status` 正常返回 JSON
- 模块加载无 broken
- 页面不再包含个人二维码
- `install.sh` 通过 `bash -n` 语法检查

> 未在全新云主机上完整跑一遍 `install.sh`（会重装系统级依赖）；脚本中的 apt/npm/docker 步骤已在生产环境同版本验证。

---

## 8. 已知限制

- NapCat 首次登录必须扫码；
- 2C2G 不建议跑本地大模型/唱歌模型；
- B 站、QZone、VoxCPM 等第三方接口可能因风控/地区/额度失败；
- `install.sh` 目前只支持 Debian/Ubuntu；
- 部分 Skill/插件依赖外部 API Key，需要在设置里单独填；
- 公开仓库不包含任何人的聊天记录或记忆。

---

## 9. 更新与回滚

更新：

```bash
cd /opt/qq-agent
sudo systemctl stop qq-agent
sudo tar xzf qq-agent-linux-v1.1.0.tar.gz --strip-components=1 -C /opt/qq-agent
sudo npm install --omit=dev
sudo systemctl start qq-agent
```

回滚：重新解压上一个版本的 Release 包，`data/` 不受影响。

升级前备份：

```bash
sudo tar czf /root/qq-agent-data-$(date +%F).tar.gz -C /opt/qq-agent data
```

---

## 10. 安全与合规

- 不要把 `data/`、API Key、Token 提交到 Git；
- 不要把 3210/3000/3001/6099 直接暴露公网；
- 使用第三方 Skill/插件前确认其许可证与内容版权；
- 本项目与腾讯、B 站、DeepSeek 无隶属关系；
- 核心代码基于上游 `K0nd1us/QQ-agent`（MIT），第三方内容版权归各自作者。

---

## 11. 获取帮助

- 安装问题：先看 [INSTALL.md](INSTALL.md) 的“常见问题”
- 运行日志：`journalctl -u qq-agent -n 100 --no-pager`
- NapCat：`docker logs -f napcat`
- 提交 Issue 时请附：系统版本、Node 版本、错误日志（**不要贴 Key**）
