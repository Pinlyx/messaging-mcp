export type ErrorCode =
  | 'not_configured'
  | 'read_only'
  | 'invalid_input'
  | 'auth'
  | 'permission'
  | 'rate_limited'
  | 'window_closed'
  | 'recipient'
  | 'template'
  | 'network'
  | 'api_error';

export interface ErrorOptions {
  retryable?: boolean;
  retryAfterSec?: number;
  hint?: string;
  status?: number;
  /** Platform error code, kept for debugging. */
  platformCode?: string | number;
}

/** An error whose message is safe to show to the assistant: it never contains tokens. */
export class MessagingError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSec?: number;
  readonly hint?: string;
  readonly status?: number;
  readonly platformCode?: string | number;

  constructor(code: ErrorCode, message: string, opts: ErrorOptions = {}) {
    super(message);
    this.name = 'MessagingError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    if (opts.retryAfterSec !== undefined) this.retryAfterSec = opts.retryAfterSec;
    if (opts.hint !== undefined) this.hint = opts.hint;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.platformCode !== undefined) this.platformCode = opts.platformCode;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.retryAfterSec !== undefined ? { retryAfterSec: this.retryAfterSec } : {}),
        ...(this.hint ? { hint: this.hint } : {}),
        ...(this.platformCode !== undefined ? { platformCode: this.platformCode } : {}),
      },
    };
  }
}
