import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pause as defaultPause } from './http.js';

/**
 * Thin Telegram Bot API client on fetch: the methods the bot needs. Messages use parse_mode HTML,
 * so callers escape their text with escapeHtml. The token is part of every URL, therefore errors never
 * carry the URL or the original fetch error — only the method name and Telegram's own description.
 */

export const TELEGRAM_API_URL = 'https://api.telegram.org';
/** Telegram's limit for one message. */
export const MESSAGE_MAX_LENGTH = 4096;

export type TelegramConfig = Readonly<{
  token: string;
  baseUrl?: string;
  /** Timeout of an ordinary request, ms; long polling adds its own wait on top. */
  timeoutMs?: number;
  /** Extra attempts after 429, 5xx or a network error. */
  retries?: number;
  /** Longest wait for retry_after, seconds: a bigger one gives up instead of hanging the bot. */
  maxRetryAfterSeconds?: number;
  pause?: (ms: number, signal: AbortSignal) => Promise<void>;
}>;

export type TelegramChat = Readonly<{ id: number }>;
/** `date` is Unix time in seconds. */
export type TelegramMessage = Readonly<{
  message_id: number; chat: TelegramChat; date?: number; text?: string;
  /** The message this one replies to (the bot reads replies to its question messages). */
  reply_to_message?: TelegramMessage;
}>;
export type TelegramCallbackQuery = Readonly<{ id: string; message?: TelegramMessage; data?: string }>;
export type TelegramUpdate = Readonly<{ update_id: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery }>;

export type InlineButton = Readonly<{ text: string; data: string }>;
export type InlineKeyboard = readonly (readonly InlineButton[])[];
export type MessageOptions = Readonly<{ keyboard?: InlineKeyboard }>;

export class TelegramError extends Error {
  override name = 'TelegramError';
  constructor(readonly method: string, readonly status: number | null, description: string) {
    super(`Telegram ${method}: ${description}`);
  }
}

export interface TelegramClient {
  /** Long polling: waits up to `timeoutSeconds` for updates after `offset`. */
  getUpdates(offset: number, options: Readonly<{ timeoutSeconds: number; signal?: AbortSignal }>): Promise<TelegramUpdate[]>;
  /** Sends the text, split into several messages when it is longer than Telegram allows; returns the last one's id. */
  sendMessage(chatId: number, text: string, options?: MessageOptions): Promise<number>;
  editMessageText(chatId: number, messageId: number, text: string, options?: MessageOptions): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  /** Sends image files as albums of up to ten (one file — a single photo); the caption goes on the first one. */
  sendPhotos(chatId: number, files: readonly string[], caption?: string): Promise<void>;
  /** Replaces the bot's «/» menu: command names without the slash. */
  setMyCommands(commands: ReadonlyArray<Readonly<{ command: string; description: string }>>): Promise<void>;
}

/** Telegram's limit of photos in one album. */
export const ALBUM_MAX_PHOTOS = 10;
/** Telegram's limit of a photo caption. */
export const CAPTION_MAX_LENGTH = 1024;

type ApiResponse<T> = { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };

export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Splits on line breaks where possible; a single overlong line is cut. */
export function splitMessage(text: string, limit = MESSAGE_MAX_LENGTH): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    let rest = line;
    while (rest.length > limit) {
      if (current) { parts.push(current); current = ''; }
      parts.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    const next = current ? `${current}\n${rest}` : rest;
    if (next.length > limit) { parts.push(current); current = rest; } else { current = next; }
  }
  if (current) parts.push(current);
  return parts;
}

const markup = (keyboard: InlineKeyboard | undefined) => (keyboard
  ? { reply_markup: { inline_keyboard: keyboard.map((row) => row.map((button) => ({ text: button.text, callback_data: button.data }))) } }
  : {});

