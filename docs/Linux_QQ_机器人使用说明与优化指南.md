# Linux QQ 机器人使用说明与优化指南

> 适用项目：`/opt/qq-agent`（K0nd1us/QQ-agent 的 Linux 部署版 + NapCat 接入）
> 文档版本：v1.0（2026-10-19）
> 核查方式：实际读取运行进程、systemd 配置、`data/config.json`、`src/` 源码、`skills/`、`plugins/`、控制台接口与日志；未凭记忆或旧版本推断。
> 敏感信息：本文所有示例均使用占位符，不包含真实 API Key、Token、QQ 密码或聊天记录。

---

## 第一章 文档说明与项目概况

### 1.1 文档用途

这份文档同时服务两类读者：

1. **日常使用者**：想知道机器人能做什么、怎么触发、怎么开关、出问题怎么办。
2. **后续维护者**：想快速定位代码、配置、日志、备份与升级方式，以及未来扩展（微信/多平台）的可行性与风险。

### 1.2 实际运行环境（2026-10-19 核查）

| 项目 | 实际值 |
|---|---|
| 操作系统 | Ubuntu 22.04.5 LTS，内核 5.15，x86_64 |
| CPU / 内存 | 2 核 / 1736 MB，另有 4 GB swap |
| 磁盘 | 40 GB，已用约 12 GB，剩余约 26 GB |
| 运行时 | Node.js v20.19.5（`/opt/node20`，`/usr/local/bin/node` 软链） |
| 机器人目录 | `/opt/qq-agent` |
| 运行用户 | `qqagent`（非 root） |
| 服务管理 | systemd：`qq-agent.service` |
| 控制台 | `http://127.0.0.1:3210`（仅本机，需 SSH 隧道） |
| QQ 接入 | NapCat（Docker，OneBot v11） |
| 容器 | `napcat`，`restart=unless-stopped` |
| 数据目录 | `/opt/qq-agent/data`（约 209 MB） |
| 代码托管 | GitHub 私有仓库 `tamsuishore-star/qq-agent-linux-public`，分支 `main` |

### 1.3 本次核查范围与限制

**已核查**：进程与服务状态、systemd 单元、实际配置项、技能/插件目录与清单、OneBot 连接状态、NapCat 容器、内存/磁盘、日志、控制台接口、Git 仓库状态。

**未核查/无法核查**：每条 AI 回复的实际语义质量；所有第三方 API 的余额与配额；微信等外部平台的实际接入（仅做资料调研，未申请账号）；机器人所有历史会话内容（涉及隐私，未逐条阅读）。

---

## 第二章 机器人功能总览

### 2.1 架构

```
手机/PC QQ
   │
   ▼
NapCat（Docker，Linux 版 QQ + OneBot v11）
   │  ws://127.0.0.1:3001 / http://127.0.0.1:3000
   ▼
QQ Agent（Node.js，headless，systemd）
   ├─ src/server.js        入口，启动 HTTP 控制台
   ├─ src/app.js           应用装配、路由、服务生命周期
   ├─ src/onebot.js        OneBot v11 客户端（收发消息）
   ├─ src/orchestrator.js  会话编排：防抖聚批、唤醒、并发、重试
   ├─ src/llm.js           模型调用与 Key 解析
   ├─ src/memory.js        长期记忆
   ├─ src/sessions.js      会话读写与索引
   ├─ src/skills/          技能框架
   ├─ skills/              技能（业务能力）
   └─ plugins/             插件（横切能力）
        │
        ▼
   data/（配置、人设、记忆、会话、表情缓存）
```

### 2.2 已确认可用的功能

| 功能 | 说明 | 状态 |
|---|---|---|
| 私聊自动回复 | 与机器人单聊，按人设回复 | ✅ 实测 |
| 群聊回复 | 群内被 @ 或按上下文参与 | ✅ 实测 |
| 关键词唤醒/退出 | `/退出` 可让机器人在当前会话静默 | ✅ 配置确认 |
| AI 问答 | 走 OpenAI 兼容接口（当前 `deepseek-flash`） | ✅ 运行中 |
| 人设 | `persona.roleText` 角色卡，可多套 | ✅ 运行中 |
| 长期记忆 | `data/memory`、`data/memory-v2` | ✅ 已迁移 |
| 会话记录 | `data/sessions`，1743 个文件 | ✅ 运行中 |
| 表情包 | 梗鲸表情包、表情记忆 | ✅ 已加载 |
| 语音 | TTS 技能（Edge/第三方引擎） | ✅ 你已实测 |
| 群聊白名单 | 4 个群在 `allow.groups` | ✅ 配置确认 |
| 主动私信/主动参与 | `proactive`、`silence-ping` | ✅ 已启用 |
| 控制台 | 会话/记忆/技能/插件/设置 | ✅ 可访问 |
| 插件/技能扩展 | 21 个插件、23 个技能目录 | ✅ 已加载 |

