import * as readline from 'readline';
import { ChatOpenAI } from "@langchain/openai";
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  HumanMessage,
  SystemMessage,
  BaseMessage,
  AIMessage,
  ToolMessage,
  DynamicStructuredTool,
} from 'langchain';
import { z } from "zod";
import { OpenAI } from "openai";
// import { ChatOllama } from '@langchain/ollama'
import Store from './store';
import { formatDateTime } from '../utils/common';
import { User } from '../models/User';
import getCalendarEvents from '../utils/getCalendarEvents';
import { Logger } from 'pino';
import { EasyInputMessage, ResponseCreateParamsStreaming, ResponseFunctionToolCall, ResponseInputItem, ResponseReasoningItem } from 'openai/resources/responses/responses.js';

export class ExtendedDynamicStructuredTool extends DynamicStructuredTool {
  usage_str: string
  constructor(fields: ConstructorParameters<typeof DynamicStructuredTool>[0], usage_str: string) {
    super(fields as any);
    this.usage_str = usage_str;
  }
}

export default class AI {
  ai_user_id: string = "ea502c0f-7fe6-4f7c-9d63-80dd7b0de90e";
  test_mode: boolean = (process.env.TESTING != undefined && process.env.TESTING.toLowerCase() == "true");
  logger: Logger;
  db: Store;
  openai = new OpenAI(
    {
      apiKey: process.env.ALIBABA_API_KEY,
      // baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"
    }
  );


  // Tools will be initialized in constructor so they can reference this.db
  getCurrentTimeTool: ExtendedDynamicStructuredTool;
  memoryWriteTool: ExtendedDynamicStructuredTool;
  memoryQueryTool: ExtendedDynamicStructuredTool;
  memoryQueryByUserTool: ExtendedDynamicStructuredTool;
  memoryDeleteTool: ExtendedDynamicStructuredTool;

  // Assignment tools
  assignmentCreateTool: ExtendedDynamicStructuredTool;
  // assignmentGetTool: ExtendedDynamicStructuredTool;
  assignmentListTool: ExtendedDynamicStructuredTool;
  assignmentUpdateTool: ExtendedDynamicStructuredTool;
  assignmentDeleteTool: ExtendedDynamicStructuredTool;

  // Assessment tools
  assessmentCreateTool: ExtendedDynamicStructuredTool;
  // assessmentGetTool: ExtendedDynamicStructuredTool;
  assessmentListTool: ExtendedDynamicStructuredTool;
  assessmentUpdateTool: ExtendedDynamicStructuredTool;
  assessmentDeleteTool: ExtendedDynamicStructuredTool;

  // User Tools
  userListTool: ExtendedDynamicStructuredTool;

  // Timetable Tool
  timetableTool: ExtendedDynamicStructuredTool;

  // Sticker & GIFs Tools
  stickerGifTool: ExtendedDynamicStructuredTool;
  sendStickerGifTool: ExtendedDynamicStructuredTool;

  // WhatsApp Specific Tools will be added later on runtime
  sendMessageTool?: ExtendedDynamicStructuredTool;
  listGroupsTool?: ExtendedDynamicStructuredTool;

  tools: ExtendedDynamicStructuredTool[];

  // Model will be created after tools are defined
  bindModel: () => void;
  model: ReturnType<ChatOpenAI['bindTools']>;

