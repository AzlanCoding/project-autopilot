import P from "pino";
import { Boom } from '@hapi/boom';
import makeWASocket, { fetchLatestBaileysVersion, AuthenticationState, CacheStore, DisconnectReason, generateMessageIDV2, isJidNewsletter, proto, getAggregateVotesInPollMessage, BaileysEventEmitter, WAMessage } from 'baileys';
import BaileysBottle from 'baileys-bottle-devstroupe';
import NodeCache from '@cacheable/node-cache';
import qrcode from 'qrcode-terminal';
import 'dotenv/config';
import StoreHandle from "baileys-bottle-devstroupe/lib/bottle/StoreHandle";
import { BufferSystem } from './bufferSystem';
import type Store from "./store";
import type AI from "./ai";
import { ExtendedDynamicStructuredTool } from "./ai";
import { SystemMessage } from 'langchain';
import z from "zod";
import { EasyInputMessage, ResponseInput, ResponseInputItem } from "openai/resources/responses/responses.js";


export interface PreProccessChatMsg {
  id?: string,
  user?: 'AI' | string | null,
  time: number,
  text: string,
  quotedMessage?: string | null
}


// --- Bot Class Definition ---
export class SofiaBot {
  sock?: ReturnType<typeof makeWASocket>;
  private logger: P.Logger; // Type assertion for local use
  bottle?: Awaited<ReturnType<typeof BaileysBottle.init>>;
  authState?: AuthenticationState;
  ai: AI;
  db: Store;
  store?: StoreHandle;
  bufferSystem: BufferSystem;
  private saveAuthState?: () => Promise<any>;


