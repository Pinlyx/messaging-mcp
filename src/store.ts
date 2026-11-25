import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Attachment,
  ChannelId,
  ConversationQuery,
  ConversationSummary,
  MessagesQuery,
  NewMessage,
  SearchHit,
  SearchQuery,
  StoredMessage,
  Store,
} from './types.js';

interface Row {
  id: number;
  channel: ChannelId;
  conversationId: string;
  externalId?: string;
  direction: 'in' | 'out';
  ts: number;
  text?: string;
  attachments: Attachment[];
  demo: boolean;
}

interface Contact {
  name?: string;
  username?: string;
  readThrough: number;
}

function toMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Date.now();
}

function toMessage(r: Row): StoredMessage {
  return {
    id: r.id,
    channel: r.channel,
    conversationId: r.conversationId,
    ...(r.externalId ? { externalId: r.externalId } : {}),
    direction: r.direction,
    timestamp: new Date(r.ts).toISOString(),
    ...(r.text !== undefined ? { text: r.text } : {}),
    attachments: r.attachments,
    demo: r.demo,
  };
}

const key = (channel: string, id: string): string => `${channel}\u0000${id}`;

/** In-memory store. Also the base of the JSON file store. */
export class MemoryStore implements Store {
  readonly kind: 'json' | 'memory' = 'memory';
  protected rows: Row[] = [];
  protected contacts = new Map<string, Contact>();
  protected kv = new Map<string, string>();
  protected nextId = 1;
  private seen = new Set<string>();

  addMessage(msg: NewMessage): boolean {
    if (msg.externalId) {
      const k = key(msg.channel, msg.externalId);
      if (this.seen.has(k)) return false;
      this.seen.add(k);
    }
    const ts = toMs(msg.timestamp);
    this.rows.push({
      id: this.nextId++,
      channel: msg.channel,
      conversationId: msg.conversationId,
      ...(msg.externalId ? { externalId: msg.externalId } : {}),
      direction: msg.direction,
      ts,
      ...(msg.text !== undefined ? { text: msg.text } : {}),
      attachments: msg.attachments,
      demo: msg.demo === true,
    });
    const ck = key(msg.channel, msg.conversationId);
    const c = this.contacts.get(ck) ?? { readThrough: 0 };
    if (msg.contactName) c.name = msg.contactName;
    if (msg.contactUsername) c.username = msg.contactUsername;
    this.contacts.set(ck, c);
    this.persist();
    return true;
  }

  private rowsOf(channel: string, id: string): Row[] {
    return this.rows
      .filter((r) => r.channel === channel && r.conversationId === id)
      .sort((a, b) => a.ts - b.ts || a.id - b.id);
  }

  private summarize(channel: ChannelId, id: string, c: Contact): ConversationSummary | undefined {
    const rows = this.rowsOf(channel, id);
    const last = rows[rows.length - 1];
    if (!last) return undefined;
    const inbound = rows.filter((r) => r.direction === 'in');
    const lastIn = inbound[inbound.length - 1];
    return {
      channel,
      id,
      ...(c.name ? { name: c.name } : {}),
      ...(c.username ? { username: c.username } : {}),
      lastMessageAt: new Date(last.ts).toISOString(),
      ...(last.text !== undefined ? { lastMessageText: last.text } : {}),
      lastMessageDirection: last.direction,
      lastInboundAt: lastIn ? new Date(lastIn.ts).toISOString() : null,
      ...(lastIn?.externalId ? { lastInboundExternalId: lastIn.externalId } : {}),
      unread: inbound.filter((r) => r.ts > c.readThrough).length,
    };
  }

  getConversation(channel: ChannelId, id: string): ConversationSummary | undefined {
    const c = this.contacts.get(key(channel, id));
    return c ? this.summarize(channel, id, c) : undefined;
  }

