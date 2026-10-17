import { createHash } from 'crypto';
import { ModelStatic } from 'sequelize';
import { Logger } from 'pino';
import { decryptPollVote, proto } from 'baileys';
import type Store from './store';
import { Poll, PollVote } from '../models/Poll';

export interface PollResults {
  poll: Poll,
  /** Each option with the voters who picked it, in the poll's order. */
  options: { option: string, voters: string[] }[],
  /** Everyone with a current vote. */
  voters: string[],
}

const sha256 = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('base64');

/**
 * Decrypts an encrypted poll vote, trying every jid the poll's creator and the voter may be known by (WhatsApp moved
 * people to lid jids, and votes are encrypted with whichever jids the voter's phone used). Returns the picked options by
 * name, or null if no combination decrypts it.
 */
export function decryptVote(poll: Pick<Poll, 'id' | 'secret' | 'options' | 'creator_jids'>, vote: proto.Message.IPollEncValue, voterJids: string[]): string[] | null {
  const pollEncKey = Buffer.from(poll.secret, 'base64');
  for (const pollCreatorJid of poll.creator_jids) {
    for (const voterJid of voterJids) {
      try {
        const decrypted = decryptPollVote(vote as any, { pollCreatorJid, pollMsgId: poll.id, pollEncKey, voterJid });
        const hashes = new Set((decrypted.selectedOptions ?? []).map(h => Buffer.from(h).toString('base64')));
        return poll.options.filter(option => hashes.has(sha256(option)));
      }
      catch {
        // Wrong jid combination, the authenticated decryption fails
      }
    }
  }
  return null;
}

/** Polls Sofia sent or saw in her chats, and their decrypted votes. */
export class PollService {
  constructor(private store: Store, private logger: Logger) { }

  private get Polls() {
    return this.store.db.models.PollStore as ModelStatic<Poll>;
  }

  private get Votes() {
    return this.store.db.models.PollVoteStore as ModelStatic<PollVote>;
  }

  findById(id: string) {
    return this.Polls.findByPk(id);
  }

  /** Saves a poll (or keeps the existing one) so its votes can be read later. */
  async save(poll: InferPoll) {
    const [saved] = await this.Polls.findOrCreate({ where: { id: poll.id }, defaults: poll });
    return saved;
  }

  /** Decrypts and saves a vote, replacing the voter's previous vote if it is newer. Returns the picked options. */
  async recordVote(pollId: string, vote: proto.Message.IPollEncValue, voterJids: string[], votedAt: Date): Promise<string[] | null> {
    const poll = await this.findById(pollId);
    if (!poll) {
      this.logger.warn(`Vote for unknown poll ${pollId} (sent before Sofia saved polls?)`);
      return null;
    }
    const selected = decryptVote(poll, vote, voterJids);
    if (!selected) {
      this.logger.warn({ pollId, voterJids }, 'Could not decrypt poll vote');
      return null;
    }
    const voter = voterJids[0];
    const existing = await this.Votes.findOne({ where: { poll_id: pollId, voter } });
    if (!existing) {
      await this.Votes.create({ poll_id: pollId, voter, selected, voted_at: votedAt });
    }
    else if (existing.voted_at <= votedAt) {
      await existing.update({ selected, voted_at: votedAt });
    }
    return selected;
  }

  /** The current votes for a poll, or null if the poll isn't known. `name` turns voter jids into names. */
  async results(pollId: string, name: (jid: string) => Promise<string> = async j => j): Promise<PollResults | null> {
    const poll = await this.findById(pollId);
    if (!poll) {
      return null;
    }
    const votes = (await this.Votes.findAll({ where: { poll_id: pollId } })).filter(v => v.selected.length > 0);
    const names = new Map(await Promise.all(votes.map(async v => [v.voter, await name(v.voter)] as const)));
    return {
      poll,
      options: poll.options.map(option => ({ option, voters: votes.filter(v => v.selected.includes(option)).map(v => names.get(v.voter)!) })),
      voters: votes.map(v => names.get(v.voter)!),
    };
  }
}

type InferPoll = Pick<Poll, 'id' | 'chat' | 'from_me' | 'creator_jids' | 'question' | 'options' | 'multiple' | 'secret'>;
