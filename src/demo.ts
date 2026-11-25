import type { ChannelAdapter, SendInput, SendResult, TemplateInfo, TemplateSendInput } from './channels/adapter.js';
import type { ChannelId, NewMessage, Store } from './types.js';

let counter = 0;

/** Pretends to send. Nothing leaves this machine. */
export class DemoAdapter implements ChannelAdapter {
  readonly demo = true;
  constructor(
    readonly channel: ChannelId,
    readonly accountId: string,
    readonly accountLabel: string,
  ) {}

  async sendText(_input: SendInput): Promise<SendResult> {
    return { id: `demo_${this.channel}_${++counter}`, demo: true };
  }

  async sendTemplate(_input: TemplateSendInput): Promise<SendResult> {
    return { id: `demo_${this.channel}_${++counter}`, demo: true };
  }

  async listTemplates(): Promise<TemplateInfo[]> {
    return DEMO_TEMPLATES;
  }

  async markRead(): Promise<void> {}
}

export const DEMO_TEMPLATES: TemplateInfo[] = [
  {
    name: 'order_update',
    language: 'en',
    status: 'APPROVED',
    category: 'UTILITY',
    body: 'Hi {{1}}, your order {{2}} has shipped. Tracking: {{3}}',
    parameterCount: 3,
  },
  {
    name: 'order_update',
    language: 'tr',
    status: 'APPROVED',
    category: 'UTILITY',
    body: 'Merhaba {{1}}, {{2}} numaralı siparişiniz kargoya verildi. Takip: {{3}}',
    parameterCount: 3,
  },
  {
    name: 'follow_up',
    language: 'de',
    status: 'APPROVED',
    category: 'UTILITY',
    body: 'Hallo {{1}}, wir melden uns zu Ihrer Anfrage. Haben Sie noch Fragen?',
    parameterCount: 1,
  },
  { name: 'hello_world', language: 'en_US', status: 'APPROVED', category: 'UTILITY', body: 'Hello World', parameterCount: 0 },
];

export const DEMO_ACCOUNTS: Record<ChannelId, { id: string; label: string }> = {
  whatsapp: { id: 'demo-phone-1', label: 'Demo shop (+1 555 0100)' },
  instagram: { id: 'demo-ig-1', label: '@demo.shop' },
  messenger: { id: 'demo-page-1', label: 'Demo Shop page' },
  telegram: { id: '1000000', label: '@demo_shop_bot' },
};

interface SeedMessage {
  /** Minutes before now. */
  ago: number;
  dir: 'in' | 'out';
  text: string;
}
interface SeedConversation {
  channel: ChannelId;
  id: string;
  name: string;
  username?: string;
  messages: SeedMessage[];
}

const SEED: SeedConversation[] = [
  {
    channel: 'whatsapp',
    id: '905551230001',
    name: 'Ayşe Demir',
    messages: [
      { ago: 95, dir: 'in', text: 'Merhaba, 48213 numaralı siparişimi verdim.' },
      { ago: 90, dir: 'out', text: 'Merhaba Ayşe Hanım, siparişinizi aldık, bugün hazırlıyoruz.' },
      { ago: 25, dir: 'in', text: 'Kargoya ne zaman verilir? Cumartesi evde olmayacağım.' },
    ],
  },
  {
    channel: 'whatsapp',
    id: '4915112340002',
    name: 'Jonas Weber',
    messages: [
      { ago: 60 * 24 * 3 + 30, dir: 'in', text: 'Guten Tag, kann ich die Rechnung als PDF bekommen?' },
      { ago: 60 * 24 * 3, dir: 'out', text: 'Klar, wir schicken sie Ihnen per E-Mail zu.' },
    ],
  },
  {
    channel: 'whatsapp',
    id: '5511987650003',
    name: 'Marina Costa',
    messages: [{ ago: 190, dir: 'in', text: 'Olá! Vocês entregam em São Paulo? Qual o prazo?' }],
  },
  {
    channel: 'instagram',
    id: '17841400000000001',
    name: 'Sofía Ramos',
    username: 'sofia.travels',
    messages: [{ ago: 40, dir: 'in', text: 'Hola! ¿Tienen disponible la talla M en azul?' }],
  },
  {
    channel: 'instagram',
    id: '17841400000000002',
    name: 'Kenji Mori',
    username: 'kenji_photo',
    messages: [
      { ago: 60 * 30, dir: 'in', text: 'こんにちは、スタジオの予約は可能ですか？' },
      { ago: 60 * 29, dir: 'out', text: 'こんにちは！今週は土曜日が空いています。' },
      { ago: 60 * 28, dir: 'in', text: '土曜日の午後でお願いします。' },
    ],
  },
  {
    channel: 'messenger',
    id: '5000000000000001',
    name: 'Liam Carter',
    messages: [
      { ago: 130, dir: 'in', text: 'Is the store open on Sunday?' },
      { ago: 120, dir: 'out', text: 'Yes, 10:00 to 18:00.' },
      { ago: 115, dir: 'in', text: 'Great, thanks!' },
    ],
  },
  {
    channel: 'messenger',
    id: '5000000000000002',
    name: 'Chloé Martin',
    messages: [{ ago: 5, dir: 'in', text: 'Bonjour, je voudrais modifier mon adresse de livraison.' }],
  },
  {
    channel: 'telegram',
    id: '700000001',
    name: 'Dmitri Volkov',
    username: 'dvolkov',
    messages: [{ ago: 12, dir: 'in', text: 'Здравствуйте! Подскажите, как продлить подписку?' }],
  },
  {
    channel: 'telegram',
    id: '700000002',
    name: 'Emre Kaya',
    username: 'emrek',
    messages: [
      { ago: 60 * 24 * 6, dir: 'in', text: 'Fiyat listesini alabilir miyim?' },
      { ago: 60 * 24 * 6 - 5, dir: 'out', text: 'Tabii, işte güncel liste: ...' },
    ],
  },
];

/** Fills a store with sample conversations. Timestamps are relative to `now` so windows look realistic. */
export function seedDemo(store: Store, now = Date.now()): number {
  let n = 0;
  for (const c of SEED) {
    for (const m of c.messages) {
      const msg: NewMessage = {
        channel: c.channel,
        conversationId: c.id,
        externalId: `demo-${c.channel}-${c.id}-${m.ago}-${m.dir}`,
        direction: m.dir,
        timestamp: new Date(now - m.ago * 60_000).toISOString(),
        text: m.text,
        attachments: [],
        contactName: c.name,
        ...(c.username ? { contactUsername: c.username } : {}),
        demo: true,
      };
      if (store.addMessage(msg)) n++;
    }
  }
  return n;
}