  listConversations(q: ConversationQuery): { total: number; items: ConversationSummary[] } {
    const needle = q.query?.trim().toLowerCase();
    const all: ConversationSummary[] = [];
    for (const [k, c] of this.contacts) {
      const [channel, id] = k.split('\u0000') as [ChannelId, string];
      if (q.channel && channel !== q.channel) continue;
      if (needle && !`${c.name ?? ''} ${c.username ?? ''} ${id}`.toLowerCase().includes(needle)) continue;
      const s = this.summarize(channel, id, c);
      if (!s) continue;
      if (q.unreadOnly && s.unread === 0) continue;
      all.push(s);
    }
    all.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
    return { total: all.length, items: all.slice(q.offset, q.offset + q.limit) };
  }

  getMessages(channel: ChannelId, id: string, q: MessagesQuery): StoredMessage[] {
    let rows = this.rowsOf(channel, id);
    if (q.before) {
      const before = toMs(q.before);
      rows = rows.filter((r) => r.ts < before);
    }
    return rows.slice(Math.max(0, rows.length - q.limit)).map(toMessage);
  }

  searchMessages(q: SearchQuery): SearchHit[] {
    const needle = q.query.trim().toLowerCase();
    if (!needle) return [];
    return this.rows
      .filter((r) => (!q.channel || r.channel === q.channel) && (r.text ?? '').toLowerCase().includes(needle))
      .sort((a, b) => b.ts - a.ts || b.id - a.id)
      .slice(0, q.limit)
      .map((r) => {
        const name = this.contacts.get(key(r.channel, r.conversationId))?.name;
        return { message: toMessage(r), ...(name ? { conversationName: name } : {}) };
      });
  }

  markRead(channel: ChannelId, id: string): void {
    const c = this.contacts.get(key(channel, id));
    if (!c) return;
    const rows = this.rowsOf(channel, id);
    const last = rows[rows.length - 1];
    c.readThrough = last ? last.ts : Date.now();
    this.persist();
  }

  getKv(k: string): string | undefined {
    return this.kv.get(k);
  }

  setKv(k: string, value: string): void {
    this.kv.set(k, value);
    this.persist();
  }

  close(): void {}

  protected persist(): void {}

  protected load(rows: Row[], contacts: Record<string, Contact>, kv: Record<string, string>): void {
    this.rows = rows;
    this.nextId = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
    this.contacts = new Map(Object.entries(contacts));
    this.kv = new Map(Object.entries(kv));
    this.seen = new Set(rows.filter((r) => r.externalId).map((r) => key(r.channel, r.externalId as string)));
  }

  protected dump(): { version: 1; rows: Row[]; contacts: Record<string, Contact>; kv: Record<string, string> } {
    return { version: 1, rows: this.rows, contacts: Object.fromEntries(this.contacts), kv: Object.fromEntries(this.kv) };
  }
}

/** Fallback store: everything in memory, written to one JSON file after each change. */
export class JsonStore extends MemoryStore {
  override readonly kind: 'json' | 'memory' = 'json';

  constructor(private readonly path: string) {
    super();
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, 'utf8')) as ReturnType<MemoryStore['dump']>;
        this.load(data.rows ?? [], data.contacts ?? {}, data.kv ?? {});
      } catch {
        throw new Error(`Cannot read ${path}: it is not a messaging-mcp JSON store. Move it away or pick another --db path.`);
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
    }
  }

  protected override persist(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.dump()));
    renameSync(tmp, this.path);
  }
}

interface Statement {
  run(...p: unknown[]): { changes: number | bigint };
  get(...p: unknown[]): Record<string, unknown> | undefined;
  all(...p: unknown[]): Record<string, unknown>[];
}
interface Db {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** SQLite store on the built-in node:sqlite module (Node 22.13 and newer). */
export class SqliteStore implements Store {
  readonly kind = 'sqlite' as const;
  private readonly db: Db;

