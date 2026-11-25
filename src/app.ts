import type { Server } from 'node:http';
import type { ChannelAdapter } from './channels/adapter.js';
import type { FetchLike, Sleep } from './channels/http.js';
import { InstagramAdapter, MessengerAdapter, WhatsAppAdapter } from './channels/meta.js';
import { TelegramAdapter, TelegramApi } from './channels/telegram.js';
import type { Config } from './config.js';
import { DEMO_ACCOUNTS, DemoAdapter, seedDemo } from './demo.js';
import { MessagingService } from './service.js';
import { MemoryStore, openStore } from './store.js';
import { TelegramPoller } from './telegram-poller.js';
import { CHANNEL_IDS, type ChannelId, type Store } from './types.js';
import { createWebhookServer } from './webhook.js';

export interface AppDeps {
  fetch?: FetchLike;
  sleep?: Sleep;
  /** Diagnostics. Never write to stdout: it carries the MCP protocol. */
  log?: (line: string) => void;
  store?: Store;
  now?: () => number;
}

export interface App {
  service: MessagingService;
  store: Store;
  /** Starts the Telegram poller / webhook registration and the webhook receiver, as configured. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The webhook HTTP server once started (for tests). */
  webhookServer(): Server | undefined;
}

export function buildApp(config: Config, deps: AppDeps = {}): App {
  const log = deps.log ?? ((line: string) => process.stderr.write(`messaging-mcp: ${line}\n`));
  const fetchFn: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const adapters = new Map<ChannelId, ChannelAdapter>();
  let store: Store;
  let telegramApi: TelegramApi | undefined;

  if (config.demo) {
    store = deps.store ?? new MemoryStore();
    seedDemo(store, deps.now ? deps.now() : Date.now());
    for (const id of CHANNEL_IDS) adapters.set(id, new DemoAdapter(id, DEMO_ACCOUNTS[id].id, DEMO_ACCOUNTS[id].label));
  } else {
    if (deps.store) store = deps.store;
    else {
      const opened = openStore(config.dbPath);
      store = opened.store;
      if (opened.note) log(opened.note);
    }
    const common = { fetch: fetchFn, graphHost: config.graphHost };
    if (config.whatsapp) adapters.set('whatsapp', new WhatsAppAdapter(config.whatsapp, common));
    if (config.messenger) adapters.set('messenger', new MessengerAdapter(config.messenger, common));
    if (config.instagram) adapters.set('instagram', new InstagramAdapter(config.instagram, common));
    if (config.telegram) {
      telegramApi = new TelegramApi(config.telegram.botToken, fetchFn, deps.sleep);
      adapters.set('telegram', new TelegramAdapter(config.telegram, telegramApi));
    }
  }

  const service = new MessagingService({
    store,
    adapters,
    readOnly: config.readOnly,
    demo: config.demo,
    ...(deps.now ? { now: deps.now } : {}),
  });

  let poller: TelegramPoller | undefined;
  let server: Server | undefined;

  return {
    service,
    store,
    webhookServer: () => server,

    async start() {
      for (const w of config.warnings) log(w);
      if (config.demo || !config.ingest) return;

      const tg = config.telegram;
      if (tg && telegramApi) {
        try {
          const me = await telegramApi.call<{ username?: string }>('getMe');
          const a = adapters.get('telegram');
          if (a instanceof TelegramAdapter && me.username) a.accountLabel = `@${me.username}`;
        } catch (err) {
          log(`telegram: getMe failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (tg.webhookUrl) {
          const target = `${tg.webhookUrl.replace(/\/+$/, '')}/webhooks/telegram`;
          try {
            await telegramApi.call('setWebhook', {
              url: target,
              secret_token: tg.webhookSecret,
              allowed_updates: ['message', 'callback_query'],
            });
            log(`telegram: webhook registered at ${target}`);
          } catch (err) {
            log(`telegram: setWebhook failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          poller = new TelegramPoller({ api: telegramApi, store, log, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
          await poller.start();
          log('telegram: long polling started');
        }
      }

      if (config.webhookPort !== undefined) {
        const channels = new Set<ChannelId>(adapters.keys());
        server = createWebhookServer({
          store,
          ingest: { channels, ...(config.whatsapp ? { whatsappPhoneNumberId: config.whatsapp.phoneNumberId } : {}) },
          ...(config.metaAppSecret ? { metaAppSecret: config.metaAppSecret } : {}),
          ...(config.metaVerifyToken ? { metaVerifyToken: config.metaVerifyToken } : {}),
          ...(tg?.webhookUrl ? { telegramSecret: tg.webhookSecret } : {}),
          log,
        });
        await new Promise<void>((resolve, reject) => {
          server?.once('error', reject);
          server?.listen(config.webhookPort, config.webhookHost, () => resolve());
        });
        log(`webhook receiver listening on http://${config.webhookHost}:${config.webhookPort}/webhooks/meta`);
      }
    },

    async stop() {
      await poller?.stop();
      if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
      store.close();
    },
  };
}
