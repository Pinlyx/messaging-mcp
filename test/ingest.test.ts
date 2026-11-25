import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'unified-message';
import { buildApp, type App } from '../src/app.js';
import { ingestItems } from '../src/ingest.js';
import { MemoryStore } from '../src/store.js';
import { TelegramApi } from '../src/channels/telegram.js';
import { TelegramPoller } from '../src/telegram-poller.js';
import type { ChannelId } from '../src/types.js';
import { baseConfig, fixture, fixtureText, mockFetch } from './helpers.js';

const all = new Set<ChannelId>(['whatsapp', 'instagram', 'messenger', 'telegram']);
const SECRET = 'app-secret';
const sign = (raw: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

describe('ingest', () => {
  it('stores a WhatsApp message with the contact name and ignores statuses', () => {
    const store = new MemoryStore();
    const r = ingestItems(store, [...parse('whatsapp', fixture('whatsapp-text')), ...parse('whatsapp', fixture('whatsapp-status'))], { channels: all });
    expect(r.stored).toBe(1);
    expect(r.ignored).toBeGreaterThan(0);
    const c = store.getConversation('whatsapp', '16505551234');
    expect(c).toMatchObject({ name: 'Sheena Nelson', unread: 1 });
    expect(store.getMessages('whatsapp', '16505551234', { limit: 5 })[0]?.text).toBe('Does it come in another color?');
  });

  it('drops duplicate deliveries', () => {
    const store = new MemoryStore();
    const items = parse('messenger', fixture('messenger-text'));
    expect(ingestItems(store, items, { channels: all }).stored).toBe(1);
    expect(ingestItems(store, items, { channels: all })).toMatchObject({ stored: 0, duplicates: 1 });
  });

  it('files an echo under the customer as an outbound message', () => {
    const store = new MemoryStore();
    ingestItems(store, parse('messenger', fixture('messenger-text')), { channels: all });
    ingestItems(store, parse('messenger', fixture('messenger-echo')), { channels: all });
    const msgs = store.getMessages('messenger', '5000000000000001', { limit: 5 });
    expect(msgs.map((m) => m.direction)).toEqual(['in', 'out']);
    expect(store.getConversation('messenger', '5000000000000001')?.lastInboundAt).not.toBeNull();
  });

  it('counts a button press as an inbound message', () => {
    const store = new MemoryStore();
    ingestItems(store, parse('whatsapp', fixture('whatsapp-button')), { channels: all });
    expect(store.getMessages('whatsapp', '16505551234', { limit: 5 })[0]).toMatchObject({ direction: 'in', text: '[button] Confirm' });
    ingestItems(store, parse('messenger', fixture('messenger-postback')), { channels: all });
    expect(store.getConversation('messenger', '5000000000000001')?.unread).toBe(1);
  });

  it('keeps Telegram message ids apart per chat', () => {
    const store = new MemoryStore();
    const a = { update_id: 1, message: { message_id: 1, from: { id: 10, first_name: 'A' }, chat: { id: 10, type: 'private' }, date: 1763600000, text: 'a' } };
    const b = { update_id: 2, message: { message_id: 1, from: { id: 20, first_name: 'B' }, chat: { id: 20, type: 'private' }, date: 1763600001, text: 'b' } };
    ingestItems(store, parse('telegram', a), { channels: all });
    ingestItems(store, parse('telegram', b), { channels: all });
    expect(store.listConversations({ limit: 10, offset: 0 }).total).toBe(2);
  });

  it('drops channels that are off and WhatsApp messages for another phone number', () => {
    const store = new MemoryStore();
    expect(ingestItems(store, parse('instagram', fixture('instagram-text')), { channels: new Set(['telegram']) }).stored).toBe(0);
    expect(ingestItems(store, parse('whatsapp', fixture('whatsapp-text')), { channels: all, whatsappPhoneNumberId: '999' }).stored).toBe(0);
    expect(ingestItems(store, parse('whatsapp', fixture('whatsapp-text')), { channels: all, whatsappPhoneNumberId: '106540352242922' }).stored).toBe(1);
  });

  it('does not store telegram edits twice', () => {
    const store = new MemoryStore();
    expect(ingestItems(store, parse('telegram', fixture('telegram-edited')), { channels: all }).stored).toBe(0);
  });
});

describe('webhook receiver', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.stop();
    app = undefined;
  });

  let tg: ReturnType<typeof mockFetch> | undefined;

  async function start(): Promise<string> {
    tg = mockFetch(() => ({ body: { ok: true, result: { username: 'shop_bot' } } }));
    app = buildApp(
      baseConfig({
        webhookPort: 0,
        whatsapp: { accessToken: 't', phoneNumberId: '106540352242922' },
        messenger: { pageAccessToken: 't', pageId: '109000000000001' },
        instagram: { accessToken: 't', accountId: '17841400000000001', apiHost: 'https://graph.instagram.com' },
        telegram: { botToken: '1:T', webhookSecret: 'tg-secret', webhookUrl: 'https://example.test/hook' },
        metaAppSecret: SECRET,
        metaVerifyToken: 'verify-me',
      }),
      { store: new MemoryStore(), log: () => undefined, fetch: tg.fetch },
    );
    await app.start();
    const port = (app.webhookServer()!.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}`;
  }

  it('answers the subscribe handshake only with the right token', async () => {
    const url = await start();
    const good = await fetch(`${url}/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
    expect(good.status).toBe(200);
    expect(await good.text()).toBe('12345');
    const bad = await fetch(`${url}/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`);
    expect(bad.status).toBe(403);
  });

  it('stores a correctly signed WhatsApp, Messenger and Instagram delivery', async () => {
    const url = await start();
    for (const name of ['whatsapp-text', 'messenger-text', 'instagram-text']) {
      const raw = fixtureText(name);
      const res = await fetch(`${url}/webhooks/meta`, { method: 'POST', headers: { 'x-hub-signature-256': sign(raw), 'content-type': 'application/json' }, body: raw });
      expect(res.status).toBe(200);
    }
    const list = app!.service.listConversations({ limit: 10 });
    expect(list.conversations.map((c) => c.channel).sort()).toEqual(['instagram', 'messenger', 'whatsapp']);
    expect(app!.service.getConversation({ channel: 'instagram', conversationId: '1100000000000001' }).messages[0]?.text).toBe('Is this still available?');
  });

  it('rejects a wrong or missing signature and stores nothing', async () => {
    const url = await start();
    const raw = fixtureText('whatsapp-text');
    const wrong = await fetch(`${url}/webhooks/meta`, { method: 'POST', headers: { 'x-hub-signature-256': sign(raw, 'other') }, body: raw });
    expect(wrong.status).toBe(401);
    const missing = await fetch(`${url}/webhooks/meta`, { method: 'POST', body: raw });
    expect(missing.status).toBe(401);
    const tampered = await fetch(`${url}/webhooks/meta`, { method: 'POST', headers: { 'x-hub-signature-256': sign(raw) }, body: raw.replace('color', 'colour') });
    expect(tampered.status).toBe(401);
    expect(app!.service.listConversations({ limit: 10 }).total).toBe(0);
  });

  it('answers 404 elsewhere and checks the Telegram secret', async () => {
    const url = await start();
    expect((await fetch(`${url}/nope`)).status).toBe(404);
    const raw = fixtureText('telegram-text');
    expect((await fetch(`${url}/webhooks/telegram`, { method: 'POST', body: raw })).status).toBe(401);
    expect((await fetch(`${url}/webhooks/telegram`, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' }, body: raw })).status).toBe(200);
    const set = tg!.calls.find((c) => c.url.endsWith('/setWebhook'))!;
    expect(set.body).toMatchObject({ url: 'https://example.test/hook/webhooks/telegram', secret_token: 'tg-secret' });
    expect(app!.service.listChannels().channels.find((c) => c.channel === 'telegram')?.account?.label).toBe('@shop_bot');
  });
});

describe('telegram polling', () => {
  it('reads updates, advances and persists the offset', async () => {
    let round = 0;
    const { fetch, calls } = mockFetch((c) => {
      if (!c.url.endsWith('/getUpdates')) return { body: { ok: true, result: true } };
      round++;
      return {
        body: {
          ok: true,
          result:
            round === 1
              ? [
                  { update_id: 100, message: { message_id: 1, from: { id: 5, first_name: 'Eve', username: 'eve' }, chat: { id: 5, type: 'private' }, date: 1763600000, text: 'hello bot' } },
                  { update_id: 101, message: { message_id: 2, from: { id: 5, first_name: 'Eve' }, chat: { id: 5, type: 'private' }, date: 1763600005, text: 'second' } },
                ]
              : [],
        },
      };
    });
    const store = new MemoryStore();
    const poller = new TelegramPoller({ api: new TelegramApi('1:T', fetch, async () => undefined), store, log: () => undefined });
    expect(await poller.pollOnce(0)).toBe(2);
    expect(store.getConversation('telegram', '5')).toMatchObject({ name: 'Eve', username: 'eve', unread: 2 });
    expect(store.getKv('telegram.offset')).toBe('102');
    await poller.pollOnce(0);
    const second = calls.filter((c) => c.url.endsWith('/getUpdates'))[1]!;
    expect(second.body).toMatchObject({ offset: 102, allowed_updates: ['message', 'callback_query'] });
  });
});
