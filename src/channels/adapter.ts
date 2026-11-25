import type { ChannelId } from '../types.js';

export interface SendInput {
  /** Phone number, PSID, IGSID or Telegram chat id. */
  to: string;
  text: string;
  /** free_form (inside the reply window) or tag (outside it, with a message tag). */
  kind: 'free_form' | 'tag';
  tag?: string;
  /** Platform id of a message to reply to (quote). */
  replyToId?: string;
}

export interface TemplateSendInput {
  to: string;
  name: string;
  language: string;
  /** Body parameters in order: {{1}}, {{2}}, ... */
  parameters: string[];
}

export interface SendResult {
  /** Platform id of the sent message. */
  id?: string;
  /** True when nothing left this machine (demo mode). */
  demo?: boolean;
}

export interface TemplateInfo {
  name: string;
  language: string;
  status: string;
  category?: string;
  body?: string;
  parameterCount: number;
}

export interface ChannelAdapter {
  readonly channel: ChannelId;
  /** Our own account on the platform: phone number id, page id, IG account id or bot id. */
  readonly accountId: string;
  readonly accountLabel?: string;
  readonly demo: boolean;
  sendText(input: SendInput): Promise<SendResult>;
  sendTemplate?(input: TemplateSendInput): Promise<SendResult>;
  listTemplates?(): Promise<TemplateInfo[]>;
  /** Sends a read receipt upstream. `lastInboundId` is the platform id of the newest inbound message. */
  markRead?(conversationId: string, lastInboundId?: string): Promise<void>;
}