### 2.3 技能清单（`skills/`，实际目录）

| 技能 | 能力 |
|---|---|
| `ai-image` | 文生图 / 图生图 |
| `api-beggar` | 查询 API 余额，低于阈值时玩梗提醒 |
| `chat-archive` | 群聊档案检索、活跃榜、词云 |
| `codex-voice` | 文字转语音（双引擎、多音色） |
| `knowledge-base` | 本地编程/网络知识库 + 联网兜底 |
| `ledger` | “小本本”人情账 |
| `message-recall-2` | 撤回机器人自己发的消息（主人限定） |
| `mimo-tts` | MiMo 语音合成 |
| `owner-whitelist` | 主人在聊天里改白名单 |
| `profile-like` / `qq-like` | 名片点赞 / 个人页点赞 |
| `qzone` / `qzone-post` | 发 QQ 空间 |
| `search-image` | 搜图发图 |
| `sing-aloud` | 点歌、念唱 |
| `skill-summary` | “你会什么”功能汇总 |
| `support-topup` | 投喂/赞助感谢 |
| `trendy-memes` | 网络流行梗 |
| `tts-say` | “发语音/念一下” |
| `voxcpm-voice` | 音色克隆朗读 |
| `whale-memes` | 梗鲸表情包 |
| `daily-fortune` | 已删除（原目录结构损坏） |

> 目录里有 23 个，其中 `sing-aloud` 存在重复副本；`daily-fortune` 因缺少清单已删除。

### 2.4 插件清单（`plugins/`，21 个）

`burst-merge`（连发合并）、`context-chime`（插话判定）、`conversation-memory`（分层记忆）、`early-finish`（省 token）、`friend-gate`（好友申请，当前关闭）、`group-cost-report`（群花费）、`group-reports`（日报/周报）、`guardian`（看门狗，当前关闭）、`hot-trend-tracker`（热梗）、`msg-reaction`（表情回应）、`owner-identity`（主人识别）、`qq-agent-browser`（浏览器，Windows 专用，当前关闭）、`qzone-sweeper`（空间互动）、`repeat-echo`（复读）、`silence-ping`（主动私信）、`sticker-memory`（表情记忆）、`token-ledger`（Token 账本）、`token-saver`（节流）、`typo-sim`（手滑）、`welcome-newcomer`（进群欢迎）、`whale-voice`（鲸鱼语音）。

---

## 第三章 日常使用教程

### 3.1 私聊

直接给机器人 QQ 发消息即可，无需 @。首次对话会按人设回复；上下文由会话文件维护。

### 3.2 群聊

- 被 **@机器人** 时必回；
- 未被 @ 时，`context-chime` 插件会做一次轻量判断，决定是否接话；
- 机器人只在白名单群内工作：当前 `allow.groups` 配置了 4 个群（群号不在此列出）；
- 白名单可以用技能 `owner-whitelist` 在聊天里修改（主人限定），或直接改 `data/config.json` 的 `allow`。

### 3.3 唤醒与退出

| 操作 | 实际行为 |
|---|---|
| @机器人 | 必定唤醒 |
| 群里叫它名字/角色名 | 由提示词与上下文判断 |
| 发送 `/退出` | **静默 30 分钟**（`commandMute.command=/退出`，`durationMin=30`），不是永久退出 |
| 等待 30 分钟 | 自动恢复响应 |
| 修改静默时长 | 改 `data/config.json` → `commandMute.durationMin`，重启服务 |

> 注意：`/退出` 是当前唯一确认的“斜杠命令”。它不是完整的命令系统，而是“命令静默”功能的开关。

### 3.4 会话与记忆

- 每个群/私聊独立会话文件，互不串台；
- 长期记忆在 `data/memory` 与 `data/memory-v2`；
- 想看/清理记忆，可在控制台「记忆」页操作；删除前建议先备份 `data/`。

### 3.5 语音

触发方式（由技能实现，实测可用）：

- 明确说“发语音 / 念一下 / 读一下 XXX”；
- 或由 `whale-voice` 按配置模式自动念。

失败常见原因：对应 TTS 引擎未配置、网络不可达、语音接口额度不足。

### 3.6 图片 / 表情

- 发图给机器人可触发看图（若模型支持视觉）；
- “来张表情包 / 要图”由 `whale-memes` 处理；
- 搜图由 `search-image` 处理。

### 3.7 管理类操作

主人身份由 `owner-identity` 按 QQ 号认定（`config.skills['owner-identity'].ids`）。主人可：

- 改白名单（`owner-whitelist`）；
- 撤回机器人消息（`message-recall-2`）；
- 查群花费（`group-cost-report`）；
- 同意好友申请（`friend-gate`，当前关闭）。

