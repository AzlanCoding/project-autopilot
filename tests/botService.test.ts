import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { SofiaBot, PreProccessChatMsg } from '../src/services/botService';
import { UserService } from '../src/services/userService';

/** A bot without WhatsApp, AI or a database. Names in history are used as is and there is no prompt changelog. */
function setup() {
  const users = Object.create(UserService.prototype) as UserService;
  Object.assign(users, {
    store: { toolCallHist: { trailsFor: async () => new Map() } },
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

test('group info matches participants to users, labels Sofia, masks unknown people, and is cached', async () => {
  const bot = setup();
  const users: { [jid: string]: any } = {
    '6590000001@s.whatsapp.net': { id: 'user-azlan', name: 'Azlan', description: 'GDGoC member, class chairperson' },
    '6590000002@s.whatsapp.net': { id: 'user-mary', name: 'Mary', description: '' },
  };
  (bot.db as any).user.getUserByJid = async (jid: string) => users[jid] ?? null;
  let fetches = 0;
  bot.sock = {
    user: { id: '6599999999:1@s.whatsapp.net', lid: '100000000000099:1@lid' },
    groupMetadata: async () => {
      fetches++;
      return {
        id: '123@g.us', subject: 'GDGoC NYP Core', desc: 'Planning DevFest',
        participants: [
          { id: '100000000000001@lid', phoneNumber: '6590000001@s.whatsapp.net', admin: 'superadmin' },
          { id: '100000000000002@lid' }, // phone number only known through the LID mapping
          { id: '100000000000003@lid' }, // not a user, no mapping
          { id: '100000000000099@lid' }, // Sofia
        ],
      };
    },
    signalRepository: { lidMapping: { getPNForLID: async (lid: string) => lid == '100000000000002@lid' ? '6590000002:3@s.whatsapp.net' : null } },
  } as any;

  const info = await bot.getGroupInfo('123@g.us');
  assert.deepEqual(info, {
    id: '123@g.us', name: 'GDGoC NYP Core', description: 'Planning DevFest',
    participants: [
      { name: 'Azlan', userId: 'user-azlan', description: 'GDGoC member, class chairperson', admin: true },
      { name: 'Mary', userId: 'user-mary', description: '', admin: false },
      { name: 'Unknown (0003)', userId: null, description: null, admin: false },
      { name: 'You (Sofia)', userId: null, description: null, admin: false },
    ],
  });
  await bot.getGroupInfo('123@g.us');
  assert.equal(fetches, 1, 'cached');

  const { formatGroupInfo } = await import('../src/services/ai');
  assert.equal(formatGroupInfo(info), [
    'Group Chat: GDGoC NYP Core (123@g.us)',
    'Group Description: Planning DevFest',
    'Participants (4):',
    '- Azlan (user ID user-azlan) [admin]: GDGoC member, class chairperson',
    '- Mary (user ID user-mary)',
    '- Unknown (0003)',
    '- You (Sofia)',
  ].join('\n'));
  // Long descriptions are cut so big groups don't fill the prompt
  const long = formatGroupInfo({ ...info, description: '', participants: [{ name: 'A', userId: 'a', description: 'x'.repeat(300), admin: false }] });
  assert.match(long, /Group Description: \(none\)\nParticipants \(1\):\n- A \(user ID a\): x{200}\.\.\.$/);
});

test('files are sent as photos when they are PNG or JPEG, everything else as documents', async () => {
  const bot = setup();
  const messages: any[] = [];
  bot.sock = { sendMessage: async (jid: string, content: any) => { messages.push({ jid, ...content, image: content.image ? 'buf' : undefined, document: content.document ? 'buf' : undefined }); } } as any;
  await bot.sendFile('123@g.us', { buffer: Buffer.from('x'), mime: 'image/png', fileName: 'slide.png', caption: 'Slide 4' });
  await bot.sendFile('123@g.us', { buffer: Buffer.from('x'), mime: 'application/pdf', fileName: 'Proposal.pdf' });
  await bot.sendFile('123@g.us', { buffer: Buffer.from('x'), mime: 'image/gif', fileName: 'party.gif' });
  assert.deepEqual(messages, [
    { jid: '123@g.us', image: 'buf', mimetype: 'image/png', caption: 'Slide 4', document: undefined },
    { jid: '123@g.us', document: 'buf', mimetype: 'application/pdf', fileName: 'Proposal.pdf', image: undefined },
    { jid: '123@g.us', document: 'buf', mimetype: 'image/gif', fileName: 'party.gif', image: undefined },
  ]);
});
