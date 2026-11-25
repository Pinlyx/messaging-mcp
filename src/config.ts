import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { GRAPH_HOST, INSTAGRAM_GRAPH_HOST } from './constants.js';

export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId?: string;
}
export interface MessengerConfig {
  pageAccessToken: string;
  pageId: string;
}
export interface InstagramConfig {
  accessToken: string;
  accountId: string;
  apiHost: string;
}
export interface TelegramConfig {
  botToken: string;
  /** Public https URL to register with setWebhook. Absent: long polling. */
  webhookUrl?: string;
  webhookSecret: string;
}

export interface Config {
  demo: boolean;
  readOnly: boolean;
  /** Run the webhook receiver and Telegram poller in this process. */
  ingest: boolean;
  /** Serve MCP over stdio. */
  stdio: boolean;
  webhookPort?: number;
  webhookHost: string;
  dbPath: string;
  metaAppSecret?: string;
  metaVerifyToken?: string;
  graphHost: string;
  whatsapp?: WhatsAppConfig;
  messenger?: MessengerConfig;
  instagram?: InstagramConfig;
  telegram?: TelegramConfig;
  /** Human readable notes about ignored or incomplete settings, printed to stderr at start. */
  warnings: string[];
}

export type ParsedArgs = { kind: 'help' } | { kind: 'version' } | { kind: 'run'; config: Config };

export const HELP = `messaging-mcp: MCP server for WhatsApp, Instagram, Messenger and Telegram

Usage: messaging-mcp [options]

  --demo                 Seeded sample conversations, no keys needed, nothing is really sent
  --read-only            Do not register the send tools
  --webhook-port <port>  Receive Meta webhooks on POST /webhooks/meta (default: off)
  --webhook-host <host>  Interface for the webhook receiver (default 127.0.0.1)
  --telegram-webhook <https-url>
                         Register this public URL with Telegram instead of long polling
                         (needs --webhook-port; the receiver answers on /webhooks/telegram)
  --db <path>            Database file (default: your user data folder, or MESSAGING_MCP_DB)
  --no-ingest            Do not poll Telegram or receive webhooks in this process
  --no-stdio             Run only the webhook receiver and Telegram poller (no MCP over stdio)
  -h, --help             Show this help
  -v, --version          Show the version

Channels turn on when their environment variables are set:
  WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_BUSINESS_ACCOUNT_ID (templates)
  MESSENGER_PAGE_ACCESS_TOKEN, MESSENGER_PAGE_ID
  INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_ACCOUNT_ID
  TELEGRAM_BOT_TOKEN
  META_APP_SECRET, META_VERIFY_TOKEN   (webhook signature and subscribe handshake)
Docs: https://github.com/Pinlyx/messaging-mcp
`;

export function defaultDbDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'messaging-mcp');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'messaging-mcp');
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'messaging-mcp');
}