---

## 第四章 命令与操作大全

> 本项目**没有**统一的 `/help` 命令系统。绝大多数能力是“自然语言 + 技能工具”触发，只有 `/退出` 是明确的斜杠命令。

### 4.1 明确的命令

| 命令 | 作用 | 场景 | 权限 | 示例 |
|---|---|---|---|---|
| `/退出` | 当前会话静默 30 分钟 | 群/私聊 | 所有人 | 发送 `/退出` |
| `/退出` 后等待 | 30 分钟后自动恢复 | — | — | 无需操作 |

### 4.2 自然语言触发（按技能）

| 想做什么 | 可以说 | 对应技能 |
|---|---|---|
| 看功能列表 | “你会什么 / 有什么功能” | `skill-summary` |
| 查群花费 | @机器人 “金额统计” | `group-cost-report` |
| 查 API 余额 | “查余额” | `api-beggar` |
| 点赞 | “赞我 / 给我点 20 个赞” | `qq-like` / `profile-like` |
| 点歌 | “唱一首 XXX” | `sing-aloud` |
| 发语音 | “发语音 / 念一下 XXX” | `tts-say` / `whale-voice` / `voxcpm-voice` |
| 生图 | “画一张 XXX” | `ai-image` |
| 搜图 | “找张 XXX 的图” | `search-image` |
| 表情包 | “来张表情包” | `whale-memes` |
| 翻旧消息 | “上周那个链接是啥” | `chat-archive` |
| 发空间 | “发条说说 XXX” | `qzone-post` |
| 撤回 | “撤回” | `message-recall-2`（主人） |
| 改白名单 | “把 XX 群加白名单” | `owner-whitelist`（主人） |
| 记人情账 | “你欠我一顿饭” | `ledger` |

> 具体是否命中，取决于模型判断与技能描述；上表是技能清单中的真实能力，不保证每句话都 100% 触发。

---

## 第五章 控制台使用手册

### 5.1 打开方式

控制台默认只监听 `127.0.0.1:3210`，公网无法直接访问。推荐 SSH 隧道：

```bash
# 在你自己的 Windows 上执行（需要服务器 SSH 权限）
ssh -N -L 13210:127.0.0.1:3210 root@<服务器IP>
# 浏览器打开
http://127.0.0.1:13210
```

也可以直接双击桌面的 `打开QQ机器人控制台.bat`（脚本内部就是上面的隧道命令）。

### 5.2 页面结构

| 页签 | 作用 | 备注 |
|---|---|---|
| 会话 | 查看每个群/私聊的处理记录 | 可看到消息、工具调用、回复 |
| 存档 | 聊天存档检索 | 依赖 `chat-archive` |
| 记忆 | 查看/编辑长期记忆 | 修改会影响人设表现 |
| 用量 | Token 与花费统计 | 数据来自本地账本 |
| 技能 | 技能开关与设置 | 修改后部分需重启 |
| 插件 | 插件开关与设置 | `guardian`/`qq-agent-browser` 已关闭 |
| SnowLuma | 上游的 QQ 管理页 | **Linux 下可忽略**，本项目用 NapCat |
| 设置 | 模型、人设、服务等 | 高风险操作集中地 |

### 5.3 常用操作

| 操作 | 位置 | 是否需重启 |
|---|---|---|
| 查看是否在线 | 顶栏/接口 `/api/status` | 否 |
| 改 API Key | 设置 → 模型/提供商 | 否（优先 `dshProviderKeys`） |
| 改人设 | 设置 → 人设 | 否 |
| 开关技能/插件 | 技能/插件页 | 部分需要重启 |
| 改端口 | 设置 → 服务 | 是 |
| 暂停机器人 | 顶栏“暂停” | 否 |

### 5.4 重要提示

- **不要打开 `hotReload`**（界面无开关，只在 `data/config.json` 的 `extensions.hotReload`）。开启会导致内存持续上涨并崩溃。
- 控制台没有登录密码，安全边界是“仅本机”。不要把 3210 直接暴露到公网。
- `SnowLuma` 页签的“未登录”提示在 Linux 下是正常的，不代表机器人掉线；以 OneBot 连接状态为准。

---

## 第六章 配置说明

### 6.1 文件位置

| 文件 | 作用 | 是否入库 |
|---|---|---|
| `data/config.json` | 全部运行配置（含密钥） | ❌ 禁止 |
| `config/config.example.json` | 安全模板 | ✅ |
| `data/sessions/` | 会话记录 | ❌ |
| `data/memory/`、`data/memory-v2/` | 记忆 | ❌ |
| `data/logs/` | 应用日志 | ❌ |

### 6.2 关键配置项

