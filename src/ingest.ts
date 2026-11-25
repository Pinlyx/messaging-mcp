import { createHash } from 'node:crypto';
import type { UnifiedItem, UnifiedMessage } from 'unified-message';
import { isChannelId, type ChannelId, type NewMessage, type Store } from './types.js';

export interface IngestOptions {
  /** Channels that are switched on. Items for other channels are dropped. */
  channels: ReadonlySet<ChannelId>;
  /** WhatsApp phone number id; messages addressed to another number of the same app are dropped. */
  whatsappPhoneNumberId?: string;
}

export interface IngestResult {
  stored: number;
  duplicates: number;
  ignored: number;
}

/** Telegram message ids are only unique per chat, so the chat id is part of the stored id. */
function externalId(channel: ChannelId, conversationId: string, id: string): string {
  return channel === 'telegram' ? `${conversationId}:${id}` : id;
}

function fromMessage(m: UnifiedMessage, channel: ChannelId): NewMessage {
  const inbound = !m.isEcho;
  return {
    channel,
    conversationId: m.conversationId,
    externalId: externalId(channel, m.conversationId, m.id),
    direction: inbound ? 'in' : 'out',
    timestamp: m.timestamp,
    ...(m.text !== undefined ? { text: m.text } : {}),
    attachments: m.attachments,
    ...(inbound && m.from.name ? { contactName: m.from.name } : {}),
    ...(inbound && m.from.username ? { contactUsername: m.from.username } : {}),
  };
}

/** Writes normalized webhook or polling items to the store. Reactions, reads and delivery statuses are skipped. */
export function ingestItems(store: Store, items: UnifiedItem[], opts: IngestOptions): IngestResult {
  const result: IngestResult = { stored: 0, duplicates: 0, ignored: 0 };
  for (const item of items) {
    if (item.kind === 'unsupported' || !isChannelId(item.channel) || !opts.channels.has(item.channel)) {
      result.ignored++;
      continue;
    }
    const channel = item.channel;
    let msg: NewMessage | undefined;
    if (item.kind === 'message') {
      if (channel === 'whatsapp' && opts.whatsappPhoneNumberId && item.to?.id && item.to.id !== opts.whatsappPhoneNumberId) {
        result.ignored++;
        continue;
      }
      msg = fromMessage(item, channel);
    } else if (item.kind === 'postback') {
      // A button press is something the customer did, so it counts as an inbound message and opens the window.
      const label = item.title ?? item.payload ?? 'button';
      msg = {
        channel,
        conversationId: item.conversationId,
        externalId: `postback:${createHash('sha1').update(JSON.stringify(item.raw)).digest('hex').slice(0, 24)}`,
        direction: 'in',
        timestamp: item.timestamp,
        text: `[button] ${label}`,
        attachments: [],
        ...(item.from.name ? { contactName: item.from.name } : {}),
        ...(item.from.username ? { contactUsername: item.from.username } : {}),
      };
    }
    if (!msg) {
      result.ignored++;
      continue;
    }
    if (store.addMessage(msg)) result.stored++;
    else result.duplicates++;
  }
  return result;
}
