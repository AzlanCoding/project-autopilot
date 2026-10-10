import * as fs from 'fs/promises';
import * as path from 'path';

export interface PromptChange {
  /** When the change went live, in seconds (same unit as chat message times). */
  time: number,
  summary: string,
}

/**
 * Reads `src/static/prompts/changelog.json`, a list of `{ date, summary }` entries describing changes to the system prompt.
 * Read on every call like `system.md`, so edits apply without a restart.
 */
export async function loadPromptChanges(changelogPath = "src/static/prompts/changelog.json"): Promise<PromptChange[]> {
  try {
    const entries = JSON.parse(await fs.readFile(path.resolve(changelogPath), 'utf-8')) as { date: string, summary: string }[];
    return entries.map(e => ({ time: new Date(e.date).getTime() / 1000, summary: e.summary })).filter(c => !isNaN(c.time)).sort((a, b) => a.time - b.time);
  }
  catch {
    return [];
  }
}

/**
 * The system message inserted into the chat history where the prompt changed. Sofia copies the style of her own earlier
 * messages, so without it she keeps texting the old way until those messages leave the history window.
 */
export function promptChangeNote(change: PromptChange, formatTime: (ms: number) => string): string {
  return `NOTE: Your instructions were updated at ${formatTime(change.time * 1000)}. What changed: ${change.summary}\nYour messages before this note were written under the old instructions, so don't copy their style. Follow your current instructions from here on.`;
}