| 配置 | 含义 | 当前值（非敏感） | 修改后 |
|---|---|---|---|
| `api.baseUrl` | AI 接口地址 | `https://api.deepseek.com` | 重启 |
| `api.apiKey` | 接口密钥 | 已配置（不展示） | 重启 |
| `api.model` | 默认模型 | `deepseek-flash` | 重启 |
| `dshProviderKeys` | 各提供商 Key | 已配置（不展示） | 优先于 `api.apiKey` |
| `snowluma.wsUrl` | OneBot WS | `ws://127.0.0.1:3001` | 重启 |
| `snowluma.httpUrl` | OneBot HTTP | `http://127.0.0.1:3000` | 重启 |
| `snowluma.autoLaunch` | 是否拉起 QQ 端 | `false` | 重启 |
| `persona.botName` | 机器人名 | `小鲸鱼` | 否 |
| `persona.roleText` | 角色卡 | 已配置（长文本） | 否 |
| `allow.groups` | 群白名单 | 4 个群 | 重启 |
| `allowAllWhenEmpty` | 空名单是否全放行 | `true` | 重启 |
| `commandMute.command` | 静默命令 | `/退出` | 重启 |
| `commandMute.durationMin` | 静默时长 | `30` | 重启 |
| `wakeDelayMs` | 聚批延迟 | `2000` | 重启 |
| `drainDelayMs` | 冷静窗口 | `1200` | 重启 |
| `maxConcurrentRuns` | 最大并发 | `2` | 重启 |
| `proactive.enabled` | 主动私信 | `true` | 重启 |
| `server.port` | 控制台端口 | `3210` | 重启 |
| `extensions.hotReload` | 热重载 | **`false`** | 重启 |

### 6.3 修改步骤

```bash
# 1) 备份
cp -a /opt/qq-agent/data/config.json /opt/qq-agent/data/config.json.bak.$(date +%s)
# 2) 用宝塔文件管理器或 nano 编辑
nano /opt/qq-agent/data/config.json
# 3) 校验 JSON
python3 -m json.tool /opt/qq-agent/data/config.json > /dev/null && echo OK
# 4) 重启
systemctl restart qq-agent
# 5) 验证
curl -s http://127.0.0.1:3210/api/status
```

### 6.4 环境变量

| 变量 | 作用 |
|---|---|
| `QQ_AGENT_PORT` | 覆盖控制台端口 |
| `QQ_AGENT_DATA_DIR` | 覆盖数据目录 |
| `NODE_OPTIONS` | 当前为 `--max-old-space-size=640` |

---

## 第七章 Linux 服务管理

### 7.1 机器人服务

| 操作 | 命令 | 说明 |
|---|---|---|
| 看状态 | `systemctl status qq-agent --no-pager` | 是否 active |
| 启动 | `systemctl start qq-agent` | 手动启动 |
| 停止 | `systemctl stop qq-agent` | 会断开 OneBot |
| 重启 | `systemctl restart qq-agent` | 改配置后使用 |
| 开机自启 | `systemctl enable qq-agent` | 已启用 |
| 实时日志 | `journalctl -u qq-agent -f` | Ctrl+C 退出 |
| 最近日志 | `journalctl -u qq-agent -n 100 --no-pager` | 排查用 |

### 7.2 QQ 接入（NapCat）

| 操作 | 命令 |
|---|---|
| 看容器 | `docker ps --filter name=napcat` |
| 日志 | `docker logs napcat --tail 50` |
| 重启 | `docker restart napcat`（约 10 秒快速登录） |
| 资源 | `docker stats --no-stream` |

### 7.3 一键健康检查

```bash
systemctl is-active qq-agent
docker ps --filter name=napcat
curl -s http://127.0.0.1:3210/api/status
free -h
```

期望：`active`、`Up`、`"connected":true`。

---

## 第八章 常见问题及故障排查

| 问题表现 | 可能原因 | 检查方法 | 解决方法 | 验证 |
|---|---|---|---|---|
| 私聊/群聊没回复 | 服务停了 | `systemctl is-active qq-agent` | `systemctl start qq-agent` | 再发一条 |
| 有回复但内容报错 | API Key/余额/网络 | `journalctl -u qq-agent -n 50` | 换 Key/充值/查网络 | 发消息看是否正常 |
| 显示未连接 | NapCat 未登录/掉线 | `docker logs napcat --tail 50` | 重新扫码或 `docker restart napcat` | `/api/status` 变 true |
| 内存涨到 1GB 反复重启 | `hotReload` 被打开 | `python3 -c "import json;print(json.load(open('/opt/qq-agent/data/config.json'))['extensions'])"` | 改为 false 并重启 | 观察 RSS 稳定 |
| 控制台打不开 | 没有隧道/端口占用 | `ss -tlnp \| grep 3210` | 建 SSH 隧道，换本地端口 | 浏览器 200 |
| 控制台显示 SnowLuma 未登录 | Linux 下不用 SnowLuma | 看 `/api/status` 的 onebot | 忽略该页签 | connected 为 true |
| NapCat 反复要扫码 | 登录态失效/风控 | 日志 `ErrCode` | 手机 QQ 扫码并完成验证 | `get_login_info` 返回 user_id |
| 磁盘增长快 | 会话/缓存累积 | `du -sh data/*` | 备份后清理旧缓存 | 磁盘余量恢复 |

