import P from "pino";
import { Boom } from '@hapi/boom';
import makeWASocket, { fetchLatestBaileysVersion, AuthenticationState, CacheStore, DisconnectReason, generateMessageIDV2, isJidNewsletter, proto, getAggregateVotesInPollMessage, BaileysEventEmitter, WAMessage, jidNormalizedUser } from 'baileys';
import BaileysBottle from 'baileys-bottle-devstroupe';
import NodeCache from '@cacheable/node-cache';
import qrcode from 'qrcode-terminal';
import 'dotenv/config';
import StoreHandle from "baileys-bottle-devstroupe/lib/bottle/StoreHandle";
import { BufferSystem } from './bufferSystem';
import { decideGroupReply, DecisionMsg, ReplyDecision } from './replyDecision';
import type Store from "./store";
import type AI from "./ai";
import type { ChatAdapter } from "./ai";
import { EasyInputMessage, ResponseInput, ResponseInputItem } from "openai/resources/responses/responses.js";


const BOTTLE_STORE_NAME = 'sofia';

/**
 * Binds the baileys-bottle store with two fixes for lost chat history:
 * 1. The bottle's handlers look up a chat's message list and create it if missing. When events for the same chat
 *    are handled concurrently (e.g. history sync chunks and new messages right after logging in), several lists
 *    get created for one chat and `store.messages.all()` only returns one of them, so the rest looks lost.
 *    Running the handlers one at a time prevents this.
 * 2. The bottle drops history sync messages older than 1 day unless the chunk is the latest one, so most of the
 *    history restored after re-linking was thrown away. Mark every chunk as latest so all of it is kept.
 */
export function bindStore(store: StoreHandle, ev: BaileysEventEmitter, logger: P.Logger) {
  let queue: Promise<unknown> = Promise.resolve();
  const proxy = Object.create(ev) as BaileysEventEmitter;
  proxy.on = ((event: string, listener: (data: any) => any) => {
    return ev.on(event as any, (data: any) => {
      const arg = event === 'messaging-history.set' ? { ...data, isLatest: true } : data;
      queue = queue.then(() => listener(arg)).catch(e => logger.error(e, `Store handler for ${event} failed`));
    });
  }) as any;
  store.bind(proxy as any);
}

/**
 * Merges duplicate message lists created by the bottle race described in `bindStore`, so history that was split
 * across them becomes visible again. Duplicate copies of the same message are removed.
 */
export async function mergeDuplicateMessageLists(ds: { query: (sql: string) => Promise<any> }) {
  await ds.query(`
    WITH ranked AS (
      SELECT id, MIN(id) OVER (PARTITION BY jid, "dBAuthId") AS keep_id FROM message_dic
    )
    UPDATE message SET "dictionaryId" = ranked.keep_id
    FROM ranked WHERE message."dictionaryId" = ranked.id AND ranked.id <> ranked.keep_id`);
  await ds.query(`DELETE FROM message_dic d WHERE NOT EXISTS (SELECT 1 FROM message m WHERE m."dictionaryId" = d.id)
    AND EXISTS (SELECT 1 FROM message_dic k WHERE k.jid = d.jid AND k."dBAuthId" = d."dBAuthId" AND k.id < d.id)`);
  await ds.query(`DELETE FROM message m USING message o
    WHERE m."dictionaryId" = o."dictionaryId" AND m."msgId" = o."msgId" AND m.id > o.id`);
}

export interface PreProccessChatMsg {
  id?: string,
  user?: 'AI' | string | null,
  time: number,
  text: string,
  quotedMessage?: string | null,
  /** Sofia was @mentioned in this message. */
  mentionsAI?: boolean,
  /** This message replies to (quotes) one of Sofia's messages. */
  quotesAI?: boolean,
}


