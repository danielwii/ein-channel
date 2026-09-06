# Telegram

## Iris Mesh 单 Bot 回复试运行

在现有 Telegram 接收端中增加消息关联，不启动第二个 Bot 轮询器。
`mesh.ts notify` 发出的通知绑定负责人、事项链接和方案版本；Daniel 回复原消息后，
程序核对配置中的 Telegram 用户和聊天身份，将原文排队投递给已登记的 Herdr Agent。
接收方通过回信接口回答，后续回复仍保持同一事项关联。

```sh
bun mesh.ts notify /absolute/path/notification.json
bun mesh.ts status
bun test mesh-bridge.test.ts
```

通知 JSON 字段：`route`、`issue`（URL）、`version`、`text`。
本机配置在 `~/.claude/channels/telegram/mesh.json`，投递记录在同目录 `mesh.sqlite`；
两者都是私有运行状态，不能提交。配置包含唯一 `user_id`、`chat_id`、本地 API 的
`api_key` 及 `routes`。每个 route 包含 `label`、`herdr`、`session`、`agent`、
`terminal_id`、`callback`，远端另含 `ssh`。发送前通过 Herdr 重新核对目标。

远端回信使用仅监听 loopback 的 SSH 反向转发，由接收进程维护，不向远端复制 Bot token。
每次投递生成仅供该次答复的 receipt；回信接口确认发送到 TG 后才返回 `sent`。
忙碌或暂时不可达的收件人每 10 秒检查一次，没有模型调用；不确定是否已投递的消息保留为
`uncertain`，不会自动重复投递。状态 `dispatched` 只表示 Herdr 接受，`replied` 表示
收件方实际调用回信接口且 TG 发送成功，不代表业务工作验收。

当前边界：只验证文字、回复明确通知、通讯测试，不执行业务变更。无关联消息继续走原来的
Claude Channel；没有实现自由点名路由、自动审批或 Hub 决策同步。进程生命周期仍由当前
Claude MCP 会话管理；本次不新增独立守护服务。目标 Agent 重建或更换后需重新核对绑定。

---

Connect a Telegram bot to your Claude Code with an MCP server.

The MCP server logs into Telegram as a bot and provides tools to Claude to reply, react, or edit messages. When you message the bot, the server forwards the message to your Claude Code session.

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.

## Quick Setup
> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

**1. Create a bot with BotFather.**

Open a chat with [@BotFather](https://t.me/BotFather) on Telegram and send `/newbot`. BotFather asks for two things:

- **Name** — the display name shown in chat headers (anything, can contain spaces)
- **Username** — a unique handle ending in `bot` (e.g. `my_assistant_bot`). This becomes your bot's link: `t.me/my_assistant_bot`.

BotFather replies with a token that looks like `123456789:AAHfiqksKZ8...` — that's the whole token, copy it including the leading number and colon.

**2. Install the plugin.**

These are Claude Code commands — run `claude` to start a session first.

Install the plugin:
```
/plugin install telegram@claude-plugins-official
```

**3. Give the server the token.**

```
/telegram:configure 123456789:AAHfiqksKZ8...
```

Writes `TELEGRAM_BOT_TOKEN=...` to `~/.claude/channels/telegram/.env`. You can also write that file by hand, or set the variable in your shell environment — shell takes precedence.

> To run multiple bots on one machine (different tokens, separate allowlists), point `TELEGRAM_STATE_DIR` at a different directory per instance.

**4. Relaunch with the channel flag.**

The server won't connect without this — exit your session and start a new one:

```sh
claude --channels plugin:telegram@claude-plugins-official
```

**5. Pair.**

With Claude Code running from the previous step, DM your bot on Telegram — it replies with a 6-character pairing code. If the bot doesn't respond, make sure your session is running with `--channels`. In your Claude Code session:

```
/telegram:access pair <code>
```

Your next DM reaches the assistant.

> Unlike Discord, there's no server invite step — Telegram bots accept DMs immediately. Pairing handles the user-ID lookup so you never touch numeric IDs.

**6. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies. Ask Claude to do it, or `/telegram:access policy allowlist` directly.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). Default policy is `pairing`. `ackReaction` only accepts Telegram's fixed emoji whitelist.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments. Images (`.jpg`/`.png`/`.gif`/`.webp`) send as photos with inline preview; other types send as documents. Max 50MB each. Auto-chunks text; files send as separate messages after the text. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to a message by ID. **Only Telegram's fixed whitelist** is accepted (👍 👎 ❤ 🔥 👀 etc). |
| `edit_message` | Edit a message the bot previously sent. Useful for "working…" → result progress updates. Only works on the bot's own messages. |

Inbound messages trigger a typing indicator automatically — Telegram shows
"botname is typing…" while the assistant works on a response.

## Photos

Inbound photos are downloaded to `~/.claude/channels/telegram/inbox/` and the
local path is included in the `<channel>` notification so the assistant can
`Read` it. Telegram compresses photos — if you need the original file, send it
as a document instead (long-press → Send as File).

## No history or search

Telegram's Bot API exposes **neither** message history nor search. The bot
only sees messages as they arrive — no `fetch_messages` tool exists. If the
assistant needs earlier context, it will ask you to paste or summarize.

This also means there's no `download_attachment` tool for historical messages
— photos are downloaded eagerly on arrival since there's no way to fetch them
later.