  constructor(db: Store, logger: Logger) {
    this.db = db;
    this.logger = logger;
    // Simple current time tool
    this.getCurrentTimeTool = new ExtendedDynamicStructuredTool({
      name: "get_current_time",
      description: "Get the current date and time",
      schema: z.object({}),
      func: async () => {
        return formatDateTime(new Date());
      }
    }, "{}");

    // memory_write tool: calls store.memoryWrite
    this.memoryWriteTool = new ExtendedDynamicStructuredTool({
      name: "memory_write",
      description: "Store a durable memory in the database with optional dedupe strategy",
      schema: z.object({
        text: z.string().describe("[Required] The core text content of the memory to be stored. Do not put any user ID inside this field. Make sure the content is not time relative. (e.g., instead of 10 mins ago, state the actual date time.)"),
        authorUserId: z.string().optional().describe(`The ID of the user who told you about this memory. Put ${this.ai_user_id} if you are writing it on your own.`),
        subjectUserId: z.string().optional().describe(`The ID of the user this memory is related to. Put ${this.ai_user_id} if the memory is about yourself.`),
        groupId: z.string().optional().describe("The ID of the group this memory belongs to. In most cases this should be left undefined"),
        isGlobal: z.boolean().optional().describe("A flag indicating if this memory should be considered global."),
        category: z.string().optional().describe("A categorization tag for the memory. If it is an event, put 'event'. If its a memory related to yourself, put 'core'. Put 'important' if its extremly important that you remember this fact, leave empty if none of these apply."),
        // sourceMessageId: z.string().optional().describe("The ID of the original message where this memory originated."),
        dedupeStrategy: z.enum(['supersede', 'overwrite', 'merge', 'keep_both']).optional().describe("The strategy to use if a similar memory already exists.")
      }),
      func: async (args) => {
        if (this.test_mode) {
          throw Error("Disabled due to test mode.");
        }
        const res = await this.db.memoryWrite(args as any);
        // memoryWrite returns a human-friendly string already
        return String(res);
      }
    }, "{text: string, authorUserId?: string, subjectUserId?: string, groupId?: string, isGlobal?: boolean, category?: string, dedupeStrategy?: 'supersede'|'overwrite'|'merge'|'keep_both'}");

    // memory_query tool: calls store.memoryQuery
    this.memoryQueryTool = new ExtendedDynamicStructuredTool({
      name: "memory_query",
      description: "Query memories by text.",
      schema: z.object({
        queryText: z.string().describe("[Required] The text query to search memories by."),
        // queryEmbedding: z.array(z.number()).optional().describe("An array of embedding vectors to search memories by."),
        groupId: z.string().optional().describe("Optional group ID to narrow down memory search."),
        subjectUserId: z.string().optional().describe("Optional subject user ID to filter memories by."),
        includeGlobal: z.boolean().optional().describe("If true, includes global memories across all groups."),
        topK: z.number().optional().describe("The maximum number of top memories to return.")
      }),
      func: async (args) => {
        const res = await this.db.memoryQuery(args as any);
        // Return JSON string so the model receives structured data in the tool response
        return JSON.stringify(res);
      }
    }, "{queryText: string, groupId?: string, subjectUserId?: string, includeGlobal?: boolean, topK?: number}");

    // memory_query_by_user tool: fetch memories related to a user id
    this.memoryQueryByUserTool = new ExtendedDynamicStructuredTool({
      name: "memory_query_by_user",
      description: "Return memories related to a specific user id. Provide userId and optional queryText/topK/includeGlobal.",
      schema: z.object({
        userId: z.string().describe("[Required] The ID of the user whose memories are to be retrieved."),
        queryText: z.string().optional().describe("Optional text query to narrow down memories."),
        topK: z.number().optional().describe("The maximum number of memories to return."),
        includeGlobal: z.boolean().optional().describe("If true, includes global memories.")
      }),
      func: async (args) => {
        const { userId, queryText, topK = 10, includeGlobal = true } = args as any;
        const res = await this.db.memoryQueryByUserId({ userId, queryText, topK, includeGlobal });
        // Return JSON so the model receives structured data
        return JSON.stringify(res);
      }
    }, "{userId: string, queryText?: string, topK?: number, includeGlobal?: boolean}");

    this.memoryDeleteTool = new ExtendedDynamicStructuredTool({
      name: "del_memory_by_id",
      description: "Delete a specific memory by ID.",
      schema: z.object({
        memoryId: z.string().describe("[Required] The ID of the memory. If you don't have the memory ID, query to find the memory first."),
      }),
      func: async (args) => {
        if (this.test_mode) {
          throw Error("Disabled due to test mode.");
        }
        const { memoryId } = args as any;
        const res = await this.db.deleteMemory(memoryId);
        // Return JSON so the model receives structured data
        return JSON.stringify(res);
      }
    }, "{memoryId: string}");

    // this.db.assessment.

    // -------------------------
    // Assignment: Create
    // -------------------------
    this.assignmentCreateTool = new ExtendedDynamicStructuredTool({
      name: "assignment_create",
      description: "Create a new assignment. Provide subject, title, optional description and dueDate.",
      schema: z.object({
        subject: z.string().min(1).describe("[Required] Subject of the assignment."),
        title: z.string().min(1).describe("[Required] Title of the assignment. Include the weightage of the assignment. E.g., Assignment 1 (15%)"),
        description: z.string().min(1).describe("Optional description text but avoid leaving empty."),
        dueDate: z.string().describe("Due date as ISO 8601 in Sigapore Timezone. E.g, 2026-04-16T11:47:12+08:00")
      }),
      func: async (args) => {
        const { subject, title, description = null, dueDate } = args as any;
        if (!dueDate) {
          throw Error("dueDate is required.")
        }
        if (!description) {
          throw Error("Please describe the assignment.")
        }
        const created = await this.db.assignment.create({ subject, title, description, dueDate: (new Date(dueDate)).getTime() });
        const result = created?.toJSON ? created.toJSON() : created;
        return JSON.stringify({ ...result, dueDate: result?.dueDate ? formatDateTime(Number(result?.dueDate)) : result?.dueDate })
      }
    }, "{subject: string, title: string, description: string, dueDate: string}");


    // // -------------------------
    // // Assignment: Get by id
    // // -------------------------
    // this.assignmentGetTool = new ExtendedDynamicStructuredTool({
    //   name: "assignment_get",
    //   description: "Get an assignment by id. Provide id.",
    //   schema: z.object({
    //     id: z.number().int().positive().describe("[Required] Primary key id of the assignment.")
    //   }),
    //   func: async (args) => {
    //     try {
    //       const { id } = args as any;
    //       const found = await this.db.assignment.findById(id);
    //       return JSON.stringify(found ? (found.toJSON ? found.toJSON() : found) : null);
    //     } catch (err: any) {
    //       return `Tool execution error: ${err?.message ?? String(err)}\nToolArgs: {id: string}`;
    //     }
    //   }
    // });

    // -------------------------
    // Assignment: List (with optional pagination)
    // -------------------------
    this.assignmentListTool = new ExtendedDynamicStructuredTool({
      name: "assignment_list",
      description: "List assignments.",
      schema: z.object({}),
      func: async (args) => {
        const rows = await this.db.assignment.findAll();
        const out = (rows || []).map((r: any) => (r.toJSON ? r.toJSON() : r)).map((r: any) => ({ ...r, dueDate: formatDateTime(Number(r.dueDate)) }));
        return JSON.stringify(out);
      }
    }, "{}");

    // -------------------------
    // Assignment: Update
    // -------------------------
    this.assignmentUpdateTool = new ExtendedDynamicStructuredTool({
      name: "assignment_update",
      description: "Update an assignment by id. Provide id and updates object with any updatable fields.",
      schema: z.object({
        id: z.number().int().positive().describe("[Required] Primary key id of the assignment."),
        updates: z.object({
          subject: z.string().min(1).optional().describe("Optional new subject."),
          title: z.string().min(1).optional().describe("Optional new title."),
          description: z.string().optional().nullable().describe("Optional new description."),
          dueDate: z.string().optional().describe("Optional new due date as ISO 8601 in Sigapore Timezone. E.g, 2026-04-16T11:47:12+08:00")
        }).partial().describe("Fields to update.")
      }),
      func: async (args) => {
        const { id, updates } = args as any;
        const updated = await this.db.assignment.update(id, { ...updates, ...(updates.dueDate ? { dueDate: (new Date(updates.dueDate)).getTime() } : {}) });
        if (!updated) {
          throw Error("Assignment not found.");
        }
        const result = updated.toJSON ? updated.toJSON() : updated;
        return JSON.stringify({ ...result, date: result?.dueDate ? formatDateTime(Number(result?.dueDate)) : result?.dueDate });
      }
    }, "{id: number, updates: {subject?: string, title?: string, description?: string, dueDate?: string}}");

    // -------------------------
    // Assignment: Delete
    // -------------------------
    this.assignmentDeleteTool = new ExtendedDynamicStructuredTool({
      name: "assignment_delete",
      description: "Delete an assignment by id. Provide id.",
      schema: z.object({
        id: z.number().int().positive().describe("[Required] Primary key id of the assignment to delete.")
      }),
      func: async (args) => {
        const { id } = args as any;
        await this.db.assignment.destroy(id);
        return JSON.stringify({ success: true, id });
      }
    }, "{id: number}");

    // -------------------------
    // Assessment: Create
    // -------------------------
    this.assessmentCreateTool = new ExtendedDynamicStructuredTool({
      name: "assessment_create",
      description: "Create a new assessment. Provide subject, title, optional description and date.",
      schema: z.object({
        subject: z.string().min(1).describe("[Required] Subject of the assessment."),
        title: z.string().min(1).describe("[Required] Title of the assessment. Include the weightage of the assessment. E.g., Practical Test 1 (25%)"),
        description: z.string().min(1).describe("Description of the assessment."),
        date: z.string().describe("Date as ISO 8601 in Sigapore Timezone. E.g, 2026-04-16T11:47:12+08:00")
      }),
      func: async (args) => {
        const { subject, title, description = null, date } = args as any;
        const created = await this.db.assessment.create({ subject, title, description, date: (new Date(date)).getTime() });
        const result = created?.toJSON ? created.toJSON() : created;
        return JSON.stringify({ ...result, date: result?.date ? (formatDateTime(Number(result?.date))) : result?.date })
      }
    }, "{subject: string, title: string, description: string, date: string }");

    // // -------------------------
    // // Assessment: Get by id
    // // -------------------------
    // this.assessmentGetTool = new ExtendedDynamicStructuredTool({
    //   name: "assessment_get",
    //   description: "Get an assessment by id. Provide id.",
    //   schema: z.object({
    //     id: z.number().int().positive().describe("[Required] Primary key id of the assessment.")
    //   }),
    //   func: async (args) => {
    //     try {
    //       const { id } = args as any;
    //       const found = await this.db.assessment.findById(id);
    //       return JSON.stringify(found ? (found.toJSON ? found.toJSON() : found) : null);
    //     } catch (err: any) {
    //       return `Tool execution error: ${err?.message ?? String(err)}`;
    //     }
    //   }
    // });

    // -------------------------
    // Assessment: List (with optional pagination)
    // -------------------------
    this.assessmentListTool = new ExtendedDynamicStructuredTool({
      name: "assessment_list",
      description: "List assessments.",
      schema: z.object({}),
      func: async (args) => {
        const rows = await this.db.assessment.findAll();
        const out = (rows || []).map((r: any) => (r.toJSON ? r.toJSON() : r)).map((r: any) => ({ ...r, date: formatDateTime(Number(r.date)) }));
        return JSON.stringify(out);
      }
    }, "{}");

    // -------------------------
    // Assessment: Update
    // -------------------------
    this.assessmentUpdateTool = new ExtendedDynamicStructuredTool({
      name: "assessment_update",
      description: "Update an assessment by id. Provide id and updates object with any updatable fields.",
      schema: z.object({
        id: z.number().int().positive().describe("[Required] Primary key id of the assessment."),
        updates: z.object({
          subject: z.string().min(1).optional().describe("Optional new subject."),
          title: z.string().min(1).optional().describe("Optional new title."),
          description: z.string().optional().nullable().describe("Optional new description."),
          date: z.string().optional().describe("Optional new date as ISO 8601 in Sigapore Timezone. E.g, 2026-04-16T11:47:12+08:00")
        }).partial().describe("Fields to update.")
      }),
      func: async (args) => {
        const { id, updates } = args as any;
        const updated = await this.db.assessment.update(id, { ...updates, ...(updates.date ? { date: (new Date(updates.date)).getTime() } : {}) });
        if (!updated) {
          throw Error("Assessment not found.");
        }
        const result = updated.toJSON ? updated.toJSON() : updated;
        return JSON.stringify({ ...result, date: result?.date ? formatDateTime(Number(result?.date)) : result?.date });
      }
    }, "{id: number, updates: {subject?: string, title?: string, description?: string, date?: string}}");

    // -------------------------
    // Assessment: Delete
    // -------------------------
    this.assessmentDeleteTool = new ExtendedDynamicStructuredTool({
      name: "assessment_delete",
      description: "Delete an assessment by id. Provide id.",
      schema: z.object({
        id: z.number().int().positive().describe("[Required] Primary key id of the assessment to delete.")
      }),
      func: async (args) => {
        const { id } = args as any;
        await this.db.assessment.destroy(id);
        return JSON.stringify({ success: true, id });
      }
    }, "{id: number}");

    // -------------------------
    // User: List
    // -------------------------
    this.userListTool = new ExtendedDynamicStructuredTool({
      name: "user_list",
      description: "List all users in your contacts list.",
      schema: z.object({}),
      func: async (args) => {
        const rows = await this.db.user.findAll();
        const out = (rows || []).map((r: any) => (r.toJSON ? r.toJSON() : r)).map((r: User) => ({ id: r.id, name: r.name, description: r.description }));
        return JSON.stringify(out);
      }
    }, "{}");

    this.stickerGifTool = new ExtendedDynamicStructuredTool({
      name: "search_sticker_gif",
      description: "Search for a Sticker OR GIF",
      schema: z.object({
        query: z.string().describe("The query to search for. Can be a keyword or a phrase."),
      }),
      func: async (args) => {
        throw Error("Hi Sofia. This is a built-in message from Azlan. Sorry but I'm not done writing the code for this tool yet. Please try again some other time.");
      }
    }, "{}")

    this.sendStickerGifTool = new ExtendedDynamicStructuredTool({
      name: "send_sticker_gif",
      description: "Send a Sticker OR a GIF to the current chat",
      schema: z.object({
        id: z.string().describe("The ID of the sticker.")
      }),
      func: async (args) => {
        throw Error("Hi Sofia. This is a built-in message from Azlan. Sorry but I'm not done writing the code for this tool yet. Please try again some other time.");
      }
    }, "{}")

    this.timetableTool = new ExtendedDynamicStructuredTool({
      name: "get_timetable",
      description: "Get the timetable for a specific day. Note that events that start with (ELEARN) are e-learning lessons and can be done at any time.",
      schema: z.object({
        date: z.string().optional().describe("[Optional] The date of the timetable in the format DD/MM/YYYY. If not provided, it will return the current day's timetable."),
      }),
      func: async (args) => {
        const { date = undefined } = args as any;
        return (await getCalendarEvents(true, date)) || "No events found for the specified date.";
      }
    }, "{date?:string}")


    // Register tools (order doesn't matter)
    this.tools = [
      this.getCurrentTimeTool,
      this.memoryWriteTool, this.memoryQueryTool, this.memoryQueryByUserTool, this.memoryDeleteTool,
      this.assignmentCreateTool/*, this.assignmentGetTool*/, this.assignmentListTool, this.assignmentUpdateTool, this.assignmentDeleteTool,
      this.assessmentCreateTool/*, this.assessmentGetTool*/, this.assessmentListTool, this.assessmentUpdateTool, this.assessmentDeleteTool,
      this.userListTool,
      this.stickerGifTool, this.sendStickerGifTool,
      this.timetableTool
    ];

    // Model Setup (Keep Ollama/OpenAI context)
    // this.model = new ChatOpenAI({
    //   apiKey: process.env.OPENAI_API_KEY,
    //   // modelName: "gpt-4o-mini",
    //   modelName: "qwen3.5:latest",
    //   configuration: {
    //     baseURL: "http://localhost:11434/v1"
    //   }
    // }).bindTools(this.tools);

    this.model = new ChatOpenAI();

    this.bindModel = () => { // Reload tools for AI.
      this.model = new ChatOpenAI({
        apiKey: process.env.ALIBABA_API_KEY,
        // model: 'gpt-4o-mini',
        model: 'qwen3.5-plus',
        configuration: {
          // baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
          baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"
        }
      }).bindTools(this.tools)
      // this.model = new ChatOllama({
      //   model: "qwen3.5:latest",
      //   numCtx: 4096 * 4
      //   // model: 'qwen3.5-flash',
      //   // configuration: {
      //   //   baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
      //   // }
      // }).bindTools(this.tools)
    }
    this.bindModel();

    this.db.ai_scheduled_task_runner = async (message: () => Promise<string>, modelOptions: Partial<ResponseCreateParamsStreaming> = { model: "qwen3.6-plus" }) => {
      // 1. Read the System Prompt from the file
      const systemPromptPath = path.resolve("src/static/prompts/system.md");
      const systemMessageContent = await fs.readFile(systemPromptPath, 'utf-8');
      const memoryPrompt = `Current Chat Mode: System Scheduled Task Mode (GIFs and Stickers unavaliable in this mode)\nYour Core Memories: ${JSON.stringify((await this.db.getCoreMemories({})).data)}
      Avaliable Tool Calls: ${this.tools.map(t => t.name).join(', ')}
      IMPORTANT: This chat is triggered automatically by the system due to a scheduled task. SEND YOUR REPLY USING THE send_message TOOL CALL ONLY! ONLY 1 USER MESSAGE WILL BE SENT! FOLLOW THE USER INSTRUCTIONS IMMEDIATELY! DO NOT ASK FOR CONFIRMATION!
      GROUP CHATS: ${await this.listGroupsTool!.func({})}`;
      const systemPrompt = `${systemMessageContent}\nCurrent Time: ${formatDateTime(new Date())}\n${memoryPrompt}`;
      const chatHistory: BaseMessage[] = [new SystemMessage(systemPrompt), new HumanMessage(await message())]
      const streamGenerator = this.processChatv2(chatHistory, undefined, modelOptions);
      for await (const yieldState of streamGenerator) {
        if (yieldState.type === 'chunk_display') {
          this.logger.warn(`SCHEDULED TASK YIELDED CONTENT: ${yieldState.content as string}`);
          // if (yieldState.delimiter) {
          //   process.stdout.write("\n-------------------------------\n");
          // }
        } else if (yieldState.type === 'done') {
          break; // Exit the loop after the full content is collected
        }
      }
    }
  }

