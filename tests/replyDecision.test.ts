import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideFromAnswers, decideGroupReply, newMessageBlocks, buildState, DecisionAnswers, DecisionMsg } from '../src/services/replyDecision';

/** Parses "[HH:MM] Name: text" lines, "Sofia (AI)" is Sofia. `last` adds flags to the last message. */
function chat(lines: string[], last: Partial<DecisionMsg> = {}): DecisionMsg[] {
  return lines.map((line, i) => {
    const [, hh, mm, speaker, text] = line.match(/^\[(\d+):(\d+)\] ([^:]+): (.*)$/)!;
    const msg: DecisionMsg = { speaker: speaker == 'Sofia (AI)' ? null : speaker, time: Date.UTC(2026, 9, 9, +hh - 8, +mm) / 1000 + i, text };
    return i == lines.length - 1 ? { ...msg, ...last } : msg;
  });
}

const pick = ({ reply, short }: { reply: boolean, short?: boolean }) => ({ reply, short });

function answers(addressee: Record<string, number>, kind: Record<string, number>, cont = 0, help = 0): DecisionAnswers {
  const top = (p: Record<string, number>) => Object.entries(p).sort((a, b) => b[1] - a[1])[0][0];
  return {
    addressee: { type: 'choice', choice: top(addressee), probabilities: addressee },
    kind: { type: 'choice', choice: top(kind), probabilities: kind },
    continues_sofia_thread: { type: 'noul', noul: cont },
    sofia_can_help: { type: 'noul', noul: help },
  };
}

test('replies to questions and emotional messages meant for Sofia, not laughter', () => {
  assert.equal(decideFromAnswers(answers({ sofia: 0.9, nobody: 0.1 }, { school_question: 0.8, statement: 0.2 })).reply, true);
  assert.equal(decideFromAnswers(answers({ sofia: 0.9, nobody: 0.1 }, { emotional: 0.6, acknowledgement: 0.4 })).reply, true);
  assert.equal(decideFromAnswers(answers({ sofia: 0.9, nobody: 0.1 }, { laughter: 0.8, request: 0.2 })).reply, false);
});

test('gives a short reply to acknowledgements clearly meant for Sofia only', () => {
  assert.deepEqual(pick(decideFromAnswers(answers({ sofia: 0.9, nobody: 0.1 }, { acknowledgement: 0.7, emotional: 0.3 }))), { reply: true, short: true });
  assert.deepEqual(pick(decideFromAnswers(answers({ sofia: 0.6, whole_group: 0.4 }, { acknowledgement: 0.8, statement: 0.2 }))), { reply: false, short: false });
  assert.deepEqual(pick(decideFromAnswers(answers({ sofia: 0.6, whole_group: 0.4 }, { acknowledgement: 0.8, statement: 0.2 }), { quotesAI: true })), { reply: true, short: true });
  assert.deepEqual(pick(decideFromAnswers(answers({ sofia: 0.9, nobody: 0.1 }, { school_question: 0.8, statement: 0.2 }))), { reply: true, short: false });
});

test('only replies to whole group questions Sofia can help with', () => {
  assert.equal(decideFromAnswers(answers({ whole_group: 0.9, sofia: 0.1 }, { school_question: 0.9 }, 0, 0.9)).reply, true);
  assert.equal(decideFromAnswers(answers({ whole_group: 0.9, sofia: 0.1 }, { social_question: 0.9 }, 0, 0.2)).reply, false);
  assert.equal(decideFromAnswers(answers({ other_member: 0.9, sofia: 0.1 }, { school_question: 0.9 }, 0, 0.9)).reply, false);
});

test('a continuation only counts when Sofia spoke recently', () => {
  const a = answers({ whole_group: 0.8, sofia: 0.2 }, { request: 0.6, statement: 0.4 }, 0.8, 0.7);
  assert.equal(decideFromAnswers(a, { sofiaRecent: false }).reply, false);
  assert.equal(decideFromAnswers(a, { sofiaRecent: true }).reply, true);
});

