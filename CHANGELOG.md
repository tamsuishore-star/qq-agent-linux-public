# Changelog

本项目遵循语义化版本：`MAJOR.MINOR.PATCH`。
Linux QQ Agent 的产品版本从 **V1.0.0** 起算；上游 `package.json` 的 `0.4.0` 仅为源码版本号，不代表本项目版本。

## [1.1.0] — 2026-10-25

首个公开 Linux 发行版，按生产环境实际运行的 48 个模块打包。

### 新增 / 修复

- 一键安装脚本 `install.sh`：Node 20 + Docker + NapCat + systemd + 配置向导
- 公开发行包：GitHub Release tar.gz / zip、`git clone`、仓库内 `install.sh`
- Linux 无界面运行：Web 工作台 + systemd 常驻
- B 站视频转发：匿名 `buvid3` Cookie 绕过云 IP 412；视频发送支持 NapCat 挂载路径与 base64 兜底
- 唱歌：VoxCPM 503 自动重试；成功片段缓存兜底；语音 base64 发送
- peak-guard 高峰期节流、token 账本、群报表、记忆/存档等模块
- 文档：README、安装部署、安全说明、使用说明

## [Unreleased]

### 计划

- 工作台信息架构重构：总览 / 对话 / 记忆 / 能力 / 模型 / 系统
- 失效入口处理：外部服务入口统一标注“外部服务”，新增外部链接页
- Skill / 插件：启用、禁用、重载、详情、状态（物理删除暂不做）
- 稳定性：定位 `Runtime_MapGrow` 相关内存增长；增加运行观测
- 平台边界：`wmic/taskkill/explorer` 收敛到 `src/platform/`
- 工程化：最小测试（node:test）、发布流程

### 已完成（2026-10-19）

- **peak-guard 高峰期智能节流**：核心新增 `reply.gate` 能力点（`Orchestrator.onIncoming` 排会话前），插件按高峰时段 + 每群/全局每分钟预算拦截普通群聊调用；`save/strict` 额外限制 max_tokens
  - 配置：`plugins/peak-guard/plugin.json`（模式/时段/预算/豁免）
  - 自动升压：429/503、错误率、平均延迟超阈值时进入压力状态并保持（滞回），阈值可配\n  - 测试：`test/peak-guard.test.mjs` 9/9
  - 基线（生产 7 天）：输入 87.4M、缓存 76.9M、命中率 87.98%、调用 3078 次、估算成本 ¥16.62
- **界面决策（最终）**：沿用经典工作台（`/`），移除 `/next` 预览与 `ui-next/`；经典界面保留品牌、总览页、模块启停、外部链接标注等改进
- **新版工作台 `/next`（已移除）**：曾用于预览，2026-10-19 按产品所有者决定删除
  - 位置：`ui-next/`、`src/app.js`（`/next` 静态入口）
  - 验证：staging 下页面 200、CSS/JS 200
- **模块卸载链路**：
  - `GET /api/modules`（列表 + 内置清单 + 安装登记）
  - `DELETE /api/modules/:kind/:id?mode=uninstall`（停用 → 移入 `data/.trash/` → 清配置 → 注销）
  - `config/builtin-modules.json`（44 个内置快照，只允许禁用）
  - `data/modules-registry.json`（市场安装登记，只有登记过的可卸载）
  - 安全：id 校验、路径范围校验、拒绝符号链接、内置 403
  - 验证：staging fixture 卸载成功并落盘回收站；内置模块返回 403
- **基线**：标签 `v1.0.0`、分支 `develop/v1.1.0`
- **品牌（UI 显示名）**：顶栏/页面标题/启动提示改为 **TamsuiShore QQ Agent · 淡水海边**
  - 位置：`ui/index.html`
  - 说明：仅显示名，仓库名、远程地址、包名未改
- **外部服务标注**：Skill 市场、插件市场、人设广场、意见收集、官网按钮统一加“外部”徽标，并注明需联网访问 `kondius.cn`
  - 位置：`ui/index.html`、`ui/style.css`
- **隐藏 SnowLuma 页签**：Linux 版由 NapCat 接入，该页签不适用；视图代码保留，入口隐藏
  - 位置：`ui/index.html`
- **运行总览页（V1.1.0 第一个新页面）**：真实展示服务状态、QQ 连接、模型、进程内存、系统负载、技能/插件统计、今日用量
  - 后端：`GET /api/overview`（仅进程/系统指标，不含配置与密钥）
  - 前端：`ui/app/13-overview.js`、`ui/index.html`、`ui/style.css`
  - 验证：独立 staging 实例启动后 `GET /api/overview` 返回 200；页面包含 `view-overview`；语法检查通过
  - 状态：**仅在 develop 分支，未部署生产**
- **模块卡片显式开关**：卡片新增“已启用 / 已禁用”按钮，点击切换（复用 `POST /api/skills/:id`，加载失败的条目禁用）
  - 位置：`ui/app/06-settings-render.js`、`ui/style.css`
- **修复 `reply-meme`**：把嵌套目录拍平为 `skills/reply-meme/`，删除重复副本 `_1`/`_2`
  - 生产备份：`/root/qq-agent-reply-meme-backup-1792406576.tar.gz`
  - 生产验证：模块总数 44、损坏 0、`reply-meme` loaded=true
- **最小测试**：`test/manifest.test.mjs`（node:test，5 条用例），`npm test` 可执行
  - 验证：`node --test test/` → 5 pass / 0 fail
- **发现待修**：生产模块列表中有 3 个坏副本 `reply-meme` / `reply-meme_1` / `reply-meme_2`（缺少 manifest）——已在本轮修复
- **ADR**：新增 `docs/adr/0001-v1.1.0-scope-and-naming.md`，记录范围、命名、外部服务与平台边界决策
- **运维：Node 堆上限 640MB → 960MB**（缓解 OOM，见下）
  - 位置：`/etc/systemd/system/qq-agent.service.d/limits.conf`
  - 原因：2026-10-19 13:43、16:25 两次 `JavaScript heap out of memory`，V8 栈显示 `Runtime_MapGrow`，判断存在持续累积的数据结构
  - 验证：重启后 `active`、OneBot `connected:true`，RSS 约 286MB
  - 回滚：把该值改回 `640`，`systemctl daemon-reload && systemctl restart qq-agent`
  - 遗留：根因未定位，960MB 只是缓冲；需在后续版本用堆快照/内存观测继续排查

## [1.0.0] — 2026-10-19

首个可运行、可回滚的 Linux 部署基线。

- 仓库：`tamsuishore-star/qq-agent-linux-public`，标签 `v1.0.0`，提交 `a2f08e8`
- 运行：Ubuntu 22.04 / Node 20 / systemd / NapCat（Docker，OneBot v11）
- 功能：私聊、群聊、@/上下文插话、`/退出` 静默、AI 回复、人设、记忆、语音、表情、插件与技能
- 数据：人设与记忆迁移完成；`data/` 不入库
- 文档：`docs/Linux_QQ机器人使用说明与优化指南.md`
- 已知问题：2GB 内存偏紧；控制台无认证；无自动化测试