  /**
   * Asynchronously streams the model response, yielding control back to the caller
   * periodically to allow for display control.
   * @param userInput The message from the user.
   * @param chatHistory The current list of messages for context.
   * @yields A Promise that resolves when the response content is fully generated.
   */
  async * processChat(
    chatHistory: BaseMessage[],
    userInput?: string,
  ) {
    if (userInput) {
      const userMessage = new HumanMessage(userInput);
      chatHistory.push(userMessage);
    }

    // 🔧 Build tool registry (name → tool)
    const toolMap: Record<string, ExtendedDynamicStructuredTool> = Object.fromEntries(
      this.tools.map(t => [t.name, t])
    );

    try {
      console.log("\n🤖 Thinking...");

      const memory = await this.memoryQueryTool.func({ queryText: userInput })
      if (memory instanceof Array && memory.length > 0) {
        chatHistory.push(new SystemMessage(`Possibly relavent memory data: ${memory}`))
      }

      let fullResponseContent = "";
      let chunck = "";

      // 🔁 Recursive stream handler
      const handleStream = async function* (
        stream: any,
        model: ReturnType<ChatOpenAI['bindTools']>
      ): AsyncGenerator<any> {
        for await (const chunk of stream) {

          // 🧠 TOOL CALL HANDLING (multi-call safe)
          if (
            chunk.tool_calls &&
            chunk.tool_calls.length > 0 &&
            chunk.tool_calls.every((tc: any) => tc.id)
          ) {
            const toolCalls = chunk.tool_calls;

            // 1. Add AIMessage with all tool calls
            chatHistory.push(
              new AIMessage({
                content: "",
                tool_calls: toolCalls,
              })
            );

            // 2. Execute all tools
            for (const toolCall of toolCalls) {
              console.dir(toolCall);
              console.log(`Called ${toolCall.name}`)
              const tool = toolMap[toolCall.name];

              let result: string;

              try {
                if (!tool) {
                  result = `Error: Unknown tool "${toolCall.name}"`;
                } else {
                  // 🧩 Flush remaining buffer if there is. (e.g, AI says it will go get the information)
                  if (chunck) {
                    yield {
                      type: "chunk_display",
                      content: chunck,
                      delimiter: false,
                    };
                    chunck = "";
                  }

                  // parse args safely (if present)
                  const args = toolCall.args ?? {};
                  console.trace(args)
                  result = await tool.invoke(args);
                }
              } catch (err: any) {
                console.error(err);
                result = `Tool execution error: ${err.message}\nToolArgs: ${tool.usage_str}`;
              }
              console.trace(result);

              chatHistory.push(
                new ToolMessage({
                  content: result,
                  tool_call_id: toolCall.id!,
                })
              );
            }

            // 3. Restart stream AFTER all tools complete
            const followStream = await model.stream(chatHistory);

            yield* handleStream(followStream, model);
            return; // stop current stream
          }

          // 📡 NORMAL STREAMING (unchanged)
          const chunkText = (chunk.content || "") as string;

          fullResponseContent += chunkText;
          chunck += chunkText;

          if (chunck.includes("\n\n")) {
            let text = chunck.slice(0, chunck.indexOf("\n\n"));
            chunck = chunck.slice(chunck.indexOf("\n\n") + 2);

            yield {
              type: "chunk_display",
              content: text,
              delimiter: true,
            };
          }
        }
      };

      // 🚀 Start initial stream
      const initialStream = await this.model.stream(chatHistory);

      for await (const yieldState of handleStream(initialStream, this.model)) {
        yield yieldState;
      }

      // 🧩 Flush remaining buffer
      if (chunck) {
        yield {
          type: "chunk_display",
          content: chunck,
          delimiter: false,
        };
      }

      // ✅ Persist final AI response
      chatHistory.push(new AIMessage(fullResponseContent));

      yield {
        type: "done",
        content: chatHistory,
      };

    } catch (error) {
      console.error("\n🚨 Oops! Something went wrong:", error);
      chatHistory.pop();
      throw error;
    }
  }


