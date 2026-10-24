import { type Logger } from "pino";
import { getTime } from "../utils/common";

export interface BufferOptions {
  /** How long to wait after the last message before running. */
  delayMs: number;
  /** A participant counts as typing for this long after their last `composing` update, unless they stop earlier. */
  typingTimeoutMs: number;
  /** Typing can delay a run by at most this long after the first buffered message. */
  maxWaitMs: number;
}

interface ChatBuffer {
  status: 'WAITING' | 'RUNNING';
  timeout?: NodeJS.Timeout;
  func: () => Promise<void>;
  /** Latest call received while RUNNING, run again once the current run finishes. */
  pending?: () => Promise<void>;
  /** A message arrived while RUNNING that the running reply hasn't been told about yet, see `takeNewMessages`. */
  newWhileRunning?: boolean;
  firstQueuedAt: number;
  lastUpdate: number;
}

/**
 * Waits for a chat to go quiet before replying.
 *
 * Typing is tracked per participant because WhatsApp sends presence updates for one participant at a time.
 * In group chats, checking only the participant in the latest update meant anyone else going idle resumed
 * the buffer while someone was still typing, and a missing `paused` update left the buffer stuck forever.
 */
export class BufferSystem {
  private logger: Logger;
  private options: BufferOptions;
  chatBuffers: { [index: string]: ChatBuffer | undefined } = {};
  /** chat id -> participant -> time their typing status expires */
  private typing: { [index: string]: Map<string, number> | undefined } = {};

  constructor(logger: Logger, options: Partial<BufferOptions> = {}) {
    this.logger = logger;
    this.options = { delayMs: 3000, typingTimeoutMs: 15000, maxWaitMs: 30000, ...options };
  }

  bufferCall(id: string, func: () => Promise<void>) {
    const now = getTime();
    const buffer = this.chatBuffers[id];
    if (!buffer) {
      this.logger.info("Started buffer for " + id);
      this.chatBuffers[id] = { status: 'WAITING', func, firstQueuedAt: now, lastUpdate: now };
    }
    else if (buffer.status == 'RUNNING') {
      this.logger.info("Buffer already running! Will run again after for " + id);
      buffer.pending = func;
      buffer.newWhileRunning = true;
      return;
    }
    else {
      this.logger.info("Buffer already waiting! Re-buffering for " + id);
      buffer.func = func;
      buffer.lastUpdate = now;
    }
    this.schedule(id);
  }

  /**
   * Whether a message arrived in a chat since its reply started (or since the last call), so the running reply can stop
   * and take it into account. The pending run still happens afterwards and finds nothing unseen if it was handled.
   */
  takeNewMessages(id: string): boolean {
    const buffer = this.chatBuffers[id];
    if (buffer?.status != 'RUNNING' || !buffer.newWhileRunning) {
      return false;
    }
    buffer.newWhileRunning = false;
    return true;
  }

  /**
   * Records whether a participant in a chat is typing.
   */
  setTyping(id: string, participant: string, isTyping: boolean) {
    let typers = this.typing[id];
    if (isTyping) {
      typers = this.typing[id] ??= new Map();
      typers.set(participant, getTime() + this.options.typingTimeoutMs);
    }
    else if (typers) {
      typers.delete(participant);
      if (typers.size == 0) {
        delete this.typing[id];
      }
    }
    if (this.chatBuffers[id]?.status == 'WAITING') {
      this.logger.info(`Buffer ${isTyping ? 'paused' : 'resumed'} by ${participant} for ${id}`);
      this.schedule(id);
    }
  }

  /** Returns the earliest time a current typer's status expires, or null if nobody is typing. */
  private earliestTypingExpiry(id: string, now: number): number | null {
    const typers = this.typing[id];
    if (!typers) {
      return null;
    }
    for (const [participant, expiresAt] of typers) {
      if (expiresAt <= now) {
        typers.delete(participant);
      }
    }
    if (typers.size == 0) {
      delete this.typing[id];
      return null;
    }
    return Math.min(...typers.values());
  }

  private schedule(id: string) {
    const buffer = this.chatBuffers[id];
    if (!buffer || buffer.status != 'WAITING') {
      return;
    }
    clearTimeout(buffer.timeout);

    const now = getTime();
    const deadline = buffer.firstQueuedAt + this.options.maxWaitMs;
    const typingExpiry = this.earliestTypingExpiry(id, now);
    let runAt = buffer.lastUpdate + this.options.delayMs;
    if (typingExpiry != null && now < deadline) {
      // Re-check when the earliest typer expires (or at the deadline), schedule() runs again then.
      runAt = Math.max(runAt, Math.min(typingExpiry, deadline));
    }

    buffer.timeout = setTimeout(() => {
      const nowTyping = this.earliestTypingExpiry(id, getTime()) != null;
      if (nowTyping && getTime() < deadline) {
        this.schedule(id);
      }
      else {
        this.run(id);
      }
    }, Math.max(0, runAt - now));
  }

  private run(id: string) {
    const buffer = this.chatBuffers[id];
    if (!buffer) {
      return;
    }
    this.logger.info("Buffer running for " + id);
    buffer.status = 'RUNNING';
    buffer.lastUpdate = getTime();
    buffer.func()
      .catch(e => this.logger.error(e, "Buffered call failed for " + id))
      .finally(() => {
        if (buffer.pending) {
          this.logger.info("Running pending buffer for " + id);
          const now = getTime();
          buffer.func = buffer.pending;
          buffer.pending = undefined;
          buffer.newWhileRunning = false;
          buffer.status = 'WAITING';
          buffer.firstQueuedAt = now;
          buffer.lastUpdate = now;
          this.schedule(id);
        }
        else {
          this.logger.info("Deleting buffer " + id);
          delete this.chatBuffers[id];
        }
      });
  }
}
