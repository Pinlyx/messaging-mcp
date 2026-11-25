import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { baseConfig, mockFetch } from './helpers.js';

describe('demo mode', () => {
  function demoApp() {
    const { fetch, calls } = mockFetch();
    const app = buildApp(baseConfig({ demo: true }), { fetch, log: () => undefined });
    return { app, calls };
  }

  it('seeds conversations on all four channels in several languages', () => {
    const { app } = demoApp();
    const list = app.service.listConversations({ limit: 100 });
    expect(list.total).toBeGreaterThanOrEqual(9);
    expect(new Set(list.conversations.map((c) => c.channel))).toEqual(new Set(['whatsapp', 'instagram', 'messenger', 'telegram']));
    const text = list.conversations.map((c) => c.last_message_preview).join(' ');
    expect(text).toMatch(/[а-я]/i);
    expect(text).toMatch(/[ぁ-ん]/);
    expect(app.service.listChannels().channels.every((c) => c.enabled && c.mode === 'demo')).toBe(true);
  });

  it('has both open and closed windows so the rule check is visible', () => {
    const { app } = demoApp();
    const list = app.service.listConversations({ limit: 100 }).conversations;
    expect(list.some((c) => c.can_reply_now)).toBe(true);
    expect(list.some((c) => !c.can_reply_now)).toBe(true);
  });

  it('marks sends as demo, stores them and never touches the network', async () => {
    const { app, calls } = demoApp();
    const r = await app.service.sendMessage({ channel: 'messenger', conversationId: '5000000000000002', text: 'Bien sur' });
    expect(r).toMatchObject({ sent: true, demo: true });
    const conv = app.service.getConversation({ channel: 'messenger', conversationId: '5000000000000002' });
    expect(conv.messages.at(-1)).toMatchObject({ direction: 'out', demo: true, text: 'Bien sur' });
    const t = await app.service.sendWhatsAppTemplate({ conversationId: '4915112340002', name: 'follow_up', language: 'de', parameters: ['Jonas'] });
    expect(t).toMatchObject({ sent: true, demo: true });
    expect(calls).toHaveLength(0);
  });

  it('still enforces the rules on demo conversations', async () => {
    const { app } = demoApp();
    const r = await app.service.sendMessage({ channel: 'whatsapp', conversationId: '4915112340002', text: 'Hallo' });
    expect(r).toMatchObject({ sent: false, blocked_by: 'platform_rules' });
  });

  it('lists demo templates and searches across languages', async () => {
    const { app } = demoApp();
    const t = await app.service.listWhatsAppTemplates();
    expect(t.templates.some((x) => x.name === 'order_update' && x.language === 'tr')).toBe(true);
    expect(app.service.searchMessages({ query: 'Rechnung' }).count).toBe(1);
  });
});