  constructor(path: string, DatabaseSync: new (p: string) => Db) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        external_id TEXT,
        direction TEXT NOT NULL,
        ts INTEGER NOT NULL,
        text TEXT,
        attachments TEXT NOT NULL DEFAULT '[]',
        demo INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS messages_external ON messages (channel, external_id) WHERE external_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages (channel, conversation_id, ts);
      CREATE TABLE IF NOT EXISTS conversations (
        channel TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT,
        username TEXT,
        read_through INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (channel, id)
      );
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  addMessage(msg: NewMessage): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (channel, conversation_id, external_id, direction, ts, text, attachments, demo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.channel,
        msg.conversationId,
        msg.externalId ?? null,
        msg.direction,
        toMs(msg.timestamp),
        msg.text ?? null,
        JSON.stringify(msg.attachments),
        msg.demo ? 1 : 0,
      );
    if (Number(res.changes) === 0) return false;
    this.db
      .prepare(
        `INSERT INTO conversations (channel, id, name, username) VALUES (?, ?, ?, ?)
         ON CONFLICT (channel, id) DO UPDATE SET
           name = COALESCE(excluded.name, conversations.name),
           username = COALESCE(excluded.username, conversations.username)`,
      )
      .run(msg.channel, msg.conversationId, msg.contactName ?? null, msg.contactUsername ?? null);
    return true;
  }

  private rowToMessage(r: Record<string, unknown>): StoredMessage {
    return toMessage({
      id: Number(r.id),
      channel: r.channel as ChannelId,
      conversationId: r.conversation_id as string,
      ...(typeof r.external_id === 'string' ? { externalId: r.external_id } : {}),
      direction: r.direction as 'in' | 'out',
      ts: Number(r.ts),
      ...(typeof r.text === 'string' ? { text: r.text } : {}),
      attachments: JSON.parse(String(r.attachments ?? '[]')) as Attachment[],
      demo: Number(r.demo) === 1,
    });
  }

  private summaryFrom(r: Record<string, unknown>): ConversationSummary {
    const channel = r.channel as ChannelId;
    const id = r.id as string;
    const last = this.db
      .prepare('SELECT text, direction FROM messages WHERE channel = ? AND conversation_id = ? ORDER BY ts DESC, id DESC LIMIT 1')
      .get(channel, id);
    const lastIn = this.db
      .prepare(
        "SELECT external_id FROM messages WHERE channel = ? AND conversation_id = ? AND direction = 'in' ORDER BY ts DESC, id DESC LIMIT 1",
      )
      .get(channel, id);
    return {
      channel,
      id,
      ...(typeof r.name === 'string' ? { name: r.name } : {}),
      ...(typeof r.username === 'string' ? { username: r.username } : {}),
      lastMessageAt: new Date(Number(r.last_ts)).toISOString(),
      ...(typeof last?.text === 'string' ? { lastMessageText: last.text } : {}),
      lastMessageDirection: (last?.direction as 'in' | 'out' | undefined) ?? 'in',
      lastInboundAt: r.last_in === null || r.last_in === undefined ? null : new Date(Number(r.last_in)).toISOString(),
      ...(typeof lastIn?.external_id === 'string' ? { lastInboundExternalId: lastIn.external_id } : {}),
      unread: Number(r.unread),
    };
  }

  private static readonly BASE = `
    SELECT * FROM (
      SELECT c.channel AS channel, c.id AS id, c.name AS name, c.username AS username,
        (SELECT MAX(ts) FROM messages m WHERE m.channel = c.channel AND m.conversation_id = c.id) AS last_ts,
        (SELECT MAX(ts) FROM messages m WHERE m.channel = c.channel AND m.conversation_id = c.id AND m.direction = 'in') AS last_in,
        (SELECT COUNT(*) FROM messages m WHERE m.channel = c.channel AND m.conversation_id = c.id AND m.direction = 'in' AND m.ts > c.read_through) AS unread
      FROM conversations c
    ) AS t WHERE last_ts IS NOT NULL`;

  getConversation(channel: ChannelId, id: string): ConversationSummary | undefined {
    const r = this.db.prepare(`${SqliteStore.BASE} AND channel = ? AND id = ?`).get(channel, id);
    return r ? this.summaryFrom(r) : undefined;
  }

