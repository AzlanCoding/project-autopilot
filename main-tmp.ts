import P from "pino";
import { Boom } from '@hapi/boom';
import makeWASocket, { fetchLatestBaileysVersion, AuthenticationState, CacheStore, DisconnectReason, generateMessageIDV2, isJidNewsletter, proto, getAggregateVotesInPollMessage, BaileysEventEmitter } from 'baileys'
import BaileysBottle from 'baileys-bottle';
import NodeCache from '@cacheable/node-cache';
import qrcode from 'qrcode-terminal';
import 'dotenv/config'

if (!process.env.BAILEYS_BOTTLE_SQL_DATABASE_URL) {
  throw Error(`Environment variable 'BAILEYS_BOTTLE_SQL_DATABASE_URL' is not defined`)
}

const logger = P({
  level: "trace",
  transport: {
    targets: [
      {
        target: "pino-pretty", // pretty-print for console
        options: { colorize: true },
        level: "trace",
      },
      {
        target: "pino/file", // raw file output
        options: { destination: './wa-logs.txt' },
        level: "trace",
      },
    ],
  },
})
logger.level = 'trace'



const main = async () => {
  const bottle = await BaileysBottle.init({
    type: 'postgres',
    url: process.env.BAILEYS_BOTTLE_SQL_DATABASE_URL
  });

  const msgRetryCounterCache = new NodeCache() as CacheStore

  // fetch latest version of WA Web
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`Using WhatsApp v${version.join('.')}, isLatest: ${isLatest}`);

  const { auth, store } = await bottle.createStore('sofia');
  const { state: authState, saveState: saveAuthState } = await auth.useAuthHandle();

  const sock = makeWASocket({
    version,
    logger,
    auth: authState as AuthenticationState,
    generateHighQualityLinkPreview: true,
    msgRetryCounterCache,
    // patchMessageBeforeSending: ((message: proto.IMessage, jids: string[]) => jids ? jids.map(jid => ({ recipientJid: jid, ...message })) : message) as any,
    // ignore all broadcast messages -- to receive the same
    // comment the line below out
    // shouldIgnoreJid: jid => isJidBroadcast(jid),
    // implement to handle retries & poll updates
    // getMessage,
  });

  store.bind(sock.ev as any);

  sock.ev.process(
    // events is a map for event name => event data
    async (events) => {
      // something about the connection changed
      // maybe it closed, or we received all offline message or connection opened
      if (events['connection.update']) {
        const update = events['connection.update']
        const { connection, lastDisconnect, qr } = update
        if (connection === 'close') {
          // reconnect if not logged out
          if ((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
            main()
          } else {
            logger.fatal('Connection closed. You are logged out.')
          }
        }

        if (qr) {
          console.log("Scan to login to WhatsApp:")
          qrcode.generate(update.qr!, { small: true });
        }

        logger.debug(update, 'connection update')
      }

      // credentials updated -- save them
      if (events['creds.update']) {
        await saveAuthState()
        logger.debug({}, 'creds save triggered')
      }

      if (events['labels.association']) {
        logger.debug(events['labels.association'], 'labels.association event fired')
      }


      if (events['labels.edit']) {
        logger.debug(events['labels.edit'], 'labels.edit event fired')
      }

      if (events['call']) {
        logger.debug(events['call'], 'call event fired')
      }

      // history received
      if (events['messaging-history.set']) {
        const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set']
        if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
          logger.debug(messages, 'received on-demand history sync')
        }
        logger.debug({ contacts: contacts.length, chats: chats.length, messages: messages.length, isLatest, progress, syncType: syncType?.toString() }, 'messaging-history.set event fired')
      }

      // received a new message
      if (events['messages.upsert']) {
        const upsert = events['messages.upsert']
        logger.debug(upsert, 'messages.upsert fired')

        if (!!upsert.requestId) {
          logger.debug(upsert, 'placeholder request message received')
        }



        if (upsert.type === 'notify') {
          for (const msg of upsert.messages) {
            if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
              const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
              if (text == "requestPlaceholder" && !upsert.requestId) {
                const messageId = await sock.requestPlaceholderResend(msg.key)
                logger.debug({ id: messageId }, 'requested placeholder resync')
              }

              // go to an old chat and send this
              if (text == "onDemandHistSync") {
                const messageId = await sock.fetchMessageHistory(50, msg.key, msg.messageTimestamp!)
                logger.debug({ id: messageId }, 'requested on-demand history resync')
              }

              if (!msg.key.fromMe && !isJidNewsletter(msg.key?.remoteJid!)) {
                const id = generateMessageIDV2(sock.user?.id)
                logger.debug({ id, orig_id: msg.key.id }, 'replying to message')
                await sock.sendMessage(msg.key.remoteJid!, { text: 'pong ' + msg.key.id }, { messageId: id })
              }
            }
          }
        }
      }

      // messages updated like status delivered, message deleted etc.
      if (events['messages.update']) {
        logger.debug(events['messages.update'], 'messages.update fired')

        for (const { key, update } of events['messages.update']) {
          if (update.pollUpdates) {
            const pollCreation: proto.IMessage = {} // get the poll creation message somehow
            if (pollCreation) {
              console.log(
                'got poll update, aggregation: ',
                getAggregateVotesInPollMessage({
                  message: pollCreation,
                  pollUpdates: update.pollUpdates,
                })
              )
            }
          }
        }
      }

      if (events['message-receipt.update']) {
        logger.debug(events['message-receipt.update'])
      }

      if (events['contacts.upsert']) {
        logger.debug(events['message-receipt.update'])
      }

      if (events['messages.reaction']) {
        logger.debug(events['messages.reaction'])
      }

      if (events['presence.update']) {
        logger.debug(events['presence.update'])
      }

      if (events['chats.update']) {
        logger.debug(events['chats.update'])
      }

      if (events['contacts.update']) {
        for (const contact of events['contacts.update']) {
          if (typeof contact.imgUrl !== 'undefined') {
            const newUrl = contact.imgUrl === null
              ? null
              : await sock!.profilePictureUrl(contact.id!).catch(() => null)
            logger.debug({ id: contact.id, newUrl }, `contact has a new profile pic`)
          }
        }
      }

      if (events['chats.delete'] != undefined) {
        logger.debug('chats deleted: ' + events['chats.delete'])
      }

      // if (events['group.member-tag.update']) {
      //   logger.debug('group member tag update: '+ JSON.stringify(events['group.member-tag.update'], undefined, 2))
      // }
    }
  )

}

main()