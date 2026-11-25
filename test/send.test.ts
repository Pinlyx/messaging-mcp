import { describe, expect, it } from 'vitest';
import { MessagingError } from '../src/errors.js';
import { GRAPH_VERSION } from '../src/constants.js';
import { inbound, liveRig } from './helpers.js';

describe('WhatsApp requests', () => {
  it('sends a text message to /{phone-number-id}/messages with a bearer token', async () => {
    const rig = liveRig({ respond: () => ({ body: { messages: [{ id: 'wamid.OUT1' }] } }) });
    inbound(rig.store, 'whatsapp', '4915112340002', 30);
    const r = await rig.service.sendMessage({ channel: 'whatsapp', conversationId: '4915112340002', text: 'Hallo!' });
    expect(r).toMatchObject({ sent: true, message_id: 'wamid.OUT1' });
    const c = rig.calls[0]!;
    expect(c.url).toBe(`https://graph.facebook.com/${GRAPH_VERSION}/111/messages`);
    expect(c.method).toBe('POST');
    expect(c.headers.authorization).toBe('Bearer WA_TOKEN');
    expect(c.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '4915112340002',
      type: 'text',
      text: { preview_url: false, body: 'Hallo!' },
    });
    expect(c.url).not.toContain('WA_TOKEN');
    // the sent message is part of the conversation now
    expect(rig.store.getMessages('whatsapp', '4915112340002', { limit: 5 }).at(-1)).toMatchObject({ direction: 'out', externalId: 'wamid.OUT1' });
  });

  it('normalizes the phone number and quotes a message', async () => {
    const rig = liveRig({ respond: () => ({ body: { messages: [{ id: 'x' }] } }) });
    inbound(rig.store, 'whatsapp', '+49 151 1234 0002', 5);
    await rig.service.sendMessage({ channel: 'whatsapp', conversationId: '+49 151 1234 0002', text: 'ok', replyToMessageId: 'wamid.IN' });
    expect(rig.calls[0]!.body).toMatchObject({ to: '4915112340002', context: { message_id: 'wamid.IN' } });
  });

  it('sends a template with body parameters, also outside the 24h window', async () => {
    const rig = liveRig({ respond: () => ({ body: { messages: [{ id: 'wamid.T1' }] } }) });
    inbound(rig.store, 'whatsapp', '905551230001', 60 * 24 * 5);
    const r = await rig.service.sendWhatsAppTemplate({ conversationId: '905551230001', name: 'order_update', language: 'tr', parameters: ['Ayşe', '48213', 'TRK1'] });
    expect(r).toMatchObject({ sent: true, template: 'order_update' });
    expect(rig.calls[0]!.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '905551230001',
      type: 'template',
      template: {
        name: 'order_update',
        language: { code: 'tr' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ayşe' }, { type: 'text', text: '48213' }, { type: 'text', text: 'TRK1' }] }],
      },
    });
  });

  it('omits components for a template without parameters', async () => {
    const rig = liveRig({ respond: () => ({ body: { messages: [{ id: 'x' }] } }) });
    await rig.service.sendWhatsAppTemplate({ conversationId: '1555', name: 'hello_world', language: 'en_US' });
    expect((rig.calls[0]!.body as { template: object }).template).toEqual({ name: 'hello_world', language: { code: 'en_US' } });
  });

  it('lists templates from the business account and follows paging only on the Graph host', async () => {
    const rig = liveRig({
      respond: (c) => {
        if (c.url.includes('after=ok')) return { body: { data: [{ name: 'b', language: 'de', status: 'PENDING', components: [] }] } };
        return {
          body: {
            data: [{ name: 'a', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}, order {{2}}' }] }],
            paging: { next: `https://graph.facebook.com/${GRAPH_VERSION}/222/message_templates?after=ok` },
          },
        };
      },
    });
    const approved = await rig.service.listWhatsAppTemplates();
    expect(approved.templates).toEqual([expect.objectContaining({ name: 'a', parameter_count: 2, category: 'UTILITY' })]);
    expect(rig.calls[0]!.url).toContain('/222/message_templates?');
    const all = await rig.service.listWhatsAppTemplates({ onlyApproved: false });
    expect(all.count).toBe(2);

    const evil = liveRig({ respond: () => ({ body: { data: [], paging: { next: 'https://evil.example/steal' } } }) });
    await evil.service.listWhatsAppTemplates();
    expect(evil.calls).toHaveLength(1);
  });

  it('sends a read receipt for the last inbound message', async () => {
    const rig = liveRig();
    inbound(rig.store, 'whatsapp', '1555', 5);
    const r = await rig.service.markRead({ channel: 'whatsapp', conversationId: '1555' });
    expect(r).toMatchObject({ read_receipt: 'sent' });
    expect(rig.calls[0]!.body).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'in-whatsapp-1555-5' });
    expect(rig.store.getConversation('whatsapp', '1555')?.unread).toBe(0);
  });
});

