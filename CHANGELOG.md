# Changelog

## 0.1.0 - 2026-11-26

First release.

- MCP server (stdio) for WhatsApp Cloud API, Instagram, Messenger and Telegram, using the official APIs.
- Tools: `list_channels`, `list_conversations`, `get_conversation`, `search_messages`, `can_message`, `send_message`, `send_whatsapp_template`, `list_whatsapp_templates`, `mark_read`, `get_rules`.
- Rule checks before every send (reply window, message tags, length limits) with the reason and alternatives when a message is refused.
- Incoming messages: Telegram long polling or webhook, Meta webhook receiver with signature verification.
- Local storage on `node:sqlite` with a JSON file fallback.
- `--demo` mode with sample conversations on all four channels, `--read-only` mode without send tools.
- X is not supported in this version.
