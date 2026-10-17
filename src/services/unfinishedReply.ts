import { systemOne } from './replyDecision';

/**
 * Qwen sometimes ends a reply by saying it is about to do something ("Going in now! 🚀") without making the tool call,
 * especially with thinking on: it plans the call, then stops (https://github.com/QwenLM/Qwen3/issues/1817). The user is
 * left waiting for something that never happens. When a reply ends with text and no tool call, the decision model checks
 * how the text ends, and Sofia gets one more turn to actually do it if it says she is about to act.
 */

/** "about_to_act" probability at or above this nudges Sofia. Tested: unfinished endings 0.36-0.95, finished ones 0.00-0.09. */
export const UNFINISHED_THRESHOLD = 0.3;

export const UNFINISHED_NUDGE = "Your last message says you're about to do something, but you didn't call a tool, so nothing happened and the user is still waiting. Do it now by calling the tool. If it's actually done or you changed your mind, call `end_message` instead. Don't apologise or repeat yourself.";

const QUESTIONS = {
  ending: {
    type: 'choice', instructions: 'How does this last message end?', criteria: {
      about_to_act: "Says she is about to do something now or is doing it ('going in now', 'let me check', 'give me a sec', 'setting it now', 'sending now')",
      done_or_answered: 'Reports something already done, or answers / gives information',
      question_or_offer: "Asks a question or offers to do something if the user wants ('want me to...?')",
      sign_off: 'A greeting, thanks or good night',
    }
  },
};

/** How likely it is that `text` (the end of a reply) says Sofia is about to act, 0 to 1. Throws if the API fails. */
export async function aboutToActProbability(text: string): Promise<number> {
  const state = `Sofia is an AI assistant on WhatsApp. She can only act by calling tools (send messages, check timetables, set reminders, search, save memories). Her reply has just ended. This is the last thing she sent:\n\n"${text}"`;
  const answers = await systemOne(state, QUESTIONS);
  return answers.ending.probabilities?.about_to_act ?? 0;
}
