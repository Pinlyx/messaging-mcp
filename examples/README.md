# Examples

| File | Client | Where it goes |
| --- | --- | --- |
| `claude-desktop.json` | Claude Desktop, all four channels | `claude_desktop_config.json` (Settings > Developer > Edit Config) |
| `claude-desktop-demo.json` | Claude Desktop, demo mode, no keys | same file |
| `cursor-mcp.json` | Cursor, read only | `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` |
| `claude-code.sh` | Claude Code | run the commands in a terminal |

Any other MCP client works the same way: command `npx`, arguments `-y messaging-mcp`, secrets in `env`.

Run one always-on process for webhooks and let clients read the same database:

```bash
# always on (server, systemd, pm2, docker): receives Meta webhooks and Telegram updates
META_APP_SECRET=... META_VERIFY_TOKEN=... npx -y messaging-mcp --no-stdio --webhook-port 8787

# in the MCP client: same MESSAGING_MCP_DB, does not poll or listen itself
npx -y messaging-mcp --no-ingest
```