  /**
   * Same behavior as the original processChat but implemented using the official OpenAI Node.js Responses streaming API.
   *
   * Notes / assumptions:
   * - `this.openai` is an instance of `new OpenAI({ apiKey })`.
   * - `this.modelName` is the model id to call (e.g., "gpt-4o-mini" or "gpt-4o").
   * - `this.tools` is an array of ExtendedDynamicStructuredTool objects with `.name` and `.invoke(args)` (or `.invoke` signature).
   * - `this.memoryQueryTool.func` exists and returns memory results for the given query.
   * - `chatHistory` uses the same message classes as in the original code.
   *
   * Adjust imports and minor details to match your codebase.
   */
  async * processChatv2(
    chatHistory: BaseMessage[],
    userInput?: string,
    additionalOptions: Partial<ResponseCreateParamsStreaming> = {}
  ) {
    // Add user message to history if provided
    if (userInput) {
      const userMessage = new HumanMessage(userInput);
      chatHistory.push(userMessage);
    }

    // Build tool map for quick lookup
    const toolMap: Record<string, ExtendedDynamicStructuredTool> = Object.fromEntries(
      this.tools.map((t: ExtendedDynamicStructuredTool) => [t.name, t])
    );

    try {
      console.log("\n🤖 Thinking (v2 with official OpenAI client)...");

      // Query memory and add a system hint if relevant
      const memory = await this.memoryQueryTool.func({ queryText: userInput || chatHistory.filter(m => m instanceof HumanMessage).slice(-1)[0].content });
      if (Array.isArray(memory) && memory.length > 0) {
        chatHistory.push(new SystemMessage(`Possibly relevant memory data: ${memory}`));
      }

      // Convert chatHistory to the shape expected by the OpenAI Responses API
      const buildMessagesForOpenAI: (history: BaseMessage[]) => Array<ResponseInputItem> = (history) =>
        history.map((m) => {
          // Map your message classes to role/content pairs
          if (m instanceof HumanMessage) {
            return { role: "user", content: (m.content ?? "") as string, type: "message" } as EasyInputMessage;
          }
          if (m instanceof AIMessage) {
            if (m.tool_calls) {
              for (let i = 0; i < m.tool_calls.length; i++) {
                return {
                  call_id: (m.tool_calls[i] as any).id,
                  arguments: (m.tool_calls[i] as any).args instanceof String ? (m.tool_calls[i] as any).args : JSON.stringify((m.tool_calls[i] as any).args),
                  name: (m.tool_calls[i] as any).name, type: 'function_call'
                } as ResponseFunctionToolCall
              }
            }
            else {
              return { role: "assistant", content: (m.content ?? "") as string, type: "message" } as EasyInputMessage;
            }
          }
          if (m instanceof SystemMessage) {
            return { role: "system", content: (m.content ?? "") as string, type: "message" } as EasyInputMessage;
          }
          if (m instanceof ToolMessage) {
            // ToolMessage is treated as assistant content (tool output)
            return { output: m.content, call_id: m.tool_call_id || m.id, type: "function_call_output" } as ResponseInputItem.FunctionCallOutput;
          }
          // Fallback
          return { role: "assistant", content: ((m as any).content ?? "") as string, type: "message" } as EasyInputMessage;
        });


      // We'll accumulate the full assistant text and a small buffer for chunked yields
      let fullResponseContent = "";
      let buffer = "";

      // Helper to flush buffer as chunk_display
      const flushBuffer = (delimiter: boolean) => {
        if (!buffer) return null;
        const out = {
          type: "chunk_display",
          content: buffer,
          delimiter,
        };
        buffer = "";
        return out;
      };

      const handleStream = async function* (instance: AI): AsyncGenerator<{
        type: string,
        content: string,
        delimiter: boolean
      }> {
        instance.logger.trace("CALL START")
        let hasToolCalls = false;
        const openaiMessages = buildMessagesForOpenAI(chatHistory);
        instance.logger.trace(openaiMessages);
        // Start streaming from the Responses API
        // The official client exposes a streaming helper `client.responses.stream`.
        // We pass `input` as the messages array.
        const stream = await instance.openai.responses.create({
          model: "qwen3.5-plus",
          input: openaiMessages,
          stream: true,
          tools: instance.tools.map((t) => ({
            type: "function",
            name: t.name,
            description: t.description,
            parameters: z.toJSONSchema(t.schema as any, {
              target: 'draft-7',
            }),
            strict: true
          })),
          tool_choice: "auto",
          // You can pass additional options here (e.g., temperature) if desired
          ...additionalOptions
        });

        for await (const event of stream) {
          instance.logger.trace(event);
          if (event.type == "response.output_item.done") {
            if (event.item.type == "function_call") {
              hasToolCalls = true;
              let args;
              try {
                args = JSON.parse(event.item.arguments) || {}
              }
              catch {
                args = `${event.item.arguments}`
              }
              chatHistory.push(
                new AIMessage({
                  content: "",
                  tool_calls: [{
                    type: "tool_call",
                    id: event.item.call_id,
                    name: event.item.name,
                    args
                  }],
                })
              );

              console.dir(event.item)
              console.log(`Called ${event.item.name}`)
              const tool = toolMap[event.item.name];
              let result: string;
              try {
                if (!tool) {
                  result = `Error: Unknown tool "${event.item.name}"`;
                } else {

                  if (buffer) {
                    yield {
                      type: "chunk_display",
                      content: buffer,
                      delimiter: false,
                    };
                    buffer = "";
                  }

                  // parse args safely (if present)
                  const args2 = JSON.parse(event.item.arguments) ?? {};
                  console.trace(args2)
                  result = await tool.invoke(args2);

                }

              }
              catch (err: any) {
                console.error(err);
                result = `Tool execution error:${err.message}\nToolArgs: ${tool.usage_str}`;
              }
              console.trace(result);

              chatHistory.push(
                new ToolMessage({
                  content: result,
                  tool_call_id: event.item.call_id,
                })
              )

            }
          }
          else if (event.type == "response.output_text.delta") {
            // 📡 NORMAL STREAMING (unchanged)
            const chunkText = (event.delta || "") as string;
            fullResponseContent += chunkText;
            buffer += chunkText;

            if (buffer.includes("\n\n")) {
              let text = buffer.slice(0, buffer.indexOf("\n\n"));
              buffer = buffer.slice(buffer.indexOf("\n\n") + 2);

              yield {
                type: "chunk_display",
                content: text,
                delimiter: true,
              };
            }
          }
        }

        if (hasToolCalls) {
          instance.logger.trace("RECALLING!!!")
          yield* handleStream(instance);
          return;
        }

      }

      for await (const event of handleStream(this)) {
        yield event;
      }



      // 🧩 Flush remaining buffer
      if (buffer) {
        yield {
          type: "chunk_display",
          content: buffer,
          delimiter: false,
        };
      }

      // Persist final AI response into chatHistory
      chatHistory.push(new AIMessage(fullResponseContent));

      // Return final chatHistory
      yield {
        type: "done",
        content: chatHistory,
        delimiter: false
      };
    } catch (error) {
      console.error("\n🚨 Oops! Something went wrong (v2):", error);
      // If we added the user's message at the top and want to revert it on error, pop it
      if (userInput) {
        // remove last message if it matches the user input
        const last = chatHistory[chatHistory.length - 1];
        if (last instanceof HumanMessage && last.content === userInput) {
          chatHistory.pop();
        }
      }
      throw error;
    }
  }

