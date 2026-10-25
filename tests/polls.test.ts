import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'crypto';
import pino from 'pino';
import { aesEncryptGCM, hmacSign, proto } from 'baileys';
import AI from '../src/services/ai';
import { decryptVote, PollService } from '../src/services/pollService';
import { describeContent } from '../src/services/botService';
import { chatContext } from '../src/services/chatContext';

const SOFIA = ['6500000000@s.whatsapp.net', '100000000000000@lid'];
const VOTER = ['6590000001@s.whatsapp.net', '100000000000001@lid'];
const secret = randomBytes(32);
const poll = { id: 'POLL1', chat: '120363000000000000@g.us', from_me: true, creator_jids: SOFIA, question: 'Lunch?', options: ['Mac', 'Sushi', 'Pasta'], multiple: true, secret: secret.toString('base64') };

/** Encrypts a vote the way the voter's phone does (the reverse of Baileys' decryptPollVote). */
function encryptVote(options: string[], { creatorJid, voterJid, key = secret }: { creatorJid: string, voterJid: string, key?: Buffer }): proto.Message.IPollEncValue {
  const sign = Buffer.concat([Buffer.from(poll.id), Buffer.from(creatorJid), Buffer.from(voterJid), Buffer.from('Poll Vote'), new Uint8Array([1])]);
  const decKey = hmacSign(sign, hmacSign(key, new Uint8Array(32), 'sha256'), 'sha256');
  const vote = proto.Message.PollVoteMessage.encode({ selectedOptions: options.map(o => createHash('sha256').update(o).digest()) }).finish();
  const encIv = randomBytes(12);
  return { encIv, encPayload: aesEncryptGCM(vote, decKey, encIv, Buffer.from(`${poll.id}\u0000${voterJid}`)) };
}

test('votes are decrypted whichever jids (phone number or lid) the voter used', () => {
  // Encrypted with both lids, while the phone number jids are tried first
  const vote = encryptVote(['Sushi', 'Pasta'], { creatorJid: SOFIA[1], voterJid: VOTER[1] });
  assert.deepEqual(decryptVote(poll, vote, VOTER), ['Sushi', 'Pasta']);
  assert.deepEqual(decryptVote(poll, encryptVote([], { creatorJid: SOFIA[0], voterJid: VOTER[0] }), VOTER), []); // Vote taken back
  // A vote for another poll (different secret) or by someone else can't be read
  assert.equal(decryptVote(poll, encryptVote(['Mac'], { creatorJid: SOFIA[0], voterJid: VOTER[0], key: randomBytes(32) }), VOTER), null);
  assert.equal(decryptVote(poll, encryptVote(['Mac'], { creatorJid: SOFIA[0], voterJid: '6599999999@s.whatsapp.net' }), VOTER), null);
});

/** A PollService on in-memory tables. */
function setup() {
  const polls = new Map<string, any>();
  const votes: any[] = [];
  const store: any = { db: { models: {
    PollStore: {
      findByPk: async (id: string) => polls.get(id) ?? null,
      findOrCreate: async ({ where, defaults }: any) => { if (!polls.has(where.id)) polls.set(where.id, { ...defaults }); return [polls.get(where.id), true]; },
    },
    PollVoteStore: {
      findOne: async ({ where }: any) => votes.find(v => v.poll_id == where.poll_id && v.voter == where.voter) ?? null,
      findAll: async ({ where }: any) => votes.filter(v => v.poll_id == where.poll_id),
      create: async (data: any) => { const v = { ...data, async update(c: any) { Object.assign(this, c); } }; votes.push(v); return v; },
    },
  } } };
  return { polls: new PollService(store, pino({ level: 'silent' })), votes };
}

