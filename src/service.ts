import { canMessage, getChannel, listChannels, validateMessage } from 'messaging-rules';
import type { CanMessageResult, ChannelRules, Problem } from 'messaging-rules';
import type { ChannelAdapter, TemplateInfo } from './channels/adapter.js';
import { MessagingError } from './errors.js';
import { CHANNEL_IDS, type ChannelId, type ConversationSummary, type Store, type StoredMessage } from './types.js';

export interface ServiceDeps {
  store: Store;
  adapters: ReadonlyMap<ChannelId, ChannelAdapter>;
  readOnly: boolean;
  demo: boolean;
  now?: () => number;
}

const PREVIEW = 140;

function preview(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text.length > PREVIEW ? `${text.slice(0, PREVIEW - 1)}…` : text;
}

function windowStatus(r: CanMessageResult) {
  return {
    allowed: r.allowed,
    reason: r.reason,
    ...(r.windowEndsAt ? { window_ends_at: r.windowEndsAt } : {}),
    conditions: r.conditions,
    alternatives: r.allowedAlternatives.map((a) => ({
      kind: a.kind,
      ...(a.tag ? { tag: a.tag } : {}),
      description: a.description,
      ...(a.windowEndsAt ? { window_ends_at: a.windowEndsAt } : {}),
      conditions: a.conditions,
    })),
    sources: r.sources,
  };
}

function problemOut(p: Problem) {
  return { code: p.code, severity: p.severity, field: p.field, message: p.message };
}

function messageOut(m: StoredMessage) {
  return {
    message_id: m.externalId ?? `local:${m.id}`,
    direction: m.direction,
    at: m.timestamp,
    ...(m.text !== undefined ? { text: m.text } : {}),
    ...(m.attachments.length
      ? { attachments: m.attachments.map((a) => ({ type: a.type, ...(a.name ? { name: a.name } : {}), ...(a.mime ? { mime: a.mime } : {}) })) }
      : {}),
    ...(m.demo ? { demo: true } : {}),
  };
}

export type Sender = 'bot' | 'human';

export interface SendArgs {
  channel: ChannelId;
  conversationId: string;
  text: string;
  kind?: 'free_form' | 'tag';
  tag?: string;
  sender?: Sender;
  replyToMessageId?: string;
}

export interface TemplateArgs {
  conversationId: string;
  name: string;
  language: string;
  parameters?: string[];
}

export class MessagingService {
  private readonly now: () => number;
  readonly readOnly: boolean;

  constructor(private readonly deps: ServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.readOnly = deps.readOnly;
  }

  private adapter(channel: ChannelId): ChannelAdapter {
    const a = this.deps.adapters.get(channel);
    if (!a) {
      throw new MessagingError('not_configured', `The ${channel} channel is not configured.`, {
        hint: `Set the ${channel} environment variables (see docs/setup-${channel === 'whatsapp' ? 'whatsapp' : channel === 'telegram' ? 'telegram' : 'instagram-messenger'}.md) or run with --demo. list_channels shows what is on.`,
      });
    }
    return a;
  }

  private check(channel: ChannelId, conv: ConversationSummary | undefined, o: { sender?: Sender; kind?: string; tag?: string } = {}): CanMessageResult {
    return canMessage({
      channel,
      lastInboundAt: conv?.lastInboundAt ?? null,
      now: this.now(),
      sender: o.sender ?? 'bot',
      ...(o.kind ? { kind: o.kind } : {}),
      ...(o.tag ? { tag: o.tag } : {}),
    });
  }

  listChannels() {
    const channels = CHANNEL_IDS.map((id) => {
      const a = this.deps.adapters.get(id);
      return {
        channel: id,
        enabled: !!a,
        ...(a
          ? {
              account: { id: a.accountId, ...(a.accountLabel ? { label: a.accountLabel } : {}) },
              mode: a.demo ? 'demo' : 'live',
              can_send: !this.readOnly,
              can_send_templates: !this.readOnly && !!a.sendTemplate,
              can_mark_read_upstream: !this.readOnly && !!a.markRead,
            }
          : {}),
      };
    });
    return {
      mode: this.deps.demo ? 'demo' : 'live',
      read_only: this.readOnly,
      store: this.deps.store.kind,
      channels,
      unsupported: [{ channel: 'x', note: 'X (Twitter) is not supported in v0.1: its messaging API is paid.' }],
    };
  }

  listConversations(a: { channel?: ChannelId; unreadOnly?: boolean; query?: string; limit?: number; offset?: number }) {
    const limit = Math.min(Math.max(a.limit ?? 20, 1), 100);
    const offset = Math.max(a.offset ?? 0, 0);
    const { total, items } = this.deps.store.listConversations({
      ...(a.channel ? { channel: a.channel } : {}),
      ...(a.unreadOnly ? { unreadOnly: true } : {}),
      ...(a.query ? { query: a.query } : {}),
      limit,
      offset,
    });
    return {
      total,
      offset,
      count: items.length,
      has_more: offset + items.length < total,
      conversations: items.map((c) => {
        const w = this.check(c.channel, c);
        return {
          channel: c.channel,
          conversation_id: c.id,
          ...(c.name ? { name: c.name } : {}),
          ...(c.username ? { username: c.username } : {}),
          unread: c.unread,
          last_message_at: c.lastMessageAt,
          last_message_direction: c.lastMessageDirection,
          ...(c.lastMessageText !== undefined ? { last_message_preview: preview(c.lastMessageText) } : {}),
          can_reply_now: w.allowed,
          ...(w.windowEndsAt ? { reply_window_ends_at: w.windowEndsAt } : {}),
        };
      }),
    };
  }