  async * processChatv3(
    chatHistory: Array<ResponseInputItem>,
    userInput?: string,
    additionalOptions: Partial<ResponseCreateParamsStreaming> = {}
  ) {
    // Add user message to history if provided
    if (userInput) {
      const userMessage = {
        role: 'user',
        content: userInput,
        type: 'message'
      } as EasyInputMessage;
      chatHistory.push(userMessage);
    }

    // Build tool map for quick lookup
    const toolMap: Record<string, ExtendedDynamicStructuredTool> = Object.fromEntries(
      this.tools.map((t: ExtendedDynamicStructuredTool) => [t.name, t])
    );

    try {
      console.log("\n🤖 Thinking (v3 with official OpenAI client)...");

      // Query memory and add a system hint if relevant
      const memory = JSON.parse(await this.memoryQueryTool.func({ queryText: userInput || (chatHistory.filter(m => m.type == 'message' && m.role == 'user').slice(-1)[0] as EasyInputMessage).content }));
      this.logger.trace(memory, "Memory data retrieve")
      if (Array.isArray(memory) && memory.length > 0) {
        chatHistory.push({
          role: 'system',
          content: `Possibly relevant memory data to aid with responses: ${memory.map(m => m.text).join(';')}`,
          type: 'message'
        } as EasyInputMessage);
      }

      // // Convert chatHistory to the shape expected by the OpenAI Responses API
      // const buildMessagesForOpenAI: (history: BaseMessage[]) => Array<ResponseInputItem> = (history) =>
      //   history.map((m) => {
      //     // Map your message classes to role/content pairs
      //     if (m instanceof HumanMessage) {
      //       return { role: "user", content: (m.content ?? "") as string, type: "message" } as EasyInputMessage;
      //     }
      //     if (m instanceof AIMessage) {
      //       if (m.tool_calls) {
      //         for (let i = 0; i < m.tool_calls.length; i++) {
      //           return {
      //             call_id: (m.tool_calls[i] as any).id,
      //             arguments: (m.tool_calls[i] as any).args instanceof String ? (m.tool_calls[i] as any).args : JSON.stringify((m.tool_calls[i] as any).args),
      //             name: (m.tool_calls[i] as any).name, type: 'function_call'
      //           } as ResponseFunctionToolCall
      //         }
      //       }
      //       else {
      //         return { role: "assistant", content: (m.content ?? "") as string, type: "message" } as EasyInputMessage;
      //       }
      //     }
      //     if (m instanceof SystemMessage) {
      //       return { role: "system", content: (m.content ?? "") as string, type: "message" } as EasyInputMessage;
      //     }
      //     if (m instanceof ToolMessage) {
      //       // ToolMessage is treated as assistant content (tool output)
      //       return { output: m.content, call_id: m.tool_call_id || m.id, type: "function_call_output" } as ResponseInputItem.FunctionCallOutput;
      //     }
      //     // Fallback
      //     return { role: "assistant", content: ((m as any).content ?? "") as string, type: "message" } as EasyInputMessage;
      //   });


      // We'll accumulate the full assistant text and a small buffer for chunked yields
      let fullResponseContent = "";
      let buffer = "";

      // // Helper to flush buffer as chunk_display
      // const flushBuffer = (delimiter: boolean) => {
      //   if (!buffer) return null;
      //   const out = {
      //     type: "chunk_display",
      //     content: buffer,
      //     delimiter,
      //   };
      //   buffer = "";
      //   return out;
      // };

      const handleStream = async function* (instance: AI): AsyncGenerator<{
        type: 'chunk_display' | 'done',
        content: string,
        delimiter: boolean
      } | {
        type: 'tool_call',
        data: ResponseFunctionToolCall
      } | {
        type: 'reasoning',
        data: ResponseReasoningItem
      } | {
        type: 'tool_call_output',
        data: ResponseInputItem.FunctionCallOutput
      }> {
        instance.logger.trace("CHAT CALL START")
        let hasToolCalls = false;
        instance.logger.trace(chatHistory, "CHAT HISTORY CREATED");
        // Start streaming from the Responses API
        // The official client exposes a streaming helper `client.responses.stream`.
        // We pass `input` as the messages array.
        const stream = await instance.openai.responses.create({
          model: "qwen3.5-plus",
          input: chatHistory,
          stream: true,
          tools: instance.tools.map((t) => ({
            type: "function",
            name: t.name,
            description: t.description,
            parameters: z.toJSONSchema(t.schema as any, {
              target: 'draft-7',
            }),
            strict: true
          })),
          tool_choice: "auto",
          // You can pass additional options here (e.g., temperature) if desired
          ...additionalOptions
        });

        for await (const event of stream) {
          instance.logger.trace(event, "CHAT EVENT");
          if (event.type == "response.output_item.done") {
            if (event.item.type == "function_call") {
              hasToolCalls = true;
              let args;
              try {
                if (event.item.arguments.trim() == "") {
                  args = {}
                }
                else {
                  args = JSON.parse(event.item.arguments) || {}
                }
              }
              catch {
                args = event.item.arguments
              }

              chatHistory.push(
                event.item
                // new AIMessage({
                //   content: "",
                //   tool_calls: [{
                //     type: "tool_call",
                //     id: event.item.call_id,
                //     name: event.item.name,
                //     args
                //   }],
                // })
              );

              yield {
                type: 'tool_call',
                data: event.item
              }

              console.dir(event.item)
              console.log(`Called ${event.item.name}`)
              const tool = toolMap[event.item.name];
              let result: string;
              try {
                if (!tool) {
                  result = `Error: Unknown tool "${event.item.name}"`;
                } else {

                  if (buffer) {
                    yield {
                      type: "chunk_display",
                      content: buffer,
                      delimiter: false,
                    };
                    buffer = "";
                  }

                  // parse args safely (if present)
                  const args2 = JSON.parse(event.item.arguments) ?? {};
                  console.trace(args2)
                  result = await tool.invoke(args2);

                }

              }
              catch (err: any) {
                console.error(err);
                result = `Tool execution error:${err.message}\nToolArgs: ${tool.usage_str}`;
              }
              console.trace(result);

              const outputData = {
                output: result,
                call_id: event.item.call_id,
                type: 'function_call_output'
              } as ResponseInputItem.FunctionCallOutput

              chatHistory.push(
                outputData
                // new ToolMessage({
                //   content: result,
                //   tool_call_id: event.item.call_id,
                // })
              )
              yield {
                type: 'tool_call_output',
                data: outputData
              }

            }
            else if (event.item.type == 'reasoning') {
              chatHistory.push({
                id: event.item.id,
                summary: event.item.summary,
                type: 'reasoning'
              } as ResponseReasoningItem)
              yield {
                type: "reasoning",
                data: event.item,
              }
            }
          }
          else if (event.type == "response.output_text.delta") {
            // 📡 NORMAL STREAMING (unchanged)
            const chunkText = (event.delta || "") as string;
            fullResponseContent += chunkText;
            buffer += chunkText;

            if (buffer.includes("\n\n")) {
              let text = buffer.slice(0, buffer.indexOf("\n\n"));
              buffer = buffer.slice(buffer.indexOf("\n\n") + 2);

              yield {
                type: "chunk_display",
                content: text,
                delimiter: true,
              };
            }
          }
        }

        if (hasToolCalls) {
          instance.logger.trace("RECALLING!!!")
          yield* handleStream(instance);
          return;
        }

      }

      for await (const event of handleStream(this)) {
        yield event;
      }



      // 🧩 Flush remaining buffer
      if (buffer) {
        yield {
          type: "chunk_display",
          content: buffer,
          delimiter: false,
        };
      }

      // Persist final AI response into chatHistory
      chatHistory.push(
        {
          role: 'assistant',
          content: fullResponseContent,
          type: 'message'
        } as EasyInputMessage
        // new AIMessage(fullResponseContent)
      );

      // Return final chatHistory
      yield {
        type: "done",
        content: chatHistory,
        delimiter: false
      };
    } catch (error) {
      console.error("\n🚨 Oops! Something went wrong (v3):", error);
      // If we added the user's message at the top and want to revert it on error, pop it
      if (userInput) {
        // remove last message if it matches the user input
        const last = chatHistory[chatHistory.length - 1];
        if (last.type == 'message' && last.role == 'user') {
          chatHistory.pop();
        }
      }
      throw error;
    }
  }