---

## 第九章 数据备份与恢复

### 9.1 必须备份的内容

| 内容 | 路径 | 说明 |
|---|---|---|
| 配置（含 Key） | `data/config.json` | 丢失需重配 |
| 人设 | 同上 `persona` | 重要创作内容 |
| 记忆 | `data/memory`、`data/memory-v2` | 长期记忆 |
| 会话 | `data/sessions` | 约 190MB，1743 个文件 |
| 表情/缓存 | `data/stickers.json`、`data/sticker-images`、`data/whale-memes` | 可按需 |
| 代码 | GitHub 私有仓库 | 已托管 |

### 9.2 备份

```bash
# 使用仓库自带脚本（保留 7 天）
/opt/qq-agent/scripts/backup.sh
# 或手动
tar czf /root/qq-agent-data-$(date +%F).tar.gz -C /opt/qq-agent data
```

> 备份包含 API Key 与聊天记录，权限应为 600，不要上传公开网盘。

### 9.3 恢复（会短暂停服）

```bash
systemctl stop qq-agent
cp -a /opt/qq-agent/data /opt/qq-agent/data.bak.$(date +%s)
tar xzf /root/qq-agent-data-YYYY-MM-DD.tar.gz -C /opt/qq-agent
chown -R qqagent:qqagent /opt/qq-agent/data
systemctl start qq-agent
curl -s http://127.0.0.1:3210/api/status
```

---

## 第十章 现有项目问题分析

| 编号 | 问题 | 证据 | 影响 | 等级 |
|---|---|---|---|---|
| P0-1 | `hotReload` 开启会内存泄漏 | 实测 3 分钟涨到 1GB 并 OOM 重启；关闭后 247MB 稳定 | 服务反复崩溃 | 已修复（false） |
| P0-2 | 2GB 内存偏紧 | 当前 Node 215MB + NapCat 178MB + 系统约 300MB | 高峰期可能吃 swap | 持续观察 |
| P0-3 | 控制台无登录认证 | `server.token` 为空，仅监听本机 | 一旦暴露公网即高危 | 未修复 |
| P1-1 | SnowLuma 页签在 Linux 无意义 | 页面读的是 Windows 路径 | 误导使用者 | 文档说明 |
| P1-2 | 部分管理代码是 Windows 专用 | `src/app.js` 中 `wmic`/`taskkill`/`explorer.exe` | 相关按钮在 Linux 失效 | 未修复 |
| P1-3 | 会话文件持续增长 | 1743 个、约 190MB | 磁盘与启动 IO | 未修复 |
| P1-4 | 缺少自动化测试与 CI | 仓库无 test 脚本 | 升级回归靠手工 | 未修复 |
| P2-1 | 核心与 QQ 平台耦合 | `src/onebot.js` 直接产出 QQ 字段；会话 key 为 `group_/private_` | 多平台扩展需适配层 | 未修复 |
| P2-2 | 插件/技能无统一生命周期 | 目录即加载，无健康检查 | 坏插件只能看日志 | 未修复 |
| P2-3 | 配置无校验提示 | 手改 JSON，格式错会启动失败 | 误操作成本高 | 未修复 |

---

## 第十一章 本次实际优化记录

> 原则：线上机器人可正常运行，本次**未修改任何生产代码或配置**，只新增了这份文档。

| 项目 | 内容 |
|---|---|
| 优化项 | 新增项目文档 `docs/Linux_QQ机器人使用说明与优化指南.md` |
| 原有问题 | 缺少面向使用者的完整手册；排障知识分散在对话里 |
| 修改内容 | 仅新增 Markdown 文档，无代码/配置变更 |
| 修改位置 | 仓库 `docs/`；服务器 `/opt/qq-agent/docs/` |
| 预期收益 | 后续维护与排障可查；降低误操作风险 |
| 验证结果 | 文档写入成功；机器人状态未变化（`active`、`connected:true`、0 重启） |
| 是否应用生产 | 文档已放置，**不涉及运行逻辑** |
| 回退方式 | 删除该文件即可，无副作用 |

**历史修复（部署期，非本次）**：关闭 `hotReload`、设置堆上限 640MB、删除 4 个损坏的技能/插件、恢复完整功能并验证内存稳定。这些已在生产生效。

**本次仅分析、未实施的优化**：控制台认证、日志页面、配置校验、多平台适配层、会话归档策略等，原因见第十七章。

