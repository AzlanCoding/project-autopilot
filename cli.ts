/**
 * Chat with Sofia in the terminal without WhatsApp. WhatsApp tools (send_message, list_groups, read_chat_history)
 * are backed by an in-memory mock so everything else (memory, scheduled tasks, timetable, etc.) can be tested.
 *
 * Usage: pnpm cli [--user <name or id>] [--seed <file.json>] [--allow-writes]
 *   --allow-writes  Allow memory and scheduled task writes. Only use against a test database.
 *   --seed          JSON file: { users: [{name, description, whatsapp_jid}], groups: [{id, name}],
 *                   chats: { "<user name or group id>": [{ from: "<user name>" | "AI", text, minutesAgo }] } }
 * Commands: /tasks, /run-task <id>, /chat <user name>, /as <user name> <text>, /wait <seconds>, /exit
 * Lines can also be piped in through stdin to script a conversation.
 */
import 'dotenv/config';
import fs from 'fs';
import readline from 'readline';
import pino from 'pino';
import AI, { ChatAdapter } from './src/services/ai';
import Store from './src/services/store';
import type { PreProccessChatMsg } from './src/services/botService';
import { EasyInputMessage, ResponseFunctionToolCall, ResponseInputItem } from 'openai/resources/responses/responses.js';
import { formatDateTime } from './src/utils/common';

const argValue = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

class MockChatAdapter implements ChatAdapter {
  chats: { [id: string]: PreProccessChatMsg[] } = {};
  groups: { id: string, name: string }[] = [{ id: '120363000000000000@g.us', name: 'IT2504 PEM & PCS' }];

  constructor(private db: Store) { }

  /** Chats are keyed by WhatsApp JID for users (like the real store) and group id for groups. */
  private async chatKey(id: string) {
    if (id.endsWith('@g.us')) {
      if (!this.groups.some(g => g.id == id)) throw Error(`Unknown group with id ${id}`);
      return id;
    }
    const user = await this.db.user.findById(id);
    if (!user) throw Error(`Unknown user with id ${id}`);
    return user.whatsapp_jid;
  }

  async record(id: string, user: string, text: string, time = Math.floor(Date.now() / 1000)) {
    const key = await this.chatKey(id);
    (this.chats[key] ??= []).push({ id: `mock-${Math.random()}`, user, time, text });
  }

  async sendMessage(id: string, text: string) {
    const name = id.endsWith('@g.us') ? this.groups.find(g => g.id == id)?.name : (await this.db.user.findById(id))?.name;
    console.log(`\n📤 [send_message -> ${name} (${id})]\n${text}\n`);
    await this.record(id, 'AI', text);
  }

  async listGroups() {
    return this.groups;
  }

  async loadChatById(id: string) {
    return [...(this.chats[await this.chatKey(id)] || [])];
  }
}

const main = async () => {
  const logger = pino({ level: process.env.LOG_LEVEL || 'info' }, pino.destination('cli.log'));
  const db = new Store(logger);
  await db.init();
  await db.ensureMilvusCollection();

  const ai = new AI(db, logger);
  ai.test_mode = !process.argv.includes('--allow-writes');
  ai.cli_mode = true;
  const adapter = new MockChatAdapter(db);
  ai.registerChatTools(adapter);

  const findUser = async (nameOrId: string) => (await db.user.findAll()).find(u => u.id == nameOrId || u.name.toLowerCase() == nameOrId.toLowerCase());

  const seedFile = argValue('--seed');
  if (seedFile) {
    const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    for (const u of seed.users || []) {
      if (!(await db.user.getUserByJid(u.whatsapp_jid))) {
        await db.user.create(u);
      }
    }
    if (seed.groups) adapter.groups = seed.groups;
    for (const [chat, messages] of Object.entries<any[]>(seed.chats || {})) {
      const chatId = chat.endsWith('@g.us') ? chat : (await findUser(chat))!.id;
      for (const m of messages) {
        const from = m.from == 'AI' ? 'AI' : (await findUser(m.from))!.whatsapp_jid;
        await adapter.record(chatId, from, m.text, Math.floor(Date.now() / 1000) - (m.minutesAgo ?? 0) * 60);
      }
    }
  }

  await db.scheduledTask.initService(5000);

  let user = await findUser(argValue('--user') || '') || (await db.user.findAll())[0];
  if (!user) {
    throw Error('No users in the database. Use --seed to add some.');
  }

  let chatHistory: ResponseInputItem[] = [];
  const startChat = async () => {
    chatHistory = [{ role: 'system', content: await ai.generatePrompt('testing', user.name, user.id, user.description), type: 'message' } as EasyInputMessage];
    console.log(`\n=== Chatting as ${user.name} (${user.id}) | writes ${ai.test_mode ? 'disabled' : 'enabled'} ===`);
    console.log('Commands: /tasks, /run-task <id>, /chat <user name>, /as <user name> <text>, /wait <seconds>, /exit\n');
  };
  await startChat();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const prompt = () => process.stdin.isTTY && rl.setPrompt(`${user.name}: `) === undefined && rl.prompt();
  prompt();
  for await (const line of rl) {
    const input = line.trim();
    if (!input) { prompt(); continue; }
    if (!process.stdin.isTTY) console.log(`${user.name}: ${input}`);

    if (input == '/exit') break;
    if (input == '/tasks') {
      console.log(await ai.listScheduledTasksTool.func({}));
    }
    else if (input.startsWith('/as ')) {
      // /as <user name> <text>: that user messages Sofia (recorded only, no reply is generated)
      const [, name, ...words] = input.split(' ');
      const other = await findUser(name);
      if (other) await adapter.record(other.id, other.whatsapp_jid, words.join(' ')); else console.log('Unknown user');
    }
    else if (input.startsWith('/wait ')) {
      await new Promise(r => setTimeout(r, Number(input.slice('/wait '.length)) * 1000));
    }
    else if (input.startsWith('/run-task ')) {
      await db.scheduledTask.runTask(input.slice('/run-task '.length).trim());
    }
    else if (input.startsWith('/chat ')) {
      const next = await findUser(input.slice('/chat '.length).trim());
      if (next) { user = next; await startChat(); } else console.log('Unknown user');
    }
    else {
      await adapter.record(user.id, user.whatsapp_jid, input);
      chatHistory.push({ role: 'user', content: `${user.name} (${user.id}):\n${input}\nTime:${formatDateTime(new Date())}`, type: 'message' } as EasyInputMessage);
      let reply = '';
      try {
        for await (const state of ai.processChatv3(chatHistory)) {
          if (state.type == 'chunk_display') {
            reply += (reply ? '\n\n' : '') + state.content;
          }
          else if (state.type == 'tool_call') {
            const data = (state as any).data as ResponseFunctionToolCall;
            console.log(`🔧 ${data.name}(${data.arguments})`);
          }
          else if (state.type == 'tool_call_output') {
            const output = String((state as any).data.output);
            console.log(`   ↳ ${output.length > 600 ? output.slice(0, 600) + '...' : output}`);
          }
        }
      }
      catch (e) {
        console.error('Chat failed:', e);
      }
      // processChatv3 already appended the assistant reply to chatHistory
      if (reply) {
        await adapter.record(user.id, 'AI', reply);
        console.log(`\nSofia: ${reply}\n`);
      }
    }
    prompt();
  }
  rl.close();
  await db.unloadMilvus();
  process.exit(0);
};

main().catch(e => {
  console.error(e);
  process.exit(1);
});