// --- Bot Class Definition ---
export class SofiaBot implements ChatAdapter {
  sock?: ReturnType<typeof makeWASocket>;
  private logger: P.Logger; // Type assertion for local use
  bottle?: Awaited<ReturnType<typeof BaileysBottle.init>>;
  authState?: AuthenticationState;
  ai: AI;
  db: Store;
  store?: StoreHandle;
  bufferSystem: BufferSystem;
  /** Chat id -> the newest message Sofia has seen (replied to, chose not to reply to, or saw mid-reply). In memory only. */
  private lastSeen: { [chatId: string]: { id?: string, time: number } | undefined } = {};
  private saveAuthState?: () => Promise<any>;
  private bottleDataSource?: Awaited<ReturnType<Awaited<ReturnType<typeof BaileysBottle.init>>['createStore']>>['_ds'];


  constructor(loggerInstance: P.Logger, ai: AI, db: Store) {
    this.logger = loggerInstance;
    this.bufferSystem = new BufferSystem(loggerInstance);
    this.ai = ai;
    this.db = db;
    this.ai.registerChatTools(this);
  }

  async connect(force: boolean = false): Promise<void> {
    if (this.sock && !force) {
      this.logger.warn("Bot is already connected.");
      return;
    }

    this.logger.info("Initializing SofiaBot connection...");

    if (!process.env.BAILEYS_BOTTLE_SQL_DATABASE_URL) {
      this.logger.fatal(`Environment variable 'BAILEYS_BOTTLE_SQL_DATABASE_URL' is not defined`);
      throw Error(`Environment variable 'BAILEYS_BOTTLE_SQL_DATABASE_URL' is not defined`);
    }

    this.bottle = await BaileysBottle.init({
      type: 'postgres',
      url: process.env.BAILEYS_BOTTLE_SQL_DATABASE_URL
    });

    const msgRetryCounterCache = new NodeCache() as CacheStore;

    // fetch latest version of WA Web
    const { version, isLatest } = await fetchLatestBaileysVersion();
    this.logger.info(`Using WhatsApp v${version.join('.')}, isLatest: ${isLatest}`);

    const { auth, store, _ds } = await this.bottle.createStore(BOTTLE_STORE_NAME);
    this.store = store;
    this.bottleDataSource = _ds;
    try {
      await mergeDuplicateMessageLists(_ds);
    }
    catch (e) {
      this.logger.error(e, 'Failed to merge duplicate message lists');
    }
    const { state: authState, saveState: saveAuthState } = await auth.useAuthHandle();
    this.authState = authState as AuthenticationState;
    this.saveAuthState = saveAuthState;

    this.sock = makeWASocket({
      version,
      logger: this.logger,
      auth: authState as AuthenticationState,
      generateHighQualityLinkPreview: true,
      msgRetryCounterCache,
      // Keep every history sync chunk (Baileys skips FULL syncs by default) so history is restored after re-linking.
      shouldSyncHistoryMessage: () => true,
    });

    bindStore(store, this.sock.ev, this.logger);

    // ------------------------------------------------------------------
    // Event Handling Logic
    // ------------------------------------------------------------------
    this.setupEventHandlers();
    // ------------------------------------------------------------------

    this.logger.info("Bot connection setup complete. Awaiting WA events...");
  }

  /**
   * Clears the stored WhatsApp credentials while keeping the chats, contacts and messages linked to the store.
   */
  async resetAuthCredentials() {
    if (!this.bottleDataSource) {
      return;
    }
    await this.bottleDataSource.getRepository('Auth').update({ key: BOTTLE_STORE_NAME }, { value: '' });
  }

