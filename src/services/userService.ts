// Written by Bing Chat
import { Sequelize, ModelStatic, InferCreationAttributes, InferAttributes } from 'sequelize';
import { User } from '../models/User'; // Import User model
import { PreProccessChatMsg } from './botService';
import { formatDateTime } from '../utils/common';
import { EasyInputMessage, ResponseInputItem } from 'openai/resources/responses/responses.js';
import Store from './store';

type UserCreateInput = Omit<InferCreationAttributes<User>, 'id'>;
type UserAttributes = InferAttributes<User>;

export class UserService {
  private store: Store;
  private db: Sequelize;
  private Model: ModelStatic<User>;

  constructor(store: Store) {
    this.store = store
    this.db = this.store.db;
    this.Model = this.db.models.UserStore as ModelStatic<User>;
  }

  async create(data: UserCreateInput): Promise<User> {
    return this.Model.create(data);
  }

  async findById(id: string): Promise<User | null> { // ID is now string
    return this.Model.findByPk(id);
  }

  async findAll(): Promise<User[]> {
    return this.Model.findAll();
  }

  async update(id: string, updates: Partial<UserAttributes>): Promise<User | null> {
    const inst = await this.findById(id);
    if (!inst) return null;
    return inst.update(updates, { where: { id } });
  }

  async destroy(id: string): Promise<void> {
    await this.Model.destroy({ where: { id } });
  }

  async getUserByJid(jid: string): Promise<User | null> {
    return this.Model.findOne({ where: { whatsapp_jid: jid } });
  }

  async generateUserStringFromJid(jid: string): Promise<string> {
    const user = await this.getUserByJid(jid);
    return user ? `${user.name} (${user.id})` : `Unknown User`;
  }

  /**
   * Takes an array of PreProccessChatMsg and merges consecutive messages from the same user.
   *
   * @param {PreProccessChatMsg[]} messages - The array of message objects.
   * @returns {Promise<string[]>} An array of formatted strings, one for each unique/merged message block.
   */
  async formatAndMergeMessages(messages: PreProccessChatMsg[], limit: number = 7): Promise<[Array<ResponseInputItem>, string?]> {
    if (!messages || messages.length === 0) {
      return [[], undefined];
    }

    // const dateLimit = new Date().getTime() - 24 * 60 * 60 * 1000; // 24 hours ago
    // messages = (await Promise.all(messages.filter((m: PreProccessChatMsg) => m.time > dateLimit).map(async (m: PreProccessChatMsg) => ({ ...m, user: m.user ? (m.user == 'AI' ? m.user : await this.generateUserStringFromJid(m.user)) : "Unknown User" })))) as PreProccessChatMsg[];
    messages = (await Promise.all(messages.map(async (m: PreProccessChatMsg) => ({ ...m, user: m.user ? (m.user == 'AI' ? m.user : await this.generateUserStringFromJid(m.user)) : "Unknown User" })))) as PreProccessChatMsg[];

    // TODO: Make Paralell
    let newMessages: Array<ResponseInputItem | PreProccessChatMsg> = [];
    for (let i = 0; i < messages.length; i++) {
      newMessages.push(messages[i], ...(messages[i].id ? await this.store.toolCallHist.followTrail(messages[i].id as string) : []));
    }

    const results: ResponseInputItem[] = [];
    let i = 0;

    let lastMsgId;

    while (i < newMessages.length) {
      let currentMessage = newMessages[i];
      if (!(currentMessage as any).user) {
        results.push(currentMessage as ResponseInputItem);
        limit++;
        i++;
        continue;
      }
      currentMessage = currentMessage as PreProccessChatMsg;
      let mergedMessages = [currentMessage];
      let j = i + 1;

      if (currentMessage.id) {
        lastMsgId = currentMessage.id;
      }

      // Check for consecutive messages from the same user
      while (j < newMessages.length && (newMessages[j] as any).user && ((newMessages[j] as PreProccessChatMsg).user == currentMessage.user)) {
        mergedMessages.push(newMessages[j] as PreProccessChatMsg);
        j++;
      }

      // Process the merged block
      let user = currentMessage.user;
      let user_is_ai = user === 'AI';
      let outputParts = [];

      for (let k = 0; k < mergedMessages.length; k++) {
        const msg = mergedMessages[k];

        // Format components for the current message in the block
        let userText = msg.user ? (msg.user === 'AI' ? 'AI' : msg.user) : 'Unknown';
        let quotedMsgPart = msg.quotedMessage ? `Quoted Msg:${msg.quotedMessage}\n` : '';
        let timeStamp = `Time:${formatDateTime(msg.time * 1000)}`; // Using toLocaleString() for better general readability

        if (k > 0) {
          if (user_is_ai) {
            outputParts.push(msg.text);
          }
          else {
            outputParts.push(
              `${quotedMsgPart}${msg.text}\n${timeStamp}`
            );
          }
        } else {
          if (user_is_ai) {
            outputParts.push(`${userText}:\n${msg.text}`);
          } else {
            // First message in the block (k=0)
            outputParts.push(`${userText}:\n${quotedMsgPart}${msg.text}\n${timeStamp}`);
          }
        }
      }

      // Final assembly for the block
      let finalBlock = outputParts.join('\n\n');
      results.push((finalBlock.startsWith('AI:\n') ? { role: 'assistant', content: finalBlock.slice(4), type: 'message' } : { role: 'user', content: finalBlock, type: 'message' }) as EasyInputMessage);

      // Move index to the next unprocessed message
      i = j;
    }

    return [results.slice(limit * -1), lastMsgId];
  }

  // Example Usage (for testing/demonstration)
  /*
  const mockMessages: PreProccessChatMsg[] = [
      { user: 'UserA', time: 1678886400000, text: 'Hello', quotedMessage: null },
      { user: 'UserA', time: 1678886401000, text: 'World', quotedMessage: null }, // Merges with above
      { user: 'AI', time: 1678886402000, text: 'Hi there', quotedMessage: 'Test Quote' }, // New user
      { user: 'AI', time: 1678886403000, text: 'How are you?', quotedMessage: null } // Merges with above
  ];
  
  const formatted = formatAndMergeMessages(mockMessages);
  console.log(formatted.join('\n\n'));
  */
}