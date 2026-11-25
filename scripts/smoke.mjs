// Starts `node dist/index.js --demo` over stdio, connects an MCP client and calls a few tools.
// No keys, no network: demo mode never sends anything. Run `npm run build` first.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const extra = process.argv.slice(2);

const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, '--demo', ...extra], stderr: 'pipe' }));

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '';
  return { isError: res.isError === true, data: JSON.parse(text) };
}

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log(`tools (${tools.length}): ${tools.join(', ')}`);

const list = await call('list_conversations', { limit: 3 });
console.log(`list_conversations: total ${list.data.total}, first 3:`);
for (const c of list.data.conversations) {
  console.log(`  [${c.channel}] ${c.name ?? c.conversation_id} unread=${c.unread} can_reply_now=${c.can_reply_now} "${c.last_message_preview}"`);
}
assert.ok(list.data.total >= 9);

// Closed WhatsApp window: nothing is sent, the answer says why and points to templates.
const blocked = await call('send_message', { channel: 'whatsapp', conversation_id: '4915112340002', text: 'Hallo, kurze Rueckfrage zur Rechnung.' });
console.log(`send_message (whatsapp, window closed): sent=${blocked.data.sent} blocked_by=${blocked.data.blocked_by}`);
console.log(`  reason: ${blocked.data.reason}`);
console.log(`  suggestion: ${blocked.data.suggestion?.tool}`);
assert.equal(blocked.data.sent, false);
assert.equal(blocked.data.suggestion?.tool, 'send_whatsapp_template');

// Open Messenger window: accepted, marked demo.
const sent = await call('send_message', { channel: 'messenger', conversation_id: '5000000000000002', text: 'Bonjour Chloe, bien sur, quelle est la nouvelle adresse ?' });
console.log(`send_message (messenger, window open): sent=${sent.data.sent} demo=${sent.data.demo} id=${sent.data.message_id}`);
assert.equal(sent.data.sent, true);
assert.equal(sent.data.demo, true);

const conv = await call('get_conversation', { channel: 'messenger', conversation_id: '5000000000000002' });
const last = conv.data.messages.at(-1);
console.log(`get_conversation: last message is ${last.direction} demo=${last.demo}: "${last.text}"`);
assert.equal(last.direction, 'out');

await client.close();
console.log('smoke ok');
