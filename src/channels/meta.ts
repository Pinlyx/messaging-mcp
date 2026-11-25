import { GRAPH_VERSION } from '../constants.js';
import { MessagingError } from '../errors.js';
import type { InstagramConfig, MessengerConfig, WhatsAppConfig } from '../config.js';
import type { ChannelAdapter, SendInput, SendResult, TemplateInfo, TemplateSendInput } from './adapter.js';
import { mapGraphError, requestJson, type FetchLike } from './http.js';

interface Deps {
  fetch: FetchLike;
  graphHost: string;
}

async function graphPost(deps: Deps & { token: string }, url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await requestJson(
    deps.fetch,
    url,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    [deps.token],
  );
  if (!res.ok) throw mapGraphError(res, [deps.token]);
  return (typeof res.body === 'object' && res.body !== null ? res.body : {}) as Record<string, unknown>;
}

/** WhatsApp Cloud API: POST /{phone-number-id}/messages. */
export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel = 'whatsapp' as const;
  readonly demo = false;
  readonly accountId: string;

  constructor(
    private readonly cfg: WhatsAppConfig,
    private readonly deps: Deps,
  ) {
    this.accountId = cfg.phoneNumberId;
  }

  private get base(): string {
    return `${this.deps.graphHost}/${GRAPH_VERSION}`;
  }

  /** The API wants the number in international format, digits only. */
  static normalizeNumber(to: string): string {
    return to.replace(/[^\d]/g, '');
  }

  async sendText(input: SendInput): Promise<SendResult> {
    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: WhatsAppAdapter.normalizeNumber(input.to),
      type: 'text',
      text: { preview_url: false, body: input.text },
    };
    if (input.replyToId) body.context = { message_id: input.replyToId };
    const out = await graphPost({ ...this.deps, token: this.cfg.accessToken }, `${this.base}/${this.cfg.phoneNumberId}/messages`, body);
    return pickId((out.messages as { id?: string }[] | undefined)?.[0]?.id);
  }

  async sendTemplate(input: TemplateSendInput): Promise<SendResult> {
    const template: Record<string, unknown> = { name: input.name, language: { code: input.language } };
    if (input.parameters.length > 0) {
      template.components = [{ type: 'body', parameters: input.parameters.map((text) => ({ type: 'text', text })) }];
    }
    const out = await graphPost(
      { ...this.deps, token: this.cfg.accessToken },
      `${this.base}/${this.cfg.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: WhatsAppAdapter.normalizeNumber(input.to),
        type: 'template',
        template,
      },
    );
    return pickId((out.messages as { id?: string }[] | undefined)?.[0]?.id);
  }

  async listTemplates(): Promise<TemplateInfo[]> {
    const waba = this.cfg.businessAccountId;
    if (!waba) {
      throw new MessagingError('not_configured', 'Listing templates needs WHATSAPP_BUSINESS_ACCOUNT_ID.', {
        hint: 'Set WHATSAPP_BUSINESS_ACCOUNT_ID to your WhatsApp Business Account id (not the phone number id).',
      });
    }
    const out: TemplateInfo[] = [];
    let url: string | undefined = `${this.base}/${waba}/message_templates?limit=100&fields=name,language,status,category,components`;
    for (let page = 0; url && page < 5; page++) {
      const res = await requestJson(
        this.deps.fetch,
        url,
        { method: 'GET', headers: { Authorization: `Bearer ${this.cfg.accessToken}` } },
        [this.cfg.accessToken],
      );
      if (!res.ok) throw mapGraphError(res, [this.cfg.accessToken]);
      const body = (res.body ?? {}) as { data?: Record<string, unknown>[]; paging?: { next?: string } };
      for (const t of body.data ?? []) out.push(toTemplateInfo(t));
      const next = body.paging?.next;
      // Only follow paging links that stay on the Graph host, so the token is never sent elsewhere.
      url = next && next.startsWith(`${this.deps.graphHost}/`) ? next : undefined;
    }
    return out;
  }

  async markRead(_conversationId: string, lastInboundId?: string): Promise<void> {
    if (!lastInboundId) return;
    await graphPost({ ...this.deps, token: this.cfg.accessToken }, `${this.base}/${this.cfg.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: lastInboundId,
    });
  }
}

