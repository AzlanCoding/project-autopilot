import 'dotenv/config'; // Load before CHAT_MODEL is read, main.ts imports this file before loading dotenv
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
import { describeDateWeek, formatDateTime, messageBreakIndex, getTime, parseTimestamp, SEMESTERS, WK_Number_to_timeframe } from '../utils/common';
import { User } from '../models/User';
import { ScheduledTask } from '../models/ScheduledTask';
import type { PreProccessChatMsg } from './botService';
import type { Sticker } from '../models/Sticker';
import type { PollResults } from './pollService';
import { ModelImage, toModelImage } from '../utils/media';
import { parsePages, pdfPageCount, pdfPageImage, readPdfText } from '../utils/pdf';
import { chatContext } from './chatContext';
import { ExtendedDynamicStructuredTool, isToolImageResult, ToolImageResult } from '../utils/tool';
import { aboutToActProbability, replyEnding, UNFINISHED_NUDGE, UNFINISHED_THRESHOLD } from './unfinishedReply';
import getCalendarEvents from '../utils/getCalendarEvents';
import { Logger } from 'pino';
import { EasyInputMessage, ResponseCreateParamsStreaming, ResponseFunctionToolCall, ResponseInputItem, ResponseReasoningItem } from 'openai/resources/responses/responses.js';
import { BUILTIN_TOOLS, CHAT_API_KEY, CHAT_BASE_URL, CHAT_MODEL, CHAT_PROVIDER, MODELSTUDIO_BASE_URL, USE_WEB_TOOLS } from '../config/modelStudio';
import { formatPage, formatSearchResults, webFetch, webSearch } from './webTools';
import { WORKSPACE_ENABLED } from '../config/googleWorkspace';
import { GoogleWorkspace, MIME } from './googleWorkspace';
import { isDriveId, toGoogleLink } from '../utils/googleUrls';
import { createWorkspaceReadTools } from './workspaceTools';
import { createWorkspaceWriteTools } from './workspaceWriteTools';
import { createFileTools, ExtractedImages } from './fileTools';
import { createImageTools } from './imageTools';
import moment from 'moment-timezone';
import { SCHEDULE_TIMEZONE } from './scheduledTaskService';

export { CHAT_MODEL };
export { ExtendedDynamicStructuredTool, isToolImageResult };
export type { ToolImageResult };


/**
 * Chat platform operations needed by the chat tools. Implemented by SofiaBot (WhatsApp) and by the CLI test harness.
 */
export interface ChatAdapter {
  /**
   * Send a message to a user id, group id (ending with `@g.us`) or WhatsApp jid. `label` marks it as sent by the AI
   * (quoting an "I am an AI Agent" message), only the first message of a send is labelled.
   */
  sendMessage(id: string, text: string, label?: boolean): Promise<void>;
  /** Send a file or image (images as photos, everything else as a document) to a user id, group id or WhatsApp jid. */
  sendFile(id: string, file: OutgoingFile): Promise<void>;
  /** Send a sticker or GIF to a user id, group id (ending with `@g.us`) or WhatsApp jid. */
  sendStickerGif(id: string, sticker: Sticker): Promise<void>;
  /** Download an image, sticker, GIF, video or document by the media id shown in the chat history. */
  getMedia(mediaId: string): Promise<ChatMedia>;
  /** Send a poll to a user id, group id (ending with `@g.us`) or WhatsApp jid, returns its poll id. */
  sendPoll(id: string, poll: { question: string, options: string[], multiple: boolean }): Promise<string>;
  /** The current votes of a poll by the poll id shown in the chat history, or null if the poll isn't known. */
  getPollResults(pollId: string): Promise<PollResults | null>;
  listGroups(): Promise<{ id: string, name: string }[]>;
  /** A group chat's name, description and participants (matched to users where known). */
  getGroupInfo(groupId: string): Promise<GroupInfo>;
  /** Load the chat history with a user id or group id, oldest first. */
  loadChatById(id: string): Promise<PreProccessChatMsg[]>;
}

export interface OutgoingFile {
  buffer: Buffer,
  mime: string,
  fileName: string,
  caption?: string,
}

export interface GroupParticipantInfo {
  /** The user's name, `You (Sofia)`, or `Unknown (<last 4 digits>)` for people who aren't users. */
  name: string,
  userId: string | null,
  description: string | null,
  admin: boolean,
}

export interface GroupInfo {
  id: string,
  name: string,
  description: string,
  participants: GroupParticipantInfo[],
}

/** Descriptions are cut to this length so a large group doesn't fill the prompt. */
const GROUP_DESCRIPTION_MAX_CHARS = 200;
const cut = (text: string, max: number) => text.length > max ? `${text.slice(0, max).trimEnd()}...` : text;

/** A group's info for the system prompt and `get_group_info`. */
export function formatGroupInfo(info: GroupInfo): string {
  const people = info.participants.map(p => {
    const id = p.userId ? ` (user ID ${p.userId})` : '';
    const description = p.description?.trim() ? `: ${cut(p.description.trim().replace(/\s+/g, ' '), GROUP_DESCRIPTION_MAX_CHARS)}` : '';
    return `- ${p.name}${id}${p.admin ? ' [admin]' : ''}${description}`;
  });
  return `Group Chat: ${info.name} (${info.id})\n` +
    `Group Description: ${info.description.trim() ? info.description.trim() : '(none)'}\n` +
    `Participants (${info.participants.length}):\n${people.join('\n')}`;
}

export interface ChatMedia {
  buffer: Buffer,
  mime: string,
  kind: 'image' | 'sticker' | 'gif' | 'video' | 'document',
  /** Documents only */
  fileName?: string,
}

/** Returned by tools that show the model an image (`view_media`), the image is added after the tool output. */

/** Tools that end Sofia's reply: `end_message`, and send tools called with `end_message: true`. */
const endsReply = (name: string, args: any) => name == 'end_message' || args?.end_message === true;
/** Output items of Model Studio's built-in tools (see `BUILTIN_TOOLS`). They have already run when they arrive. */
const BUILTIN_TOOL_ITEMS = new Set(['web_search_call', 'web_extractor_call']);
/** Short description of a built-in tool call for logs and the CLI, e.g. `web_search "NYP news"`. */
export function describeBuiltinToolCall(item: any): string {
  if (item.type == 'web_search_call') {
    return `web_search ${JSON.stringify(item.action?.query ?? '')}`;
  }
  if (item.type == 'web_extractor_call') {
    return `web_extractor ${(item.urls ?? []).join(' ')}`;
  }
  return item.type;
}
const INTERRUPTED_NOTE = "Your reply was stopped after the messages above (they were already sent) because new messages arrived. Continue your reply taking them into account, don't repeat what you already sent.";

export interface ScheduledTaskRunOptions {
  /** Whether the model must send a message with send_message. Defaults to true. */
  requireMessage?: boolean;
  /** User id or group id whose chat history should be included in the context. */
  contextChatId?: string | null;
}

export default class AI {
  ai_user_id: string = "ea502c0f-7fe6-4f7c-9d63-80dd7b0de90e";
  test_mode: boolean = (process.env.TESTING != undefined && process.env.TESTING.toLowerCase() == "true");
  /** How likely the end of a reply says Sofia is about to act without having done it, see `unfinishedReply.ts`. */
  aboutToAct: (text: string) => Promise<number> = aboutToActProbability;
  /** Model Studio's built-in tools sent with every request, from `BUILTIN_TOOLS` (none by default). */
  builtinTools: string[] = BUILTIN_TOOLS;
  /** Whether Sofia can search the web and read pages, and through which provider's tools (see `USE_WEB_TOOLS`). */
  useWebTools: boolean = USE_WEB_TOOLS;
  chatProvider: 'modelstudio' | 'deepseek' = CHAT_PROVIDER;
  /** Set by the CLI test harness so the system prompt tells the model it is being tested. */
  cli_mode: boolean = false;
  logger: Logger;
  db: Store;
  // Sofia's chats and scheduled tasks, Model Studio unless `CHAT_BASE_URL` points elsewhere (e.g. DeepSeek)
  openai = new OpenAI(
    {
      apiKey: CHAT_API_KEY,
      baseURL: CHAT_BASE_URL
    }
  );


  // Tools will be initialized in constructor so they can reference this.db
  getCurrentTimeTool: ExtendedDynamicStructuredTool;
  memoryWriteTool: ExtendedDynamicStructuredTool;
  memoryUpdateTool: ExtendedDynamicStructuredTool;
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

  /** Sofia's Google Workspace account, set when it's signed in (`pnpm google-auth`). */
  workspace?: GoogleWorkspace;
  workspaceTools: ExtendedDynamicStructuredTool[] = [];
  /** Images from `extract_images`, generate_image, edit_image and material_icon, by id (img_1...). */
  extractedImages = new ExtractedImages();
  imageTools: ExtendedDynamicStructuredTool[] = [];

  // Web Tools on DeepSeek (Model Studio's are built-in tools, see `builtinTools`)
  webSearchTool: ExtendedDynamicStructuredTool;
  webFetchTool: ExtendedDynamicStructuredTool;

  // Sticker & GIFs Tools
  stickerGifTool: ExtendedDynamicStructuredTool;
  endMessageTool: ExtendedDynamicStructuredTool;