  private setupEventHandlers() {
    if (!this.sock) {
      throw Error("Socket not ready!")
    }
    this.sock.ev.process(
      async (events) => {
        // connection update handler
        if (events['connection.update']) {
          const update = events['connection.update'];
          const { connection, lastDisconnect, qr } = update;
          if (connection === 'close') {
            if ((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
              this.logger.warn("Connection lost, attempting to reconnect...");
              setTimeout(() => this.connect(true), 5000); // Use setTimeout instead of direct recursive call
            } else {
              // Only reset the credentials. Deleting the bottle's auth row to re-link would cascade delete
              // every stored chat and message, which wipes Sofia's chat history.
              this.logger.fatal('Connection closed. You are logged out. Clearing credentials, scan the new QR code to log in again.');
              await this.resetAuthCredentials();
              setTimeout(() => this.connect(true), 5000);
            }
          }

          if (connection === 'open') {
            // The logger writes to log.log, so print to the console too to show up in `docker compose logs -f sofia`.
            console.log(`[${new Date().toISOString()}] Sofia is connected to WhatsApp and ready (${this.sock?.user?.id}).`);
            this.logger.info(`Connected to WhatsApp as ${this.sock?.user?.id}`);
          }

          if (qr) {
            console.log("\n=================================");
            console.log("Scan to login to WhatsApp:");
            qrcode.generate(update.qr!, { small: true });
            console.log("=============================");
          }
          this.logger.debug(update, 'connection update');
        }

        // credentials update handler
        if (events['creds.update']) {
          await this.saveAuthState!();
          this.logger.debug({}, 'creds save triggered');
        }

        // messages upsert handler
        if (events['messages.upsert']) {
          const upsert = events['messages.upsert'];
          this.logger.debug(upsert, 'messages.upsert fired');

          if (upsert.type === 'notify') {
            for (const msg of upsert.messages) {
              if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
                const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

                if (text === "requestPlaceholder" && !upsert.requestId) {
                  try {
                    const messageId = await this.sock!.requestPlaceholderResend(msg.key);
                    this.logger.info(`Requested placeholder resync for key ${msg.key.id}`);
                  } catch (e) {
                    this.logger.error(e, 'Error requesting placeholder resend');
                  }
                }

                if (text === "onDemandHistSync") {
                  try {
                    await this.sock!.fetchMessageHistory(50, msg.key, msg.messageTimestamp!);
                    this.logger.info(`Requested on-demand history resync from ${msg.key.remoteJid}`);
                  } catch (e) {
                    this.logger.error(e, 'Error requesting history sync');
                  }
                }

                if ((!process.env.TESTING || process.env.TESTING.toLowerCase() != "true") && !msg.key.fromMe && !isJidNewsletter(msg.key?.remoteJid!)) {
                  try {
                    const id = generateMessageIDV2(this.sock!.user?.id);
                    this.logger.info(msg, `Received Message from Chat: ${msg.key.remoteJidAlt || this.parseJid(msg.key.remoteJid)}`)
                    if (msg.key.remoteJid) {
                      await this.sock!.presenceSubscribe(msg.key.remoteJid); // Subscribe to precense updates so that it can see who is typing...
                      await this.sock!.readMessages([msg.key]);
                      // The sender just sent a message so they are no longer typing.
                      this.bufferSystem.setTyping(msg.key.remoteJid, msg.key.participant || msg.key.remoteJid, false);
                      this.bufferSystem.bufferCall(msg.key.remoteJid, (async () => {
                        const isGroup = msg.key.remoteJid!.endsWith('@g.us');
                        let stopTyping: (() => Promise<void>) | undefined;
                        try {
                          const chatHistory = await this.loadChat(msg.key.remoteJid!, msg.key.remoteJidAlt);
                          const unseen = this.unseenMessages(msg.key.remoteJid!, chatHistory);
                          this.markSeen(msg.key.remoteJid!, chatHistory);
                          if (unseen.messages.length) {
                            let replyHint: string | undefined;
                            if (isGroup) {
                              const decision = await this.shouldReplyInGroup(chatHistory, unseen.known ? unseen.messages : []);
                              if (decision.short) {
                                replyHint = 'The latest message is just a small thanks, acknowledgement or sign-off to you. Reply with one short message (or just a sticker or GIF), do not start a new topic.';
                              }
                              if (!decision.reply) {
                                this.logger.info(`Not replying in ${msg.key.remoteJid}: ${decision.reason}`);
                                return;
                              }
                            }
                            // Only show typing once Sofia has decided to reply.
                            stopTyping = this.keepTyping(msg.key.remoteJid!);
                            let [chatHistoryParsed, lastMsgId] = await this.formatHistory(chatHistory, unseen.messages);
                            this.logger.trace(chatHistoryParsed);
                            let systemPrompt;
                            if (msg.key.remoteJid && msg.key.remoteJid.endsWith('@g.us')) {
                              let grpName = (await this.store?.contacts.id(msg.key.remoteJid))?.name || "Unknown Group Chat";
                              systemPrompt = await this.ai.generatePrompt('group', grpName, msg.key.remoteJid);
                            }
                            else if (msg.key.remoteJidAlt) {
                              const current_user = await this.db.user.getUserByJid(msg.key.remoteJidAlt)
                              if (!current_user) {
                                await this.sock!.sendMessage(msg.key.remoteJid!, { text: "Error: Unknown User. Please contact Azlan for access!" })
                                this.logger.error(`Unknown user with jid ${msg.key.remoteJid}  ${msg.key.remoteJidAlt}`);
                                return;
                              }
                              systemPrompt = await this.ai.generatePrompt('chat', current_user?.name, current_user?.id, current_user?.description)
                            }
                            else {
                              this.logger.error(`Unknown chat ${msg.key.remoteJid}  ${msg.key.remoteJidAlt}`);
                              return;
                            }
                            let firstMsg = true;
                            const streamGenerator = this.ai.processChatv3([{
                              role: 'system',
                              content: systemPrompt
                            } as EasyInputMessage, ...(chatHistoryParsed as Array<ResponseInputItem>), ...(replyHint ? [{ role: 'system', content: replyHint } as EasyInputMessage] : [])],
                              undefined, {}, () => this.messagesDuringReply(msg.key.remoteJid!, msg.key.remoteJidAlt));

                            const replyMsg: WAMessage = {
                              message: {
                                conversation: `I am an AI Agent`
                              },
                              key: {
                                id: 'autoCmd' + Math.floor(process.uptime()),
                                remoteJid: '120364402285813629@g.us', // Random Group ID, probably invalid,
                                fromMe: false,
                                participant: this.sock!.user?.lid,
                              },
                              messageTimestamp: Math.floor((new Date()).getTime() / 1000),
                              pushName: 'Sofia',
                              broadcast: false,
                            };

                            // Consume the generator stream manually to control output
                            for await (const yieldState of streamGenerator) {
                              if (yieldState.type === 'chunk_display') {
                                process.stdout.write(yieldState.content as string);
                                if (yieldState.delimiter) {
                                  process.stdout.write("\n-------------------------------\n");
                                }
                                let newMsg;
                                if (firstMsg) {
                                  newMsg = await this.sock!.sendMessage(msg.key.remoteJid!, { text: yieldState.content as string }, { quoted: replyMsg });
                                  firstMsg = false;
                                }
                                else {
                                  newMsg = await this.sock!.sendMessage(msg.key.remoteJid!, { text: yieldState.content as string })
                                }
                                lastMsgId = newMsg?.key.id as string | undefined;
                                await this.sock!.sendPresenceUpdate('composing', msg.key.remoteJid!);
                              } else if (yieldState.type === 'done') {
                                break; // Exit the loop after the full content is collected
                              } else if (yieldState.type === 'tool_call' || yieldState.type == 'tool_call_output' || yieldState.type == 'reasoning') {
                                if (!lastMsgId) {
                                  this.logger.error("ERROR: No Last Message ID, Tool call and reasoning data not saved!");
                                }
                                else {
                                  const newToolCallHist = await this.db.toolCallHist.create({
                                    id: undefined,
                                    whatsapp_chat: msg.key.remoteJidAlt || msg.key.remoteJid!,
                                    aftId: lastMsgId,
                                    data: (yieldState as any).data,
                                  })
                                  lastMsgId = newToolCallHist.id;
                                }
                              }
                            }
                          }
                        }
                        catch (e) {
                          this.logger.error(e);
                        }
                        finally {
                          await stopTyping?.();
                        }
                      }).bind(this));
                    } else {
                      this.logger.error('Error getting msg.key.remoteJid, value is null or undefined!');
                    }
                  } catch (e) {
                    this.logger.error(e);
                  }
                }
              }
            }
          }
        }

        // Presence Update (Is someone typing?)
        if (events['presence.update']) {
          const precense = events['presence.update']
          // console.dir(precense)
          this.logger.info(precense, "GOT PRESENCE")
          // Each update only contains the participants whose presence changed, so track them individually.
          for (const [participant, p] of Object.entries(precense.presences)) {
            if (this.isOwnJid(participant)) {
              continue;
            }
            this.bufferSystem.setTyping(precense.id, participant, p.lastKnownPresence == 'composing' || p.lastKnownPresence == 'recording');
          }
        }

        // status update handler
        if (events['messages.update']) {
          this.logger.debug(events['messages.update'], 'messages.update fired');
        }
        // ... existing code ...
      }
    );
  }