  async generatePrompt(mode: 'testing' | 'chat' | 'group', current_user_name: string, current_user_id: string, current_user_desc?: string): Promise<string> {
    // 1. Read the System Prompt from the file
    const systemPromptPath = path.resolve("src/static/prompts/system.md");
    const systemMessageContent = await fs.readFile(systemPromptPath, 'utf-8');

    // 2. Get memory for a current user id
    const memories = mode == 'group' ? '' : await this.memoryQueryByUserTool.func({ userId: current_user_id }) as string;
    const memoryPrompt = `${mode == 'group' ? `Current Group Chat: ${current_user_name} (${current_user_id})` : `You are currently chatting with ${current_user_name} with user ID ${current_user_id}. ${current_user_desc ? "User Description: " + current_user_desc + ". " : ""}Below are your memories related to the current user.
    User Memories: ${JSON.parse(memories).data.filter((m: any) => m.category != 'core').slice(-10).map((m: any) => m.text).join(';')}
    If you have no memory of saying hi to this user for the first time, please use the \`memory_write\` tool call to save this event (leave category empty) and then introduce yourself to the user.`}
    Current Chat Mode: ${mode == 'testing' ? 'Testing Mode (1-to-1) (GIFs and Stickers unavaliable in this mode)' : mode == 'chat' ? "WhatsApp Chat (1-to-1)" : "WhatsApp Group Chat (1-to-many)"}
    Your Core Memories: ${(await this.db.getCoreMemories({})).data.map(m => m.text).join(';')}
    Avaliable Tool Calls: ${this.tools.map(t => t.name).join(', ')}
    User's can't see you using tool calls, so make sure to send the output of the tool call back to the user if appropriate.`
    // Avaliable Tool Calls: ${this.tools.map(t => `\`${t.name}\`: ${t.description}, Parameters: ${JSON.stringify(z.toJSONSchema(t.schema as any).properties) || "Not needed"}`).join('\n')}`
    return systemMessageContent + (mode === 'testing' ? `\nCurrent Time:${formatDateTime(new Date())}` : '') + `\n${memoryPrompt}`
  }

  async shouldRespond(history: ResponseInputItem[]) {
    if (history.length == 0) {
      return false
    };
    const messages = (history.filter(m => m.type == 'message') as EasyInputMessage[]).map(m => m.role == 'assistant' ? `AI: ${m.content}` : `User: ${m.content}`).join('\n\n');
    const model = new ChatOpenAI({
      apiKey: process.env.ALIBABA_API_KEY,
      model: 'qwen-flash',
      configuration: {
        // baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"
      }
    }).withStructuredOutput(z.object({
      shouldRespond: z.boolean().describe("Whether or not the AI model Sofia should reply or not.")
    }))
    const systemMsg = `You determine whether an AI named Sofia should respond.
