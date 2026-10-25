# AI生图 · ai-image

面向 [QQ-agent](https://github.com/K0nd1us/QQ-agent) 的图片生成技能，支持文生图和图生图，并将结果直接发送到当前群聊或私聊。

## 安装与配置

将合集中的 `skills/ai-image/` 整个目录复制到 QQ-agent 的 `skills/` 下，或在仓库根目录执行 `npm run pack:extension -- ai-image` 后导入生成的 ZIP。压缩包根目录直接包含 `skill.json`、`index.js` 和 `lib/`，符合市场打包格式。首次安装按宿主的热重载设置加载。

在控制台的「AI生图」设置中填写：

| 配置 | 用途 |
| --- | --- |
| `baseUrl` | 必填，图片 API 前缀，如 `https://example.com/v1` |
| `apiKey` | 必填，密码字段，使用 Bearer 认证 |
| `model` | 默认 `gpt-image-1`，按服务商支持情况修改 |
| `editModel` | 可选，单独指定图生图模型；留空复用 `model` |

支持纯域名、API 前缀以及完整的 `/images/generations`、`/images/edits` 地址。纯域名自动补 `/v1`；其他路径按原样保留为前缀，例如 `https://example.com/proxy/v1`。不要填聊天接口地址。需要 **OpenAI images 兼容接口**：文生图为 JSON POST，图生图为上传单张参考图的 multipart POST；仅支持 chat/completions 的服务不能直接使用。

初次没有配置时，技能同步显示缺少 Base URL/API Key 的原因。修改配置后下一次调用生效，无需重新加载代码。

## 使用

- 文生图：「画一张雨夜城市街景，赛博朋克风格」。
- 图生图：先发参考图，再说「保留这张图的人物姿势，把背景换成雪山」。
- 指定图片：「把消息 #12345 的第 2 张图改成水彩风」。

注册 `gen` 与 `edit` 两个工具（实际名称前缀为 `ai-image__`）。每次生成 1~4 张，支持可选尺寸。参考图支持 PNG/JPEG/WebP；图片格式、数量、尺寸和参数最终以服务商及模型为准。

图生图优先使用明确指定的消息或本轮触发消息中的图片。自动回看最近 30 条记录时，会按本轮触发批的本地消息序号或时间边界排除后来新发的图片。QQ 图片链接过期时，会尝试协议端提供的其他地址或本地文件。

图片先下载或解码、检查体积与格式，再保存到系统临时目录 `qq-agent-ai-image`，经 `ctx.sender` 发到当前会话。本地路径发送有 `dataUrl` 回退；缓存失败时仍可发送。缓存保留最新 20 张，一小时内文件暂不清理以保护并发发送。会话历史与限频、去重由 QQ-agent 的发送器负责。

API Key 不写入源码，不发送给参考图或结果图的下载地址。默认关闭生成重试；可选重试仅针对 HTTP 429，不能据此保证服务商不计费。图片下载遇到网络故障可以重试一次，生成超时、5xx、断连和发送失败都不会再次调用生成接口。

## 停用、中止与更新

停用、卸载或重载技能会中断在途 HTTP 请求和重试等待，并阻止旧操作继续提交生成或发送图片。再次启用不会恢复旧操作。已经被服务商受理的请求仍可能计费。

工具会在生成、下载和发送边界检查可见的会话结束状态。已核对的 QQ Agent API v1 没有向技能传递会话取消信号；用户按“中止”时，等待工具返回期间的状态仍可能是 `running`，因此技能无法立即获知这个按钮操作。已经交给宿主发送队列的消息也无法由技能撤回；彻底支持即时中止需要宿主提供取消接口。

配置修改下一次调用生效。宿主热重载只重新导入入口，Node.js 会缓存静态导入的子模块；修改 `lib/` 后应重启 QQ Agent，确保加载新代码。

额外请求字段 `extraBody` 必须是合法 JSON 对象，不能覆盖模型、提示词、图片和数量等核心字段。

## 开发与验证

Node.js 20 或以上，无第三方运行时依赖。以下命令在合集仓库根目录执行。

```text
npm test -- ai-image
npm run test:audit
npm run pack:extension -- ai-image
```

测试使用本地模拟 HTTP 服务和 QQ-agent 上下文，覆盖 JSON/multipart、参考图定位、热更新、图片下载与解码、超时、体积限制、部分失败和密钥脱敏；不需要真实 API Key，也不调用付费接口。真实服务商、模型和 QQ 发送需配置后验证。

`test:audit` 是本项目的清单与工具契约检查，不等于 QQ-agent 全仓审计。安装进 QQ-agent 源码仓库后可再运行其官方 `npm run test:audit`。

本技能在 `qq-agent-extensions` 合集中维护，使用仓库根目录的 Git。

开发依据：[skill-development.md](https://github.com/K0nd1us/QQ-agent/blob/main/doc/extend_development/skill-development.md)、[skill-reference.md](https://github.com/K0nd1us/QQ-agent/blob/main/doc/extend_development/skill-reference.md)、[snowluma-capabilities.md](https://github.com/K0nd1us/QQ-agent/blob/main/doc/extend_development/snowluma-capabilities.md)；并核对上游 `sender.js`、`store.js` 的当前实现。
