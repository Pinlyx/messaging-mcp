import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createMcpServer } from '../src/server.js';
import { baseConfig, mockFetch } from './helpers.js';

const SEND_TOOLS = ['send_message', 'send_whatsapp_template'];
const READ_TOOLS = ['list_channels', 'list_conversations', 'get_conversation', 'search_messages', 'can_message', 'mark_read', 'get_rules', 'list_whatsapp_templates'];

const open: Client[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});

async function connect(readOnly: boolean) {
  const app = buildApp(baseConfig({ demo: true, readOnly }), { fetch: mockFetch().fetch, log: () => undefined });
  const server = createMcpServer(app.service, '0.1.0');
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  open.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { text: string }[])[0]?.text ?? '';
  return { isError: res.isError === true, data: JSON.parse(text) as Record<string, any> };
}

describe('MCP tools', () => {
  it('registers read and send tools by default', async () => {
    const client = await connect(false);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.sort()).toEqual([...READ_TOOLS, ...SEND_TOOLS].sort());
  });

  it('registers no send tool in read-only mode', async () => {
    const client = await connect(true);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.sort()).toEqual([...READ_TOOLS].sort());
    for (const t of SEND_TOOLS) expect(names).not.toContain(t);
    const res = await client.callTool({ name: 'send_message', arguments: { channel: 'telegram', conversation_id: '1', text: 'x' } }).catch((e: Error) => e);
    expect(res instanceof Error || (res as { isError?: boolean }).isError === true).toBe(true);
  });

  it('describes every tool and marks send tools as non read-only', async () => {
    const client = await connect(false);
    const tools = (await client.listTools()).tools;
    for (const t of tools) expect((t.description ?? '').length).toBeGreaterThan(40);
    expect(tools.find((t) => t.name === 'send_message')?.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === 'list_conversations')?.annotations?.readOnlyHint).toBe(true);
  });

  it('validates input with the schema', async () => {
    const client = await connect(false);
    const bad = await client.callTool({ name: 'list_conversations', arguments: { channel: 'fax' } }).catch((e: Error) => e);
    expect(bad instanceof Error || (bad as { isError?: boolean }).isError === true).toBe(true);
  });

  it('runs the demo flow end to end', async () => {
    const client = await connect(false);
    expect((await call(client, 'list_channels')).data.mode).toBe('demo');
    const list = await call(client, 'list_conversations', { channel: 'whatsapp', unread_only: true });
    expect(list.data.conversations.length).toBeGreaterThan(0);
    const closed = await call(client, 'send_message', { channel: 'whatsapp', conversation_id: '4915112340002', text: 'Hallo' });
    expect(closed.isError).toBe(false);
    expect(closed.data).toMatchObject({ sent: false, suggestion: { tool: 'send_whatsapp_template' } });
    const open = await call(client, 'send_message', { channel: 'telegram', conversation_id: '700000001', text: 'Settings, then Subscription.' });
    expect(open.data).toMatchObject({ sent: true, demo: true });
    expect((await call(client, 'can_message', { channel: 'instagram', conversation_id: '17841400000000002' })).data.allowed).toBe(false);
    expect((await call(client, 'search_messages', { query: 'subscription' })).data.count).toBe(1);
    expect((await call(client, 'mark_read', { channel: 'telegram', conversation_id: '700000001' })).data.local_unread_cleared).toBe(true);
    expect((await call(client, 'get_rules', { channel: 'telegram', section: 'summary' })).data.id).toBe('telegram');
  });

  it('returns structured errors as tool errors', async () => {
    const client = await connect(false);
    const r = await call(client, 'get_conversation', { channel: 'telegram', conversation_id: 'does-not-exist' });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatchObject({ code: 'invalid_input' });
  });
});