  // Chat platform specific tools will be added later on runtime by registerChatTools()
  sendMessageTool?: ExtendedDynamicStructuredTool;
  sendStickerGifTool?: ExtendedDynamicStructuredTool;
  viewMediaTool?: ExtendedDynamicStructuredTool;
  sendPollTool?: ExtendedDynamicStructuredTool;
  readPollTool?: ExtendedDynamicStructuredTool;
  listGroupsTool?: ExtendedDynamicStructuredTool;
  getGroupInfoTool?: ExtendedDynamicStructuredTool;
  readPdfTool?: ExtendedDynamicStructuredTool;
  /** send_file, extract_images */
  fileTools: ExtendedDynamicStructuredTool[] = [];
  viewPdfPageTool?: ExtendedDynamicStructuredTool;
  readChatHistoryTool?: ExtendedDynamicStructuredTool;
  chatAdapter?: ChatAdapter;

  // Week Tools
  weekNumToDateTool: ExtendedDynamicStructuredTool;
  dateToWeekNumTool: ExtendedDynamicStructuredTool;

  // Scheduled Task Tools
  scheduleTaskTool: ExtendedDynamicStructuredTool;
  listScheduledTasksTool: ExtendedDynamicStructuredTool;
  editScheduledTaskTool: ExtendedDynamicStructuredTool;
  cancelScheduledTaskTool: ExtendedDynamicStructuredTool;

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
      description: "Store a durable memory in the database. The result lists other similar memories, update or delete any that are now outdated or duplicated.",
      schema: z.object({
        text: z.string().describe("[Required] The core text content of the memory to be stored. Do not put any user ID inside this field. Make sure the content is not time relative. (e.g., instead of 10 mins ago, state the actual date time.)"),
        authorUserId: z.string().optional().describe(`The ID of the user who told you about this memory. Put ${this.ai_user_id} if you are writing it on your own.`),
        subjectUserId: z.string().optional().describe(`The ID of the user this memory is related to. Put ${this.ai_user_id} if the memory is about yourself.`),
        groupId: z.string().optional().describe("The ID of the group this memory belongs to. In most cases this should be left undefined"),
        isGlobal: z.boolean().optional().describe("A flag indicating if this memory should be considered global."),
        category: z.string().optional().describe("A categorization tag for the memory. If it is an event, put 'event'. If its a memory related to yourself, put 'core'. Put 'important' if its extremly important that you remember this fact, leave empty if none of these apply."),
        // sourceMessageId: z.string().optional().describe("The ID of the original message where this memory originated."),
      }),
      func: async (args) => {
        if (this.test_mode) {
          throw Error("Disabled due to test mode.");
        }
        // memoryWrite returns a human-friendly string already
        return await this.db.memoryWrite(args as any);
      }
    }, "{text: string, authorUserId?: string, subjectUserId?: string, groupId?: string, isGlobal?: boolean, category?: string}");

    this.memoryUpdateTool = new ExtendedDynamicStructuredTool({
      name: "memory_update",
      description: "Replace the text of an existing memory by ID. Use this to correct or merge outdated memories.",
      schema: z.object({
        memoryId: z.string().describe("[Required] The ID of the memory to update."),
        text: z.string().min(1).describe("[Required] The new full text of the memory. Same rules as memory_write: no user IDs, no time relative wording."),
      }),
      func: async (args) => {
        if (this.test_mode) {
          throw Error("Disabled due to test mode.");
        }
        const { memoryId, text } = args as any;
        return await this.db.memoryUpdate(memoryId, text);
      }
    }, "{memoryId: string, text: string}");

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
      description: "Search your sticker and GIF collection. Describe the reaction or emotion you want to send (e.g. \"excited celebration\", \"sleepy good night\", \"laughing hard\"). Returns the best matches with their ids and descriptions, then send one with `send_sticker_gif`.",
      schema: z.object({
        query: z.string().min(1).describe("[Required] The reaction, emotion or content you are looking for."),
        type: z.enum(['sticker', 'gif', 'any']).optional().describe("Only search stickers or GIFs. Defaults to any."),
        limit: z.number().int().min(1).max(10).optional().describe("Number of results. Defaults to 5."),
      }),
      func: async (args) => {
        const { query, type = 'any', limit = 5 } = args as any;
        const results = await this.db.stickers.search(query, type == 'any' ? undefined : type, limit);
        if (!results.length) {
          return "No stickers or GIFs found. Reply with text instead.";
        }
        return JSON.stringify(results.map(s => ({ id: s.id, type: s.kind, animated: s.animated, description: s.description })));
      }
    }, "{query: string, type?: 'sticker' | 'gif' | 'any', limit?: number}");

    this.endMessageTool = new ExtendedDynamicStructuredTool({
      name: "end_message",
      description: "End your reply now, so you don't send any more text after this. Use it after you've said everything, e.g. after sending a sticker or GIF as your whole reply.",
      schema: z.object({}),
      func: async () => "Reply ended.",
    }, "{}");

    this.timetableTool = new ExtendedDynamicStructuredTool({
      name: "get_timetable",
      description: "Get the timetable for a specific day. Note that events that start with (ELEARN) are e-learning lessons and can be done at any time. Lessons are split into one section per timetable calendar, titled with the calendar's name (e.g. one per specialisation track), each listing all of its classes in time order, including the modules the whole class takes. \"No lessons for today\" means that calendar has no lessons that day.",
      schema: z.object({
        date: z.string().optional().describe("[Optional] The date of the timetable in the format DD/MM/YYYY. If not provided, it will return the current day's timetable."),
      }),
      func: async (args) => {
        const { date = undefined } = args as any;
        return (await getCalendarEvents(true, date)) || "No events found for the specified date.";
      }
    }, "{date?:string}");


    // Week Tools
    const semesterNames = SEMESTERS.map(sem => `${sem.name} (Week 1 starts ${sem.week1.split('-').reverse().join('/')})`).join(', ');
    this.weekNumToDateTool = new ExtendedDynamicStructuredTool({
      name: "week_number_to_date_range",
      description: `Translates a semester's week number into its dates (Monday to Sunday) and says which part of the academic calendar it is in (Instruction, Mid-Sem Break, Study/Exam or Vacation). Semesters: ${semesterNames}. Week numbers restart every semester.`,
      schema: z.object({
        week_num: z.number().describe("[Required] The week number."),
        semester: z.number().int().optional().describe("The semester number, e.g. 2 for Semester 2. Defaults to the current semester, or the next one if the current semester is in its Vacation weeks."),
      }),
      func: async (args) => {
        const { week_num, semester } = args as any;
        if (semester === undefined) {
          return WK_Number_to_timeframe(week_num);
        }
        const found = SEMESTERS.find(sem => sem.name == `Semester ${semester}`);
        if (!found) {
          throw Error(`Unknown semester ${semester}. Known semesters: ${semesterNames}.`);
        }
        return WK_Number_to_timeframe(week_num, found);
      }
    }, "{week_num: number, semester?: number}");

    this.dateToWeekNumTool = new ExtendedDynamicStructuredTool({
      name: "date_to_week_num_tool",
      description: "Gets the semester and week number a date falls in, with that week's dates and which part of the academic calendar it is in.",
      schema: z.object({
        date: z.string().describe("The date as ISO 8601, e.g, 2007-12-27")
      }),
      func: async (args) => {
        const { date } = args as any;
        return describeDateWeek(date);
      }
    }, "{date: string}")


    // Scheduled Task Tools
    const formatTask = (t: ScheduledTask) => ({
      id: t.id,
      task: t.task,
      recurring: t.recurring,
      ...(t.recurring ? { cronPattern: t.cronPattern } : { runAt: formatDateTime(Number(t.runAt)) }),
      contextChatId: t.contextChatId,
      createdAt: formatDateTime(Number(t.createdAt)),
      // One-time tasks are deleted when they run, so they never have a lastRunAt
      ...(t.recurring ? { lastRunAt: t.lastRunAt ? formatDateTime(Number(t.lastRunAt)) : null } : {}),
      nextRun: (() => { const n = this.db.scheduledTask.nextRun(t.id); return n ? formatDateTime(n) : null; })(),
    });
    const validateChatId = async (id?: string) => {
      if (!id) return;
      const exists = id.endsWith('@g.us')
        ? !this.chatAdapter || (await this.chatAdapter.listGroups()).some(g => g.id == id)
        : !!(await this.db.user.findById(id).catch(() => null));
      if (!exists) {
        throw Error(`Unknown user or group id "${id}". Get the correct id from \`user_list\` or \`list_groups\`.`);
      }
    };
    const parseRunAt = (runAt?: string) => {
      if (runAt === undefined) return undefined;
      const time = new Date(runAt).getTime();
      if (isNaN(time)) {
        throw Error(`Invalid runAt "${runAt}". Use ISO 8601 in Singapore Timezone, e.g, 2026-04-16T11:47:12+08:00`);
      }
      return time;
    };
    const cronDescription = `Cron pattern in Singapore Timezone, either "minute hour day-of-month month day-of-week" or with seconds in front. E.g, "0 9 * * 1-5" is 9am every weekday, "*/30 * * * *" is every 30 minutes.`;

    this.scheduleTaskTool = new ExtendedDynamicStructuredTool({
      name: "schedule_task",
      description: "Schedule yourself to do a task later, once or on a recurring schedule. E.g, check if someone has replied, remind someone about something, follow up on a conversation. When it runs you will be given the task text, so write it with all the context you will need (who, which chat, what to check or say).",
      schema: z.object({
        task: z.string().min(1).describe("[Required] Detailed instructions for your future self, including names and user/group IDs involved."),
        recurring: z.boolean().describe("[Required] true to repeat on cronPattern, false to run once at runAt."),
        runAt: z.string().optional().describe("Required if recurring is false. When to run, as ISO 8601 in Sigapore Timezone. E.g, 2026-04-16T11:47:12+08:00"),
        cronPattern: z.string().optional().describe(`Required if recurring is true. ${cronDescription}`),
        contextChatId: z.string().optional().describe("The user ID or group ID of the chat this task relates to (usually the current chat)."),
      }),
      func: async (args) => {
        if (this.test_mode) {
          throw Error("Disabled due to test mode.");
        }
        const { task, recurring, runAt, cronPattern, contextChatId } = args as any;
        await validateChatId(contextChatId);
        const created = await this.db.scheduledTask.create({
          task,
          recurring,
          runAt: recurring ? null : (parseRunAt(runAt) ?? null),
          cronPattern: recurring ? cronPattern : null,
          contextChatId: contextChatId ?? null,
        });
        return JSON.stringify(formatTask(created));
      }
    }, "{task: string, recurring: boolean, runAt?: string, cronPattern?: string, contextChatId?: string}");

    this.listScheduledTasksTool = new ExtendedDynamicStructuredTool({
      name: "list_scheduled_tasks",
      description: "List all tasks you have scheduled for yourself, as they are right now. Return Schema: `runAt` is when a one-time task will run. `cronPattern` is a recurring task's schedule. `nextRun` is the next time the task will run. `lastRunAt` (recurring tasks only) is the last time it ran, null if it hasn't run yet. One-time tasks are deleted as soon as they run, so a one-time task that already ran is no longer listed. That is normal, not a bug. Only trust a fresh call to this tool, not task lists from earlier in the chat.",
      schema: z.object({}),
      func: async () => {
        return JSON.stringify((await this.db.scheduledTask.findAll()).map(formatTask));
      }
    }, "{}");

    this.editScheduledTaskTool = new ExtendedDynamicStructuredTool({
      name: "edit_scheduled_task",
      description: "Edit a scheduled task by id. Only provide the fields you want to change.",
      schema: z.object({
        id: z.string().describe("[Required] The ID of the scheduled task."),
        task: z.string().min(1).optional().describe("New instructions."),
        recurring: z.boolean().optional().describe("Change between one-time (false) and recurring (true). Provide runAt or cronPattern to match."),
        runAt: z.string().optional().describe("New run time for one-time tasks, as ISO 8601 in Sigapore Timezone. E.g, 2026-04-16T11:47:12+08:00"),
        cronPattern: z.string().optional().describe(`New schedule for recurring tasks. ${cronDescription}`),
      }),
      func: async (args) => {
        if (this.test_mode) {
          throw Error("Disabled due to test mode.");
        }
        const { id, task, recurring, runAt, cronPattern } = args as any;
        const updated = await this.db.scheduledTask.update(id, {
          ...(task !== undefined ? { task } : {}),
          ...(recurring !== undefined ? { recurring } : {}),
          ...(runAt !== undefined ? { runAt: parseRunAt(runAt) } : {}),
          ...(cronPattern !== undefined ? { cronPattern } : {}),
        });
        if (!updated) {
          throw Error("Scheduled task not found.");
        }
        return JSON.stringify(formatTask(updated));
      }
    }, "{id: string, task?: string, recurring?: boolean, runAt?: string, cronPattern?: string}");

    this.cancelScheduledTaskTool = new ExtendedDynamicStructuredTool({
      name: "cancel_scheduled_task",
      description: "Cancel (delete) a scheduled task by id.",
      schema: z.object({
        id: z.string().describe("[Required] The ID of the scheduled task to cancel."),
      }),
      func: async (args) => {
        if (this.test_mode) {
          throw Error("Disabled due to test mode.");
        }
        const { id } = args as any;
        if (!(await this.db.scheduledTask.findById(id))) {
          throw Error("Scheduled task not found.");
        }
        await this.db.scheduledTask.destroy(id);
        return JSON.stringify({ success: true, id });
      }
    }, "{id: string}");


    // Register tools (order doesn't matter)
    this.webSearchTool = new ExtendedDynamicStructuredTool({
      name: "web_search",
      description: "Search the web. Returns the top results with their title, link, date and a summary. Use it for current events, news or facts you're not sure of, not for class info (use your other tools for that). Read a result in full with `web_fetch`.",
      schema: z.object({
        query: z.string().min(1).max(128).describe("[Required] What to search for, a few keywords. Supports operators like site:nyp.edu.sg, \"exact phrase\", -exclude and after:2026-10-01."),
        question: z.string().max(128).optional().describe("[Optional] The user's original question, helps find better results."),
        count: z.number().int().min(1).max(10).optional().describe("[Optional] Number of results, 1-10. Defaults to 5."),
      }),
      func: async (args) => {
        const { query, question, count = 5 } = args as any;
        return formatSearchResults(await webSearch(query, { count, question }));
      }
    }, "{query: string, question?: string, count?: number}");

    this.webFetchTool = new ExtendedDynamicStructuredTool({
      name: "web_fetch",
      description: "Read a web page in full (as Markdown), e.g. a result from `web_search` whose summary isn't enough. Only use URLs from `web_search` results or that someone sent, don't guess URLs (guessed ones are usually wrong). To find a page on a particular site, search with site:, e.g. `site:weather.gov.sg 4-day outlook`.",
      schema: z.object({
        url: z.string().min(1).describe("[Required] The page's full URL, starting with http:// or https://."),
      }),
      func: async (args) => {
        const { url } = args as any;
        return formatPage(url, await webFetch(url));
      }
    }, "{url: string}");

    if (WORKSPACE_ENABLED) {
      this.workspace = new GoogleWorkspace(this.logger);
      this.workspaceTools = [
        ...createWorkspaceReadTools(this.workspace),
        // WhatsApp images (by media_id) can be inserted once the chat tools are registered
        ...createWorkspaceWriteTools(this.workspace, { getChatMedia: id => this.chatAdapter!.getMedia(id), getImage: id => this.extractedImages.get(id) }),
      ];
    }

    // Image generation/editing (Qwen-Image) and Material icons; results go in extractedImages (img_N)
    this.imageTools = createImageTools({
      extracted: this.extractedImages, workspace: this.workspace,
      getChatMedia: id => this.chatAdapter!.getMedia(id),
      onImages: (count, model) => this.logger.info(`Made ${count} image${count == 1 ? '' : 's'} with ${model}`),
    });

    this.tools = [
      ...(this.useWebTools && this.chatProvider == 'deepseek' ? [this.webSearchTool, this.webFetchTool] : []),
      ...this.imageTools,
      ...this.workspaceTools,
      this.getCurrentTimeTool,
      this.memoryWriteTool, this.memoryUpdateTool, this.memoryQueryTool, this.memoryQueryByUserTool, this.memoryDeleteTool,
      this.assignmentCreateTool/*, this.assignmentGetTool*/, this.assignmentListTool, this.assignmentUpdateTool, this.assignmentDeleteTool,
      this.assessmentCreateTool/*, this.assessmentGetTool*/, this.assessmentListTool, this.assessmentUpdateTool, this.assessmentDeleteTool,
      this.userListTool,
      this.stickerGifTool, this.endMessageTool,
      this.timetableTool,
      this.weekNumToDateTool, this.dateToWeekNumTool,
      this.scheduleTaskTool, this.listScheduledTasksTool, this.editScheduledTaskTool, this.cancelScheduledTaskTool
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
        model: CHAT_MODEL,
        configuration: {
          // baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
          baseURL: MODELSTUDIO_BASE_URL
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

    this.db.ai_scheduled_task_runner = async (message: () => Promise<string>, modelOptions: Partial<ResponseCreateParamsStreaming> = { model: CHAT_MODEL }, { requireMessage = true, contextChatId }: ScheduledTaskRunOptions = {}) => {
      // 1. Read the System Prompt from the file
      const systemPromptPath = path.resolve("src/static/prompts/system.md");
      const systemMessageContent = await fs.readFile(systemPromptPath, 'utf-8');
      const memoryPrompt = `Current Chat Mode: System Scheduled Task Mode (GIFs and Stickers unavailable in this mode)\nYour Core Memories: ${JSON.stringify((await this.db.getCoreMemories({})).data)}
      Available Tool Calls: ${this.tools.map(t => t.name).join(', ')}
      GROUP CHATS: ${await this.listGroupsTool!.func({})}${this.webToolsPrompt()}${this.testModePrompt()}`;
      const systemPrompt = `${systemMessageContent}\nCurrent Time: ${formatDateTime(new Date())}\n${memoryPrompt}`;
      const chatHistory: ResponseInputItem[] = [{
        role: 'system',
        content: systemPrompt,
        type: 'message'
      } as EasyInputMessage];

      // 2. Include the history of the chat the task relates to, formatted the same way as a live chat
      let contextDescription = '';
      if (contextChatId) {
        try {
          if (contextChatId.endsWith('@g.us')) {
            const group = (await this.chatAdapter!.listGroups()).find(g => g.id == contextChatId);
            contextDescription = `the group chat "${group?.name ?? 'Unknown Group Chat'}" (${contextChatId})`;
          }
          else {
            const user = await this.db.user.findById(contextChatId);
            contextDescription = `your chat with ${user?.name ?? 'Unknown User'} (${contextChatId})${user?.description ? `. User Description: ${user.description}` : ''}`;
          }
          const [history] = await this.db.user.formatAndMergeMessages(await this.chatAdapter!.loadChatById(contextChatId), 12);
          if (history.length > 0) {
            chatHistory.push({ role: 'system', content: `Below is the recent message history of ${contextDescription}.`, type: 'message' } as EasyInputMessage);
            chatHistory.push(...history);
          }
          else {
            contextDescription += ' (no messages yet)';
          }
        }
        catch (e) {
          this.logger.error(e, `Failed to load chat history of ${contextChatId} for scheduled task`);
        }
      }

      // 3. Tell the model why it is running and what to do
      chatHistory.push({
        role: 'system',
        content: `SCHEDULED TASK TRIGGER: You are being triggered automatically by a scheduled task, not by a new message${contextDescription ? `. The task relates to ${contextDescription}` : ''}.
Current Time: ${formatDateTime(new Date())}
Nobody will see your text reply. ${requireMessage ? 'MAKE SURE YOU SEND A MESSAGE USING THE send_message TOOL CALL!' : 'Use the send_message TOOL CALL if you need to message anyone.'} Do the task immediately, DO NOT ASK FOR CONFIRMATION!
ONLY do the task below. Any other tasks or promises in the chat history are handled separately (by their own scheduled tasks or chats), do not do them here.

Task:
${await message()}`,
        type: 'message'
      } as EasyInputMessage);

      const streamGenerator = this.processChatv3(chatHistory, undefined, modelOptions);
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
   * Adds the tools that need a chat platform (send_message, list_groups, read_chat_history) and rebinds the model.
   */
  registerChatTools(adapter: ChatAdapter) {
    this.chatAdapter = adapter;
    this.sendMessageTool = new ExtendedDynamicStructuredTool({
      name: "send_message",
      description: "Send messages to a chat or a group chat based on a user id or group id (ending with `@g.us`). Each item in `messages` is sent as a separate WhatsApp message, in order, like your bite sized replies.",
      schema: z.object({
        id: z.string().describe("[Required] The user id or group id to send the chat to. E.g,`467793d9-6b60-45e7-9fbc-a202ef40837f` or `12345678@g.us`"),
        messages: z.array(z.string().min(1)).min(1).describe("[Required] The messages to send, each one is a separate WhatsApp message."),
      }),
      func: async (args) => {
        const { id, messages } = args as any;
        for (let i = 0; i < messages.length; i++) {
          // Only the first message is labelled as from the AI, like Sofia's normal replies
          await adapter.sendMessage(id, messages[i], i == 0);
        }
        return `${messages.length} message${messages.length == 1 ? '' : 's'} sent`;
      }
    }, "{id: string, messages: string[]}");

    const findSticker = async (stickerId: string) => {
      const sticker = await this.db.stickers.findById(stickerId);
      if (!sticker || sticker.status != 'approved') {
        throw Error(`Unknown sticker or GIF id "${stickerId}". Get ids from \`search_sticker_gif\`.`);
      }
      return sticker;
    };
    const endMessageField = z.boolean().describe("[Required] true to end your reply after this (you won't send any more text), e.g. when the sticker/GIF is your whole reply. false to keep replying after it.");

    this.sendStickerGifTool = new ExtendedDynamicStructuredTool({
      name: "send_sticker_gif",
      description: "Send a sticker or GIF (by id from `search_sticker_gif`), to the chat you are replying in or to another chat.",
      schema: z.object({
        sticker_id: z.string().describe("[Required] The sticker or GIF id, e.g. `stk_1a2b3c4d`."),
        id: z.string().optional().describe("User id or group id (ending with `@g.us`) to send it to. Leave it out to send it to the chat you are replying in."),
        end_message: endMessageField,
      }),
      func: async (args) => {
        const { sticker_id, id } = args as any;
        const chatId = id ?? chatContext.getStore()?.chatId;
        if (!chatId) {
          throw Error("You are not replying in a chat right now, give the user id or group id to send it to.");
        }
        await adapter.sendStickerGif(chatId, await findSticker(sticker_id));
        return "Sent";
      }
    }, "{sticker_id: string, id?: string, end_message: boolean}");

    this.viewMediaTool = new ExtendedDynamicStructuredTool({
      name: "view_media",
      description: "Download and view an image, sticker, GIF or video from the chat history by its `media_id` (shown like `<WhatsApp Image media_id=...>`), or an image from `extract_images` (img_1). For GIFs, animated stickers and videos you only see the first frame.",
      schema: z.object({
        media_id: z.string().describe("[Required] The media_id from the chat history."),
      }),
      func: async (args): Promise<ToolImageResult> => {
        const { media_id } = args as any;
        if (/^img_\d+$/.test(String(media_id).trim())) {
          const extracted = this.extractedImages.get(media_id);
          return { text: `${media_id} (${extracted.label}) is attached in the next message.`, image: await toModelImage(extracted.buffer, extracted.mime) };
        }
        const media = await adapter.getMedia(media_id);
        if (media.kind == 'document') {
          throw Error(`${media_id} is a document ("${media.fileName}"), not an image. Use \`read_pdf\` to read a PDF, or \`view_pdf_page\` to see one of its pages.`);
        }
        const image = await toModelImage(media.buffer, media.mime);
        const label = { image: 'Image', sticker: 'Sticker', gif: 'GIF', video: 'Video' }[media.kind];
        return {
          text: `${label} ${media_id} is attached in the next message${image.animated ? `. It is ${media.kind == 'video' ? 'a video' : 'animated (moving)'}, you can only see its first frame` : ''}.`,
          image,
        };
      }
    }, "{media_id: string}");

    this.readPdfTool = new ExtendedDynamicStructuredTool({
      name: "read_pdf",
      description: "Read the text of a PDF sent in the chat (shown like `<WhatsApp Document media_id=... \"file.pdf\" (PDF)>`), page by page. Long PDFs are read a few pages at a time: it says which pages to read next. If a page has no text (e.g. a scanned document or a chart), look at it with `view_pdf_page`.",
      schema: z.object({
        source: z.string().describe("[Required] The PDF's media_id from the chat history, or its Google Drive link."),
        pages: z.string().optional().describe("[Optional] Pages to read, e.g. \"3\", \"2-5\" or \"4-\". Defaults to all pages (as many as fit)."),
      }),
      func: async (args) => {
        const { source, pages } = args as any;
        const { buffer, name } = await this.loadPdf(source);
        const { text, pageCount, scanned } = await readPdfText(buffer, pages);
        const note = scanned ? `\n\n[These pages have little or no text, it's probably scanned or made of images. Use \`view_pdf_page\` to look at them.]` : '';
        return `${name} (${pageCount} page${pageCount == 1 ? '' : 's'})\n\n${text}${note}`;
      }
    }, "{source: string, pages?: string}");

    this.viewPdfPageTool = new ExtendedDynamicStructuredTool({
      name: "view_pdf_page",
      description: "See one page of a PDF sent in the chat as an image, e.g. for scanned pages, charts, diagrams, posters or layouts that `read_pdf` can't show.",
      schema: z.object({
        source: z.string().describe("[Required] The PDF's media_id from the chat history, or its Google Drive link."),
        page: z.number().int().min(1).describe("[Required] The page number, starting at 1."),
      }),
      func: async (args): Promise<ToolImageResult> => {
        const { source, page } = args as any;
        const { buffer, name } = await this.loadPdf(source);
        parsePages(String(page), await pdfPageCount(buffer));
        const image = await toModelImage(await pdfPageImage(buffer, page), 'image/png');
        return { text: `Page ${page} of ${name} is attached in the next message.`, image };
      }
    }, "{source: string, page: number}");

    this.listGroupsTool = new ExtendedDynamicStructuredTool({
      name: 'list_groups',
      description: 'List all of the group chats that you have access to.',
      schema: z.object({}),
      func: async () => {
        return JSON.stringify(await adapter.listGroups());
      }
    }, "{}");

    this.getGroupInfoTool = new ExtendedDynamicStructuredTool({
      name: 'get_group_info',
      description: "Get a group chat's name, description and participants, with each participant's user ID and description (which says e.g. whether they're a GDGoC member). Use `list_groups` to find group ids.",
      schema: z.object({
        group_id: z.string().describe("[Required] The group id, ending with `@g.us`."),
      }),
      func: async (args) => {
        const { group_id } = args as any;
        if (!String(group_id).endsWith('@g.us')) {
          throw Error(`"${group_id}" is not a group id, group ids end with @g.us. Get them from \`list_groups\`.`);
        }
        return formatGroupInfo(await adapter.getGroupInfo(group_id));
      }
    }, "{group_id: string}");

    this.readChatHistoryTool = new ExtendedDynamicStructuredTool({
      name: "read_chat_history",
      description: "Read the recent chat history you had with a user (by user id) or in a group chat (by group id ending with `@g.us`). Useful to check if someone replied, to recall what was said in another chat, or to read older messages of the current chat that are left out of your history (use `after`). Be discreet about sharing private chats with other people.",
      schema: z.object({
        id: z.string().describe("[Required] The user id or group id. Get them from `user_list` or `list_groups`."),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum number of messages to return. Defaults to 30. Without `after` these are the most recent messages."),
        after: z.string().optional().describe("[Optional] Only return messages sent after this date and time, as ISO 8601 in Singapore Timezone. E.g, 2026-04-16T11:47:12+08:00. Returns the earliest messages after it (up to `limit`), and says how to read further if there are more."),
      }),
      func: async (args) => {
        const { id, limit = 30, after } = args as any;
        let messages = await adapter.loadChatById(id);
        let more = 0;
        if (after) {
          // A time without an offset is taken as Singapore time, not the server's timezone
          const afterTime = moment.tz(after, moment.ISO_8601, SCHEDULE_TIMEZONE);
          if (!afterTime.isValid()) {
            throw Error(`Invalid \`after\` "${after}", use ISO 8601 in Singapore Timezone, e.g. 2026-04-16T11:47:12+08:00`);
          }
          messages = messages.filter(m => m.time * 1000 > afterTime.valueOf());
          more = Math.max(0, messages.length - limit);
          messages = messages.slice(0, limit);
          if (messages.length === 0) {
            return `No messages found in this chat after ${formatDateTime(afterTime.valueOf())}.`;
          }
        }
        else {
          messages = messages.slice(-limit);
        }
        if (messages.length === 0) {
          return "No messages found in this chat.";
        }
        const names: { [jid: string]: string } = {};
        const lines = [];
        for (const m of messages) {
          let name;
          if (m.user === 'AI') {
            name = 'You (Sofia)';
          }
          else if (m.user) {
            name = names[m.user] ??= await this.db.user.generateUserStringFromJid(m.user);
          }
          else {
            name = 'Unknown User';
          }
          lines.push(`[${formatDateTime(m.time * 1000)}] ${name}: ${m.quotedMessage ? `(Quoting: ${m.quotedMessage}) ` : ''}${m.text}`);
        }
        if (more) {
          const last = moment(messages[messages.length - 1].time * 1000).tz(SCHEDULE_TIMEZONE).format();
          lines.push(`(${more} more message${more == 1 ? '' : 's'} after these, call again with after: "${last}" to read them)`);
        }
        return lines.join('\n');
      }
    }, "{id: string, limit?: number, after?: string}");

    this.sendPollTool = new ExtendedDynamicStructuredTool({
      name: "send_poll",
      description: "Send a WhatsApp poll, to the chat you are replying in or to another chat. Use it when you want people to vote (e.g. picking a date or a lunch spot), then check the votes later with `read_poll`.",
      schema: z.object({
        question: z.string().min(1).max(255).describe("[Required] The poll question."),
        options: z.array(z.string().min(1).max(100)).min(2).max(12).describe("[Required] 2 to 12 different options."),
        allow_multiple_answers: z.boolean().describe("[Required] true lets people pick several options, false only one."),
        id: z.string().optional().describe("User id or group id (ending with `@g.us`) to send it to. Leave it out to send it to the chat you are replying in."),
        end_message: endMessageField,
      }),
      func: async (args) => {
        const { question, options, allow_multiple_answers, id } = args as any;
        const unique = [...new Set((options as string[]).map(o => o.trim()))];
        if (unique.length != options.length) {
          throw Error("Poll options must all be different.");
        }
        const chatId = id ?? chatContext.getStore()?.chatId;
        if (!chatId) {
          throw Error("You are not replying in a chat right now, give the user id or group id to send the poll to.");
        }
        const pollId = await adapter.sendPoll(chatId, { question: question.trim(), options: unique, multiple: allow_multiple_answers });
        return `Poll sent, poll_id=${pollId}. Use read_poll with it to see the votes.`;
      }
    }, "{question: string, options: string[], allow_multiple_answers: boolean, id?: string, end_message: boolean}");

    this.readPollTool = new ExtendedDynamicStructuredTool({
      name: "read_poll",
      description: "Read the current votes of a WhatsApp poll by its `poll_id` (shown like `<WhatsApp Poll poll_id=...>` in the chat history, or returned by `send_poll`). Shows who voted for each option.",
      schema: z.object({
        poll_id: z.string().describe("[Required] The poll_id."),
      }),
      func: async (args) => {
        const { poll_id } = args as any;
        const results = await adapter.getPollResults(poll_id);
        if (!results) {
          throw Error(`Unknown poll "${poll_id}". Only polls sent or seen since polls were added can be read.`);
        }
        return JSON.stringify({
          question: results.poll.question,
          type: results.poll.multiple ? 'pick any number' : 'pick one',
          voters: results.voters.length,
          options: results.options.map(o => ({ option: o.option, votes: o.voters.length, voters: o.voters })),
          note: "Only votes cast after the poll was saved are counted. People who haven't voted aren't listed.",
        });
      }
    }, "{poll_id: string}");

    this.fileTools = createFileTools({ adapter, workspace: this.workspace, extracted: this.extractedImages });
    this.tools.push(...this.fileTools);
    this.tools.push(this.sendMessageTool, this.listGroupsTool, this.getGroupInfoTool, this.readChatHistoryTool, this.sendStickerGifTool, this.viewMediaTool, this.readPdfTool, this.viewPdfPageTool, this.sendPollTool, this.readPollTool);
    this.bindModel();
  }

  // /**
  //  * Asynchronously streams the model response, yielding control back to the caller
  //  * periodically to allow for display control.
  //  * @param userInput The message from the user.
  //  * @param chatHistory The current list of messages for context.
  //  * @yields A Promise that resolves when the response content is fully generated.
  //  */
  // async * processChat(
  //   chatHistory: BaseMessage[],
  //   userInput?: string,
  // ) {
  //   if (userInput) {
  //     const userMessage = new HumanMessage(userInput);
  //     chatHistory.push(userMessage);
  //   }

  //   // 🔧 Build tool registry (name → tool)
  //   const toolMap: Record<string, ExtendedDynamicStructuredTool> = Object.fromEntries(
  //     this.tools.map(t => [t.name, t])
  //   );

  //   try {
  //     console.log("\n🤖 Thinking...");

  //     const memory = await this.memoryQueryTool.func({ queryText: userInput })
  //     if (memory instanceof Array && memory.length > 0) {
  //       chatHistory.push(new SystemMessage(`Possibly relavent memory data: ${memory}`))
  //     }

  //     let fullResponseContent = "";
  //     let chunck = "";

  //     // 🔁 Recursive stream handler
  //     const handleStream = async function* (
  //       stream: any,
  //       model: ReturnType<ChatOpenAI['bindTools']>
  //     ): AsyncGenerator<any> {
  //       for await (const chunk of stream) {

  //         // 🧠 TOOL CALL HANDLING (multi-call safe)
  //         if (
  //           chunk.tool_calls &&
  //           chunk.tool_calls.length > 0 &&
  //           chunk.tool_calls.every((tc: any) => tc.id)
  //         ) {
  //           const toolCalls = chunk.tool_calls;

  //           // 1. Add AIMessage with all tool calls
  //           chatHistory.push(
  //             new AIMessage({
  //               content: "",
  //               tool_calls: toolCalls,
  //             })
  //           );

  //           // 2. Execute all tools
  //           for (const toolCall of toolCalls) {
  //             console.dir(toolCall);
  //             console.log(`Called ${toolCall.name}`)
  //             const tool = toolMap[toolCall.name];

  //             let result: string;

  //             try {
  //               if (!tool) {
  //                 result = `Error: Unknown tool "${toolCall.name}"`;
  //               } else {
  //                 // 🧩 Flush remaining buffer if there is. (e.g, AI says it will go get the information)
  //                 if (chunck) {
  //                   yield {
  //                     type: "chunk_display",
  //                     content: chunck,
  //                     delimiter: false,
  //                   };
  //                   chunck = "";
  //                 }

  //                 // parse args safely (if present)
  //                 const args = toolCall.args ?? {};
  //                 console.trace(args)
  //                 result = await tool.invoke(args);
  //               }
  //             } catch (err: any) {
  //               console.error(err);
  //               result = `Tool execution error: ${err.message}\nToolArgs: ${tool.usage_str}`;
  //             }
  //             console.trace(result);

  //             chatHistory.push(
  //               new ToolMessage({
  //                 content: result,
  //                 tool_call_id: toolCall.id!,
  //               })
  //             );
  //           }

  //           // 3. Restart stream AFTER all tools complete
  //           const followStream = await model.stream(chatHistory);

  //           yield* handleStream(followStream, model);
  //           return; // stop current stream
  //         }

  //         // 📡 NORMAL STREAMING (unchanged)
  //         const chunkText = (chunk.content || "") as string;

  //         fullResponseContent += chunkText;
  //         chunck += chunkText;

  //         if (chunck.includes("\n\n")) {
  //           let text = chunck.slice(0, chunck.indexOf("\n\n"));
  //           chunck = chunck.slice(chunck.indexOf("\n\n") + 2);

  //           yield {
  //             type: "chunk_display",
  //             content: text,
  //             delimiter: true,
  //           };
  //         }
  //       }
  //     };

  //     // 🚀 Start initial stream
  //     const initialStream = await this.model.stream(chatHistory);

  //     for await (const yieldState of handleStream(initialStream, this.model)) {
  //       yield yieldState;
  //     }

  //     // 🧩 Flush remaining buffer
  //     if (chunck) {
  //       yield {
  //         type: "chunk_display",
  //         content: chunck,
  //         delimiter: false,
  //       };
  //     }

  //     // ✅ Persist final AI response
  //     chatHistory.push(new AIMessage(fullResponseContent));

  //     yield {
  //       type: "done",
  //       content: chatHistory,
  //     };

  //   } catch (error) {
  //     console.error("\n🚨 Oops! Something went wrong:", error);
  //     chatHistory.pop();
  //     throw error;
  //   }
  // }


  // /**
  //  * Same behavior as the original processChat but implemented using the official OpenAI Node.js Responses streaming API.
  //  *
  //  * Notes / assumptions:
  //  * - `this.openai` is an instance of `new OpenAI({ apiKey })`.
  //  * - `this.modelName` is the model id to call (e.g., "gpt-4o-mini" or "gpt-4o").
  //  * - `this.tools` is an array of ExtendedDynamicStructuredTool objects with `.name` and `.invoke(args)` (or `.invoke` signature).
  //  * - `this.memoryQueryTool.func` exists and returns memory results for the given query.
  //  * - `chatHistory` uses the same message classes as in the original code.
  //  *
  //  * Adjust imports and minor details to match your codebase.
  //  */
  // async * processChatv2(
  //   chatHistory: BaseMessage[],
  //   userInput?: string,
  //   additionalOptions: Partial<ResponseCreateParamsStreaming> = {}
  // ) {
  //   // Add user message to history if provided
  //   if (userInput) {
  //     const userMessage = new HumanMessage(userInput);
  //     chatHistory.push(userMessage);
  //   }

  //   // Build tool map for quick lookup
  //   const toolMap: Record<string, ExtendedDynamicStructuredTool> = Object.fromEntries(
  //     this.tools.map((t: ExtendedDynamicStructuredTool) => [t.name, t])
  //   );

  //   try {
  //     console.log("\n🤖 Thinking (v2 with official OpenAI client)...");

  //     // Query memory and add a system hint if relevant
  //     const memory = await this.memoryQueryTool.func({ queryText: userInput || chatHistory.filter(m => m instanceof HumanMessage).slice(-1)[0].content });
  //     if (Array.isArray(memory) && memory.length > 0) {
  //       chatHistory.push(new SystemMessage(`Possibly relevant memory data: ${memory}`));
  //     }

  //     // Convert chatHistory to the shape expected by the OpenAI Responses API
  //     const buildMessagesForOpenAI: (history: BaseMessage[]) => Array<ResponseInputItem> = (history) =>
  //       history.map((m) => {
  //         // Map your message classes to role/content pairs
  //         if (m instanceof HumanMessage) {
  //           return { role: "user", content: (m.content ?? "") as string, type: "message" } as EasyInputMessage;
  //         }
  //         if (m instanceof AIMessage) {
  //           if (m.tool_calls) {
  //             for (let i = 0; i < m.tool_calls.length; i++) {
  //               return {
  //                 call_id: (m.tool_calls[i] as any).id,
  //                 arguments: (m.tool_calls[i] as any).args instanceof String ? (m.tool_calls[i] as any).args : JSON.stringify((m.tool_calls[i] as any).args),
  //                 name: (m.tool_calls[i] as any).name, type: 'function_call'
  //               } as ResponseFunctionToolCall
  //             }
  //           }
  //           else {
  //             return { role: "assistant", content: (m.content ?? "") as string, type: "message" } as EasyInputMessage;
  //           }
  //         }
  //         if (m instanceof SystemMessage) {
  //           return { role: "system", content: (m.content ?? "") as string, type: "message" } as EasyInputMessage;
  //         }
  //         if (m instanceof ToolMessage) {
  //           // ToolMessage is treated as assistant content (tool output)
  //           return { output: m.content, call_id: m.tool_call_id || m.id, type: "function_call_output" } as ResponseInputItem.FunctionCallOutput;
  //         }
  //         // Fallback
  //         return { role: "assistant", content: ((m as any).content ?? "") as string, type: "message" } as EasyInputMessage;
  //       });


  //     // We'll accumulate the full assistant text and a small buffer for chunked yields
  //     let fullResponseContent = "";
  //     let buffer = "";

  //     // Helper to flush buffer as chunk_display
  //     const flushBuffer = (delimiter: boolean) => {
  //       if (!buffer) return null;
  //       const out = {
  //         type: "chunk_display",
  //         content: buffer,
  //         delimiter,
  //       };
  //       buffer = "";
  //       return out;
  //     };

  //     const handleStream = async function* (instance: AI): AsyncGenerator<{
  //       type: string,
  //       content: string,
  //       delimiter: boolean
  //     }> {
  //       instance.logger.trace("CALL START")
  //       let hasToolCalls = false;
  //       const openaiMessages = buildMessagesForOpenAI(chatHistory);
  //       instance.logger.trace(openaiMessages);
  //       // Start streaming from the Responses API
  //       // The official client exposes a streaming helper `client.responses.stream`.
  //       // We pass `input` as the messages array.
  //       const stream = await instance.openai.responses.create({
  //         model: "qwen3.5-plus",
  //         input: openaiMessages,
  //         stream: true,
  //         tools: instance.tools.map((t) => ({
  //           type: "function",
  //           name: t.name,
  //           description: t.description,
  //           parameters: z.toJSONSchema(t.schema as any, {
  //             target: 'draft-7',
  //           }),
  //           strict: true
  //         })),
  //         tool_choice: "auto",
  //         // You can pass additional options here (e.g., temperature) if desired
  //         ...additionalOptions
  //       });

  //       for await (const event of stream) {
  //         instance.logger.trace(event);
  //         if (event.type == "response.output_item.done") {
  //           if (event.item.type == "function_call") {
  //             hasToolCalls = true;
  //             let args;
  //             try {
  //               args = JSON.parse(event.item.arguments) || {}
  //             }
  //             catch {
  //               args = `${event.item.arguments}`
  //             }
  //             chatHistory.push(
  //               new AIMessage({
  //                 content: "",
  //                 tool_calls: [{
  //                   type: "tool_call",
  //                   id: event.item.call_id,
  //                   name: event.item.name,
  //                   args
  //                 }],
  //               })
  //             );

  //             console.dir(event.item)
  //             console.log(`Called ${event.item.name}`)
  //             const tool = toolMap[event.item.name];
  //             let result: string;
  //             try {
  //               if (!tool) {
  //                 result = `Error: Unknown tool "${event.item.name}"`;
  //               } else {

  //                 if (buffer) {
  //                   yield {
  //                     type: "chunk_display",
  //                     content: buffer,
  //                     delimiter: false,
  //                   };
  //                   buffer = "";
  //                 }

  //                 // parse args safely (if present)
  //                 const args2 = JSON.parse(event.item.arguments) ?? {};
  //                 console.trace(args2)
  //                 result = await tool.invoke(args2);

  //               }

  //             }
  //             catch (err: any) {
  //               console.error(err);
  //               result = `Tool execution error:${err.message}\nToolArgs: ${tool.usage_str}`;
  //             }
  //             console.trace(result);

  //             chatHistory.push(
  //               new ToolMessage({
  //                 content: result,
  //                 tool_call_id: event.item.call_id,
  //               })
  //             )

  //           }
  //         }
  //         else if (event.type == "response.output_text.delta") {
  //           // 📡 NORMAL STREAMING (unchanged)
  //           const chunkText = (event.delta || "") as string;
  //           fullResponseContent += chunkText;
  //           buffer += chunkText;

  //           if (buffer.includes("\n\n")) {
  //             let text = buffer.slice(0, buffer.indexOf("\n\n"));
  //             buffer = buffer.slice(buffer.indexOf("\n\n") + 2);

  //             yield {
  //               type: "chunk_display",
  //               content: text,
  //               delimiter: true,
  //             };
  //           }
  //         }
  //       }

  //       if (hasToolCalls) {
  //         instance.logger.trace("RECALLING!!!")
  //         yield* handleStream(instance);
  //         return;
  //       }

  //     }

  //     for await (const event of handleStream(this)) {
  //       yield event;
  //     }



  //     // 🧩 Flush remaining buffer
  //     if (buffer) {
  //       yield {
  //         type: "chunk_display",
  //         content: buffer,
  //         delimiter: false,
  //       };
  //     }

  //     // Persist final AI response into chatHistory
  //     chatHistory.push(new AIMessage(fullResponseContent));

  //     // Return final chatHistory
  //     yield {
  //       type: "done",
  //       content: chatHistory,
  //       delimiter: false
  //     };
  //   } catch (error) {
  //     console.error("\n🚨 Oops! Something went wrong (v2):", error);
  //     // If we added the user's message at the top and want to revert it on error, pop it
  //     if (userInput) {
  //       // remove last message if it matches the user input
  //       const last = chatHistory[chatHistory.length - 1];
  //       if (last instanceof HumanMessage && last.content === userInput) {
  //         chatHistory.pop();
  //       }
  //     }
  //     throw error;
  //   }
  // }

  /**
   * @param getNewMessages Called after tool calls, before the model continues. Returns messages that arrived in the chat
   * since the reply started (with a note), which are added to the history so Sofia can answer them in the same reply.
   * @param hasNewMessages Whether a message arrived since the reply started (or since the last call). Checked when Sofia
   * finishes thinking, sends a WhatsApp message or runs a tool: if so, the response is stopped there and the next one
   * continues with the new messages (from `getNewMessages`) added, so she doesn't send a reply that ignores them.
   */
  async * processChatv3(
    chatHistory: Array<ResponseInputItem>,
    userInput?: string,
    additionalOptions: Partial<ResponseCreateParamsStreaming> = {},
    getNewMessages?: () => Promise<ResponseInputItem[]>,
    hasNewMessages?: () => boolean
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
      // Scheduled tasks may have no user message, so fall back to the latest message (the task instructions)
      const messages = chatHistory.filter(m => m.type == 'message') as EasyInputMessage[];
      const lastMessage = messages.filter(m => m.role == 'user').slice(-1)[0] ?? messages.slice(-1)[0];
      const memory = JSON.parse(await this.memoryQueryTool.func({ queryText: userInput || lastMessage?.content }));
      this.logger.trace(memory, "Memory data retrieve")
      if (Array.isArray(memory) && memory.length > 0) {
        chatHistory.push({
          role: 'system',
          content: `Possibly relevant memory data to aid with responses: ${memory.map(m => `${parseTimestamp(m.created_at)}:${m.text}`).join(';')}\nFor time-dependant memory, take into account the current datetime so that you only use what is relevant. Current Datetime:${parseTimestamp(getTime())}`,
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


      // Small buffer for chunked yields
      let buffer = "";
      // Set when a tool ends the reply (`end_message`, or a send tool with `end_message: true`)
      let ended = false;
      // Sofia gets one nudge per reply when she says she's about to do something but stops without a tool call
      let nudged = false;
      // Messages to continue with if new ones arrived, checked at points where stopping the response loses nothing:
      // after thinking, a sent WhatsApp message or a tool call that has run (never halfway through one). There's no limit
      // on how often: long tasks (e.g. building a deck, 15+ minutes) should take every new message into account, and in
      // groups only messages that pass the reply decision stop her (see `messagesDuringReply`).
      const takeInterrupt = async (instance: AI): Promise<ResponseInputItem[] | null> => {
        if (ended || !hasNewMessages?.()) {
          return null;
        }
        try {
          const newMessages = await getNewMessages?.() ?? [];
          return newMessages.length ? newMessages : null;
        }
        catch (e) {
          instance.logger.error(e, 'Failed to load messages that arrived during the reply');
          return null;
        }
      };

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
      } | {
        /** A built-in tool (web search, page extraction, code) that Model Studio already ran within the response */
        type: 'builtin_tool_call',
        data: any
      }> {
        let hasToolCalls = false;
        // Text of this response, checked for "about to do something" endings when there are no tool calls
        let responseText = "";
        // Images from tools (`view_media`), added after this turn's tool outputs
        const images: EasyInputMessage[] = [];
        // Text of the current message item already sent to WhatsApp, kept in the history if the response is stopped mid-text
        let sentText = "";
        // Set when the response is stopped for new messages, these are added before the next response
        let interrupted: ResponseInputItem[] | null = null;
        // Results of this response's tool calls, added after its consecutive calls instead of after each one. DeepSeek's own
        // API rejects call, result, call, result: the second call ends up without the thinking it needs (tested 2026-10-25)
        const toolOutputs: ResponseInputItem.FunctionCallOutput[] = [];
        const flushToolOutputs = () => chatHistory.push(...toolOutputs.splice(0));
        const controller = new AbortController();
        instance.logger.info(chatHistory, "CHAT HISTORY CREATED");
        // Start streaming from the Responses API
        // The official client exposes a streaming helper `client.responses.stream`.
        // We pass `input` as the messages array.
        const stream = await instance.openai.responses.create({
          model: CHAT_MODEL,
          input: chatHistory,
          stream: true,
          tools: [
            ...instance.tools.map((t) => ({
              type: "function" as const,
              name: t.name,
              description: t.description,
              parameters: z.toJSONSchema(t.schema as any, {
                target: 'draft-7',
              }),
              strict: true
            })),
            // Model Studio's built-in tools, not in the OpenAI SDK's types
            ...instance.builtinTools.map(type => ({ type }) as any),
          ],
          tool_choice: "auto",
          // You can pass additional options here (e.g., temperature) if desired
          ...additionalOptions
        }, { signal: controller.signal });

        events: for await (const event of stream) {
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
              instance.logger.info(`Called ${event.item.name}`)
              const tool = toolMap[event.item.name];
              let result: string;
              let failed = false;
              try {
                if (!tool) {
                  result = `Error: Unknown tool "${event.item.name}"`;
                } else {

                  if (buffer.trim()) {
                    yield {
                      type: "chunk_display",
                      content: buffer,
                      delimiter: false,
                    };
                  }
                  buffer = "";

                  // parse args safely (if present)
                  const args2 = JSON.parse(event.item.arguments || '{}') ?? {};
                  console.trace(args2)
                  const raw = await tool.invoke(args2);
                  if (isToolImageResult(raw)) {
                    result = raw.text;
                    images.push({ role: 'user', content: [{ type: 'input_text', text: `[${event.item.name} result for ${event.item.arguments}]` }, { type: 'input_image', image_url: raw.image.dataUrl, detail: 'auto' }], type: 'message' });
                  }
                  else {
                    result = typeof raw == 'string' ? raw : JSON.stringify(raw);
                  }
                  if (endsReply(event.item.name, args2)) {
                    ended = true;
                  }

                }

              }
              catch (err: any) {
                console.error(err);
                failed = true;
                result = `Tool execution error:${err.message}\nToolArgs: ${tool?.usage_str}`;
              }
              console.trace(result);

              const outputData = {
                output: result,
                call_id: event.item.call_id,
                type: 'function_call_output'
              } as ResponseInputItem.FunctionCallOutput

              toolOutputs.push(outputData);
              yield {
                type: 'tool_call_output',
                data: outputData
              }

              interrupted = await takeInterrupt(instance);
              if (interrupted) {
                break events;
              }
            }
            else if (BUILTIN_TOOL_ITEMS.has(event.item.type)) {
              // Kept so the next request knows what was searched or run (Model Studio accepts them back as input)
              flushToolOutputs();
              chatHistory.push(event.item as any);
              instance.logger.info(`Used ${describeBuiltinToolCall(event.item)}`);
              yield {
                type: 'builtin_tool_call',
                data: event.item
              }

              interrupted = await takeInterrupt(instance);
              if (interrupted) {
                break events;
              }
            }
            else if (event.item.type == 'message') {
              sentText = "";
              // Keep text Sofia already sent in the history for the request after a tool call. Without it the model thinks
              // it has not replied yet and writes a whole new reply, so the user gets the same answer twice.
              const text = event.item.content.map(c => c.type == 'output_text' ? c.text : '').join('');
              if (text.trim()) {
                flushToolOutputs();
                chatHistory.push({ role: 'assistant', content: text, type: 'message' } as EasyInputMessage);
                responseText += text;
              }
            }
            else if (event.item.type == 'reasoning') {
              // Qwen puts its thinking in `summary`, DeepSeek leaves it empty and uses `content`, so both are kept for the
              // next request (Model Studio accepts both back as input, tested 2026-10-24)
              flushToolOutputs();
              chatHistory.push({
                id: event.item.id,
                summary: event.item.summary,
                ...(event.item.content?.length ? { content: event.item.content } : {}),
                type: 'reasoning'
              } as ResponseReasoningItem)
              yield {
                type: "reasoning",
                data: event.item,
              }

              // Her thinking is kept (the summary has all of it) so the next response continues from it
              interrupted = await takeInterrupt(instance);
              if (interrupted) {
                break events;
              }
            }
          }
          else if (event.type == 'response.failed' || event.type == 'error') {
            // Model Studio reports failed requests (e.g. an unknown model id) as an event, not an HTTP error. Without this
            // the stream just ends and Sofia silently doesn't reply.
            const error = event.type == 'error' ? event : event.response.error;
            throw Error(`Model request failed (${error?.code ?? 'unknown'}): ${error?.message ?? 'no message'}`);
          }
          else if (event.type == "response.output_text.delta") {
            if (ended) {
              continue; // The reply was ended by a tool, don't send anything after it
            }
            const chunkText = (event.delta || "") as string;
            buffer += chunkText;

            // Each blank line starts a new WhatsApp message, except inside a ``` code block (kept in one message)
            for (let breakAt = messageBreakIndex(buffer); breakAt >= 0; breakAt = messageBreakIndex(buffer)) {
              const text = buffer.slice(0, breakAt);
              buffer = buffer.slice(breakAt + 2);
              if (text.trim()) {
                yield {
                  type: "chunk_display",
                  content: text,
                  delimiter: true,
                };
                sentText += (sentText ? "\n\n" : "") + text;

                interrupted = await takeInterrupt(instance);
                if (interrupted) {
                  // The rest of this message item was never sent, only what was is kept
                  flushToolOutputs();
                  chatHistory.push(
                    { role: 'assistant', content: sentText, type: 'message' } as EasyInputMessage,
                    { role: 'system', content: INTERRUPTED_NOTE, type: 'message' } as EasyInputMessage,
                  );
                  break events;
                }
              }
            }
          }
        }

        flushToolOutputs();
        chatHistory.push(...images);
        if (interrupted) {
          controller.abort();
          instance.logger.info(`Stopped the response, continuing with ${interrupted.length} items that arrived during the reply`);
          buffer = "";
          chatHistory.push(...interrupted);
          yield* handleStream(instance);
          return;
        }
        if (ended) {
          instance.logger.info('Reply ended by a tool call');
          buffer = "";
          return;
        }
        if (hasToolCalls) {
          instance.logger.trace("RECALLING!!!")
          try {
            const newMessages = await getNewMessages?.() ?? [];
            if (newMessages.length) {
              instance.logger.info(`Adding ${newMessages.length} items that arrived during the reply`);
              chatHistory.push(...newMessages);
            }
          }
          catch (e) {
            instance.logger.error(e, 'Failed to load messages that arrived during the reply');
          }
          yield* handleStream(instance);
          return;
        }

        // The response ended with text only. If it says Sofia is about to do something, she stopped before doing it.
        if (!nudged && responseText.trim()) {
          // Send the rest of the text first so the check doesn't delay it
          if (buffer.trim()) {
            yield { type: "chunk_display", content: buffer, delimiter: false };
          }
          buffer = "";
          let p = 0;
          try {
            p = await (instance.aboutToAct ?? aboutToActProbability)(responseText.trim());
          }
          catch (e) {
            instance.logger.error(e, 'Unfinished reply check failed');
          }
          instance.logger.info({ aboutToAct: p, ending: replyEnding(responseText) }, 'Unfinished reply check');
          if (p >= UNFINISHED_THRESHOLD) {
            nudged = true;
            chatHistory.push({ role: 'system', content: UNFINISHED_NUDGE, type: 'message' } as EasyInputMessage);
            yield* handleStream(instance);
            return;
          }
        }
      }

      for await (const event of handleStream(this)) {
        yield event;
      }



      // 🧩 Flush remaining buffer
      if (buffer.trim()) {
        yield {
          type: "chunk_display",
          content: buffer,
          delimiter: false,
        };
      }

      // Sofia's replies were added to chatHistory as each message finished (see `response.output_item.done` above)
      // Return final chatHistory
      yield {
        type: "done",
        content: chatHistory,
        delimiter: false
      };
    } catch (error) {
      console.error("\n🚨 Oops! Something went wrong (v3):", error);
      this.logger.error(error)
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


  /**
   * System prompt text for the web tools, empty when `USE_WEB_TOOLS` is off. Added at runtime instead of in system.md so
   * Sofia is never told about tools she doesn't have, and with the tool names of the provider she chats through.
   */
  webToolsPrompt({ enabled = this.useWebTools, provider = this.chatProvider }: { enabled?: boolean, provider?: 'modelstudio' | 'deepseek' } = {}): string {
    if (!enabled) {
      return '';
    }
    const read = provider == 'deepseek' ? '`web_fetch`' : '`web_extractor`';
    return `\nWeb Search: You can search the web (\`web_search\`) and read web pages (${read}). Search when someone asks about current events, news, or facts you're not sure of, instead of guessing, and keep searches few and focused: they are slow and costly, so don't search for things you already know or for class info (use \`get_timetable\`, \`assignment_list\` and your other tools for that). Summarise what you found in your own words for WhatsApp (no Markdown), and paste at most one or two source links as plain URLs when they help.`;
  }

  /** A PDF by its WhatsApp media_id, or a Drive link or file id when Workspace is signed in. */
  async loadPdf(source: string): Promise<{ buffer: Buffer, name: string }> {
    const google = this.workspace && (/^https?:\/\//.test(source.trim()) || isDriveId(source)) ? await toGoogleLink(source) : null;
    if (this.workspace && google) {
      const file = await this.workspace.getFile(google);
      if (file.mimeType != MIME.pdf) {
        throw Error(`"${file.name}" isn't a PDF.${file.mimeType?.startsWith('application/vnd.google-apps') ? ' Read it with `google_read_file`.' : ''}`);
      }
      return { buffer: await this.workspace.download(file), name: file.name ?? source };
    }
    if (!this.chatAdapter) {
      throw Error('PDFs from the chat are not available here.');
    }
    const media = await this.chatAdapter.getMedia(source.trim());
    const name = media.fileName ?? source;
    if (media.kind != 'document') {
      throw Error(`${source} is ${media.kind == 'image' ? 'an image' : `a ${media.kind}`}, not a PDF. Use \`view_media\` to see it.`);
    }
    if (media.mime != 'application/pdf' && !/\.pdf$/i.test(name)) {
      throw Error(`"${name}" isn't a PDF (${media.mime}), only PDFs can be read for now.`);
    }
    return { buffer: media.buffer, name };
  }

  /** Extra system prompt text explaining the test environment, empty outside the CLI. */
  testModePrompt(): string {
    if (!this.cli_mode) return '';
    return `\nTEST MODE: You are running inside a CLI test harness used by developers to test you, not on WhatsApp. ` +
      `Messages sent with \`send_message\` and chat history from \`read_chat_history\` are simulated and do not reach real people. ` +
      (this.test_mode
        ? `Writes are disabled: memory writes and scheduled task changes will fail with "Disabled due to test mode." If that happens, tell the tester what you would have done instead of retrying.`
        : `Writes are enabled against a test database, so memory and scheduled task changes are saved.`) +
      ` Otherwise, behave exactly as you would with real users.`;
  }

  /** @param group For group chats, the group's info (description and participants) to include. */
  async generatePrompt(mode: 'testing' | 'chat' | 'group', current_user_name: string, current_user_id: string, current_user_desc?: string, group?: GroupInfo): Promise<string> {
    // 1. Read the System Prompt from the file
    const systemPromptPath = path.resolve("src/static/prompts/system.md");
    const systemMessageContent = await fs.readFile(systemPromptPath, 'utf-8');

    // 2. Get memory for a current user id
    const memories = mode == 'group' ? '' : await this.memoryQueryByUserTool.func({ userId: current_user_id }) as string;
    const memoryPrompt = `${mode == 'group' ? (group ? `Current ${formatGroupInfo(group)}` : `Current Group Chat: ${current_user_name} (${current_user_id})`) : `You are currently chatting with ${current_user_name} with user ID ${current_user_id}. ${current_user_desc ? "User Description: " + current_user_desc + ". " : ""}Below are your memories related to the current user.
    User Memories: ${JSON.parse(memories).data.filter((m: any) => m.category != 'core').slice(-10).map((m: any) => m.text).join(';')}
    If you have no memory of saying hi to this user for the first time, please use the \`memory_write\` tool call to save this event (leave category empty) and then introduce yourself to the user.`}
    Current Chat Mode: ${mode == 'testing' ? 'Testing Mode (1-to-1) (stickers and GIFs you send are simulated, media_id images are unavailable)' : mode == 'chat' ? "WhatsApp Chat (1-to-1)" : "WhatsApp Group Chat (1-to-many)"}
    Your Core Memories: ${(await this.db.getCoreMemories({})).data.map(m => m.text).join(';')}
    Available Tool Calls: ${this.tools.map(t => t.name).join(', ')}
    User's can't see you using tool calls, so make sure to send the output of the tool call back to the user if appropriate.
    Additionally, when you use the \`send_message\` tool call, show the user what you're sending in the same response as the tool call.${this.webToolsPrompt()}${this.testModePrompt()}`
    // Available Tool Calls: ${this.tools.map(t => `\`${t.name}\`: ${t.description}, Parameters: ${JSON.stringify(z.toJSONSchema(t.schema as any).properties) || "Not needed"}`).join('\n')}`
    return systemMessageContent + (mode === 'testing' ? `\nCurrent Time:${formatDateTime(new Date())}` : '') + `\n${memoryPrompt}`
  }

  //   async shouldRespond(history: ResponseInputItem[]) {
  //     if (history.length == 0) {
  //       return false
  //     };
  //     const messages = (history.filter(m => m.type == 'message') as EasyInputMessage[]).map(m => m.role == 'assistant' ? `AI: ${m.content}` : `User: ${m.content}`).join('\n\n');
  //     const model = new ChatOpenAI({
  //       apiKey: process.env.ALIBABA_API_KEY,
  //       model: 'qwen-flash',
  //       configuration: {
  //         // baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
  //         baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"
  //       }
  //     }).withStructuredOutput(z.object({
  //       shouldRespond: z.boolean().describe("Whether or not the AI model Sofia should reply or not.")
  //     }))
  //     const systemMsg = `You determine whether an AI named Sofia should respond.
  // Rules:
  // - Respond if any of the recent messages is a question or asking her to do something or asking her a question. 
  // - Respond If the user is following up on a previous statement and its appropriate for Sofia to reply.
  // - Respond if it is appropriate to comment.
  // - Other than that, do not respond.
  // Examples when you should not respond:
  // - "Sofia will be able to send GIFs and Stickers."
  // - "I've added a new feature to sofia."
  // - "I've just fixed some bugs with sofia."
  // Examples when you should respond:
  // - "Sofia, this is amazing isn't it?"
  // - "I think sofia might know."
  // - "Sofia, you're a genius!"
  // - "Maybe sofia can help think of smt..."
  // - "Sofia, what is the timetable for tomorrow."
  // - "Sofia can you play a game with me?"
  // - "Sofia create a new assignment with the information above."
  // - "Sofia, can you help me check what assessments we have soon?" 
  // `
  //     const userMsg = `This is the current Chat History:\n${messages}\nShould AI model Sofia reply?`
  //     const output = await model.invoke([new SystemMessage(systemMsg), new HumanMessage(userMsg)]);
  //     return output.shouldRespond;
  //   }

  // async run() {

  //   // Chat history will store all messages for context persistence
  //   let chatHistory: BaseMessage[] = [];

  //   try {


  //     // 3. Initialize Conversation History with the System Message (and current time)
  //     const systemMsg = new SystemMessage(await this.generatePrompt('testing', "94527fcc-fff4-4994-af46-0fea45499f20", "Azlan"));
  //     chatHistory.push(systemMsg);
  //     console.log(systemMsg.content);

  //     // --- Readline Implementation for Continuous Chat ---
  //     const rl = readline.createInterface({
  //       input: process.stdin,
  //       output: process.stdout
  //     });

  //     console.log("\n=============================================================================");
  //     console.log("👋 Hi there! I'm Sofia, your AI class assistant!");
  //     console.log("Feel free to chat with me about anything—academics, vibes, life stuff! 😊");
  //     console.log("Type 'exit' or 'quit' when you're done.");
  //     console.log("=========================================================================\n");

  //     // Function to handle the entire chat loop
  //     const chatLoop = async () => {
  //       // Prompt user for the next input
  //       rl.question('You: ', async (userInput: string) => {
  //         if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit') {
  //           console.log("\n✨ Take care! Chatting with you was so much fun. Feel free to reach out anytime! ✨");
  //           rl.close();
  //           return;
  //         }

  //         try {
  //           const streamGenerator = this.processChatv2(chatHistory, userInput);

  //           // 3. Consume the generator stream manually to control output
  //           for await (const yieldState of streamGenerator) {
  //             if (yieldState.type === 'chunk_display') {
  //               process.stdout.write(yieldState.content as string);
  //               if (yieldState.delimiter) {
  //                 process.stdout.write("\n-------------------------------\n");
  //               }
  //             } else if (yieldState.type === 'done') {
  //               chatHistory = yieldState.content as typeof chatHistory;
  //               break; // Exit the loop after the full content is collected
  //             }
  //           }

  //         } catch (error) {
  //           // Error is already logged inside processChat
  //         } finally {
  //           // Recursively call chatLoop to keep the conversation going
  //           chatLoop();
  //         }
  //       });
  //     };

  //     chatLoop();

  //   } catch (error) {
  //     if (error instanceof Error) {
  //       console.error("\nFATAL SETUP ERROR:", error.message);
  //       console.error("Please ensure you have read permissions for the system prompt file: src/static/prompts/system.md");
  //     } else {
  //       console.error("\nFATAL ERROR:", error);
  //     }
  //   }
  // }
}
