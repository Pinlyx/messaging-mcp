#!/usr/bin/env node
import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildApp } from './app.js';
import { HELP, parseArgs } from './config.js';
import { createMcpServer } from './server.js';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    err(`messaging-mcp: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  if (parsed.kind === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (parsed.kind === 'version') {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  const { config } = parsed;
  const app = buildApp(config);
  await app.start();

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await app.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (config.stdio) {
    const server = createMcpServer(app.service, pkg.version);
    const transport = new StdioServerTransport();
    transport.onclose = () => void shutdown();
    process.stdin.on('end', () => void shutdown());
    await server.connect(transport);
    err(
      `messaging-mcp ${pkg.version} ready (${config.demo ? 'demo mode' : 'live'}${config.readOnly ? ', read-only' : ''}, store: ${app.store.kind})`,
    );
  } else {
    err(`messaging-mcp ${pkg.version} running without MCP (--no-stdio). Press Ctrl+C to stop.`);
  }
}

main().catch((e) => {
  err(`messaging-mcp: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
