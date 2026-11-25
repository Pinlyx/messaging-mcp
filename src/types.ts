import type { Attachment } from 'unified-message';

export type { Attachment };

export const CHANNEL_IDS = ['whatsapp', 'instagram', 'messenger', 'telegram'] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];

export function isChannelId(v: string): v is ChannelId {
  return (CHANNEL_IDS as readonly string[]).includes(v);
}

export type Direction = 'in' | 'out';

/** A message as it is written to the store. Conversation = (channel, conversationId). */
export interface NewMessage {
  channel: ChannelId;
  /** The other party: phone number, PSID, IGSID or Telegram chat id. */
  conversationId: string;
  /** Platform message id, used to drop duplicate webhook deliveries. */
  externalId?: string;
  direction: Direction;
  /** ISO 8601, UTC. */
  timestamp: string;
  text?: string;
  attachments: Attachment[];
  /** Display name of the other party, when the platform tells us. */
  contactName?: string;
  contactUsername?: string;
  /** True for messages created in demo mode. */
  demo?: boolean;
}

export interface StoredMessage {
  id: number;
  channel: ChannelId;
  conversationId: string;
  externalId?: string;
  direction: Direction;
  timestamp: string;
  text?: string;
  attachments: Attachment[];
  demo: boolean;
}

export interface ConversationSummary {
  channel: ChannelId;
  id: string;
  name?: string;
  username?: string;
  /** ISO time of the newest message, either direction. */
  lastMessageAt: string;
  lastMessageText?: string;
  lastMessageDirection: Direction;
  /** ISO time of the newest message from the other party, null when they never wrote. */
  lastInboundAt: string | null;
  /** Platform id of the newest inbound message (used for read receipts). */
  lastInboundExternalId?: string;
  unread: number;
}

export interface ConversationQuery {
  channel?: ChannelId;
  unreadOnly?: boolean;
  /** Case-insensitive match against name, username and id. */
  query?: string;
  limit: number;
  offset: number;
}

export interface MessagesQuery {
  limit: number;
  /** Only messages older than this ISO time. */
  before?: string;
}

export interface SearchQuery {
  query: string;
  channel?: ChannelId;
  limit: number;
}

export interface SearchHit {
  message: StoredMessage;
  conversationName?: string;
}

export interface Store {
  readonly kind: 'sqlite' | 'json' | 'memory';
  /** Returns false when the message was already stored (same channel and externalId). */
  addMessage(msg: NewMessage): boolean;
  getConversation(channel: ChannelId, id: string): ConversationSummary | undefined;
  listConversations(q: ConversationQuery): { total: number; items: ConversationSummary[] };
  /** Newest `limit` messages, returned oldest first. */
  getMessages(channel: ChannelId, id: string, q: MessagesQuery): StoredMessage[];
  searchMessages(q: SearchQuery): SearchHit[];
  /** Marks everything received so far as read. */
  markRead(channel: ChannelId, id: string): void;
  getKv(key: string): string | undefined;
  setKv(key: string, value: string): void;
  close(): void;
}
