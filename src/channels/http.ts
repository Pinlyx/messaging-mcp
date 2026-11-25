import { MessagingError, type ErrorCode } from '../errors.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('***');
  return out;
}

export interface JsonResponse {
  status: number;
  ok: boolean;
  body: unknown;
  retryAfterHeader?: number;
}

/** One JSON request. Network failures become MessagingError('network'); the URL is never included. */
export async function requestJson(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  secrets: string[],
): Promise<JsonResponse> {
  let res: Response;
  try {
    res = await fetchFn(url, init);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new MessagingError('network', `Network error while calling the platform API: ${redact(detail, secrets)}`, {
      retryable: true,
    });
  }
  const text = await res.text().catch(() => '');
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 500) };
    }
  }
  const ra = Number(res.headers?.get?.('retry-after'));
  return { status: res.status, ok: res.ok, body, ...(Number.isFinite(ra) && ra > 0 ? { retryAfterHeader: ra } : {}) };
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

const RATE_CODES = new Set([4, 17, 32, 613, 80004, 80006, 80007, 130429, 131048, 131056, 133016]);

/** Turns a Graph API error response (Messenger, Instagram, WhatsApp Cloud API) into a MessagingError. */
export function mapGraphError(res: JsonResponse, secrets: string[]): MessagingError {
  const err = rec(rec(res.body)?.error);
  const code = typeof err?.code === 'number' ? err.code : undefined;
  const sub = typeof err?.error_subcode === 'number' ? err.error_subcode : undefined;
  const message = String(err?.message ?? err?.error_user_msg ?? `HTTP ${res.status}`);
  const details = typeof rec(err?.error_data)?.details === 'string' ? ` ${rec(err?.error_data)?.details as string}` : '';
  const text = redact(`${message}${details}`.trim(), secrets);
  const platformCode = code ?? res.status;
  const base = { status: res.status, platformCode };
  const make = (c: ErrorCode, hint?: string, extra: { retryable?: boolean; retryAfterSec?: number } = {}) =>
    new MessagingError(c, `${text} (code ${platformCode})`, { ...base, ...(hint ? { hint } : {}), ...extra });

  if (code === 190 || res.status === 401) {
    return make('auth', 'The access token is invalid or expired. Create a new token and restart the server.');
  }
  if ((code !== undefined && RATE_CODES.has(code)) || res.status === 429) {
    const retryAfterSec = res.retryAfterHeader;
    return make('rate_limited', 'Slow down and retry later. The server does not retry sends on its own to avoid duplicates.', {
      retryable: true,
      ...(retryAfterSec ? { retryAfterSec } : {}),
    });
  }
  if (code === 131047 || sub === 2018278) {
    return make(
      'window_closed',
      'The customer service window is closed. On WhatsApp send an approved template instead (list_whatsapp_templates, send_whatsapp_template).',
    );
  }
  if (code === 131026 || code === 131030 || code === 131021 || code === 551 || sub === 2018001 || sub === 1545041) {
    return make('recipient', 'The platform says this recipient cannot receive the message (not reachable, not allowed, or unavailable).');
  }
  if (code !== undefined && code >= 132000 && code < 133000) {
    return make('template', 'Check the template name, language code and the number of parameters against list_whatsapp_templates.');
  }
  if (code === 10 || code === 3 || code === 131005 || (code !== undefined && code >= 200 && code < 300)) {
    return make('permission', 'The token lacks a permission or the app is not approved for this action. See the setup guide for the required permissions.');
  }
  return make('api_error', code === 100 ? 'Code 100 usually means a malformed request or an id that does not belong to this account.' : undefined);
}