describe('Messenger requests', () => {
  it('replies inside the window with messaging_type RESPONSE', async () => {
    const rig = liveRig({ respond: () => ({ body: { recipient_id: 'u1', message_id: 'm_OUT1' } }) });
    inbound(rig.store, 'messenger', 'u1', 20);
    const r = await rig.service.sendMessage({ channel: 'messenger', conversationId: 'u1', text: 'Yes we ship to Berlin' });
    expect(r).toMatchObject({ sent: true, message_id: 'm_OUT1' });
    const c = rig.calls[0]!;
    expect(c.url).toBe(`https://graph.facebook.com/${GRAPH_VERSION}/333/messages`);
    expect(c.headers.authorization).toBe('Bearer MS_TOKEN');
    expect(c.body).toEqual({ recipient: { id: 'u1' }, messaging_type: 'RESPONSE', message: { text: 'Yes we ship to Berlin' } });
  });

  it('uses MESSAGE_TAG and HUMAN_AGENT outside 24h only for a human sender', async () => {
    const rig = liveRig({ respond: () => ({ body: { message_id: 'm_OUT2' } }) });
    inbound(rig.store, 'messenger', 'u2', 60 * 24 * 3);
    const asBot = await rig.service.sendMessage({ channel: 'messenger', conversationId: 'u2', text: 'hi', kind: 'tag', tag: 'HUMAN_AGENT' });
    expect(asBot).toMatchObject({ sent: false, blocked_by: 'platform_rules' });
    expect(rig.calls).toHaveLength(0);
    const asHuman = await rig.service.sendMessage({ channel: 'messenger', conversationId: 'u2', text: 'hi', kind: 'tag', tag: 'human_agent', sender: 'human' });
    expect(asHuman).toMatchObject({ sent: true });
    expect(rig.calls[0]!.body).toEqual({ recipient: { id: 'u2' }, messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT', message: { text: 'hi' } });
  });

  it('sends mark_seen', async () => {
    const rig = liveRig();
    inbound(rig.store, 'messenger', 'u3', 5);
    await rig.service.markRead({ channel: 'messenger', conversationId: 'u3' });
    expect(rig.calls[0]!.body).toEqual({ recipient: { id: 'u3' }, sender_action: 'mark_seen' });
  });
});

describe('Instagram requests', () => {
  it('posts recipient and message to the Instagram host with the Instagram token', async () => {
    const rig = liveRig({ respond: () => ({ body: { recipient_id: 'ig1', message_id: 'aWdf_OUT' } }) });
    inbound(rig.store, 'instagram', 'ig1', 10);
    const r = await rig.service.sendMessage({ channel: 'instagram', conversationId: 'ig1', text: 'Yes, size M is back.' });
    expect(r).toMatchObject({ sent: true, message_id: 'aWdf_OUT' });
    const c = rig.calls[0]!;
    expect(c.url).toBe(`https://graph.instagram.com/${GRAPH_VERSION}/444/messages`);
    expect(c.headers.authorization).toBe('Bearer IG_TOKEN');
    expect(c.body).toEqual({ recipient: { id: 'ig1' }, message: { text: 'Yes, size M is back.' } });
  });
});

describe('Telegram requests', () => {
  it('calls sendMessage with a numeric chat id, even without a prior window limit', async () => {
    const rig = liveRig({ respond: () => ({ body: { ok: true, result: { message_id: 77 } } }) });
    inbound(rig.store, 'telegram', '700000002', 60 * 24 * 6);
    const r = await rig.service.sendMessage({ channel: 'telegram', conversationId: '700000002', text: 'Here is the list' });
    expect(r).toMatchObject({ sent: true, message_id: '700000002:77' });
    const c = rig.calls[0]!;
    expect(c.url).toBe('https://api.telegram.org/bot555:TG_SECRET/sendMessage');
    expect(c.body).toEqual({ chat_id: 700000002, text: 'Here is the list' });
  });

  it('quotes with reply_parameters', async () => {
    const rig = liveRig({ respond: () => ({ body: { ok: true, result: { message_id: 5 } } }) });
    inbound(rig.store, 'telegram', '42', 5);
    await rig.service.sendMessage({ channel: 'telegram', conversationId: '42', text: 'x', replyToMessageId: '42:9' });
    expect(rig.calls[0]!.body).toMatchObject({ reply_parameters: { message_id: 9 } });
  });

  it('retries once after a 429 using retry_after and waits for it', async () => {
    let n = 0;
    const rig = liveRig({
      respond: () =>
        n++ === 0
          ? { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } } }
          : { body: { ok: true, result: { message_id: 1 } } },
    });
    inbound(rig.store, 'telegram', '42', 5);
    const r = await rig.service.sendMessage({ channel: 'telegram', conversationId: '42', text: 'x' });
    expect(r).toMatchObject({ sent: true });
    expect(rig.calls).toHaveLength(2);
  });

  it('turns a blocked bot into a recipient error', async () => {
    const rig = liveRig({ respond: () => ({ status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } }) });
    inbound(rig.store, 'telegram', '42', 5);
    await expect(rig.service.sendMessage({ channel: 'telegram', conversationId: '42', text: 'x' })).rejects.toMatchObject({ code: 'recipient' });
  });
});

