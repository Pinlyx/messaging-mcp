import { TELEGRAM_HOST } from '../constants.js';
import { MessagingError } from '../errors.js';
import type { TelegramConfig } from '../config.js';
import type { ChannelAdapter, SendInput, SendResult } from './adapter.js';
import { realSleep, redact, requestJson, type FetchLike, type Sleep } from './http.js';

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Thin Bot API client. The token is part of the URL (Telegram's design), so it is redacted from every error. */
export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchLike,
    private readonly sleep: Sleep = realSleep,
    private readonly host: string = TELEGRAM_HOST,
  ) {}

  /** Calls a Bot API method. On a 429 it waits retry_after (up to 10 s) once, then gives up. */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await requestJson(
        this.fetchFn,
        `${this.host}/bot${this.token}/${method}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
          ...(signal ? { signal } : {}),
        },
        [this.token],
      );
      const body = rec(res.body);
      if (res.ok && body?.ok === true) return body.result as T;
      const err = mapTelegramError(res.status, body, [this.token]);
      if (err.code === 'rate_limited' && attempt === 0 && err.retryAfterSec !== undefined && err.retryAfterSec <= 10) {
        await this.sleep(err.retryAfterSec * 1000);
        continue;
      }
      throw err;
    }
  }
}

export function mapTelegramError(status: number, body: Record<string, unknown> | undefined, secrets: string[]): MessagingError {
  const code = typeof body?.error_code === 'number' ? body.error_code : status;
  const description = redact(String(body?.description ?? `HTTP ${status}`), secrets);
  const retryAfter = rec(body?.parameters)?.retry_after;
  const base = { status, platformCode: code };
  const text = `${description} (code ${code})`;
  if (code === 429) {
    return new MessagingError('rate_limited', text, {
      ...base,
      retryable: true,
      ...(typeof retryAfter === 'number' ? { retryAfterSec: retryAfter } : {}),
      hint: 'Telegram asked the bot to slow down. Wait for retryAfterSec before sending again.',
    });
  }
  if (code === 401) return new MessagingError('auth', text, { ...base, hint: 'The bot token is wrong or revoked. Ask @BotFather for a fresh one.' });
  if (code === 403 || /chat not found|user is deactivated|bot was blocked|have no rights/i.test(description)) {
    return new MessagingError('recipient', text, {
      ...base,
      hint: 'The user has not started the bot, blocked it, or the chat id is wrong. A bot cannot message people who did not message it first.',
    });
  }
  if (code === 409) {
    return new MessagingError('api_error', text, {
      ...base,
      hint: 'Another process is polling this bot or a webhook is set. Only one consumer can read updates.',
    });
  }
  return new MessagingError('api_error', text, base);
}

/** Telegram Bot API sendMessage. */
export class TelegramAdapter implements ChannelAdapter {
  readonly channel = 'telegram' as const;
  readonly demo = false;
  readonly accountId: string;
  accountLabel?: string;

  constructor(
    cfg: TelegramConfig,
    readonly api: TelegramApi,
  ) {
    // The part of the token before the colon is the bot's user id, which is not secret.
    this.accountId = cfg.botToken.split(':')[0] ?? 'bot';
  }

  async sendText(input: SendInput): Promise<SendResult> {
    const params: Record<string, unknown> = {
      chat_id: /^-?\d{1,15}$/.test(input.to) ? Number(input.to) : input.to,
      text: input.text,
    };
    if (input.replyToId) {
      const mid = Number(input.replyToId.split(':').pop());
      if (Number.isInteger(mid)) params.reply_parameters = { message_id: mid, allow_sending_without_reply: true };
    }
    const result = rec(await this.api.call('sendMessage', params));
    const id = result?.message_id;
    return id !== undefined ? { id: `${input.to}:${String(id)}` } : {};
  }
}
