#!/bin/sh
# Try it without keys:
claude mcp add messaging-demo -- npx -y messaging-mcp --demo

# Your own channels (add only the ones you use):
claude mcp add messaging \
  --env TELEGRAM_BOT_TOKEN=replace-me \
  --env WHATSAPP_ACCESS_TOKEN=replace-me \
  --env WHATSAPP_PHONE_NUMBER_ID=replace-me \
  -- npx -y messaging-mcp

# Read only (the send tools are not registered at all):
# claude mcp add messaging-ro --env TELEGRAM_BOT_TOKEN=replace-me -- npx -y messaging-mcp --read-only
