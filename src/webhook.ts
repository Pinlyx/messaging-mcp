import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { parse, verifyMetaChallenge, verifyMetaSignature, verifyTelegramSecret } from 'unified-message';
import { ingestItems, type IngestOptions } from './ingest.js';
import type { Store } from './types.js';

const MAX_BODY = 2 * 1024 * 1024;

export interface WebhookOptions {
  store: Store;
  ingest: IngestOptions;
  metaAppSecret?: string;
  metaVerifyToken?: string;
  /** Secret registered with Telegram setWebhook. Absent: /webhooks/telegram answers 404. */
  telegramSecret?: string;
  log: (line: string) => void;
}

function readBody(req: IncomingMessage): Promise<Buffer | 'too_large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve('too_large');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body = '', type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

/** Meta sends one `object` per product: whatsapp_business_account, page (Messenger) or instagram. */
export function channelForMetaObject(object: unknown): 'whatsapp' | 'messenger' | 'instagram' | undefined {
  if (object === 'whatsapp_business_account') return 'whatsapp';
  if (object === 'page') return 'messenger';
  if (object === 'instagram') return 'instagram';
  return undefined;
}

export function createWebhookServer(opts: WebhookOptions): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, 'ok');

      if (url.pathname === '/webhooks/meta') {
        if (req.method === 'GET') {
          const challenge = opts.metaVerifyToken ? verifyMetaChallenge(url.searchParams, opts.metaVerifyToken) : null;
          return challenge === null ? send(res, 403, 'forbidden') : send(res, 200, challenge);
        }
        if (req.method === 'POST') {
          const raw = await readBody(req);
          if (raw === 'too_large') return send(res, 413, 'payload too large');
          if (!opts.metaAppSecret || !verifyMetaSignature(raw, req.headers['x-hub-signature-256'], opts.metaAppSecret)) {
            return send(res, 401, 'invalid signature');
          }
          let body: unknown;
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            return send(res, 400, 'invalid json');
          }
          const channel = channelForMetaObject((body as { object?: unknown } | null)?.object);
          if (!channel) return send(res, 200, 'ignored');
          const r = ingestItems(opts.store, parse(channel, body), opts.ingest);
          if (r.stored > 0) opts.log(`webhook ${channel}: stored ${r.stored} message(s)`);
          return send(res, 200, 'ok');
        }
        return send(res, 405, 'method not allowed');
      }

      if (url.pathname === '/webhooks/telegram' && opts.telegramSecret) {
        if (req.method !== 'POST') return send(res, 405, 'method not allowed');
        const raw = await readBody(req);
        if (raw === 'too_large') return send(res, 413, 'payload too large');
        if (!verifyTelegramSecret(req.headers['x-telegram-bot-api-secret-token'], opts.telegramSecret)) {
          return send(res, 401, 'invalid secret');
        }
        let body: unknown;
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          return send(res, 400, 'invalid json');
        }
        const r = ingestItems(opts.store, parse('telegram', body), opts.ingest);
        if (r.stored > 0) opts.log(`webhook telegram: stored ${r.stored} message(s)`);
        return send(res, 200, 'ok');
      }

      return send(res, 404, 'not found');
    } catch (err) {
      opts.log(`webhook error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) send(res, 500, 'error');
    }
  });
}
