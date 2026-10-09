import { MODELSTUDIO_BASE_URL } from '../config/modelStudio';

/**
 * Decides whether Sofia should reply in a group chat using Alibaba Model Studio's decision model (`decision-model-preview`).
 * The model answers each question independently with probabilities, the answers are combined in `decideFromAnswers`.
 * Tested against hand written group chats in `tests/replyDecision.test.ts` (set `LIVE_TESTS=true` to run them against the API).
 */

export const DECISION_MODEL = 'decision-model-preview';

export interface DecisionMsg {
  /** Display name of the sender, `null` for Sofia's own messages. */
  speaker: string | null,
  time: number,
  text: string,
  quotedMessage?: string | null,
  /** Sofia was @mentioned. */
  mentionsAI?: boolean,
  /** The message replies to (quotes) one of Sofia's messages. */
  quotesAI?: boolean,
}

export interface ReplyDecision {
  reply: boolean,
  reason: string,
  answers?: DecisionAnswers,
}

const CONTEXT = `CONTEXT: This is a WhatsApp group chat for students of class IT2504 at Nanyang Polytechnic (NYP), Singapore. One member, "Sofia (AI)", is an AI agent (a bot), not a human. Sofia is the class assistant: she knows the class calendar, timetable, tests, assignments and deadlines, can set reminders, pass messages to teachers or classmates, answer general knowledge and study questions, and give emotional support. She cannot know people's personal plans, opinions or preferences, and should stay out of casual social chatter between the humans.`;

const QUESTIONS = {
  addressee: {
    type: 'choice', instructions: 'Who is the LATEST message mainly addressed to?', criteria: {
      sofia: 'Sofia, the AI assistant (by name, or by replying to / continuing something she said)',
      other_member: 'A specific human member of the group',
      whole_group: 'Everyone in the group in general',
      nobody: 'No one in particular (reactions, chatter, thinking out loud)',
    }
  },
  kind: {
    type: 'choice', instructions: 'What kind of message is the LATEST message?', criteria: {
      school_question: 'A question about class, school, timetable, rooms, tests, assignments, deadlines, submissions, study topics, or general knowledge',
      social_question: 'A question about personal plans, food, outfits, parties, who is going somewhere, or asking for opinions/preferences',
      request: 'Asking Sofia to do something (remind, check, ask a teacher, send a message, explain)',
      acknowledgement: 'A plain acknowledgement or sign-off: ok, thanks, noted, got it, bye, a thumbs up',
      laughter: 'Laughter or a reaction: haha, lol, lmao, emojis only',
      emotional: 'Very excited, hugely grateful or affectionate, or sharing feelings, stress or struggles',
      statement: 'Answering someone else, or a plain statement, comment or chatter',
    }
  },
  continues_sofia_thread: { type: 'noul', instructions: "Is the LATEST message its author's continuation or follow-up of a conversation they were having with Sofia (the AI)?" },
  sofia_can_help: { type: 'noul', instructions: 'Is the LATEST message a question or request that Sofia, the AI class assistant, could usefully answer (e.g. class schedule, tests, assignments, deadlines, school info, study or general knowledge questions)? Personal or social questions only the humans can answer (where to eat, what to wear, who is going to a party, opinions about each other) are NO.' },
};

interface ChoiceAnswer { type: 'choice', choice: string, confidence?: number, probabilities: Record<string, number> }
interface NoulAnswer { type: 'noul', noul: number }
export interface DecisionAnswers {
  addressee: ChoiceAnswer,
  kind: ChoiceAnswer,
  continues_sofia_thread: NoulAnswer,
  sofia_can_help: NoulAnswer,
}

/** Message kinds Sofia replies to when the message is meant for her. */
const REPLY_KINDS_TO_SOFIA = ['school_question', 'social_question', 'request', 'emotional'];

function formatMsg(m: DecisionMsg) {
  const time = new Date(m.time * 1000).toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Singapore' });
  const quoted = m.quotedMessage ? ` (replying to: "${m.quotedMessage}")` : '';
  return `[${time}] ${m.speaker ?? 'Sofia (AI)'}:${quoted} ${m.text}`;
}

/** Builds the decision model state. The last message of `messages` is the one being judged. */
export function buildState(messages: DecisionMsg[]) {
  const earlier = messages.slice(0, -1);
  const latest = messages[messages.length - 1];
  return `${CONTEXT}\n\nCHAT TRANSCRIPT (oldest first):\n${earlier.length ? earlier.map(formatMsg).join('\n') : '(no earlier messages)'}\n\nLATEST MESSAGE (the one to judge):\n${formatMsg(latest)}`;
}

/**
 * Combines the decision model's answers.
 * `quotesAI` counts the message as meant for Sofia, `sofiaRecent` (Sofia spoke in the transcript) is needed before a
 * continuation counts, otherwise people talking about Sofia look like they are continuing a conversation with her.
 */
