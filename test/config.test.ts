import { describe, expect, it } from 'vitest';
import { defaultDbDir, parseArgs } from '../src/config.js';

function run(argv: string[], env: Record<string, string> = {}) {
  const r = parseArgs(argv, env);
  if (r.kind !== 'run') throw new Error('expected run');
  return r.config;
}

describe('configuration', () => {
  it('switches a channel on only when all its variables are set', () => {
    const c = run([], {
      WHATSAPP_ACCESS_TOKEN: 'a',
      WHATSAPP_PHONE_NUMBER_ID: '1',
      MESSENGER_PAGE_ACCESS_TOKEN: 'only-token',
      TELEGRAM_BOT_TOKEN: '1:abc',
    });
    expect(c.whatsapp).toEqual({ accessToken: 'a', phoneNumberId: '1' });
    expect(c.messenger).toBeUndefined();
    expect(c.instagram).toBeUndefined();
    expect(c.telegram?.botToken).toBe('1:abc');
    expect(c.warnings.join(' ')).toMatch(/Messenger is off/);
  });

  it('stays quiet about channels that are not configured at all', () => {
    expect(run([], {}).warnings).toEqual([]);
  });

  it('reads flags in both spellings', () => {
    const c = run(['--demo', '--read-only', '--webhook-port=9000', '--db', '/tmp/x.db'], {});
    expect(c).toMatchObject({ demo: true, readOnly: true, webhookPort: 9000, dbPath: '/tmp/x.db' });
  });

  it('uses MESSAGING_MCP_DB and falls back to the user data folder', () => {
    expect(run([], { MESSAGING_MCP_DB: '/data/m.db' }).dbPath).toBe('/data/m.db');
    expect(run([], {}).dbPath).toMatch(/messaging-mcp/);
    expect(defaultDbDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32')).toMatch(/messaging-mcp$/);
    expect(defaultDbDir({ XDG_DATA_HOME: '/xdg' }, 'linux')).toMatch(/xdg.messaging-mcp$/);
  });

  it('derives a stable Telegram webhook secret and requires a port and https', () => {
    const env = { TELEGRAM_BOT_TOKEN: '1:abc' };
    const a = run(['--webhook-port', '8787', '--telegram-webhook', 'https://x.example'], env);
    const b = run(['--webhook-port', '8787', '--telegram-webhook', 'https://x.example'], env);
    expect(a.telegram?.webhookSecret).toBe(b.telegram?.webhookSecret);
    expect(a.telegram?.webhookSecret).toMatch(/^[a-f0-9]{48}$/);
    expect(() => parseArgs(['--telegram-webhook', 'https://x.example'], env)).toThrow(/webhook-port/);
    expect(() => parseArgs(['--webhook-port', '1', '--telegram-webhook', 'http://x.example'], env)).toThrow(/https/);
  });

  it('warns when the webhook receiver cannot verify signatures', () => {
    const c = run(['--webhook-port', '8787'], { WHATSAPP_ACCESS_TOKEN: 'a', WHATSAPP_PHONE_NUMBER_ID: '1' });
    expect(c.warnings.join(' ')).toMatch(/META_APP_SECRET/);
    expect(c.warnings.join(' ')).toMatch(/META_VERIFY_TOKEN/);
  });

  it('rejects unknown flags and bad ports, and handles help and version', () => {
    expect(() => parseArgs(['--nope'], {})).toThrow(/Unknown option/);
    expect(() => parseArgs(['--webhook-port', 'abc'], {})).toThrow(/port/);
    expect(parseArgs(['--help'], {}).kind).toBe('help');
    expect(parseArgs(['-v'], {}).kind).toBe('version');
  });

  it('ignores channel variables in demo mode', () => {
    const c = run(['--demo'], { WHATSAPP_ACCESS_TOKEN: 'a', WHATSAPP_PHONE_NUMBER_ID: '1' });
    expect(c.whatsapp).toBeUndefined();
  });
});