Rules:
- DO NOT Respond ONLY if the latest message is not asking her to do something or asking her a question. 
- Respond If the user is following up on a previous statement and its appropriate for Sofia to reply.
- Respond if it is appropriate to comment.
Examples when you should not respond:
- "Sofia will be able to send GIFs and Stickers."
- "I've added a new feature to sofia."
- "I've just fixed some bugs with sofia."
Examples when you should respond:
- "Sofia, this is amazing isn't it?"
- "I think sofia might know."
- "Sofia, what is the timetable for tomorrow."
- "Sofia can you play a game with me?"
- "Sofia create a new assignment with the information above."
- "Sofia, can you help me check what assessments we have soon?" 
`
    const userMsg = `This is the current Chat History:\n${messages}\nShould AI model Sofia reply?`
    const output = await model.invoke([new SystemMessage(systemMsg), new HumanMessage(userMsg)]);
    return output.shouldRespond;
  }

  async run() {

    // Chat history will store all messages for context persistence
    let chatHistory: BaseMessage[] = [];

    try {


      // 3. Initialize Conversation History with the System Message (and current time)
      const systemMsg = new SystemMessage(await this.generatePrompt('testing', "94527fcc-fff4-4994-af46-0fea45499f20", "Azlan"));
      chatHistory.push(systemMsg);
      console.log(systemMsg.content);

      // --- Readline Implementation for Continuous Chat ---
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      console.log("\n=============================================================================");
      console.log("👋 Hi there! I'm Sofia, your AI class assistant!");
      console.log("Feel free to chat with me about anything—academics, vibes, life stuff! 😊");
      console.log("Type 'exit' or 'quit' when you're done.");
      console.log("=========================================================================\n");

      // Function to handle the entire chat loop
      const chatLoop = async () => {
        // Prompt user for the next input
        rl.question('You: ', async (userInput: string) => {
          if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit') {
            console.log("\n✨ Take care! Chatting with you was so much fun. Feel free to reach out anytime! ✨");
            rl.close();
            return;
          }

          try {
            const streamGenerator = this.processChatv2(chatHistory, userInput);

            // 3. Consume the generator stream manually to control output
            for await (const yieldState of streamGenerator) {
              if (yieldState.type === 'chunk_display') {
                process.stdout.write(yieldState.content as string);
                if (yieldState.delimiter) {
                  process.stdout.write("\n-------------------------------\n");
                }
              } else if (yieldState.type === 'done') {
                chatHistory = yieldState.content as typeof chatHistory;
                break; // Exit the loop after the full content is collected
              }
            }

          } catch (error) {
            // Error is already logged inside processChat
          } finally {
            // Recursively call chatLoop to keep the conversation going
            chatLoop();
          }
        });
      };

      chatLoop();

    } catch (error) {
      if (error instanceof Error) {
        console.error("\nFATAL SETUP ERROR:", error.message);
        console.error("Please ensure you have read permissions for the system prompt file: src/static/prompts/system.md");
      } else {
        console.error("\nFATAL ERROR:", error);
      }
    }
  }
}