  /**
   * Shows Sofia as typing in a chat until the returned function is called. WhatsApp clears the typing status after
   * a while even if `paused` is never sent, so it is re-sent every 7 seconds while Sofia is still working on a reply.
   */
  private keepTyping(jid: string): () => Promise<void> {
    const send = (presence: 'composing' | 'paused') => this.sock?.sendPresenceUpdate(presence, jid)
      .catch(e => this.logger.warn(e, `Failed to send ${presence} presence to ${jid}`));
    send('composing');
    const interval = setInterval(() => send('composing'), 7000);
    return async () => {
      clearInterval(interval);
      await send('paused');
    };
  }

  /** The messages after `seen` in a chat history (by id, or by time if that message is not in the history). */
  private messagesAfter(history: PreProccessChatMsg[], seen: { id?: string, time: number }) {
    const index = seen.id ? history.findIndex(m => m.id == seen.id) : -1;
    return index >= 0 ? history.slice(index + 1) : history.filter(m => m.time > seen.time);
  }

  /**
   * Messages from others that Sofia has not seen yet. These can sit between Sofia's own messages when they were sent while
   * she was replying. Without a record for the chat (e.g. after a restart) it falls back to the messages after Sofia's
   * last message, and `known` is false.
   */
  unseenMessages(chatId: string, history: PreProccessChatMsg[]): { messages: PreProccessChatMsg[], known: boolean } {
    const seen = this.lastSeen[chatId];
    if (!seen) {
      let start = history.length;
      while (start > 0 && history[start - 1].user != 'AI') {
        start--;
      }
      return { messages: history.slice(start), known: false };
    }
    return { messages: this.messagesAfter(history, seen).filter(m => m.user != 'AI'), known: true };
  }

