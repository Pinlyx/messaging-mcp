import { describe, expect, it } from 'vitest';
import { inbound, liveRig } from './helpers.js';

describe('rule checks before sending', () => {
  it('refuses a WhatsApp free-form message after 24h, does not call the API and suggests templates', async () => {
    const rig = liveRig();
    inbound(rig.store, 'whatsapp', '4915112340002', 60 * 24 * 3);
    const r = (await rig.service.sendMessage({ channel: 'whatsapp', conversationId: '4915112340002', text: 'Hallo' })) as Record<string, any>;
    expect(r.sent).toBe(false);
    expect(r.blocked_by).toBe('platform_rules');
    expect(r.reason).toMatch(/closed/);
    expect(r.suggestion.tool).toBe('send_whatsapp_template');
    expect(r.can_message_now.alternatives.some((a: { kind: string }) => a.kind === 'template')).toBe(true);
    expect(rig.calls).toHaveLength(0);
    expect(rig.store.getMessages('whatsapp', '4915112340002', { limit: 10 })).toHaveLength(1);
  });

  it('allows the same message at 23 hours and refuses at 25 hours', async () => {
    const ok = liveRig({ respond: () => ({ body: { messages: [{ id: 'a' }] } }) });
    inbound(ok.store, 'whatsapp', '1', 23 * 60);
    expect(await ok.service.sendMessage({ channel: 'whatsapp', conversationId: '1', text: 'x' })).toMatchObject({ sent: true });
    const late = liveRig();
    inbound(late.store, 'whatsapp', '1', 25 * 60);
    expect(await late.service.sendMessage({ channel: 'whatsapp', conversationId: '1', text: 'x' })).toMatchObject({ sent: false });
  });

  it('refuses a conversation nobody ever wrote in', async () => {
    const rig = liveRig();
    const r = (await rig.service.sendMessage({ channel: 'telegram', conversationId: '999', text: 'cold hello' })) as Record<string, any>;
    expect(r).toMatchObject({ sent: false, blocked_by: 'platform_rules' });
    expect(rig.calls).toHaveLength(0);
  });

  it('refuses an Instagram reply after 24h and offers the human agent path only as a manual option', async () => {
    const rig = liveRig();
    inbound(rig.store, 'instagram', 'ig9', 30 * 60);
    const r = (await rig.service.sendMessage({ channel: 'instagram', conversationId: 'ig9', text: 'hi' })) as Record<string, any>;
    expect(r.sent).toBe(false);
    expect(r.only_if_a_person_sends_it_manually).toEqual([expect.objectContaining({ kind: 'tag', tag: 'HUMAN_AGENT' })]);
  });

  it('refuses text over the channel limit with the validation problem', async () => {
    const rig = liveRig();
    inbound(rig.store, 'telegram', '42', 5);
    const r = (await rig.service.sendMessage({ channel: 'telegram', conversationId: '42', text: 'a'.repeat(5000) })) as Record<string, any>;
    expect(r).toMatchObject({ sent: false, blocked_by: 'validation' });
    expect(r.problems[0].severity).toBe('error');
    expect(rig.calls).toHaveLength(0);
  });

  it('rejects empty text and a tag kind without a tag', async () => {
    const rig = liveRig();
    inbound(rig.store, 'messenger', 'u', 5);
    await expect(rig.service.sendMessage({ channel: 'messenger', conversationId: 'u', text: '  ' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(rig.service.sendMessage({ channel: 'messenger', conversationId: 'u', text: 'x', kind: 'tag' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('can_message reports window state and the last inbound time', () => {
    const rig = liveRig();
    inbound(rig.store, 'whatsapp', '1', 60);
    const r = rig.service.canMessage({ channel: 'whatsapp', conversationId: '1' });
    expect(r).toMatchObject({ allowed: true, conversation_known: true });
    expect(r.window_ends_at).toBeDefined();
    const unknown = rig.service.canMessage({ channel: 'whatsapp', conversationId: 'nobody' });
    expect(unknown).toMatchObject({ allowed: false, conversation_known: false, last_inbound_at: null });
  });

  it('get_conversation carries the window summary and pages backwards', () => {
    const rig = liveRig();
    inbound(rig.store, 'messenger', 'u', 90, 'first');
    inbound(rig.store, 'messenger', 'u', 30, 'second');
    const c = rig.service.getConversation({ channel: 'messenger', conversationId: 'u', limit: 1 });
    expect(c.messages.map((m) => m.text)).toEqual(['second']);
    expect(c.can_message_now.allowed).toBe(true);
    expect(c.note).toMatch(/before/);
    expect(() => rig.service.getConversation({ channel: 'messenger', conversationId: 'nope' })).toThrow(/No conversation/);
  });

  it('refuses sending in read-only mode and still clears the local unread counter without a receipt', async () => {
    const rig = liveRig({ readOnly: true });
    inbound(rig.store, 'whatsapp', '1', 5);
    await expect(rig.service.sendMessage({ channel: 'whatsapp', conversationId: '1', text: 'x' })).rejects.toMatchObject({ code: 'read_only' });
    const r = await rig.service.markRead({ channel: 'whatsapp', conversationId: '1' });
    expect(r).toMatchObject({ read_receipt: 'skipped_read_only', local_unread_cleared: true });
    expect(rig.calls).toHaveLength(0);
  });

  it('reports a channel that is not configured', async () => {
    const rig = liveRig();
    rig.adapters.delete('instagram');
    inbound(rig.store, 'instagram', 'i', 5);
    await expect(rig.service.sendMessage({ channel: 'instagram', conversationId: 'i', text: 'x' })).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('get_rules returns source-cited rules', () => {
    const rig = liveRig();
    expect((rig.service.getRules({}) as { channels: unknown[] }).channels).toHaveLength(5);
    const wa = rig.service.getRules({ channel: 'whatsapp', section: 'windows' }) as Record<string, any>;
    expect(wa.windows[0].duration_hours).toBe(24);
    expect(() => rig.service.getRules({ channel: 'whatsapp', section: 'nope' })).toThrow();
  });
});