export function toTemplateInfo(t: Record<string, unknown>): TemplateInfo {
  const components = Array.isArray(t.components) ? (t.components as Record<string, unknown>[]) : [];
  const bodyText = components.find((c) => String(c.type).toUpperCase() === 'BODY')?.text;
  const body = typeof bodyText === 'string' ? bodyText : undefined;
  const params = body ? new Set(body.match(/\{\{[^}]+\}\}/g) ?? []).size : 0;
  return {
    name: String(t.name ?? ''),
    language: String(t.language ?? ''),
    status: String(t.status ?? ''),
    ...(typeof t.category === 'string' ? { category: t.category } : {}),
    ...(body ? { body } : {}),
    parameterCount: params,
  };
}

function pickId(id: string | undefined): SendResult {
  return id ? { id } : {};
}

/** Instagram documents only recipient and message for plain replies, so messaging_type is sent there only for tagged sends. */
function sendApiBody(input: SendInput, to: string, instagram = false): Record<string, unknown> {
  const body: Record<string, unknown> = { recipient: { id: to }, message: { text: input.text } };
  if (input.replyToId) (body.message as Record<string, unknown>).reply_to = { mid: input.replyToId };
  if (input.kind === 'tag') {
    body.messaging_type = 'MESSAGE_TAG';
    body.tag = (input.tag ?? '').toUpperCase();
  } else if (!instagram) {
    body.messaging_type = 'RESPONSE';
  }
  return body;
}

/** Messenger Platform Send API: POST /{page-id}/messages. */
export class MessengerAdapter implements ChannelAdapter {
  readonly channel = 'messenger' as const;
  readonly demo = false;
  readonly accountId: string;

  constructor(
    private readonly cfg: MessengerConfig,
    private readonly deps: Deps,
  ) {
    this.accountId = cfg.pageId;
  }

  private get url(): string {
    return `${this.deps.graphHost}/${GRAPH_VERSION}/${this.cfg.pageId}/messages`;
  }

  async sendText(input: SendInput): Promise<SendResult> {
    const out = await graphPost({ ...this.deps, token: this.cfg.pageAccessToken }, this.url, sendApiBody(input, input.to));
    return pickId(out.message_id as string | undefined);
  }

  async markRead(conversationId: string): Promise<void> {
    await graphPost({ ...this.deps, token: this.cfg.pageAccessToken }, this.url, {
      recipient: { id: conversationId },
      sender_action: 'mark_seen',
    });
  }
}

/** Instagram messaging: POST /{ig-account-id}/messages (Instagram API with Instagram Login by default). */
export class InstagramAdapter implements ChannelAdapter {
  readonly channel = 'instagram' as const;
  readonly demo = false;
  readonly accountId: string;

  constructor(
    private readonly cfg: InstagramConfig,
    private readonly deps: Deps,
  ) {
    this.accountId = cfg.accountId;
  }

  private get url(): string {
    return `${this.cfg.apiHost}/${GRAPH_VERSION}/${this.cfg.accountId}/messages`;
  }

  async sendText(input: SendInput): Promise<SendResult> {
    const out = await graphPost({ ...this.deps, token: this.cfg.accessToken }, this.url, sendApiBody(input, input.to, true));
    return pickId(out.message_id as string | undefined);
  }

  async markRead(conversationId: string): Promise<void> {
    await graphPost({ ...this.deps, token: this.cfg.accessToken }, this.url, {
      recipient: { id: conversationId },
      sender_action: 'mark_seen',
    });
  }
}
