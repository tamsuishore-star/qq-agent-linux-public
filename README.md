# TamsuiShore QQ Agent（Linux）

把 QQ 变成一个能聊天、能记事、能调用工具的 AI 助手。  
本项目是 **Linux 无界面版本**：QQ 协议端用 NapCat（Docker），机器人在后台常驻，浏览器工作台负责配置和查看。

> 当前版本：**v1.1.0**  
> 运行环境：Ubuntu 22.04 / 24.04，2 核 2G 起（推荐 2C2G 以上）  
> 不需要 Windows，不需要桌面环境。

---

## 功能

- QQ 私聊 / 群聊自动回复，支持 @、关键词、上下文档位
- 长期记忆、消息存档、会话记录、Token/成本统计
- Skill（模型工具）与插件（确定性能力）两套扩展体系
- 内置技能：记账、点歌、B 站视频转发、语音转文字、视频抽帧、分享卡片、群报表、欢迎新人、QZone 等
- Web 工作台：总览、会话、存档、记忆、用量、技能、插件、日志、设置
- 支持 DeepSeek / OpenAI 兼容接口、备选模型、搜索服务

---

## 下载方式

### 方式 1：GitHub Release（推荐）

打开：

```
https://github.com/tamsuishore-star/qq-agent-linux-public/releases/latest
```

下载：

- `qq-agent-linux-v1.1.0.tar.gz`（Linux）
- `qq-agent-linux-v1.1.0.zip`（Windows 解压后传到服务器也行）

解压后执行 `sudo bash install.sh`。

### 方式 2：git clone

```bash
git clone --branch v1.1.0 --depth 1 \
  https://github.com/tamsuishore-star/qq-agent-linux-public.git
cd qq-agent-linux-public
sudo bash install.sh
```

### 方式 3：仓库源码直接安装

```bash
sudo bash install.sh
```

脚本会自动拉取代码（如果当前目录没有 `src/server.js`）。

> 国内服务器如果 GitHub 访问慢，可以把 Release 包先下载到本地，再 `scp` 上传到服务器解压安装。

---

## 一键安装（傻瓜式）

在 Ubuntu 服务器上：

```bash
sudo bash install.sh
```

脚本会依次做：

1. 安装 Node.js 20、Docker、ffmpeg、git
2. 创建 `qqagent` 用户和 `/opt/qq-agent`
3. 安装依赖
4. 生成 `data/config.json`（会提示输入机器人 QQ 号和 DeepSeek Key）
5. 启动 NapCat 容器（端口只绑定 `127.0.0.1`）
6. 注册并启动 `qq-agent.service`
7. 打印登录 QQ / 打开控制台的命令

非交互安装：

```bash
sudo QQ_ACCOUNT=123456789 DEEPSEEK_API_KEY=sk-xxxx bash install.sh
```

---

## 首次登录 QQ（必须做一次）

NapCat 第一次启动需要扫码登录。  
在**你自己的电脑**上开 SSH 隧道：

```bash
ssh -L 6099:127.0.0.1:6099 -L 3210:127.0.0.1:3210 root@<服务器IP>
```

然后浏览器打开：

```
http://127.0.0.1:6099/webui
```

按提示扫码登录机器人 QQ。  
也可以看容器日志里的二维码：

```bash
docker logs -f napcat
```

登录成功后，再打开工作台：

```
http://127.0.0.1:3210/
```

在「设置 → 模型 API」确认 Key 和模型；在「设置 → OneBot」确认：

```
ws://127.0.0.1:3001
http://127.0.0.1:3000
```

---

详细步骤、端口、更新、卸载和常见问题见 [docs/INSTALL.md](docs/INSTALL.md)。\n\n## 手动安装（不想跑脚本）

```bash
# 1) 依赖
sudo apt update
sudo apt install -y nodejs npm docker.io ffmpeg git
# Node 需要 20+，Ubuntu 自带的可能太旧，建议用 NodeSource

# 2) 代码
sudo mkdir -p /opt/qq-agent
sudo cp -a . /opt/qq-agent/
cd /opt/qq-agent
sudo npm install --omit=dev

# 3) 配置
sudo mkdir -p data && sudo chmod 700 data
sudo cp config/config.example.json data/config.json
sudo chmod 600 data/config.json
# 编辑 data/config.json：api.apiKey / api.model / snowluma.wsUrl

# 4) 用户与服务
sudo useradd --system --create-home --shell /usr/sbin/nologin qqagent
sudo chown -R qqagent:qqagent /opt/qq-agent
sudo cp deploy/qq-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qq-agent

# 5) NapCat
sudo mkdir -p /opt/napcat/{config,plugins,qq}
sudo docker run -d --name napcat --restart unless-stopped \
  -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 -p 127.0.0.1:6099:6099 \
  -e ACCOUNT=<机器人QQ> -e TZ=Asia/Shanghai \
  -v /opt/napcat/qq:/app/.config/QQ \
  -v /opt/napcat/config:/app/napcat/config \
  -v /opt/napcat/plugins:/app/napcat/plugins \
  mlikiowa/napcat-docker:latest
```

---

## 目录结构

```
/opt/qq-agent
├── src/          # 机器人核心
├── ui/           # Web 工作台
├── skills/       # LLM 工具型技能
├── plugins/      # 确定性插件
├── config/       # 配置模板、内置模块快照
├── data/         # 运行数据（配置/会话/记忆，权限 700）
├── docs/         # 文档
├── test/         # 测试
├── deploy/       # systemd / nginx 示例
└── install.sh
```

`data/` 永远不会进 Git，升级/重装时请自行备份。

---

## 常用命令

```bash
systemctl status qq-agent
journalctl -u qq-agent -f
systemctl restart qq-agent

docker ps | grep napcat
docker logs -f napcat
```

控制台默认只监听 `127.0.0.1:3210`，推荐 SSH 隧道访问；不要直接暴露到公网。

---

## 更新

```bash
cd /opt/qq-agent
sudo git fetch --tags
sudo git checkout v1.1.0
sudo npm install --omit=dev
sudo systemctl restart qq-agent
```

升级前先备份：

```bash
sudo tar czf /root/qq-agent-data-$(date +%F).tar.gz -C /opt/qq-agent data
```

---

## 卸载

```bash
sudo systemctl disable --now qq-agent
sudo docker rm -f napcat
sudo rm -rf /opt/qq-agent /opt/napcat
sudo userdel -r qqagent 2>/dev/null || true
```

`data/` 会随项目目录一起删除，卸载前请先备份。

---

## 安全建议

- 控制台（3210）、NapCat WebUI（6099）、OneBot（3000/3001）都只绑定本机，不要把端口直接开到公网；
- 使用 SSH 隧道访问；
- `data/` 权限保持 700，`config.json` 600；
- 服务器安全组只放行 SSH；
- 不要提交 `data/`、API Key、Token 到 Git。

---

## 已知限制

- NapCat 首次登录需要扫码，无法完全无人值守；
- 2C2G 服务器不建议跑本地大模型/唱歌模型；
- B 站、QQ 空间等第三方接口可能因风控/地区限制失败，插件会降级提示；
- 不同 Skill 的第三方内容版权归各自作者，使用前请确认许可；
- 本项目与腾讯、B 站、DeepSeek 无隶属关系。

---

## License

核心代码基于上游 `K0nd1us/QQ-agent`（MIT）二次开发；`skills/`、`plugins/` 中第三方内容版权归各自作者。  
完整许可见 [LICENSE](LICENSE)。