export function createTelegramClient(config: TelegramConfig): TelegramClient {
  const base = (config.baseUrl ?? TELEGRAM_API_URL).replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? 15_000;
  const retries = config.retries ?? 3;
  const maxRetryAfter = config.maxRetryAfterSeconds ?? 300;
  const wait = config.pause ?? defaultPause;

  /** `body`: JSON fields, or a function that builds multipart form data anew for every attempt (file uploads). */
  async function call<T>(method: string, body: Record<string, unknown> | (() => FormData), options: { signal?: AbortSignal; extraMs?: number } = {}): Promise<T> {
    const runSignal = options.signal ?? new AbortController().signal;
    for (let attempt = 0; ; attempt++) {
      let delayMs: number;
      try {
        const response = await fetch(`${base}/bot${config.token}/${method}`, {
          method: 'POST',
          ...(typeof body === 'function' ? { body: body() } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
          signal: AbortSignal.any([runSignal, AbortSignal.timeout(timeoutMs + (options.extraMs ?? 0))]),
        });
        const data = await response.json().catch(() => null) as ApiResponse<T> | null;
        if (response.ok && data?.ok) return data.result as T;
        const description = data?.description ?? `HTTP ${response.status}`;
        if (response.status === 429) {
          const retryAfter = data?.parameters?.retry_after ?? 1;
          if (attempt >= retries || retryAfter > maxRetryAfter) throw new TelegramError(method, 429, description);
          delayMs = retryAfter * 1000;
        } else if (response.status >= 500 && attempt < retries) {
          delayMs = 1000 * 2 ** attempt;
        } else {
          throw new TelegramError(method, response.status, description);
        }
      } catch (error) {
        if (error instanceof TelegramError) throw error;
        if (runSignal.aborted) throw runSignal.reason;
        if (attempt >= retries) {
          const timeout = error instanceof Error && error.name === 'TimeoutError';
          // The fetch error may quote the URL with the token, so it is not passed on.
          throw new TelegramError(method, null, timeout ? 'таймаут' : 'Telegram недоступен');
        }
        delayMs = 1000 * 2 ** attempt;
      }
      await wait(delayMs, runSignal);
    }
  }

  return {
    getUpdates: (offset, options) => call<TelegramUpdate[]>('getUpdates', {
      offset, timeout: options.timeoutSeconds, allowed_updates: ['message', 'callback_query'],
    }, { ...(options.signal ? { signal: options.signal } : {}), extraMs: options.timeoutSeconds * 1000 }),

    async sendMessage(chatId, text, options = {}) {
      const parts = splitMessage(text);
      let messageId = 0;
      for (const [index, part] of parts.entries()) {
        const last = index === parts.length - 1;
        const sent = await call<{ message_id: number }>('sendMessage', {
          chat_id: chatId, text: part, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
          ...(last ? markup(options.keyboard) : {}),
        });
        messageId = sent.message_id;
      }
      return messageId;
    },

    async editMessageText(chatId, messageId, text, options = {}) {
      try {
        await call('editMessageText', {
          chat_id: chatId, message_id: messageId, text: splitMessage(text)[0], parse_mode: 'HTML',
          link_preview_options: { is_disabled: true }, ...markup(options.keyboard),
        });
      } catch (error) {
        // Pressing a button that changes nothing is not an error for the user.
        if (error instanceof TelegramError && error.status === 400 && /not modified/i.test(error.message)) return;
        throw error;
      }
    },

    async answerCallbackQuery(callbackQueryId, text) {
      await call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
    },

    async setMyCommands(commands) {
      await call('setMyCommands', { commands });
    },

    async sendPhotos(chatId, files, caption) {
      for (let start = 0; start < files.length; start += ALBUM_MAX_PHOTOS) {
        const chunk = files.slice(start, start + ALBUM_MAX_PHOTOS);
        const photos = await Promise.all(chunk.map(async (file) => ({ name: path.basename(file), data: await readFile(file) })));
        const text = start === 0 && caption ? splitMessage(caption, CAPTION_MAX_LENGTH)[0]! : null;
        const form = () => {
          const data = new FormData();
          data.set('chat_id', String(chatId));
          if (photos.length === 1) {
            data.set('photo', new Blob([photos[0]!.data]), photos[0]!.name);
            if (text) { data.set('caption', text); data.set('parse_mode', 'HTML'); }
          } else {
            data.set('media', JSON.stringify(photos.map((_photo, index) => ({
              type: 'photo', media: `attach://p${index}`, ...(index === 0 && text ? { caption: text, parse_mode: 'HTML' } : {}),
            }))));
            photos.forEach((photo, index) => data.set(`p${index}`, new Blob([photo.data]), photo.name));
          }
          return data;
        };
        // Uploads take longer than a message.
        await call(photos.length === 1 ? 'sendPhoto' : 'sendMediaGroup', form, { extraMs: 60_000 });
      }
    },
  };
}