  /** Records the newest message in `history` as seen by Sofia. */
  markSeen(chatId: string, history: PreProccessChatMsg[]) {
    const newest = history[history.length - 1];
    if (newest) {
      this.lastSeen[chatId] = { id: newest.id, time: newest.time };
    }
  }

  /**
   * Formats the chat history for the model. Unseen messages sent while Sofia was still replying sit before the end of
   * her reply, which makes them look answered, so they are moved after it with a note.
   */
  async formatHistory(history: PreProccessChatMsg[], unseen: PreProccessChatMsg[]): Promise<[ResponseInputItem[], string?]> {
    const unseenSet = new Set(unseen);
    const firstUnseen = history.findIndex(m => unseenSet.has(m));
    const interleaved = firstUnseen >= 0 && history.slice(firstUnseen).some(m => m.user == 'AI');
    if (!interleaved) {
      return this.db.user.formatAndMergeMessages(history, 12); // Limit to 12 messages.
    }
    const [earlier] = await this.db.user.formatAndMergeMessages(history.filter(m => !unseenSet.has(m)), 12);
    const [later, lastMsgId] = await this.db.user.formatAndMergeMessages(unseen, 12);
    return [[
      ...earlier,
      { role: 'system', content: "The messages below were sent while you were still replying, so you hadn't seen them yet.", type: 'message' } as EasyInputMessage,
      ...later,
    ], lastMsgId];
  }