  getConversation(a: { channel: ChannelId; conversationId: string; limit?: number; before?: string }) {
    const conv = this.deps.store.getConversation(a.channel, a.conversationId);
    if (!conv) {
      throw new MessagingError('invalid_input', `No conversation ${a.conversationId} on ${a.channel}.`, {
        hint: 'Use list_conversations to find a conversation_id. Only conversations this server has seen are stored.',
      });
    }
    const limit = Math.min(Math.max(a.limit ?? 30, 1), 100);
    const messages = this.deps.store.getMessages(a.channel, a.conversationId, { limit, ...(a.before ? { before: a.before } : {}) });
    const w = this.check(a.channel, conv);
    return {
      channel: a.channel,
      conversation_id: conv.id,
      ...(conv.name ? { name: conv.name } : {}),
      ...(conv.username ? { username: conv.username } : {}),
      unread: conv.unread,
      last_inbound_at: conv.lastInboundAt,
      can_message_now: windowStatus(w),
      messages: messages.map(messageOut),
      ...(messages.length === limit ? { note: 'There may be older messages. Pass before=<oldest at> to page back.' } : {}),
    };
  }

  searchMessages(a: { query: string; channel?: ChannelId; limit?: number }) {
    const limit = Math.min(Math.max(a.limit ?? 20, 1), 100);
    const hits = this.deps.store.searchMessages({ query: a.query, ...(a.channel ? { channel: a.channel } : {}), limit });
    return {
      count: hits.length,
      results: hits.map((h) => ({
        channel: h.message.channel,
        conversation_id: h.message.conversationId,
        ...(h.conversationName ? { name: h.conversationName } : {}),
        ...messageOut(h.message),
      })),
    };
  }

  canMessage(a: { channel: ChannelId; conversationId: string; kind?: string; tag?: string; sender?: Sender }) {
    const conv = this.deps.store.getConversation(a.channel, a.conversationId);
    const r = this.check(a.channel, conv, a);
    return {
      channel: a.channel,
      conversation_id: a.conversationId,
      conversation_known: !!conv,
      last_inbound_at: conv?.lastInboundAt ?? null,
      ...windowStatus(r),
    };
  }

  async sendMessage(a: SendArgs) {
    this.assertCanSend();
    const adapter = this.adapter(a.channel);
    const kind = a.kind ?? 'free_form';
    const sender = a.sender ?? 'bot';
    if (kind === 'tag' && !a.tag) throw new MessagingError('invalid_input', 'kind "tag" needs a tag, for example HUMAN_AGENT.');
    if (a.text.trim() === '') throw new MessagingError('invalid_input', 'text is empty.');

    const validation = validateMessage(a.channel, { text: a.text });
    const errors = validation.problems.filter((p) => p.severity === 'error');
    if (errors.length > 0) {
      return {
        sent: false,
        blocked_by: 'validation',
        reason: errors.map((p) => p.message).join(' '),
        problems: validation.problems.map(problemOut),
      };
    }

    const conv = this.deps.store.getConversation(a.channel, a.conversationId);
    const decision = this.check(a.channel, conv, { sender, kind, ...(a.tag ? { tag: a.tag } : {}) });
    if (!decision.allowed) {
      const status = windowStatus(decision);
      const humanOnly =
        sender === 'bot'
          ? windowStatus(this.check(a.channel, conv, { sender: 'human' })).alternatives.filter(
              (h) => !status.alternatives.some((b) => b.kind === h.kind && b.tag === h.tag),
            )
          : [];
      return {
        sent: false,
        blocked_by: 'platform_rules',
        reason: decision.reason,
        window_ends_at: decision.windowEndsAt,
        can_message_now: status,
        ...(humanOnly.length ? { only_if_a_person_sends_it_manually: humanOnly } : {}),
        ...(a.channel === 'whatsapp'
          ? {
              suggestion: {
                tool: 'send_whatsapp_template',
                note: 'Outside the 24 hour window WhatsApp only accepts an approved template. Call list_whatsapp_templates, then send_whatsapp_template.',
              },
            }
          : {}),
      };
    }

    const result = await adapter.sendText({
      to: a.conversationId,
      text: a.text,
      kind,
      ...(a.tag ? { tag: a.tag } : {}),
      ...(a.replyToMessageId ? { replyToId: a.replyToMessageId } : {}),
    });
    const at = new Date(this.now()).toISOString();
    this.deps.store.addMessage({
      channel: a.channel,
      conversationId: a.conversationId,
      ...(result.id ? { externalId: result.id } : {}),
      direction: 'out',
      timestamp: at,
      text: a.text,
      attachments: [],
      ...(result.demo ? { demo: true } : {}),
    });
    return {
      sent: true,
      channel: a.channel,
      conversation_id: a.conversationId,
      ...(result.id ? { message_id: result.id } : {}),
      sent_at: at,
      ...(decision.conditions.length ? { conditions_to_respect: decision.conditions } : {}),
      ...(result.demo ? { demo: true, note: 'DEMO: nothing was delivered.' } : {}),
    };
  }