export function decideFromAnswers(a: DecisionAnswers, { quotesAI = false, sofiaRecent = false } = {}): ReplyDecision {
  const kind = a.kind.probabilities;
  const toSofia = quotesAI || (a.addressee.probabilities.sofia ?? 0) >= 0.5 || (sofiaRecent && a.continues_sofia_thread.noul >= 0.7);
  if (toSofia) {
    const pReply = REPLY_KINDS_TO_SOFIA.reduce((t, k) => t + (kind[k] ?? 0), 0);
    return { reply: pReply >= 0.5, reason: `to Sofia, kind=${a.kind.choice} (${pReply.toFixed(2)} reply-worthy)`, answers: a };
  }
  if (a.addressee.choice == 'whole_group' || a.addressee.choice == 'nobody') {
    const reply = (kind.school_question ?? 0) >= 0.5 && a.sofia_can_help.noul >= 0.6;
    return { reply, reason: `to ${a.addressee.choice}, kind=${a.kind.choice}, sofia_can_help=${a.sofia_can_help.noul}`, answers: a };
  }
  return { reply: false, reason: `to ${a.addressee.choice}`, answers: a };
}

/** Asks the decision model about the last message of `messages`. Throws if the API fails. */
export async function askDecisionModel(messages: DecisionMsg[], signal?: AbortSignal): Promise<DecisionAnswers> {
  const res = await fetch(`${MODELSTUDIO_BASE_URL}/systemone`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.ALIBABA_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: DECISION_MODEL, state: buildState(messages), questions: QUESTIONS }),
    signal: signal ?? AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => null) as any;
  if (!res.ok || !body?.answers?.addressee || !body.answers.kind) {
    throw Error(`Decision model request failed (HTTP ${res.status}): ${JSON.stringify(body)}`);
  }
  return body.answers;
}

/**
 * Splits the messages after Sofia's last message (and after `since`, the newest message already judged) into blocks of
 * consecutive messages from the same sender. Each block is judged with the transcript before it, the latest 3 are kept.
 * The last message of each returned array is the one being judged (a block is merged into one message).
 */
export function newMessageBlocks(messages: DecisionMsg[], since?: number): DecisionMsg[][] {
  let start = messages.length;
  while (start > 0 && messages[start - 1].speaker != null && (since == undefined || messages[start - 1].time > since)) {
    start--;
  }
  const blocks: DecisionMsg[][] = [];
  let i = start;
  while (i < messages.length) {
    let j = i + 1;
    while (j < messages.length && messages[j].speaker == messages[i].speaker) {
      j++;
    }
    const block = messages.slice(i, j);
    const merged: DecisionMsg = {
      ...block[block.length - 1],
      text: block.map(m => m.text).join('\n'),
      quotedMessage: block.find(m => m.quotedMessage)?.quotedMessage,
      mentionsAI: block.some(m => m.mentionsAI),
      quotesAI: block.some(m => m.quotesAI),
    };
    blocks.push([...messages.slice(Math.max(0, i - 12), i), merged]);
    i = j;
  }
  // Without a previous judgement (e.g. after a restart), only judge the latest block so old messages are not answered.
  return since == undefined ? blocks.slice(-1) : blocks.slice(-3);
}

/**
 * Decides whether Sofia should reply to the new messages in a group chat. A direct @mention always gets a reply, every
 * other new block of messages is judged by the decision model and Sofia replies if any of them call for it.
 * Falls back to replying when a new message contains "sofia" if the decision model fails.
 */
export async function decideGroupReply(messages: DecisionMsg[], since?: number): Promise<ReplyDecision> {
  const blocks = newMessageBlocks(messages, since);
  if (blocks.length == 0) {
    return { reply: false, reason: 'no new messages' };
  }
  if (blocks.some(b => b[b.length - 1].mentionsAI)) {
    return { reply: true, reason: '@mentioned' };
  }
  try {
    const decisions = await Promise.all(blocks.map(async b => decideFromAnswers(await askDecisionModel(b), {
      quotesAI: b[b.length - 1].quotesAI,
      sofiaRecent: b.slice(0, -1).some(m => m.speaker == null),
    })));
    return decisions.find(d => d.reply) ?? decisions[decisions.length - 1];
  }
  catch (e) {
    const reply = blocks.some(b => b[b.length - 1].quotesAI || b[b.length - 1].text.toLowerCase().includes('sofia'));
    return { reply, reason: `decision model failed, fell back to name check: ${(e as Error).message}` };
  }
}

/*
 * Why new messages are judged per sender instead of all at once (tested 2026-10-09):
 *
 * `decideGroupReply` sends one decision model request per block of consecutive messages from the same sender (at most 3,
 * in parallel, so the latency is about one request). Sending all new messages as one combined "LATEST" message was
 * tried on 7 group chat bursts where several people messaged at once:
 *
 *   per sender: 7/7 correct
 *   combined:   5/7 correct
 *
 * Each question has a single answer for the whole state (one `addressee`, one `kind`), so when a burst mixes messages
 * meant for Sofia with chatter between humans, the answer gets diluted. The two combined failures:
 *
 *   - Mary: "guys is the java assignment due friday?" / Alex: "anyone wanna get bubble tea after" / John: "me!"
 *     kind was school_question 0.48 vs social_question 0.34, just under the 0.5 cutoff, so Mary's question was missed.
 *   - Mary: "OMG THANK YOU SO MUCH ILY" (after Sofia helped her) / Alex: "lets gooo" / John: "alex u done with yours?"
 *     John's question to Alex made the addressee `other_member` (kind emotional 0.48 vs statement 0.41), so Sofia ignored Mary.
 *
 * Combined requests did handle simpler mixes (a question to Sofia followed by "lol", or several people saying "noted"),
 * but not bursts where messages are aimed at different people.
 */
