import { parse } from 'unified-message';
import type { TelegramApi } from './channels/telegram.js';
import type { Sleep } from './channels/http.js';
import { realSleep } from './channels/http.js';
import { ingestItems } from './ingest.js';
import type { Store } from './types.js';

const OFFSET_KEY = 'telegram.offset';
const UPDATE_TYPES = ['message', 'callback_query'];

interface Update {
  update_id: number;
}

export interface PollerOptions {
  api: TelegramApi;
  store: Store;
  log: (line: string) => void;
  sleep?: Sleep;
  /** Long polling timeout in seconds. */
  timeoutSec?: number;
}

/** Reads updates with getUpdates long polling, so no public URL is needed. */
export class TelegramPoller {
  private running = false;
  private abort: AbortController | undefined;
  private done: Promise<void> | undefined;
  private readonly sleep: Sleep;

  constructor(private readonly opts: PollerOptions) {
    this.sleep = opts.sleep ?? realSleep;
  }

  /** One getUpdates round. Returns the number of updates handled. Exposed for tests. */
  async pollOnce(timeoutSec = this.opts.timeoutSec ?? 25, signal?: AbortSignal): Promise<number> {
    const stored = this.opts.store.getKv(OFFSET_KEY);
    const offset = stored ? Number(stored) : undefined;
    const updates = await this.opts.api.call<Update[]>(
      'getUpdates',
      { timeout: timeoutSec, allowed_updates: UPDATE_TYPES, ...(offset !== undefined && Number.isFinite(offset) ? { offset } : {}) },
      signal,
    );
    let next = offset ?? 0;
    for (const u of updates) {
      ingestItems(this.opts.store, parse('telegram', u), { channels: new Set(['telegram']) });
      next = Math.max(next, u.update_id + 1);
    }
    if (updates.length > 0) this.opts.store.setKv(OFFSET_KEY, String(next));
    return updates.length;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // A registered webhook blocks getUpdates (HTTP 409), so make sure none is set.
      await this.opts.api.call('deleteWebhook', { drop_pending_updates: false });
    } catch (err) {
      this.opts.log(`telegram: could not clear webhook: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.done = this.loop();
  }

  private async loop(): Promise<void> {
    let backoff = 2000;
    while (this.running) {
      this.abort = new AbortController();
      try {
        await this.pollOnce(this.opts.timeoutSec ?? 25, this.abort.signal);
        backoff = 2000;
      } catch (err) {
        if (!this.running) return;
        this.opts.log(`telegram polling: ${err instanceof Error ? err.message : String(err)} (retry in ${Math.round(backoff / 1000)}s)`);
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.done?.catch(() => undefined);
  }
}