function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function parsePort(raw: string | undefined, flag: string): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${flag} needs a port between 1 and 65535`);
  return n;
}

/** Parses the command line and environment. Throws Error with a readable message on bad input. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  let demo = false;
  let readOnly = false;
  let ingest = true;
  let stdio = true;
  let webhookPort: number | undefined;
  let webhookHost = '127.0.0.1';
  let telegramWebhook: string | undefined;
  let db: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    const inline = a.startsWith('--') && eq > 0 ? a.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case '-h':
      case '--help':
        return { kind: 'help' };
      case '-v':
      case '--version':
        return { kind: 'version' };
      case '--demo':
        demo = true;
        break;
      case '--read-only':
        readOnly = true;
        break;
      case '--no-ingest':
        ingest = false;
        break;
      case '--no-stdio':
        stdio = false;
        break;
      case '--webhook-port':
        webhookPort = parsePort(value(), '--webhook-port');
        break;
      case '--webhook-host':
        webhookHost = value();
        break;
      case '--telegram-webhook':
        telegramWebhook = value();
        break;
      case '--db':
        db = value();
        break;
      default:
        throw new Error(`Unknown option "${a}". Run messaging-mcp --help.`);
    }
  }

  const warnings: string[] = [];
  const config: Config = {
    demo,
    readOnly,
    ingest,
    stdio,
    webhookHost,
    dbPath: db ?? clean(env.MESSAGING_MCP_DB) ?? join(defaultDbDir(env), 'messaging.db'),
    graphHost: GRAPH_HOST,
    warnings,
  };
  if (webhookPort !== undefined) config.webhookPort = webhookPort;
  const secret = clean(env.META_APP_SECRET);
  const verify = clean(env.META_VERIFY_TOKEN);
  if (secret) config.metaAppSecret = secret;
  if (verify) config.metaVerifyToken = verify;

  if (demo) {
    if (webhookPort !== undefined || telegramWebhook) warnings.push('--demo ignores webhook options: nothing is received in demo mode.');
    return { kind: 'run', config };
  }

  const both = (name: string, a: string | undefined, b: string | undefined, aName: string, bName: string): boolean => {
    if (a && b) return true;
    if (a || b) warnings.push(`${name} is off: set both ${aName} and ${bName}.`);
    return false;
  };

  const waToken = clean(env.WHATSAPP_ACCESS_TOKEN);
  const waPhone = clean(env.WHATSAPP_PHONE_NUMBER_ID);
  if (both('WhatsApp', waToken, waPhone, 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID')) {
    const waba = clean(env.WHATSAPP_BUSINESS_ACCOUNT_ID);
    config.whatsapp = { accessToken: waToken as string, phoneNumberId: waPhone as string, ...(waba ? { businessAccountId: waba } : {}) };
  }

  const msToken = clean(env.MESSENGER_PAGE_ACCESS_TOKEN);
  const msPage = clean(env.MESSENGER_PAGE_ID);
  if (both('Messenger', msToken, msPage, 'MESSENGER_PAGE_ACCESS_TOKEN', 'MESSENGER_PAGE_ID')) {
    config.messenger = { pageAccessToken: msToken as string, pageId: msPage as string };
  }

  const igToken = clean(env.INSTAGRAM_ACCESS_TOKEN);
  const igId = clean(env.INSTAGRAM_ACCOUNT_ID);
  if (both('Instagram', igToken, igId, 'INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_ACCOUNT_ID')) {
    config.instagram = {
      accessToken: igToken as string,
      accountId: igId as string,
      apiHost: (clean(env.INSTAGRAM_API_HOST) ?? INSTAGRAM_GRAPH_HOST).replace(/\/+$/, ''),
    };
  }

  const tgToken = clean(env.TELEGRAM_BOT_TOKEN);
  if (tgToken) {
    const webhookSecret =
      clean(env.TELEGRAM_WEBHOOK_SECRET) ?? createHash('sha256').update(`messaging-mcp:${tgToken}`).digest('hex').slice(0, 48);
    config.telegram = { botToken: tgToken, webhookSecret, ...(telegramWebhook ? { webhookUrl: telegramWebhook } : {}) };
    if (telegramWebhook && webhookPort === undefined) {
      throw new Error('--telegram-webhook needs --webhook-port so there is something to receive the updates.');
    }
    if (telegramWebhook && !/^https:\/\//i.test(telegramWebhook)) {
      throw new Error('--telegram-webhook must be a public https URL.');
    }
  } else if (telegramWebhook) {
    warnings.push('--telegram-webhook ignored: TELEGRAM_BOT_TOKEN is not set.');
  }

  if (webhookPort !== undefined) {
    const meta = config.whatsapp || config.messenger || config.instagram;
    if (!meta && !(config.telegram && telegramWebhook)) warnings.push('--webhook-port is set but no Meta channel or Telegram webhook is configured.');
    if (meta && !secret) warnings.push('META_APP_SECRET is not set: every POST to /webhooks/meta will be rejected, because signatures cannot be checked.');
    if (meta && !verify) warnings.push('META_VERIFY_TOKEN is not set: Meta cannot complete the webhook subscribe handshake.');
  }

  return { kind: 'run', config };
}