  /**
   * Called by `processChatv3` after tool calls: returns messages sent in the chat since Sofia started replying (with a
   * note) so she can answer them in the same reply, instead of the queued buffer run replying again afterwards.
   */
  async messagesDuringReply(chatId: string, chatIdAlt?: string | null): Promise<ResponseInputItem[]> {
    const history = await this.loadChat(chatId, chatIdAlt || undefined);
    const fresh = this.unseenMessages(chatId, history);
    if (!fresh.known || !fresh.messages.length) {
      return [];
    }
    this.markSeen(chatId, history);
    const [formatted] = await this.db.user.formatAndMergeMessages(fresh.messages, 12);
    const groupNote = chatId.endsWith('@g.us') ? " (in a group chat, only if they're meant for you)" : '';
    return [
      { role: 'system', content: `New messages arrived while you were replying. You haven't responded to them yet. Answer them in this reply if they need it${groupNote}.`, type: 'message' } as EasyInputMessage,
      ...formatted,
    ];
  }

  /**
   * Decides whether Sofia should reply to the `unseen` messages in a group chat, see `decideGroupReply`.
   * With no `unseen` messages given (e.g. after a restart), only the latest messages are judged.
   */
  private async shouldReplyInGroup(chatHistory: PreProccessChatMsg[], unseen: PreProccessChatMsg[]): Promise<ReplyDecision> {
    const unseenSet = new Set(unseen);
    const recent = chatHistory.slice(-40);
    const names = new Map<string, Promise<string>>();
    const getName = (jid: string) => {
      if (!names.has(jid)) {
        names.set(jid, this.db.user.getUserByJid(jid).then(u => u?.name ?? `Unknown User (${jid.split('@')[0].slice(-4)})`));
      }
      return names.get(jid)!;
    };
    const messages: DecisionMsg[] = await Promise.all(recent.map(async m => ({
      speaker: m.user == 'AI' ? null : m.user ? await getName(m.user) : 'Unknown User',
      time: m.time,
      text: m.text,
      quotedMessage: m.quotedMessage,
      mentionsAI: m.mentionsAI,
      quotesAI: m.quotesAI,
      isNew: unseenSet.has(m),
    })));
    const decision = await decideGroupReply(messages);
    this.logger.info({ reply: decision.reply, reason: decision.reason, answers: decision.answers }, 'Group reply decision');
    return decision;
  }

  /** Whether a jid (phone number or lid, any device) belongs to Sofia's own account. */
  private isOwnJid(jid?: string | null) {
    if (!jid) {
      return false;
    }
    const ownJids = [this.sock?.user?.id, this.sock?.user?.lid].filter(j => j).map(j => jidNormalizedUser(j!));
    return ownJids.includes(jidNormalizedUser(jid));
  }

  public parseJid(jid?: string | null) {
    if (!jid) {
      return null;
    }
    else if (!jid.includes(':')) {
      return jid;
    }
    const colon_index = jid.indexOf(':');
    const a_index = jid.indexOf('@');
    return jid.slice(0, colon_index) + jid.slice(a_index)
  }

  public shortenQuotedText(text: string | null | undefined) {
    if (text && text.length > 50) {
      return text.slice(0, 48) + "..."
    }
    return text;
  }