test('replying to one of Sofia\'s messages counts as talking to her', () => {
  const a = answers({ other_member: 0.8, sofia: 0.2 }, { school_question: 0.9 });
  assert.equal(decideFromAnswers(a).reply, false);
  assert.equal(decideFromAnswers(a, { quotesAI: true }).reply, true);
});

test('judges the new blocks, merging messages from the same sender, even between Sofia\'s messages', () => {
  const texts = (blocks: DecisionMsg[][]) => blocks.map(b => b[b.length - 1].text);
  const msgs = chat(['[12:00] John: sofia when is the test', '[12:00] Sofia (AI): Friday!', '[12:01] Mary: sofia', '[12:01] Mary: what about chem', '[12:01] Sofia (AI): Also bring a calculator', '[12:02] Alex: lol']);
  const mark = (...indexes: number[]) => msgs.map((m, i) => ({ ...m, isNew: indexes.includes(i) }));
  // Mary sent hers while Sofia was still replying to John
  const blocks = newMessageBlocks(mark(2, 3, 5));
  assert.deepEqual(texts(blocks), ['sofia\nwhat about chem', 'lol']);
  assert.equal(blocks[1].length, 6); // The 5 earlier messages are kept as context
  assert.deepEqual(texts(newMessageBlocks(mark(5))), ['lol']);
  // Without marks (e.g. after a restart) only the latest block after Sofia's last message is judged
  assert.deepEqual(texts(newMessageBlocks(msgs)), ['lol']);
  assert.deepEqual(texts(newMessageBlocks(mark())), ['lol']);
});

test('the state tells the model Sofia is an AI and marks the message to judge', () => {
  const state = buildState(chat(['[12:00] John: sofia when is the test', '[12:00] Sofia (AI): Friday!', '[12:01] John: thanks']));
  assert.match(state, /"Sofia \(AI\)", is an AI agent/);
  assert.match(state, /\[12:00\] Sofia \(AI\): Friday!\n\nLATEST MESSAGE \(the one to judge\):\n\[12:01\] John: thanks$/);
});

test('a direct @mention or saying "sofia" replies without calling the decision model', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw Error('should not be called'); }) as typeof fetch;
  try {
    assert.deepEqual(await decideGroupReply(chat(['[10:00] Alex: @Sofia lol'], { mentionsAI: true })), { reply: true, reason: '@mentioned' });
    assert.deepEqual(await decideGroupReply(chat(['[10:00] Alex: Sofia is so useful ngl'])), { reply: true, reason: 'named' });
    assert.deepEqual(await decideGroupReply(chat(['[10:00] Alex: ok gn sofia'])), { reply: true, reason: 'named' });
  }
  finally {
    globalThis.fetch = original;
  }
});

test('falls back to replying to replies to Sofia when the decision model fails', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 500 })) as typeof fetch;
  try {
    assert.equal((await decideGroupReply(chat(['[10:00] Alex: is the test tmr'], { quotesAI: true }))).reply, true);
    assert.equal((await decideGroupReply(chat(['[10:00] Alex: lunch where']))).reply, false);
  }
  finally {
    globalThis.fetch = original;
  }
});