  listConversations(q: ConversationQuery): { total: number; items: ConversationSummary[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.channel) {
      where.push('channel = ?');
      params.push(q.channel);
    }
    if (q.unreadOnly) where.push('unread > 0');
    if (q.query?.trim()) {
      where.push("(LOWER(COALESCE(name, '') || ' ' || COALESCE(username, '') || ' ' || id) LIKE ? ESCAPE '\\')");
      params.push(`%${likeEscape(q.query.trim().toLowerCase())}%`);
    }
    const filter = where.length ? ` AND ${where.join(' AND ')}` : '';
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM (${SqliteStore.BASE}${filter})`).get(...params) as { n: number }).n,
    );
    const rows = this.db
      .prepare(`${SqliteStore.BASE}${filter} ORDER BY last_ts DESC LIMIT ? OFFSET ?`)
      .all(...params, q.limit, q.offset);
    return { total, items: rows.map((r) => this.summaryFrom(r)) };
  }

  getMessages(channel: ChannelId, id: string, q: MessagesQuery): StoredMessage[] {
    const before = q.before ? toMs(q.before) : Number.MAX_SAFE_INTEGER;
    const rows = this.db
      .prepare(
        'SELECT * FROM messages WHERE channel = ? AND conversation_id = ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT ?',
      )
      .all(channel, id, before, q.limit);
    return rows.reverse().map((r) => this.rowToMessage(r));
  }

  searchMessages(q: SearchQuery): SearchHit[] {
    const needle = q.query.trim().toLowerCase();
    if (!needle) return [];
    const params: unknown[] = [`%${likeEscape(needle)}%`];
    let sql = "SELECT m.*, c.name AS contact_name FROM messages m LEFT JOIN conversations c ON c.channel = m.channel AND c.id = m.conversation_id WHERE LOWER(m.text) LIKE ? ESCAPE '\\'";
    if (q.channel) {
      sql += ' AND m.channel = ?';
      params.push(q.channel);
    }
    sql += ' ORDER BY m.ts DESC, m.id DESC LIMIT ?';
    params.push(q.limit);
    return this.db
      .prepare(sql)
      .all(...params)
      .map((r) => ({
        message: this.rowToMessage(r),
        ...(typeof r.contact_name === 'string' ? { conversationName: r.contact_name } : {}),
      }));
  }

  markRead(channel: ChannelId, id: string): void {
    this.db
      .prepare(
        `UPDATE conversations SET read_through = COALESCE(
           (SELECT MAX(ts) FROM messages m WHERE m.channel = conversations.channel AND m.conversation_id = conversations.id), ?)
         WHERE channel = ? AND id = ?`,
      )
      .run(Date.now(), channel, id);
  }

  getKv(k: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(k);
    return typeof r?.value === 'string' ? r.value : undefined;
  }

  setKv(k: string, value: string): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(k, value);
  }

  close(): void {
    this.db.close();
  }
}

/** Loaded through createRequire so bundlers and test runners do not try to resolve the built-in. */
function loadSqlite(): (new (p: string) => Db) | undefined {
  try {
    const mod = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync?: new (p: string) => Db };
    return mod.DatabaseSync;
  } catch {
    return undefined;
  }
}

export interface OpenedStore {
  store: Store;
  /** Set when the SQLite file could not be used and the JSON file store took over. */
  note?: string;
}

/** SQLite when node:sqlite is available, otherwise a JSON file next to the requested path. */
export function openStore(path: string): OpenedStore {
  const DatabaseSync = loadSqlite();
  if (DatabaseSync) return { store: new SqliteStore(path, DatabaseSync) };
  const jsonPath = path.replace(/\.db$/i, '') + '.json';
  return {
    store: new JsonStore(jsonPath),
    note: `node:sqlite is not available in this Node.js version (need 22.13 or newer); using the JSON file ${jsonPath}.`,
  };
}