test('the latest vote per person counts, and results list voters by name', async () => {
  const { polls } = setup();
  await polls.save(poll);
  const at = (minute: number) => new Date(`2026-10-18T12:${String(minute).padStart(2, '0')}:00+08:00`);
  assert.deepEqual(await polls.recordVote('POLL1', encryptVote(['Mac'], { creatorJid: SOFIA[0], voterJid: VOTER[0] }), VOTER, at(1)), ['Mac']);
  await polls.recordVote('POLL1', encryptVote(['Sushi', 'Pasta'], { creatorJid: SOFIA[0], voterJid: VOTER[0] }), VOTER, at(5)); // Changed their vote
  await polls.recordVote('POLL1', encryptVote(['Mac'], { creatorJid: SOFIA[0], voterJid: VOTER[0] }), VOTER, at(3)); // Arrived late, older
  const other = ['6590000002@s.whatsapp.net'];
  await polls.recordVote('POLL1', encryptVote(['Sushi'], { creatorJid: SOFIA[0], voterJid: other[0] }), other, at(2));
  const results = (await polls.results('POLL1', async jid => ({ [VOTER[0]]: 'John', [other[0]]: 'Mary' })[jid]!))!;
  assert.deepEqual(results.options, [
    { option: 'Mac', voters: [] },
    { option: 'Sushi', voters: ['John', 'Mary'] },
    { option: 'Pasta', voters: ['John'] },
  ]);
  assert.deepEqual(results.voters.sort(), ['John', 'Mary']);

  // Taking a vote back removes it from the results
  await polls.recordVote('POLL1', encryptVote([], { creatorJid: SOFIA[0], voterJid: other[0] }), other, at(9));
  assert.deepEqual((await polls.results('POLL1'))!.voters, [VOTER[0]]);
  assert.equal(await polls.recordVote('NOPE', encryptVote(['Mac'], { creatorJid: SOFIA[0], voterJid: VOTER[0] }), VOTER, at(1)), null);
  assert.equal(await polls.results('NOPE'), null);
});

test('polls show in the chat history with their poll_id and options', () => {
  assert.equal(describeContent({ pollCreationMessageV3: { name: 'Lunch?', selectableOptionsCount: 1, options: [{ optionName: 'Mac' }, { optionName: 'Sushi' }] } }, 'ABC'),
    '<WhatsApp Poll poll_id=ABC (pick one)> "Lunch?" Options: Mac | Sushi');
  assert.equal(describeContent({ pollCreationMessage: { name: 'Free when?', selectableOptionsCount: 0, options: [{ optionName: 'Mon' }, { optionName: 'Tue' }] } }, 'XYZ'),
    '<WhatsApp Poll poll_id=XYZ (pick any number)> "Free when?" Options: Mon | Tue');
});

test('send_poll sends to the current chat, and read_poll shows the votes', async () => {
  process.env.ALIBABA_API_KEY ||= 'test';
  const sent: any[] = [];
  const ai = new AI({} as any, pino({ level: 'silent' }));
  ai.registerChatTools({
    sendMessage: async () => { }, sendStickerGif: async () => { }, getMedia: async () => { throw Error('unused'); }, listGroups: async () => [], getGroupInfo: async () => { throw Error('unused'); }, sendFile: async () => { }, loadChatById: async () => [],
    sendPoll: async (id, p) => { sent.push([id, p]); return 'POLL1'; },
    getPollResults: async (id) => id == 'POLL1' ? { poll: poll as any, options: [{ option: 'Mac', voters: [] }, { option: 'Sushi', voters: ['John'] }, { option: 'Pasta', voters: [] }], voters: ['John'] } : null,
  });
  const result = await chatContext.run({ chatId: '120363000000000000@g.us' }, () =>
    ai.sendPollTool!.invoke({ question: ' Lunch? ', options: ['Mac', 'Sushi', 'Pasta'], allow_multiple_answers: false, end_message: true }));
  assert.match(String(result), /poll_id=POLL1/);
  assert.deepEqual(sent, [['120363000000000000@g.us', { question: 'Lunch?', options: ['Mac', 'Sushi', 'Pasta'], multiple: false }]]);
  await assert.rejects(ai.sendPollTool!.invoke({ question: 'Q', options: ['A', 'A'], allow_multiple_answers: false, end_message: false }), /different/);

  const read = JSON.parse(String(await ai.readPollTool!.invoke({ poll_id: 'POLL1' })));
  assert.deepEqual([read.question, read.type, read.voters, read.options[1]], ['Lunch?', 'pick any number', 1, { option: 'Sushi', votes: 1, voters: ['John'] }]);
  await assert.rejects(ai.readPollTool!.invoke({ poll_id: 'NOPE' }), /Unknown poll/);
});