---

## 第十二章 控制台改进与设计建议

### 12.1 现状问题

- 信息架构按“数据对象”分（会话/存档/记忆/用量），缺少“总览”；
- 关键状态（是否在线、内存、最近错误）分散；
- 配置项平铺，缺少中文说明与校验；
- 日志需要去服务器看，页面内不可查；
- 无认证，安全边界仅靠“只监听本机”。

### 12.2 建议的目标结构

```
首页（仪表盘）
├─ 运行状态：服务/OneBot/QQ/运行时长/内存/磁盘
├─ 最近错误（脱敏）
└─ 最近消息事件（最近 20 条）
会话 / 记忆 / 用量
技能 / 插件（状态 + 错误 + 开关）
设置
├─ 模型与 Key（测试连通性，脱敏显示）
├─ 人设
├─ 白名单与权限
├─ 服务与端口
└─ 高级（hotReload 固定关闭，只读展示）
日志（级别筛选、关键词搜索、下载脱敏片段）
```

### 12.3 具体改进点（按收益排序）

1. **仪表盘**：复用 `/api/status` 与 `process.memoryUsage()`，只展示真实字段；不要伪造在线率。
2. **配置校验**：保存前用 JSON Schema 或手写规则校验端口、URL、必填项；错误就地提示。
3. **API 测试按钮**：调用现有 `/api/providers/test-chat`，日志只记录“成功/失败+状态码”，不打印 Key。
4. **日志页**：读取 `journalctl` 或 `data/logs`，默认只显示最近 200 行，支持级别过滤；提供“复制脱敏错误”按钮。
5. **认证**：不建议在 Node 里自建账号体系；优先 Nginx + HTTPS + Basic Auth（模板已在仓库 `deploy/`）。
6. **移动端**：现有布局是桌面优先，建议只做响应式收敛（侧栏折叠），不引入前端框架。
7. **危险操作确认**：删除记忆、清空会话、改端口、重启服务，需二次确认。

> 以上为设计建议，本次未改前端代码，避免影响正在使用的控制台。

---

## 第十三章 微信接入可行性分析

> 资料核查日期：2026-10-19。平台政策会变化，以下为当时公开资料与工程判断，**未实际申请/接入验证**。

### 13.1 四条现实路线

| 路线 | 官方支持 | 能力 | 账号风险 | 资源 | 结论 |
|---|---|---|---|---|---|
| **企业微信自建应用** | ✅ 官方 API | 可收发内部消息、通讯录、群 | 低（企业主体） | 低 | **最稳妥**，但需要企业/组织认证 |
| **企业微信群机器人 Webhook** | ✅ 官方 | **只能发，不能收** | 低 | 极低 | 只能做通知，不能做聊天机器人 |
| **微信公众号（服务号/订阅号）** | ✅ 官方 | 用户主动发消息后可回复（有时间窗限制） | 低 | 低 | 需认证主体，交互形态与 QQ 差异大 |
| **个人微信（Wechaty/PadLocal 等）** | ❌ 非官方 | 私聊/群聊/媒体，能力最接近 | **高（封号）** | 中 | 不建议用在主号；需付费 Token |

### 13.2 关键事实与风险

