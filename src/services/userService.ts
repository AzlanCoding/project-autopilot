// Written by Bing Chat
import { Sequelize, ModelStatic, InferCreationAttributes, InferAttributes } from 'sequelize';
import { User } from '../models/User'; // Import User model
import { PreProccessChatMsg } from './botService';
import { formatDateTime } from '../utils/common';
import {
  HumanMessage,
  BaseMessage,
  AIMessage
} from 'langchain';

type UserCreateInput = Omit<InferCreationAttributes<User>, 'id'>;
type UserAttributes = InferAttributes<User>;

export class UserService {
  private db: Sequelize;
  private Model: ModelStatic<User>;

  constructor(sequelize: Sequelize) {
    this.db = sequelize;
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
   * Function is wriiten by gemma 4. It is very poorly written but it works. It is not efficient and should be refactored.
   *
   * @param {PreProccessChatMsg[]} messages - The array of message objects.
   * @returns {Promise<string[]>} An array of formatted strings, one for each unique/merged message block.
   */
  async formatAndMergeMessages(messages: PreProccessChatMsg[]): Promise<BaseMessage[]> {
    if (!messages || messages.length === 0) {
      return [];
    }

    // const dateLimit = new Date().getTime() - 24 * 60 * 60 * 1000; // 24 hours ago
    // messages = (await Promise.all(messages.filter((m: PreProccessChatMsg) => m.time > dateLimit).map(async (m: PreProccessChatMsg) => ({ ...m, user: m.user ? (m.user == 'AI' ? m.user : await this.generateUserStringFromJid(m.user)) : "Unknown User" })))) as PreProccessChatMsg[];
    messages = (await Promise.all(messages.map(async (m: PreProccessChatMsg) => ({ ...m, user: m.user ? (m.user == 'AI' ? m.user : await this.generateUserStringFromJid(m.user)) : "Unknown User" })))) as PreProccessChatMsg[];

    const results = [];
    let i = 0;

    while (i < messages.length) {
      let currentMessage = messages[i];
      let mergedMessages = [currentMessage];
      let j = i + 1;

      // Check for consecutive messages from the same user
      while (j < messages.length && (messages[j].user === currentMessage.user)) {

        // A more robust check for user equality might be needed depending on actual 'user' values,
        // but based on the requirement, we check if the user matches the starting user.
        if (messages[j].user === currentMessage.user) {
          mergedMessages.push(messages[j]);
          j++;
        } else {
          break;
        }
      }

      // Process the merged block
      let user = currentMessage.user;
      let user_is_ai = user === 'AI';
      let outputParts = [];
      let allMerged = true;

      for (let k = 0; k < mergedMessages.length; k++) {
        const msg = mergedMessages[k];
        let msgParts = [];

        // Format components for the current message in the block
        let userText = msg.user ? (msg.user === 'AI' ? 'AI' : msg.user) : 'Unknown';
        let quotedMsgPart = msg.quotedMessage ? `Quoted Msg:${msg.quotedMessage}\n` : '';
        let timeStamp = `Time:${formatDateTime(msg.time)}`; // Using toLocaleString() for better general readability

        // // Build the structured part for the current message
        // let currentBlock = `${userText}:\n${quotedMsgPart}\n${msg.text}\n${timeStamp}`;

        // If we are not on the first message, we need to append the join string to the *previous* structure, 
        // or adjust how we structure the overall block.
        // Since the requirement shows the join *between* message structures, we will append the join string 
        // before adding the subsequent message block content.

        if (k > 0) {
          // // For merged messages, the join logic is complex. 
          // // Original format: ${user}:...${text}\ntime${...}
          // // Merged format: ${user}:...${text}\ntime${...}\n${quotedMessage2}:...${text2}\ntime${...}

          // // To achieve the structure suggested:
          // // Message 1 block: (Structure for Msg 1)
          // // Join: \n\n
          // // Message 2 block: (Structure for Msg 2, but adjusted to flow from Message 1's time stamp)

          // // Re-evaluating the merged format suggested:
          // // `${user}:\n${quotedMessage ? "Quoted Msg:"+quotedMessage : ""}\n${text}\ntime${new Date(time).toLocalString()}\n${quotedMessage2 ? "Quoted Msg:"+quotedMessage2 : ""}\n${text2}\ntime${new Date(time2).toLocalString()}`

          // // This suggests a flattened structure where only the *first* user's name is used, and subsequent messages 
          // // are appended with extra context.

          // // Let's build it sequentially based on the suggested output format:
          // if (k === 1) {
          //   // The second message starts directly after the time of the first message, separated by \n
          //   outputParts.push(
          //     `${msg.quotedMessage ? "Quoted Msg:" + msg.quotedMessage : ""}\n${msg.text}\nTime:${formatDateTime(msg.time)}`
          //   );
          // } else {
          //   // For k > 1, it seems to follow the same pattern appended after the time stamp.
          //   outputParts.push(
          //     `${msg.quotedMessage ? "Quoted Msg:" + msg.quotedMessage : ""}\n${msg.text}\nTime:${formatDateTime(msg.time)}`
          //   );
          // }
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
      results.push(finalBlock);

      // Move index to the next unprocessed message
      i = j;
    }

    return results.map(msg => msg.startsWith('AI:\n') ? new AIMessage(msg.slice(4)) : new HumanMessage(msg));
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