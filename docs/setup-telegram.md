# Set up Telegram

Telegram is the simplest channel: no review, no public URL.

## 1. Create a bot

1. In Telegram open **@BotFather** and send `/newbot`. Pick a name and a username ending in `bot`.
2. BotFather replies with the bot token, for example `123456:ABC-DEF...`. Set it as `TELEGRAM_BOT_TOKEN`.

No permissions or review are involved. The token is the only credential.

## 2. Start the server

```bash
TELEGRAM_BOT_TOKEN=123456:ABC... npx -y messaging-mcp
```

By default the server uses **long polling** (`getUpdates`): it asks Telegram for new messages, so nothing needs to be reachable from the internet. On start it removes any webhook registered for the bot (Telegram does not allow polling and a webhook at the same time). Only one process may read a bot's updates; a second one gets HTTP 409.

## 3. Let people write to the bot

A bot can only message people who started a conversation with it (opened the bot and pressed Start, or sent a message). Share the link `https://t.me/<your_bot_username>`. Telegram keeps updates for about 24 hours, so a short downtime is recovered when polling resumes.

In groups the bot only sees all messages if group privacy is disabled in BotFather (`/setprivacy`) or it is an admin. The conversation id of a group is the group's chat id.

## Optional: webhook instead of polling

If you prefer pushes (for example on a server that is always on and already has a public HTTPS URL):

```bash
messaging-mcp --webhook-port 8787 --telegram-webhook https://your.host
```

The server registers `https://your.host/webhooks/telegram` with `setWebhook`, with a secret token (set `TELEGRAM_WEBHOOK_SECRET`, or one is derived from the bot token) that it checks on every delivery. Your reverse proxy must forward that path to the webhook port.

## Rules

There is no reply window on Telegram once the user has started the bot. Telegram asks bots to stay under about one message per second in a single chat, 20 per minute in a group, and about 30 per second overall for bulk notifications. `get_rules` shows the cited numbers. When Telegram answers with HTTP 429 and `retry_after`, the server waits (up to 10 seconds) and retries that one request once, then reports the error.