- **个人微信没有官方机器人 API**。所有“个人号机器人”都依赖非官方协议或客户端注入，违反平台规则，存在封号风险；Wechaty 的 PadLocal 协议需要付费 Token，且稳定性依赖第三方服务（[PadLocal 文档](https://wechaty.readthedocs.io/zh-cn/latest/introduction/use-padlocal-protocol/)）。
- **企业微信**是官方路线：自建应用可接收消息回调（需要公网 HTTPS 回调地址），群机器人 Webhook 只能单向推送。适合“公司/团队内部助手”，不适合个人号场景。
- **公众号**需要认证主体，用户先发消息才能回复，且客服消息有时间窗；做“群聊机器人”不合适。
- 当前服务器 2C2G，再跑一个微信协议端（尤其是带客户端的方案）内存会非常紧张。

### 13.3 建议

1. **不建议**在个人微信号上跑非官方协议，尤其是主号；
2. 如果只是想要“微信侧的通知”，可以用**企业微信群机器人 Webhook** 做单向推送（成本极低）；
3. 如果确实需要微信双向对话，优先走**企业微信自建应用**，并准备：企业主体、公网 HTTPS 域名、回调配置；
4. 在架构上先做“适配层”（第十五章），再决定接哪个平台，避免把微信逻辑硬编码进 `onebot.js`。

---

## 第十四章 其他聊天平台扩展分析

| 平台 | 接入方式 | 官方支持 | 难度 | 资源 | 账号风险 | 费用 | 复用度 | 优先级 |
|---|---|---|---|---|---|---|---|---|
| **QQ 官方机器人** | WebSocket/Webhook + OpenAPI | ✅ 官方（需主体认证） | 中 | 低 | 低 | 免费 | 中（协议不同，需适配） | **P1** |
| **Telegram** | Bot API（HTTPS 长轮询/Webhook） | ✅ 官方 | 低 | 低 | 低 | 免费 | 高 | P1（但国内网络需代理） |
| **飞书** | 开放平台事件订阅 + API | ✅ 官方 | 中 | 低 | 低 | 免费 | 高 | P2（团队场景） |
| **钉钉** | 开放平台机器人 | ✅ 官方 | 中 | 低 | 低 | 免费 | 高 | P2 |
| **Discord** | Bot API + Gateway | ✅ 官方 | 低 | 低 | 低 | 免费 | 高 | P2（国内访问受限） |
| **企业微信** | 自建应用/群 Webhook | ✅ 官方 | 中高 | 低 | 低 | 免费 | 高 | P2（需企业主体） |
| **个人微信** | 非官方协议 | ❌ | 高 | 中 | **高** | 可能付费 | 中 | **不推荐** |

> QQ 官方机器人资料：[QQ Bot 介绍与接入指南](https://bot.q.qq.com/wiki/bot_new_product-intro/)（核查 2026-10-19）：个人认证可创建 5 个机器人、可设为公开、群上限 500；支持 WebSocket/Webhook。

---

## 第十五章 未来多平台架构设计

### 15.1 现状耦合点

- `src/onebot.js` 直接处理 OneBot v11 事件与 CQ 码；
- `src/orchestrator.js` 的会话 key 形如 `group_<id>` / `private_<id>`；
- `src/sender.js` 直接调 OneBot 发送接口；
- 技能/插件通过工具调用与 QQ 字段交互。

结论：**核心业务（人设、记忆、AI、技能）可复用，但接入层与身份/会话标识需要抽象**。

### 15.2 目标架构（渐进式）

```
平台适配器（QQ/NapCat、Telegram、飞书…）
        │  统一消息对象
        ▼
   MessageBus / Router
        │
        ▼
   Orchestrator（会话、去重、聚批、并发）
        │
        ▼
   LLM + Memory + Skills/Plugins
        │
        ▼
   平台适配器.send()
```

统一消息对象建议最小字段：

```js
{
  platform: 'qq' | 'telegram' | 'feishu',
  chatId: 'group:123' | 'private:456',
  chatType: 'group' | 'private',
  userId: '...',
  text: '...',
  media: [{ type: 'image', url: '...' }],
  raw: { /* 平台原始事件，仅适配器使用 */ },
  timestamp: 0
}
```

### 15.3 分阶段实施

| 阶段 | 内容 | 风险 |
|---|---|---|
| 1 | 抽出 `Adapter` 接口，QQ 适配器包装现有 `onebot.js`，行为不变 | 低（纯重构，需回归） |
| 2 | 统一 `chatId` 与 `userId`，迁移会话 key（保留旧 key 兼容） | 中（涉及历史会话） |
| 3 | 接入第二个平台（建议 Telegram 或飞书，官方 API） | 中 |
| 4 | 控制台增加平台维度与独立配置 | 中 |

> 本次**未实施**，因为需要改动核心链路，且当前线上正在使用；建议在独立分支完成并用测试验证后再上线。

---

## 第十六章 性能、稳定性与安全优化

### 16.1 当前实测指标（2026-10-19 02:10）

| 指标 | 数值 |
|---|---|
| 运行时长 | 1 小时 42 分 |
| 重启次数 | 0 |
| Node RSS | 214 MB |
| NapCat 内存 | 178 MB |
| 系统内存 | 已用 718 MB / 1736 MB，可用 861 MB |
| Swap | 已用 129 MB / 4095 MB |
| 磁盘 | 12 GB / 40 GB |

### 16.2 已生效的稳定性措施

- systemd `Restart=always` + `RestartSec=5`；
- `NODE_OPTIONS=--max-old-space-size=640` 限制堆；
- `hotReload=false` 消除内存泄漏；
- Docker `restart=unless-stopped`；
- NapCat `ACCOUNT` 参数实现重启快速登录；
- 4GB swap 兜底。

### 16.3 仍存在的风险

| 风险 | 说明 | 建议 |
|---|---|---|
| 2G 内存 | 高峰期可能 swap | 不加其他服务；必要时升配 |
| 控制台无认证 | 仅本机 | 公网访问必须加 Nginx+HTTPS+Basic Auth |
| 单点故障 | 服务器/账号 | 定期备份；QQ 小号 |
| 日志无轮转配置 | 依赖 journald 默认策略 | 定期 `journalctl --vacuum-time=14d` |
| 凭据明文 | `data/config.json` | 权限 600；定期轮换 Key |

---

## 第十七章 后续优化路线图

| 优先级 | 任务 | 目标 | 收益 | 难度 | 前置条件 | 风险 |
|---|---|---|---|---|---|---|
| P0 | 更换泄露过的 DeepSeek Key | 安全 | 高 | 低 | 无 | 需短暂重启 |
| P0 | 控制台访问认证 | 安全 | 高 | 中 | 域名或内网方案 | 配置错误会锁死访问 |
| P1 | 日志页/仪表盘 | 可观测 | 高 | 中 | 无 | 低 |
| P1 | 会话归档与清理策略 | 磁盘/启动 | 中 | 低 | 备份 | 误删风险 |
| P1 | 配置校验 | 稳定性 | 中 | 中 | 无 | 低 |
| P2 | Adapter 抽象 + 第二平台 | 扩展 | 高 | 高 | 测试 | 中 |
| P2 | 自动化测试/CI | 质量 | 中 | 中 | GitHub Actions | 低 |
| P3 | 多平台统一控制台 | 体验 | 中 | 高 | 平台接入完成 | 中 |

---

## 第十八章 日常维护速查表

| 场景 | 命令/操作 |
|---|---|
| 看是否在线 | `systemctl is-active qq-agent`；`curl -s http://127.0.0.1:3210/api/status` |
| 重启机器人 | `systemctl restart qq-agent` |
| 重启 QQ 端 | `docker restart napcat` |
| 实时日志 | `journalctl -u qq-agent -f` |
| 最近错误 | `journalctl -u qq-agent -n 100 --no-pager \| grep -i error` |
| 看内存 | `free -h`；`docker stats --no-stream` |
| 备份数据 | `/opt/qq-agent/scripts/backup.sh` |
| 改配置 | 编辑 `data/config.json` → 校验 → 重启 |
| 打开控制台 | 双击桌面 `打开QQ机器人控制台.bat` |
| 看仓库 | https://github.com/tamsuishore-star/qq-agent-linux-public |

---

## 第十九章 术语解释

| 术语 | 通俗解释 |
|---|---|
| systemd | Linux 的“服务管家”，负责开机自启、崩溃重启、日志收集 |
| OneBot v11 | 一套 QQ 机器人通信协议；NapCat 按它提供接口，本项目按它收发消息 |
| NapCat | 运行 Linux QQ 并对外提供 OneBot 接口的第三方程序（本项目用 Docker 跑） |
| Webhook | 平台把事件“推”到你指定的 HTTPS 地址 |
| Adapter（适配器） | 把不同平台的消息翻译成统一格式的中间层 |
| Plugin / Skill | 插件是横切能力（如复读、记忆），技能是具体玩法（如点歌、生图） |
| Token | 大模型计费单位；也指登录令牌，注意上下文 |
| SSE | 服务器单向推送事件，控制台实时刷新用它 |
| swap | 磁盘上的“虚拟内存”，内存不够时兜底，但速度慢 |
| RSS | 进程实际占用的物理内存 |

---

## 第二十章 附录

### 20.1 目录结构（生产）

```
/opt/qq-agent
├── src/               核心代码
├── ui/                控制台前端
├── skills/            技能（23 个目录）
├── plugins/           插件（21 个）
├── assets/            图标
├── electron/          上游桌面入口（Linux 不用）
├── node_modules/      依赖
├── data/              运行数据（配置/记忆/会话/日志，禁止入库）
├── docs/              本文档
├── package.json
└── README.md
```

### 20.2 关键外部依赖

| 依赖 | 用途 | 位置 |
|---|---|---|
| Node.js 20 | 运行时 | `/opt/node20` |
| NapCat | QQ 接入 | Docker 容器 `napcat` |
| AI API | 回复生成 | `data/config.json` |
| 宝塔面板 | 服务器管理 | 端口 28817（带安全入口） |

### 20.3 参考链接（核查日期 2026-10-19）

- 上游项目：https://github.com/K0nd1us/QQ-agent
- 本项目仓库：https://github.com/tamsuishore-star/qq-agent-linux-public
- QQ 官方机器人：https://bot.q.qq.com/wiki/bot_new_product-intro/
- 企业微信开发文档：https://developer.work.weixin.qq.com/document/
- Wechaty PadLocal：https://wechaty.readthedocs.io/zh-cn/latest/introduction/use-padlocal-protocol/
- Telegram Bot API：https://core.telegram.org/bots/api
- 飞书开放平台：https://open.feishu.cn/document/
- 钉钉开放平台：https://open.dingtalk.com/document/
- Discord 开发者：https://discord.com/developers/docs

> 外部平台能力与政策可能调整，接入前请以官方最新文档为准；本文不构成对第三方平台可用性的保证。

---

*文档结束。若后续修改了代码或配置，请在本文件“第十一章 本次实际优化记录”下追加记录，保持唯一文档。*