  public async loadChat(remoteJid: string, remoteJidAlt?: string): Promise<PreProccessChatMsg[]> {
    if (!this.store || !this.sock) {
      this.logger.error(`Bot is not connected. Failed to process ${remoteJid} aka ${remoteJidAlt}`);
      return [];
    }

    let messages = (await this.store.messages.all(remoteJidAlt || remoteJid)) || []
    if (remoteJidAlt && remoteJidAlt != remoteJid) {
      messages = [...messages, ...((await this.store.messages.all(remoteJid)) || [])]
    }
    const parseMentions = async (m: WAMessage | proto.IMessage, text?: string | null) => {
      if (!text) {
        return text;
      }
      let mentionedJids;
      if ('message' in m) {
        if (m.message?.extendedTextMessage?.contextInfo?.mentionedJid) {
          mentionedJids = m.message.extendedTextMessage.contextInfo.mentionedJid;
        }
        else if (m.message?.videoMessage?.contextInfo?.mentionedJid) {
          mentionedJids = m.message.videoMessage.contextInfo.mentionedJid;
        }
        // else if (m.message?.audioMessage?.contextInfo?.mentionedJid){
        //   mentionedJids = m.message.audioMessage.contextInfo.mentionedJid;
        // }
        else if (m.message?.imageMessage?.contextInfo?.mentionedJid) {
          mentionedJids = m.message.imageMessage.contextInfo.mentionedJid
        }
      }
      else if ('extendedTextMessage' in m && m.extendedTextMessage?.contextInfo?.mentionedJid) {
        mentionedJids = m.extendedTextMessage.contextInfo.mentionedJid;
      }
      else if ('videoMessage' in m && m.videoMessage?.contextInfo?.mentionedJid) {
        mentionedJids = m.videoMessage.contextInfo.mentionedJid;
      }
      // else if ('audioMessage' in m && m.audioMessage?.contextInfo?.mentionedJid){
      //   mentionedJids = m.audioMessage.contextInfo.mentionedJid;
      // }
      else if ('imageMessage' in m && m.imageMessage?.contextInfo?.mentionedJid) {
        mentionedJids = m.imageMessage.contextInfo.mentionedJid
      }
      if (mentionedJids) {
        for (let i = 0; i < mentionedJids.length; i++) {
          if (this.isOwnJid(mentionedJids[i])) {
            text = text.replaceAll(`@${mentionedJids[i].replace(/@.*$/, '')}`, '@Sofia');
            continue;
          }
          let user;
          const jid_parsed = this.parseJid(await this.sock!.signalRepository.lidMapping.getPNForLID(mentionedJids[i]));
          if (jid_parsed) {
            user = (await this.db.user.getUserByJid(jid_parsed))?.name;
          }
          text = text.replaceAll(`@${mentionedJids[i].replace('@lid', '')}`, `@${user ? user : "Unknown User"}`)
        }
      }
      return text;
    };
    const getText = (m: WAMessage) => m.message?.stickerMessage ? `<WhatsApp Sticker Or GIF>` : m.message?.videoMessage ? `<WhatsApp Video> ${m.message.videoMessage.caption || ""}` : m.message?.imageMessage ? `<WhatsApp Image> ${m.message.imageMessage.caption || ""}` : m.message?.conversation || m.message?.extendedTextMessage?.text;
    const getQuotedText = (q: proto.IMessage) => this.shortenQuotedText(q.stickerMessage ? `<WhatsApp Sticker Or GIF>` : q?.videoMessage ? `<WhatsApp Video> ${q.videoMessage.caption || ""}` : q.imageMessage ? `<WhatsApp Image> ${q.imageMessage.caption || ""}` : q.conversation || q.extendedTextMessage?.text);
    const getContextInfo = (m: WAMessage) => m.message?.extendedTextMessage?.contextInfo || m.message?.imageMessage?.contextInfo || m.message?.videoMessage?.contextInfo || m.message?.stickerMessage?.contextInfo;
    const toChatMsg = async (m: WAMessage, user: string | null): Promise<PreProccessChatMsg> => {
      const contextInfo = getContextInfo(m);
      return {
        id: m.key.id || undefined,
        user,
        time: (m.messageTimestamp as any).low || m.messageTimestamp,
        text: await parseMentions(m, getText(m)) as string,
        quotedMessage: m.message?.extendedTextMessage?.contextInfo?.quotedMessage ? await parseMentions(m.message.extendedTextMessage.contextInfo.quotedMessage, getQuotedText(m.message.extendedTextMessage.contextInfo.quotedMessage)) : null,
        mentionsAI: !!contextInfo?.mentionedJid?.some(j => this.isOwnJid(j)),
        quotesAI: !!contextInfo?.quotedMessage && this.isOwnJid(contextInfo.participant),
      };
    };
    const isGroup = remoteJid.endsWith("@g.us");
    return (await Promise.all(messages.map(async (m: WAMessage) => toChatMsg(m, m.key.fromMe ? "AI" : this.parseJid(isGroup ? (remoteJidAlt || await this.sock!.signalRepository.lidMapping.getPNForLID(m.participant || m.key.participant || "")) : remoteJidAlt)))))
      .filter((c: any) => c.text != undefined).sort((a: any, b: any) => a.time - b.time);
  }