  constructor(loggerInstance: P.Logger, ai: AI, db: Store) {
    this.logger = loggerInstance;
    this.bufferSystem = new BufferSystem(loggerInstance);
    this.ai = ai;
    this.db = db;
    this.ai.sendMessageTool = new ExtendedDynamicStructuredTool({
      name: "send_message",
      description: "Send a message to a chat or a group chat based on a user id or group id (ending with `@g.us`).",
      schema: z.object({
        id: z.string().describe("[Required] The user id or group id to send the chat to. E.g,`467793d9-6b60-45e7-9fbc-a202ef40837f` or `12345678@g.us`"),
        text: z.string().min(1).describe("The message to send."),
      }),
      func: async (args) => {
        const { id, text } = args as any;
        if (id.endsWith('@g.us')) {
          const replyMsg: WAMessage = {
            message: {
              conversation: `I am an AI Agent`
            },
            key: {
              id: 'autoCmd' + Math.floor(process.uptime()),
              remoteJid: id,
              fromMe: false,
              participant: this.sock!.user?.lid,
            },
            messageTimestamp: Math.floor((new Date()).getTime() / 1000),
            pushName: 'Sofia',
            broadcast: false,
          };
          await this.sock?.sendMessage(id, { text }, { quoted: replyMsg });
        }
        else {
          const user = await this.db.user.findById(id);
          if (!user) {
            throw Error(`Unknown user with id ${id}`)
          }
          const replyMsg: WAMessage = {
            message: {
              conversation: `I am an AI Agent`
            },
            key: {
              id: 'autoCmd' + Math.floor(process.uptime()),
              remoteJid: '120364402285813629@g.us', // Random Group ID, probably invalid
              fromMe: false,
              participant: this.sock!.user?.lid,
            },
            messageTimestamp: Math.floor((new Date()).getTime() / 1000),
            pushName: 'Sofia',
            broadcast: false,
          };
          await this.sock?.sendMessage(user.whatsapp_jid, { text }, { quoted: replyMsg });
        }
        return "Message Sent";
      }
    }, "{id: string, text: string}")
    this.ai.tools.push(this.ai.sendMessageTool);
    this.ai.listGroupsTool = new ExtendedDynamicStructuredTool({
      name: 'list_groups',
      description: 'List all of the group chats that you have access to.',
      schema: z.object({}),
      func: async (args) => {
        return JSON.stringify(Object.values(await this.sock!.groupFetchAllParticipating()).map(g => ({
          id: g.id, name: g.subject//, description: g.desc 
        })));
      }
    }, "{}");
    this.ai.tools.push(this.ai.listGroupsTool);

    this.ai.bindModel();
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

    const { auth, store } = await this.bottle.createStore('sofia');
    this.store = store;
    const { state: authState, saveState: saveAuthState } = await auth.useAuthHandle();
    this.authState = authState as AuthenticationState;
    this.saveAuthState = saveAuthState;

    this.sock = makeWASocket({
      version,
      logger: this.logger,
      auth: authState as AuthenticationState,
      generateHighQualityLinkPreview: true,
      msgRetryCounterCache,
    });

    store.bind(this.sock.ev as any);

    // ------------------------------------------------------------------
    // Event Handling Logic
    // ------------------------------------------------------------------
    this.setupEventHandlers();
    // ------------------------------------------------------------------

    this.logger.info("Bot connection setup complete. Awaiting WA events...");
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
              this.logger.fatal('Connection closed. You are logged out.');
            }
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
                  const id = generateMessageIDV2(this.sock!.user?.id);
                  this.logger.info(msg, `Received Message from Chat: ${msg.key.remoteJidAlt || this.parseJid(msg.key.remoteJid)}`)
                  if (msg.key.remoteJid) {
                    await this.sock!.presenceSubscribe(msg.key.remoteJid); // Subscribe to precense updates so that it can see who is typing...
                    await this.sock!.readMessages([msg.key]);
                    this.bufferSystem.bufferCall(msg.key.remoteJid, (async () => {
                      await this.sock!.sendPresenceUpdate('composing', msg.key.remoteJid!);
                      const chatHistory = await this.loadChat(msg.key.remoteJid!, msg.key.remoteJidAlt);
                      if (chatHistory[chatHistory.length - 1].user != 'AI') {
                        let [chatHistoryParsed, lastMsgId] = (await this.db.user.formatAndMergeMessages(chatHistory, 12)); // Limit to 12 messages.
                        this.logger.trace(chatHistoryParsed);
                        // if (msg.key.remoteJid && msg.key.remoteJid.endsWith('@g.us') && !(chatHistory.some(m => m.text.toLowerCase().includes('sofia')) && await this.ai.shouldRespond(chatHistoryParsed))) {
                        if (msg.key.remoteJid && msg.key.remoteJid.endsWith('@g.us')) {

                          let shouldReply = false;
                          for (let i = 0; i < chatHistoryParsed.length; i++) {
                            const msg = chatHistoryParsed[i];
                            if (msg.type == 'message') {
                              if (msg.role == 'assistant') {
                                shouldReply = false;
                              }
                              else if (msg.role == 'user' && msg.content.toString().toLowerCase().includes('sofia')) {
                                shouldReply = true;
                              }
                            }
                          }

                          if (!shouldReply) {
                            await this.sock!.sendPresenceUpdate('paused', msg.key.remoteJid!);
                            this.logger.info(`Cancelling chat due to noreply logic ${msg.key.remoteJid}  ${msg.key.remoteJidAlt}`);
                            return;
                          }
                        }
                        let systemPrompt;
                        if (msg.key.remoteJid && msg.key.remoteJid.endsWith('@g.us')) {
                          let grpName = (await this.store?.contacts.id(msg.key.remoteJid))?.name || "Unknown Group Chat";
                          systemPrompt = await this.ai.generatePrompt('group', grpName, msg.key.remoteJid);
                        }
                        else if (msg.key.remoteJidAlt) {
                          const current_user = await this.db.user.getUserByJid(msg.key.remoteJidAlt)
                          if (!current_user) {
                            await this.sock!.sendMessage(msg.key.remoteJid!, { text: "Error: Unknown User. Please contact Azlan for access!" })
                            await this.sock!.sendPresenceUpdate('paused', msg.key.remoteJid!);
                            this.logger.error(`Unknown user with jid ${msg.key.remoteJid}  ${msg.key.remoteJidAlt}`);
                            return;
                          }
                          systemPrompt = await this.ai.generatePrompt('chat', current_user?.name, current_user?.id, current_user?.description)
                        }
                        else {
                          await this.sock!.sendPresenceUpdate('paused', msg.key.remoteJid!);
                          this.logger.error(`Unknown chat ${msg.key.remoteJid}  ${msg.key.remoteJidAlt}`);
                          return;
                        }
                        let firstMsg = true;
                        const streamGenerator = this.ai.processChatv3([{
                          role: 'system',
                          content: systemPrompt
                        } as EasyInputMessage, ...(chatHistoryParsed as Array<ResponseInputItem>)]);

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
                      await this.sock!.sendPresenceUpdate('paused', msg.key.remoteJid!);

                    }).bind(this));
                  } else {
                    this.logger.error('Error getting msg.key.remoteJid, value is null or undefined!');
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
          this.logger.debug(precense)
          if (!precense.id.endsWith('@g.us') && this.bufferSystem.chatBuffers[precense.id]) {
            if (Object.values(precense.presences).some(p => p.lastKnownPresence == 'composing')) {
              this.bufferSystem.pauseBuffer(precense.id);
            }
            else {
              this.bufferSystem.resumeBuffer(precense.id);
            }
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

    let messages = await this.store.messages.all(remoteJidAlt || remoteJid)
    if (remoteJidAlt) {
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
    if (remoteJid.endsWith("@g.us")) {
      return (await Promise.all(messages.map(async (m: WAMessage) => ({ id: m.key.id, user: m.key.fromMe ? "AI" : this.parseJid(remoteJidAlt || await this.sock!.signalRepository.lidMapping.getPNForLID(m.participant || m.key.participant || "")), time: (m.messageTimestamp as any).low || m.messageTimestamp, text: await parseMentions(m, getText(m)), quotedMessage: m.message?.extendedTextMessage?.contextInfo?.quotedMessage ? await parseMentions(m.message.extendedTextMessage.contextInfo.quotedMessage, getQuotedText(m.message.extendedTextMessage.contextInfo.quotedMessage)) : null })))).filter((c: any) => c.text != undefined).sort((a: any, b: any) => a.time - b.time) as PreProccessChatMsg[]
    }
    else {
      return (await Promise.all(messages.map(async (m: WAMessage) => ({ id: m.key.id, user: m.key.fromMe ? "AI" : this.parseJid(remoteJidAlt), time: (m.messageTimestamp as any).low || m.messageTimestamp, text: await parseMentions(m, getText(m)), quotedMessage: m.message?.extendedTextMessage?.contextInfo?.quotedMessage ? await parseMentions(m.message.extendedTextMessage.contextInfo.quotedMessage, getQuotedText(m.message.extendedTextMessage.contextInfo.quotedMessage)) : null })))).filter((c: any) => c.text != undefined).sort((a: any, b: any) => a.time - b.time) as PreProccessChatMsg[]
    }
  }

  /**
   * Sends a text message to a specific JID.
   * @param remoteJid The recipient's JID (e.g., '1234567890@s.whatsapp.net')
   * @param text The message content.
   */
  public async sendMessage(remoteJid: string, text: string): Promise<void> {
    if (!this.sock) {
      this.logger.error("Bot is not connected. Call connect() first.");
      return;
    }
    this.logger.info(`Attempting to send message to ${remoteJid}`);
    try {
      await this.sock.sendMessage(remoteJid, { text: text });
      this.logger.info(`Successfully sent message to ${remoteJid}`);
    } catch (error) {
      this.logger.error(error, `Failed to send message to ${remoteJid}`);
      // Do not throw here if we want the bot to keep running on send failure
    }
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