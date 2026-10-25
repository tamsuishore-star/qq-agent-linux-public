---
name: ai-image
description: 在 QQ-agent 中通过兼容 images API 的服务执行文生图或图生图；用户要求画图、按参考图修改或转换风格时使用。
metadata:
  author: nuoxi4n
  version: 1.0.0
---

# AI生图

这是 QQ-agent 的 LLM 型技能，运行入口为 `skill.json` + `index.js`。
本文件说明使用方式；QQ-agent 通过 `setup()` 注册工具并加载动态提示词。

## 配置

在 QQ-agent 控制台「AI生图」设置中填写 `baseUrl` 和 `apiKey`。
`model` 默认 `gpt-image-1`，应改为服务商实际提供的图片模型；图生图需要模型支持 `/images/edits`。
需要单独的编辑模型时填写 `editModel`，否则复用 `model`。
不要在聊天参数或提示词里传递 API Key。

## 选择工具

- 纯文字创作：`ai-image__gen`，必填 `prompt`，可选 `size`、`count`（1~4）。
- 基于已有图片修改：`ai-image__edit`，必填 `prompt`，可选 `messageId`、`imageIndex`、`size`、`count`。
- 图生图的 `messageId` 只能引用当前会话真实存在的带图消息。`imageIndex` 从 1 开始；省略消息 id 时自动查找触发消息或最近 30 条记录中的图片，并排除本轮触发批之后的新消息。
- 用户明确指定旧图时传消息 id；多张图的指代不清时先确认，不要猜图。
- 参考图支持 PNG、JPEG、WebP。GIF 不能作为参考图。

例如「画一只趴在窗台上的橘猫，水彩风」用 `gen`；
「把消息 #12345 的第 2 张图改成水彩风，保留人物姿势」用 `edit`，传 `messageId: "12345"`、`imageIndex: 2`。

## 结果处理

工具会通过 `ctx.sender.sendImage` 直接发送图片，不要重复发图。
工具结果只含执行状态；没有查看实际图片时不要描述画面细节。
生成请求默认不自动重试。超时、断连、5xx 或发送失败时，不要自动重新生成。
发送失败的结果可能附有本地缓存路径，可用已有图片重发，避免再次调用付费生成接口。
技能停用或重载会取消旧操作。宿主尚未向工具公开会话取消信号，不能保证“中止”按钮立即打断在途工具或撤回已入发送队列的图片；不要声称已完成这种取消。

`image.generate` 和 `image.edit` 能力供其他扩展调用，返回 `{ ok, images, warnings? }`；
失败返回 `{ ok: false, error }`。每张图含标准 `dataUrl`、`filePath`、`mime`、`bytes`。
`image.edit` 的参考图参数为 `image: { buffer }`、`{ dataUrl }` 或 `{ url }`。
能力调用不会向聊天自动发送图片。
