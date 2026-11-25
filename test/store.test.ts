import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonStore, MemoryStore, openStore, SqliteStore } from '../src/store.js';
import type { Store } from '../src/types.js';
import { createRequire } from 'node:module';

const dirs: string[] = [];
const stores: Store[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mmcp-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const hasSqlite = (() => {
  try {
    createRequire(import.meta.url)('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

const factories: [string, () => Store][] = [
  ['memory', () => new MemoryStore()],
  ['json', () => new JsonStore(join(tmp(), 'm.json'))],
  ...(hasSqlite ? ([['sqlite', () => openStore(join(tmp(), 'm.db')).store]] as [string, () => Store][]) : []),
];

const T = (m: number) => new Date(Date.UTC(2026, 10, 26, 12, m)).toISOString();

describe.each(factories)('store: %s', (_name, make) => {
  function fresh(): Store {
    const s = make();
    stores.push(s);
    return s;
  }
  function seed(s: Store): void {
    s.addMessage({ channel: 'whatsapp', conversationId: '1', externalId: 'a', direction: 'in', timestamp: T(1), text: 'Where is my order?', attachments: [], contactName: 'Ada' });
    s.addMessage({ channel: 'whatsapp', conversationId: '1', externalId: 'b', direction: 'out', timestamp: T(2), text: 'Shipped today', attachments: [] });
    s.addMessage({ channel: 'whatsapp', conversationId: '1', externalId: 'c', direction: 'in', timestamp: T(3), text: '100% thanks_', attachments: [] });
    s.addMessage({ channel: 'telegram', conversationId: '9', externalId: '9:1', direction: 'in', timestamp: T(5), text: 'ping', attachments: [], contactName: 'Bob', contactUsername: 'bob' });
  }

  it('lists conversations newest first with unread and last inbound', () => {
    const s = fresh();
    seed(s);
    const { total, items } = s.listConversations({ limit: 10, offset: 0 });
    expect(total).toBe(2);
    expect(items.map((c) => c.id)).toEqual(['9', '1']);
    const wa = items[1]!;
    expect(wa.name).toBe('Ada');
    expect(wa.unread).toBe(2);
    expect(wa.lastInboundAt).toBe(T(3));
    expect(wa.lastInboundExternalId).toBe('c');
    expect(wa.lastMessageDirection).toBe('in');
  });

  it('ignores a duplicate external id', () => {
    const s = fresh();
    seed(s);
    const again = s.addMessage({ channel: 'whatsapp', conversationId: '1', externalId: 'a', direction: 'in', timestamp: T(9), text: 'dup', attachments: [] });
    expect(again).toBe(false);
    expect(s.getMessages('whatsapp', '1', { limit: 50 })).toHaveLength(3);
  });

  it('filters by channel, unread and query, and pages', () => {
    const s = fresh();
    seed(s);
    expect(s.listConversations({ channel: 'telegram', limit: 10, offset: 0 }).items).toHaveLength(1);
    expect(s.listConversations({ query: 'ADA', limit: 10, offset: 0 }).items.map((c) => c.id)).toEqual(['1']);
    expect(s.listConversations({ query: 'bob', limit: 10, offset: 0 }).items.map((c) => c.id)).toEqual(['9']);
    expect(s.listConversations({ limit: 1, offset: 1 }).items.map((c) => c.id)).toEqual(['1']);
    s.markRead('whatsapp', '1');
    expect(s.listConversations({ unreadOnly: true, limit: 10, offset: 0 }).items.map((c) => c.id)).toEqual(['9']);
    expect(s.getConversation('whatsapp', '1')?.unread).toBe(0);
  });

  it('returns the newest messages oldest first and pages with before', () => {
    const s = fresh();
    seed(s);
    expect(s.getMessages('whatsapp', '1', { limit: 2 }).map((m) => m.externalId)).toEqual(['b', 'c']);
    expect(s.getMessages('whatsapp', '1', { limit: 5, before: T(3) }).map((m) => m.externalId)).toEqual(['a', 'b']);
  });

  it('searches messages and treats % and _ literally', () => {
    const s = fresh();
    seed(s);
    expect(s.searchMessages({ query: 'ORDER', limit: 10 }).map((h) => h.message.externalId)).toEqual(['a']);
    expect(s.searchMessages({ query: '100%', limit: 10 })).toHaveLength(1);
    expect(s.searchMessages({ query: '%', limit: 10 })).toHaveLength(1);
    expect(s.searchMessages({ query: 'ping', channel: 'whatsapp', limit: 10 })).toHaveLength(0);
    expect(s.searchMessages({ query: 'ada', limit: 10 })).toHaveLength(0);
    expect(s.searchMessages({ query: 'Where', limit: 10 })[0]?.conversationName).toBe('Ada');
  });

  it('stores key value pairs', () => {
    const s = fresh();
    expect(s.getKv('x')).toBeUndefined();
    s.setKv('x', '1');
    s.setKv('x', '2');
    expect(s.getKv('x')).toBe('2');
  });
});

describe('persistence', () => {
  it('json store survives a restart', () => {
    const path = join(tmp(), 'p.json');
    const a = new JsonStore(path);
    a.addMessage({ channel: 'messenger', conversationId: 'u', externalId: 'm1', direction: 'in', timestamp: T(1), text: 'hi', attachments: [] });
    a.setKv('k', 'v');
    const b = new JsonStore(path);
    expect(b.getMessages('messenger', 'u', { limit: 5 })).toHaveLength(1);
    expect(b.getKv('k')).toBe('v');
    expect(b.addMessage({ channel: 'messenger', conversationId: 'u', externalId: 'm1', direction: 'in', timestamp: T(2), attachments: [] })).toBe(false);
  });

  it.skipIf(!hasSqlite)('sqlite store survives a restart', () => {
    const path = join(tmp(), 'p.db');
    const a = openStore(path).store;
    a.addMessage({ channel: 'messenger', conversationId: 'u', externalId: 'm1', direction: 'in', timestamp: T(1), text: 'hi', attachments: [{ type: 'image', url: 'https://x/y.png' }] });
    a.close();
    const b = openStore(path).store;
    expect(b).toBeInstanceOf(SqliteStore);
    const msgs = b.getMessages('messenger', 'u', { limit: 5 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.attachments[0]?.type).toBe('image');
    b.close();
  });
});
