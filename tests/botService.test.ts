import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { SofiaBot, PreProccessChatMsg } from '../src/services/botService';
import { UserService } from '../src/services/userService';

/** A bot without WhatsApp, AI or a database. Names in history are used as is and there is no prompt changelog. */
function setup() {
  const users = Object.create(UserService.prototype) as UserService;
  Object.assign(users, {
    store: { toolCallHist: { followTrail: async () => [] } },
    generateUserStringFromJid: async (jid: string) => jid,
    promptChangelogPath: 'does-not-exist.json',
  });
  return new SofiaBot(pino({ level: 'silent' }), { registerChatTools() { } } as any, { user: users } as any);
}

let n = 0;
const msg = (user: string, text: string): PreProccessChatMsg => ({ id: `m${++n}`, user, time: 1791550000 + n, text });
const summarise = (items: any[]) => items.map(i => i.role == 'system' ? `NOTE: ${i.content}` : `${i.role}: ${(i.content as string).split('\n').slice(0, 2).join(' ')}`);

test('messages sent while Sofia was replying are unseen and moved after her reply with a note', async () => {
  const bot = setup();
  const q = msg('john', 'sofia when is the test');
  bot.markSeen('chat', [q]); // Sofia started replying to John
  const history = [q, msg('AI', 'Friday!'), msg('mary', 'what about chem'), msg('AI', 'Bring a calculator')];

  const unseen = bot.unseenMessages('chat', history);
  assert.equal(unseen.known, true);
  assert.deepEqual(unseen.messages.map(m => m.text), ['what about chem']);

  const [formatted] = await bot.formatHistory(history, unseen.messages);
  assert.deepEqual(summarise(formatted), [
    'user: john: sofia when is the test',
    'assistant: Friday!\n\nBring a calculator'.split('\n').slice(0, 2).join(' '),
    "NOTE: The messages below were sent while you were still replying, so you hadn't seen them yet.",
    'user: mary: what about chem',
  ]);

  bot.markSeen('chat', history);
  assert.deepEqual(bot.unseenMessages('chat', history).messages, []);
});

test('messages after Sofia\'s reply keep their order without a note', async () => {
  const bot = setup();
  const q = msg('john', 'sofia when is the test');
  bot.markSeen('chat', [q]);
  const history = [q, msg('AI', 'Friday!'), msg('john', 'thanks')];
  const unseen = bot.unseenMessages('chat', history);
  assert.deepEqual(unseen.messages.map(m => m.text), ['thanks']);
  assert.deepEqual(summarise((await bot.formatHistory(history, unseen.messages))[0]), ['user: john: sofia when is the test', 'assistant: Friday!', 'user: john: thanks']);
});

test('without a record (e.g. after a restart) the messages after Sofia\'s last message are unseen', () => {
  const bot = setup();
  const history = [msg('john', 'hi'), msg('AI', 'hello'), msg('mary', 'sofia?')];
  assert.deepEqual(bot.unseenMessages('chat', history), { messages: [history[2]], known: false });
  assert.deepEqual(bot.unseenMessages('chat', history.slice(0, 2)).messages, []);
});

test('messages sent during a reply are handed to the model once, with a note', async () => {
  const bot = setup();
  const q = msg('azlan', 'remember the repo link');
  bot.markSeen('chat', [q]);
  const history = [q, msg('AI', 'Saving that'), msg('azlan', 'Okay Sofia?')];
  (bot as any).loadChat = async () => history;
  assert.deepEqual(summarise(await bot.messagesDuringReply('chat')), [
    "NOTE: New messages arrived while you were replying. You haven't responded to them yet. Answer them in this reply if they need it.",
    'user: azlan: Okay Sofia?',
  ]);
  assert.deepEqual(await bot.messagesDuringReply('chat'), []); // Now seen, so the queued run won't reply again
});
