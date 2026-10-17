import { AsyncLocalStorage } from 'async_hooks';

export interface ChatContext {
  /** WhatsApp jid of the chat Sofia is replying in (a user id in the CLI test harness). */
  chatId: string,
}

/**
 * The chat Sofia is currently replying in, so tools like `send_sticker_gif` and `view_media` know which chat they act on.
 * Set by SofiaBot around a reply, unset for scheduled tasks.
 */
export const chatContext = new AsyncLocalStorage<ChatContext>();