describe('API errors', () => {
  async function failWith(body: unknown, status = 400, headers: Record<string, string> = {}) {
    const rig = liveRig({ respond: () => ({ status, body, headers }) });
    inbound(rig.store, 'whatsapp', '1555', 5);
    try {
      await rig.service.sendMessage({ channel: 'whatsapp', conversationId: '1555', text: 'x' });
    } catch (e) {
      return e as MessagingError;
    }
    throw new Error('expected an error');
  }

  it('maps an expired token to auth without echoing the token', async () => {
    const e = await failWith({ error: { message: 'Invalid OAuth access token WA_TOKEN.', code: 190 } }, 401);
    expect(e.code).toBe('auth');
    expect(e.message).not.toContain('WA_TOKEN');
    expect(e.hint).toMatch(/token/i);
  });

  it('maps rate limits as retryable and keeps Retry-After', async () => {
    const e = await failWith({ error: { message: 'Too many calls', code: 4 } }, 429, { 'retry-after': '7' });
    expect(e).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterSec: 7 });
  });

  it('maps WhatsApp 131047 to window_closed with a template hint', async () => {
    const e = await failWith({ error: { message: 'Re-engagement message', code: 131047 } });
    expect(e.code).toBe('window_closed');
    expect(e.hint).toMatch(/template/);
  });

  it('maps template and permission errors', async () => {
    expect((await failWith({ error: { message: 'Template name does not exist', code: 132001 } })).code).toBe('template');
    expect((await failWith({ error: { message: 'Permission denied', code: 200 } }, 403)).code).toBe('permission');
  });

  it('keeps the platform message for anything else', async () => {
    const e = await failWith({ error: { message: 'Something odd', code: 999, error_data: { details: 'more detail' } } });
    expect(e.code).toBe('api_error');
    expect(e.message).toContain('Something odd more detail');
  });

  it('turns a network failure into a retryable error', async () => {
    const rig = liveRig();
    const broken = new Map(rig.adapters);
    expect(broken.size).toBe(4);
    const { WhatsAppAdapter } = await import('../src/channels/meta.js');
    const a = new WhatsAppAdapter(
      { accessToken: 'SECRET_T', phoneNumberId: '1' },
      { graphHost: 'https://graph.facebook.com', fetch: async () => { throw new Error('connect ECONNREFUSED SECRET_T'); } },
    );
    await expect(a.sendText({ to: '1', text: 'x', kind: 'free_form' })).rejects.toMatchObject({ code: 'network', retryable: true });
    await a.sendText({ to: '1', text: 'x', kind: 'free_form' }).catch((e: Error) => expect(e.message).not.toContain('SECRET_T'));
  });
});