  async sendWhatsAppTemplate(a: TemplateArgs) {
    this.assertCanSend();
    const adapter = this.adapter('whatsapp');
    if (!adapter.sendTemplate) throw new MessagingError('invalid_input', 'This WhatsApp adapter cannot send templates.');
    const conv = this.deps.store.getConversation('whatsapp', a.conversationId);
    const decision = this.check('whatsapp', conv, { kind: 'template' });
    if (!decision.allowed) {
      return { sent: false, blocked_by: 'platform_rules', reason: decision.reason, can_message_now: windowStatus(decision) };
    }
    const parameters = a.parameters ?? [];
    const result = await adapter.sendTemplate({ to: a.conversationId, name: a.name, language: a.language, parameters });
    const at = new Date(this.now()).toISOString();
    this.deps.store.addMessage({
      channel: 'whatsapp',
      conversationId: a.conversationId,
      ...(result.id ? { externalId: result.id } : {}),
      direction: 'out',
      timestamp: at,
      text: `[template ${a.name} / ${a.language}]${parameters.length ? ` ${parameters.join(' | ')}` : ''}`,
      attachments: [],
      ...(result.demo ? { demo: true } : {}),
    });
    return {
      sent: true,
      channel: 'whatsapp',
      conversation_id: a.conversationId,
      template: a.name,
      language: a.language,
      ...(result.id ? { message_id: result.id } : {}),
      sent_at: at,
      conditions_to_respect: decision.conditions,
      ...(result.demo ? { demo: true, note: 'DEMO: nothing was delivered.' } : {}),
    };
  }

  async listWhatsAppTemplates(a: { onlyApproved?: boolean } = {}) {
    const adapter = this.adapter('whatsapp');
    if (!adapter.listTemplates) throw new MessagingError('invalid_input', 'This WhatsApp adapter cannot list templates.');
    const all: TemplateInfo[] = await adapter.listTemplates();
    const list = a.onlyApproved === false ? all : all.filter((t) => t.status.toUpperCase() === 'APPROVED');
    return {
      count: list.length,
      templates: list.map((t) => ({
        name: t.name,
        language: t.language,
        status: t.status,
        ...(t.category ? { category: t.category } : {}),
        ...(t.body ? { body: t.body } : {}),
        parameter_count: t.parameterCount,
      })),
      note: 'Pass the body parameters in order to send_whatsapp_template. Templates with header or button parameters are not supported in v0.1.',
    };
  }

  async markRead(a: { channel: ChannelId; conversationId: string }) {
    const conv = this.deps.store.getConversation(a.channel, a.conversationId);
    if (!conv) throw new MessagingError('invalid_input', `No conversation ${a.conversationId} on ${a.channel}.`);
    const adapter = this.adapter(a.channel);
    this.deps.store.markRead(a.channel, a.conversationId);
    let upstream: 'sent' | 'not_supported' | 'skipped_read_only' | 'skipped_demo' = 'not_supported';
    if (adapter.markRead) {
      if (this.readOnly) upstream = 'skipped_read_only';
      else if (adapter.demo) upstream = 'skipped_demo';
      else {
        await adapter.markRead(a.conversationId, conv.lastInboundExternalId);
        upstream = 'sent';
      }
    }
    return {
      channel: a.channel,
      conversation_id: a.conversationId,
      local_unread_cleared: true,
      read_receipt: upstream,
      ...(upstream === 'not_supported' ? { note: `${a.channel} has no read receipt for bots; only the local unread counter was cleared.` } : {}),
    };
  }

  getRules(a: { channel?: ChannelId | 'x'; section?: string }) {
    const summary = (ch: ChannelRules) => ({ id: ch.id, name: ch.name, api: ch.api, verified: ch.verified, summary: ch.summary });
    if (!a.channel) return { channels: listChannels().map(summary) };
    const ch = getChannel(a.channel);
    if (!ch) throw new MessagingError('invalid_input', `Unknown channel "${a.channel}".`);
    const section = a.section ?? 'all';
    if (section === 'all') return ch;
    if (section === 'summary') return summary(ch);
    if (!(section in ch)) throw new MessagingError('invalid_input', `Unknown section "${section}".`);
    return { id: ch.id, verified: ch.verified, [section]: (ch as unknown as Record<string, unknown>)[section] };
  }

  private assertCanSend(): void {
    if (this.readOnly) throw new MessagingError('read_only', 'This server runs with --read-only, so sending is disabled.');
  }
}