// Hand written group chats, run against the real decision model with LIVE_TESTS=true (needs ALIBABA_API_KEY and MODELSTUDIO_WORKSPACE_URL).
const LIVE_CASES: { name: string, expect: boolean, chat: string[], last?: Partial<DecisionMsg> }[] = [
  {"name": "named question", "expect": true, "chat": ["[12:00] Mary: sofia when is the math test"]},
  {"name": "follow-up after Sofia answered", "expect": true, "chat": ["[12:00] John: Sofia, when is the math test?", "[12:00] Sofia (AI): It's on Friday, 10 Oct!", "[12:01] John: thanks! and the chem test?"]},
  {"name": "follow-up with someone else in between", "expect": true, "chat": ["[12:00] John: Sofia, when is the math test?", "[12:00] Sofia (AI): It's on Friday, 10 Oct!", "[12:01] Mary: lol John you never check the calendar", "[12:01] John: ok what about the chem one?"]},
  {"name": "plain ok thanks", "expect": true, "chat": ["[12:00] John: Sofia, when is the math test?", "[12:00] Sofia (AI): It's on Friday, 10 Oct!", "[12:01] John: ok thanks"]},
  {"name": "thumbs up", "expect": true, "chat": ["[12:00] John: Sofia remind me to submit the lab tmr", "[12:00] Sofia (AI): Done! I'll remind you tomorrow at 9am", "[12:01] John: 👍"]},
  {"name": "thanks sofia (named sign-off)", "expect": true, "chat": ["[12:00] John: Sofia, when is the math test?", "[12:00] Sofia (AI): It's on Friday, 10 Oct!", "[12:01] John: thanks sofia"]},
  {"name": "super excited thanks", "expect": true, "chat": ["[12:00] Mary: sofia can you ask Mr Tan if we can extend the deadline", "[12:30] Sofia (AI): Mr Tan said yes! The deadline is now next Monday 🎉", "[12:31] Mary: OMG thank you so much that is amazing i love u"]},
  {"name": "group lunch question", "expect": false, "chat": ["[11:50] Mary: Guys where do y'all want to go for lunch"]},
  {"name": "party outfit question", "expect": false, "chat": ["[20:00] Alex: Guys what are y'all wearing for joshua's party tomorrow"]},
  {"name": "party outfit, Sofia spoke earlier", "expect": false, "chat": ["[19:00] John: sofia when is the chem quiz", "[19:00] Sofia (AI): It's next Wednesday!", "[20:00] Alex: Guys what are y'all wearing for joshua's party tomorrow"]},
  {"name": "group question about test date", "expect": true, "chat": ["[09:00] Mary: guys when is the math test ah"]},
  {"name": "group question about deadline", "expect": true, "chat": ["[21:00] Alex: wait is the java assignment due tmr or friday??"]},
  {"name": "group question already answered by human", "expect": false, "chat": ["[21:00] Alex: wait is the java assignment due tmr or friday??", "[21:01] Mary: friday"]},
  {"name": "John asks Mary", "expect": false, "chat": ["[12:00] John: Sofia, when is the math test?", "[12:00] Sofia (AI): It's on Friday, 10 Oct!", "[12:01] Mary: John did you finish the worksheet?", "[12:02] John: nope, can I copy yours?"]},
  {"name": "general chatter", "expect": false, "chat": ["[11:50] Mary: anyone going to the canteen?", "[11:51] Alex: yeah wait for me", "[11:52] John: same lol"]},
  {"name": "talking ABOUT sofia without her name", "expect": false, "chat": ["[15:00] Alex: sofia is actually so useful ngl", "[15:01] Mary: ya she reminded me about the quiz"]},
  {"name": "followup hours later from a different person", "expect": false, "chat": ["[09:00] John: Sofia, when is the math test?", "[09:00] Sofia (AI): It's on Friday, 10 Oct!", "[14:00] Mary: anyone wanna study at the library later?"]},
  {"name": "study question to group", "expect": true, "chat": ["[22:00] Alex: guys what's the difference between TCP and UDP again"]},
  {"name": "stressed message to group", "expect": false, "chat": ["[23:00] Mary: im so tired today"]},
  {"name": "sad, continuing with Sofia", "expect": true, "chat": ["[23:00] Mary: sofia i failed my quiz", "[23:00] Sofia (AI): Aww I'm sorry Mary 🥺 Do you want to talk about it?", "[23:01] Mary: ya i studied so hard but still failed"]},
  {"name": "follow-up request to Sofia", "expect": true, "chat": ["[12:00] John: Sofia, when is the math test?", "[12:00] Sofia (AI): It's on Friday, 10 Oct!", "[12:01] John: can you remind me thursday night"]},
  {"name": "lol reaction to Sofia", "expect": false, "chat": ["[12:00] Alex: sofia tell me a joke", "[12:00] Sofia (AI): Why did the programmer quit? Because he didn't get arrays 😂", "[12:01] Alex: lmaooo"]},
  {"name": "excited, no name, after Sofia helped", "expect": true, "chat": ["[12:00] Alex: sofia did Ms Lim reply about the project groups?", "[12:05] Sofia (AI): Yes! She said you can pick your own groups 🙌", "[12:06] Alex: YESSS LETS GOOO best news ever 😭😭"]},
  {"name": "haha reaction to Sofia", "expect": false, "chat": ["[12:00] Mary: sofia say something funny", "[12:00] Sofia (AI): I'd tell you a UDP joke but you might not get it 😂", "[12:01] Mary: hahaha"]},
  {"name": "noted after Sofia announcement", "expect": false, "chat": ["[08:00] Sofia (AI): Morning everyone! Reminder: lab report due tonight 11:59pm ✨", "[08:05] Alex: noted"]},
  {"name": "question after Sofia announcement", "expect": true, "chat": ["[08:00] Sofia (AI): Morning everyone! Reminder: lab report due tonight 11:59pm ✨", "[08:05] Alex: wait is it submitted on brightspace or email?"]},
  {"name": "group asks who is coming to class", "expect": false, "chat": ["[08:30] Mary: who's coming to school today"]},
  {"name": "group asks where is class (Sofia can answer)", "expect": true, "chat": ["[08:30] Mary: guys which room is the networking lesson today"]},
  {"name": "teasing about sofia to another member", "expect": false, "chat": ["[15:00] Alex: john you rely on sofia for everything lol", "[15:01] John: shut up 😂"]},
  {"name": "@mention of Sofia with question", "expect": true, "chat": ["[10:00] Alex: @Sofia can you check if there's class on deepavali"], "last": {"mentionsAI": true}},
  {"name": "opinion poll", "expect": false, "chat": ["[17:00] John: guys is it worth buying the new iphone"]},
  {"name": "singlish group question", "expect": true, "chat": ["[19:00] Alex: eh got tutorial tmr or not ah"]},
  {"name": "singlish lunch", "expect": false, "chat": ["[11:45] John: eh makan where"]},
  {"name": "burst to sofia", "expect": true, "chat": ["[12:00] Mary: sofia", "[12:00] Mary: can u help me check", "[12:00] Mary: when the OOP assignment due"]},
  {"name": "reply to Sofia's message that is just lol", "expect": false, "chat": ["[12:00] Sofia (AI): Don't forget the lab report tonight!", "[12:01] Alex: lol"], "last": {"quotesAI": true}},
  {"name": "follow-up thank-you + new question", "expect": true, "chat": ["[12:00] John: Sofia, when is the math test?", "[12:00] Sofia (AI): It's on Friday, 10 Oct!", "[12:01] John: thanks, what chapters ah?"]},
  {"name": "other person jumps into Sofia thread with school q", "expect": true, "chat": ["[12:00] John: Sofia, when is the math test?", "[12:00] Sofia (AI): It's on Friday, 10 Oct!", "[12:01] Mary: wait what about the stats quiz"]}
,
  {"name": "good night after Sofia replied", "expect": true, "chat": ["[22:10] John: sofia remind me to submit the lab at 7am", "[22:10] Sofia (AI): Done! I'll remind you at 7am tomorrow 📌", "[22:11] John: ok gn"]},
  {"name": "everyone noting a Sofia announcement", "expect": false, "chat": ["[08:00] Sofia (AI): Morning everyone! Reminder: lab report due tonight 11:59pm ✨", "[08:01] Mary: noted", "[08:05] Alex: noted thanks"]}
];

for (const c of LIVE_CASES) {
  test(`live: ${c.expect ? 'replies to' : 'ignores'} ${c.name}`, { skip: process.env.LIVE_TESTS != 'true' }, async () => {
    const decision = await decideGroupReply(chat(c.chat, c.last));
    assert.doesNotMatch(decision.reason, /failed/);
    assert.equal(decision.reply, c.expect, decision.reason + ' ' + JSON.stringify(decision.answers?.kind.probabilities));
  });
}