  // ------------------------------------------------------------------
  // ChatAdapter implementation (used by the AI chat tools)
  // ------------------------------------------------------------------

  /**
   * Sends a text message to a user id or group id (ending with `@g.us`).
   */
  public async sendMessage(id: string, text: string): Promise<void> {
    if (!this.sock) {
      throw Error("Bot is not connected.");
    }
    let jid = id;
    if (!id.endsWith('@g.us')) {
      const user = await this.db.user.findById(id);
      if (!user) {
        throw Error(`Unknown user with id ${id}`)
      }
      jid = user.whatsapp_jid;
    }
    const replyMsg: WAMessage = {
      message: {
        conversation: `I am an AI Agent`
      },
      key: {
        id: 'autoCmd' + Math.floor(process.uptime()),
        remoteJid: id.endsWith('@g.us') ? id : '120364402285813629@g.us', // Random Group ID, probably invalid
        fromMe: false,
        participant: this.sock.user?.lid,
      },
      messageTimestamp: Math.floor((new Date()).getTime() / 1000),
      pushName: 'Sofia',
      broadcast: false,
    };
    await this.sock.sendMessage(jid, { text }, { quoted: replyMsg });
  }

  public async listGroups(): Promise<{ id: string, name: string }[]> {
    return Object.values(await this.sock!.groupFetchAllParticipating()).map(g => ({
      id: g.id, name: g.subject//, description: g.desc
    }));
  }

  /**
   * Loads chat history by user id or group id. Messages from a user are stored under their phone number JID,
   * while messages sent to them may be stored under their LID, so both are loaded.
   */
  public async loadChatById(id: string): Promise<PreProccessChatMsg[]> {
    if (id.endsWith('@g.us')) {
      return this.loadChat(id);
    }
    const user = await this.db.user.findById(id);
    if (!user) {
      throw Error(`Unknown user with id ${id}`);
    }
    const lid = await this.sock?.signalRepository.lidMapping.getLIDForPN(user.whatsapp_jid);
    return this.loadChat(lid || user.whatsapp_jid, user.whatsapp_jid);
  }
}

// // Initialize logger and bot instance
// const logger = P({
//   level: "trace",
//   transport: {
//     targets: [
//       {
//         target: "pino-pretty",
//         options: { colorize: true },
//         level: "trace",
//       },
//       {
//         target: "pino/file",
//         options: { destination: './wa-logs.txt' },
//         level: "trace",
//       },
//     ],
//   },
// });

// export const sofiaBot = new SofiaBot(logger);

// // --- Runner Function ---
// export async function runBot() {
//   try {
//     await sofiaBot.connect();
//     // Keep the process alive
//     process.on('SIGINT', async () => {
//       logger.info("Process shutting down...");
//       if (sofiaBot.sock) {
//         await sofiaBot.sock.end();
//       }
//       process.exit(0);
//     });
//   } catch (error) {
//     logger.fatal("Failed to run bot:", error);
//     process.exit(1);
//   }
// }

// // To make it callable as a script entry point:
// // runBot();