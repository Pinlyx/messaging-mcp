import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from '../src/channels/http.js';
import type { Config } from '../src/config.js';
import { MessagingService } from '../src/service.js';
import { MemoryStore } from '../src/store.js';
import type { ChannelAdapter } from '../src/channels/adapter.js';
import { InstagramAdapter, MessengerAdapter, WhatsAppAdapter } from '../src/channels/meta.js';
import { TelegramAdapter, TelegramApi } from '../src/channels/telegram.js';
import type { ChannelId, Store } from '../src/types.js';

export function fixtureText(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8');
}

export function fixture(name: string): unknown {
  return JSON.parse(fixtureText(name));
}

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Responder = (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

/** A fetch that records every request and answers from `respond` (default: 200 with an empty object). */
export function mockFetch(respond: Responder = () => undefined): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = respond(call) ?? {};
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  };
  return { fetch: fetchFn, calls };
}

export const NOW = Date.parse('2026-11-26T12:00:00Z');
export const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();

export function baseConfig(over: Partial<Config> = {}): Config {
  return {
    demo: false,
    readOnly: false,
    ingest: true,
    stdio: true,
    webhookHost: '127.0.0.1',
    dbPath: ':memory:',
    graphHost: 'https://graph.facebook.com',
    warnings: [],
    ...over,
  };
}

export interface Rig {
  service: MessagingService;
  store: Store;
  calls: Call[];
  adapters: Map<ChannelId, ChannelAdapter>;
}

/** All four live adapters wired to one mock fetch, with fake credentials. */
export function liveRig(opts: { respond?: Responder; readOnly?: boolean; store?: Store } = {}): Rig {
  const { fetch, calls } = mockFetch(opts.respond);
  const common = { fetch, graphHost: 'https://graph.facebook.com' };
  const adapters = new Map<ChannelId, ChannelAdapter>();
  adapters.set('whatsapp', new WhatsAppAdapter({ accessToken: 'WA_TOKEN', phoneNumberId: '111', businessAccountId: '222' }, common));
  adapters.set('messenger', new MessengerAdapter({ pageAccessToken: 'MS_TOKEN', pageId: '333' }, common));
  adapters.set('instagram', new InstagramAdapter({ accessToken: 'IG_TOKEN', accountId: '444', apiHost: 'https://graph.instagram.com' }, common));
  adapters.set(
    'telegram',
    new TelegramAdapter({ botToken: '555:TG_SECRET', webhookSecret: 's' }, new TelegramApi('555:TG_SECRET', fetch, async () => undefined)),
  );
  const store = opts.store ?? new MemoryStore();
  const service = new MessagingService({ store, adapters, readOnly: opts.readOnly ?? false, demo: false, now: () => NOW });
  return { service, store, calls, adapters };
}

export function inbound(store: Store, channel: ChannelId, id: string, minutes: number, text = 'hello', name = 'Test Person') {
  store.addMessage({
    channel,
    conversationId: id,
    externalId: `in-${channel}-${id}-${minutes}`,
    direction: 'in',
    timestamp: minutesAgo(minutes),
    text,
    attachments: [],
    contactName: name,
  });
}
