import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MessagingError } from './errors.js';
import type { MessagingService } from './service.js';
import { CHANNEL_IDS } from './types.js';

const channel = z.enum(CHANNEL_IDS).describe('Channel: whatsapp, instagram, messenger or telegram.');
const conversationId = z
  .string()
  .min(1)
  .describe('The other party id as returned by list_conversations: phone number (WhatsApp), PSID (Messenger), IGSID (Instagram) or chat id (Telegram).');
const limit = (def: number) => z.number().int().min(1).max(100).optional().describe(`How many to return, 1 to 100. Default ${def}.`);

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  if (err instanceof MessagingError) return { content: [{ type: 'text', text: JSON.stringify(err.toJSON(), null, 2) }], isError: true };
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: JSON.stringify({ error: { code: 'internal', message } }, null, 2) }], isError: true };
}

async function run(fn: () => unknown | Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export const INSTRUCTIONS =
  'Read and answer customer conversations on WhatsApp, Instagram, Messenger and Telegram through their official APIs. ' +
  'Start with list_channels and list_conversations. Before replying, read the conversation with get_conversation: it says whether a message may be sent right now. ' +
  'send_message refuses messages the platform would reject (reply window closed) and explains why; on WhatsApp it then points to approved templates. ' +
  'Only send what the person asked you to send. Conversations marked demo are sample data and nothing is delivered.';

/** Builds the MCP server. In read-only mode the send tools are never registered. */
export function createMcpServer(service: MessagingService, version: string): McpServer {
  const server = new McpServer({ name: 'messaging-mcp', version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'list_channels',
    {
      title: 'List channels',
      description:
        'Show which channels are switched on (WhatsApp, Instagram, Messenger, Telegram), the account behind each, whether this is demo mode and whether sending is enabled.',
      inputSchema: {},
      annotations: READ,
    },
    () => run(() => service.listChannels()),
  );

  server.registerTool(
    'list_conversations',
    {
      title: 'List conversations',
      description:
        'List conversations across channels, newest first. Each row has unread count, a preview, and whether you may reply right now. Filter by channel, unread only, or a search over name, username and id.',
      inputSchema: {
        channel: channel.optional(),
        unread_only: z.boolean().optional().describe('Only conversations with unread inbound messages.'),
        query: z.string().optional().describe('Case-insensitive match on name, username or id.'),
        limit: limit(20),
        offset: z.number().int().min(0).optional().describe('Skip this many conversations (paging).'),
      },
      annotations: READ,
    },
    (a) =>
      run(() =>
        service.listConversations({
          ...(a.channel ? { channel: a.channel } : {}),
          ...(a.unread_only ? { unreadOnly: true } : {}),
          ...(a.query ? { query: a.query } : {}),
          ...(a.limit ? { limit: a.limit } : {}),
          ...(a.offset ? { offset: a.offset } : {}),
        }),
      ),
  );

  server.registerTool(
    'get_conversation',
    {
      title: 'Get conversation',
      description:
        'Read the latest messages of one conversation, oldest first, plus a "can_message_now" summary from the platform rules (window state, when it ends, allowed alternatives such as templates or tags).',
      inputSchema: {
        channel,
        conversation_id: conversationId,
        limit: limit(30),
        before: z.string().optional().describe('ISO 8601 time: only messages older than this (paging backwards).'),
      },
      annotations: READ,
    },
    (a) =>
      run(() =>
        service.getConversation({
          channel: a.channel,
          conversationId: a.conversation_id,
          ...(a.limit ? { limit: a.limit } : {}),
          ...(a.before ? { before: a.before } : {}),
        }),
      ),
  );

  server.registerTool(
    'search_messages',
    {
      title: 'Search messages',
      description: 'Full text search (case-insensitive substring) over stored messages in both directions, newest first.',
      inputSchema: { query: z.string().min(1), channel: channel.optional(), limit: limit(20) },
      annotations: READ,
    },
    (a) => run(() => service.searchMessages({ query: a.query, ...(a.channel ? { channel: a.channel } : {}), ...(a.limit ? { limit: a.limit } : {}) })),
  );

  server.registerTool(
    'can_message',
    {
      title: 'Can I message this person now?',
      description:
        'Check the platform rules for a conversation without sending: is the reply window open, when does it end, what conditions apply and what alternatives exist. Based on the last inbound message this server has seen.',
      inputSchema: {
        channel,
        conversation_id: conversationId,
        kind: z.string().optional().describe('Message kind. Default free_form. Others: template (WhatsApp), tag, private_reply.'),
        tag: z.string().optional().describe('Message tag when kind is tag, for example HUMAN_AGENT.'),
        sender: z.enum(['bot', 'human']).optional().describe('bot (automation, default) or human (a person replying manually).'),
      },
      annotations: READ,
    },
    (a) =>
      run(() =>
        service.canMessage({
          channel: a.channel,
          conversationId: a.conversation_id,
          ...(a.kind ? { kind: a.kind } : {}),
          ...(a.tag ? { tag: a.tag } : {}),
          ...(a.sender ? { sender: a.sender } : {}),
        }),
      ),
  );

  server.registerTool(
    'mark_read',
    {
      title: 'Mark conversation as read',
      description:
        'Clear the unread counter of a conversation. Where the platform supports it (WhatsApp, Messenger, Instagram) a read receipt is also sent to the customer; in read-only and demo mode only the local counter changes. Telegram has no bot read receipts.',
      inputSchema: { channel, conversation_id: conversationId },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (a) => run(() => service.markRead({ channel: a.channel, conversationId: a.conversation_id })),
  );

  server.registerTool(
    'get_rules',
    {
      title: 'Get channel rules',
      description:
        'Source-cited messaging rules (reply windows, templates, tags, length and media limits, rate limits) for a channel, or a one-line summary of every channel when no channel is given.',
      inputSchema: {
        channel: z.enum([...CHANNEL_IDS, 'x']).optional(),
        section: z
          .enum(['all', 'summary', 'initiation', 'windows', 'message_kinds', 'tags', 'limits', 'rate_limits', 'notes', 'sources'])
          .optional()
          .describe('Only this part of the rules. Default all.'),
      },
      annotations: READ,
    },
    (a) => run(() => service.getRules({ ...(a.channel ? { channel: a.channel } : {}), ...(a.section ? { section: a.section } : {}) })),
  );

  server.registerTool(
    'list_whatsapp_templates',
    {
      title: 'List WhatsApp templates',
      description:
        'List message templates of the WhatsApp Business Account (approved ones by default). Needed to message a customer outside the 24 hour window. Requires WHATSAPP_BUSINESS_ACCOUNT_ID.',
      inputSchema: { include_unapproved: z.boolean().optional().describe('Also list pending, rejected and paused templates.') },
      annotations: { ...READ, openWorldHint: true },
    },
    (a) => run(() => service.listWhatsAppTemplates({ onlyApproved: !a.include_unapproved })),
  );

  if (service.readOnly) return server;

  server.registerTool(
    'send_message',
    {
      title: 'Send message',
      description:
        'Send a text message to a conversation. The message is first checked against the channel limits and the platform rules; if the reply window is closed nothing is sent and the result says why, with alternatives (on WhatsApp: approved templates). Use kind "tag" with a tag such as HUMAN_AGENT only when a person is replying manually and sender is "human". Only send what the user asked for.',
      inputSchema: {
        channel,
        conversation_id: conversationId,
        text: z.string().min(1).describe('The message text.'),
        kind: z.enum(['free_form', 'tag']).optional().describe('free_form (default) or tag (outside the window, needs tag).'),
        tag: z.string().optional().describe('Message tag for kind tag, for example HUMAN_AGENT.'),
        sender: z.enum(['bot', 'human']).optional().describe('bot (default) or human. Say human only when a person is really sending this manually.'),
        reply_to_message_id: z.string().optional().describe('message_id from get_conversation to quote.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (a) =>
      run(() =>
        service.sendMessage({
          channel: a.channel,
          conversationId: a.conversation_id,
          text: a.text,
          ...(a.kind ? { kind: a.kind } : {}),
          ...(a.tag ? { tag: a.tag } : {}),
          ...(a.sender ? { sender: a.sender } : {}),
          ...(a.reply_to_message_id ? { replyToMessageId: a.reply_to_message_id } : {}),
        }),
      ),
  );

  server.registerTool(
    'send_whatsapp_template',
    {
      title: 'Send WhatsApp template',
      description:
        'Send an approved WhatsApp template (works outside the 24 hour window). Pass the template name, its language code and the body parameters in order. Use list_whatsapp_templates first. Marketing templates need the customer\'s opt-in.',
      inputSchema: {
        conversation_id: conversationId,
        name: z.string().min(1).describe('Template name.'),
        language: z.string().min(2).describe('Template language code, for example en_US, tr, de.'),
        parameters: z.array(z.string()).optional().describe('Body parameter values in order ({{1}}, {{2}}, ...).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (a) =>
      run(() =>
        service.sendWhatsAppTemplate({
          conversationId: a.conversation_id,
          name: a.name,
          language: a.language,
          ...(a.parameters ? { parameters: a.parameters } : {}),
        }),
      ),
  );

  return server;
}
