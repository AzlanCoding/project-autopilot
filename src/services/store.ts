import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { OpenAIEmbeddings } from '@langchain/openai';
import { MilvusClient, QueryResults } from '@zilliz/milvus2-sdk-node';
import { ModelStatic, Sequelize } from 'sequelize'
import { Assignment } from '../models/Assignment';
import { Assessment } from '../models/Assessment';
import { AssignmentService } from './assignmentService';
import { AssessmentService } from './assessmentService';
import { User } from '../models/User';
import { UserService } from './userService';
import type AI from './ai';
import { type Logger } from 'pino';
import { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses.js';
import { ToolCallHistService } from './ToolCallHistService';
import { ToolCallHist } from '../models/ToolCallHist';
import { ScheduledTaskService } from './scheduledTaskService';
import { ScheduledTask } from '../models/ScheduledTask';

const SETTINGS_PATH = './assets/settings.json';
// Shown to the AI after a memory_write so it can clean up overlapping memories.
const SIMILAR_MEMORY_TOP_K = 5;
const SIMILAR_MEMORY_MAX_DISTANCE = 0.8; // Squared L2 on unit vectors, roughly cosine similarity >= 0.6
interface AppSettings { subjects: { [k: string]: string }; reminders: number[]; }


export default class Store {
  db: Sequelize;
  milvus: MilvusClient;
  milvusCollectionName = 'memories_vectors';
  settings: AppSettings;
  assignment: AssignmentService;
  assessment: AssessmentService;
  toolCallHist: ToolCallHistService;
  scheduledTask: ScheduledTaskService;
  user: UserService;
  private logger: Logger;

  ai_scheduled_task_runner?: (message: () => Promise<string>, modelOptions?: Partial<ResponseCreateParamsStreaming>, requireMessage?: boolean) => Promise<void>

  constructor(logger: Logger) {
    this.logger = logger;
    if (!process.env.SQL_DATABASE_URL) {
      throw Error(`Environment variable 'SQL_DATABASE_URL' is not defined`)
    }
    if (!fs.existsSync(SETTINGS_PATH)) {
      throw new Error('`settings.json` is missing!');
    }
    this.db = new Sequelize(process.env.SQL_DATABASE_URL);
    this.settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));

    const milvusAddr = process.env.MILVUS_ADDRESS ?? 'localhost:19530';
    this.milvus = new MilvusClient({ address: milvusAddr });

    this.assignment = new AssignmentService(this, this.logger);
    this.assessment = new AssessmentService(this, this.logger);
    this.toolCallHist = new ToolCallHistService(this, this.logger);
    this.scheduledTask = new ScheduledTaskService(this, this.logger);
    this.user = new UserService(this);
  }

  async init() {
    await this.db.authenticate();

    // Register class models
    const AssignmentModel = Assignment.register(this.db);
    const AssessmentModel = Assessment.register(this.db);
    const UserModel = User.register(this.db);
    const ToolCallHistModel = ToolCallHist.register(this.db);
    const ScheduledTaskModel = ScheduledTask.register(this.db);

    // Optionally ensure they are available on sequelize.models with the same keys you expect
    this.db.models.AssignmentStore = AssignmentModel;
    this.db.models.AssessmentStore = AssessmentModel;
    this.db.models.UserStore = UserModel;
    this.db.models.ToolCallHistStore = ToolCallHistModel;
    this.db.models.ScheduledTaskStore = ScheduledTaskModel;

    // this.assignment = AssignmentModel as any; // Quick Fix
    // this.assessment = AssessmentModel as any; // Quic Fix


    // Sync
    await AssignmentModel.sync({ alter: true });
    await AssessmentModel.sync({ alter: true });
    await User.sync({ alter: true });
    await ToolCallHistModel.sync({ alter: true });
    await ScheduledTaskModel.sync({ alter: true });

    this.assignment = new AssignmentService(this, this.logger);
    await this.assignment.initService();
    this.assessment = new AssessmentService(this, this.logger);
    await this.assessment.initService();
    this.user = new UserService(this);
    this.toolCallHist = new ToolCallHistService(this, this.logger);
    this.scheduledTask = new ScheduledTaskService(this, this.logger);

    // for (let table in tables) {
    //   const tbl = this.db.define(table, tables[table]);
    //   await tbl.sync({ alter: true })
    // }
  }
  async postSockInit() { }


  // Embedding provider: replace modelName/config as needed
  async getEmbedding(text: string): Promise<number[]> {
    const embeddings = new OpenAIEmbeddings({
      apiKey: process.env.ALIBABA_API_KEY,
      modelName: 'text-embedding-v4',
      dimensions: 2048,
      configuration: {
        // baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"
      }
    });
    return await embeddings.embedQuery(text);
  }

  // Ensure collection exists and index is created
  async ensureMilvusCollection(dim = 2048) {
    const name = this.milvusCollectionName;
    const has = await this.milvus.hasCollection({ collection_name: name });
    if (!has.value) {
      await this.milvus.createCollection({
        collection_name: name,
        fields: [
          { name: 'memory_id', data_type: 'VarChar', max_length: 64, is_primary_key: true },
          { name: 'text', data_type: 'VarChar', max_length: 4096 },
          { name: 'embedding', data_type: 'FloatVector', type_params: { dim: String(dim) } },
          { name: 'author_user_id', data_type: 'VarChar', max_length: 64 },
          { name: 'subject_user_id', data_type: 'VarChar', max_length: 64 },
          { name: 'group_id', data_type: 'VarChar', max_length: 64 },
          { name: 'is_global', data_type: 'Bool' },
          { name: 'category', data_type: 'VarChar', max_length: 128 },
          { name: 'created_at', data_type: 'VarChar', max_length: 64 }
        ],
        index_params: {
          field_name: 'embedding',
          index_name: 'vector_index',
          metric_type: "L2",
          index_type: "HNSW",
          params: {
            "M": 32, // Maximum number of neighbors each node can connect to in the graph
            "efConstruction": 200 //Number of candidate neighbors considered for connection during index construction
          }
        }
      });
    }

    // console.log("Creating index...")
    // await this.milvus.createIndex({
    //   collection_name: name,
    //   field_name: 'embedding',
    //   index_name: 'idx_hnsw',
    //   index_type: 'HNSW',
    //   params: { M: '16', efConstruction: '200' }
    // });

    await this.milvus.loadCollection({ collection_name: name });
  }

  unloadMilvus() {
    return this.milvus.flushAllSync();
  }

  // Insert a memory (returns memory_id)
  async writeMemory({
    text,
    authorUserId,
    subjectUserId,
    groupId,
    isGlobal = false,
    category,
    embedding
  }: {
    text: string;
    authorUserId?: string;
    subjectUserId?: string;
    groupId?: string;
    isGlobal?: boolean;
    category?: string;
    embedding?: number[];
  }) {
    embedding = embedding ?? await this.getEmbedding(text);
    const memoryId = uuidv4();
    const createdAt = new Date().toISOString();

    await this.milvus.insert({
      collection_name: this.milvusCollectionName,
      fields_data: [{
        memory_id: memoryId,
        text,
        embedding,
        author_user_id: authorUserId ?? '',
        subject_user_id: subjectUserId ?? '',
        group_id: groupId ?? '',
        is_global: !!isGlobal,
        category: category ?? '',
        created_at: createdAt
      }]
    });

    await this.milvus.flush({ collection_names: [this.milvusCollectionName] });
    return { id: memoryId, createdAt };
  }

  // Delete memory by id
  async deleteMemory(memoryId: string) {
    await this.milvus.deleteEntities({
      collection_name: this.milvusCollectionName,
      expr: `memory_id == "${memoryId}"`
    });
    await this.milvus.flush({ collection_names: [this.milvusCollectionName] });
    return { deleted: memoryId };
  }

  // Update memory: simple pattern = delete + insert (keeps same id)
  async updateMemory({
    memoryId,
    text,
    authorUserId,
    subjectUserId,
    groupId,
    isGlobal,
    category
  }: {
    memoryId: string;
    text: string;
    authorUserId?: string;
    subjectUserId?: string;
    groupId?: string;
    isGlobal?: boolean;
    category?: string;
  }) {
    // delete existing entity
    await this.milvus.deleteEntities({
      collection_name: this.milvusCollectionName,
      expr: `memory_id == "${memoryId}"`
    });

    const embedding = await this.getEmbedding(text);
    const createdAt = new Date().toISOString();

    await this.milvus.insert({
      collection_name: this.milvusCollectionName,
      fields_data: [{
        memory_id: memoryId,
        text,
        embedding,
        author_user_id: authorUserId ?? '',
        subject_user_id: subjectUserId ?? '',
        group_id: groupId ?? '',
        is_global: !!isGlobal,
        category: category ?? '',
        created_at: createdAt
      }]
    });

    await this.milvus.flush({ collection_names: [this.milvusCollectionName] });
    return { id: memoryId };
  }

  // Search by text (compute embedding then search). expr is optional Milvus filter expression.
  async queryMemory({
    queryText,
    topK = 5,
    expr,
    embedding
  }: {
    queryText: string;
    topK?: number;
    expr?: string;
    embedding?: number[];
  }) {
    embedding = embedding ?? await this.getEmbedding(queryText);

    const searchRes = await this.milvus.search({
      collection_name: this.milvusCollectionName,
      vector: embedding,
      topk: topK,
      params: { anns_field: 'embedding', params: JSON.stringify({ ef: 512 }) },
      expr: expr || undefined,
      output_fields: ['memory_id', 'text', 'author_user_id', 'subject_user_id', 'group_id', 'is_global', 'category', 'created_at']
    });

    // Normalize results: SDK shapes vary; handle common shapes
    // const results: any[] = [];
    // if (Array.isArray(searchRes.results)) {
    //   for (const r of searchRes.results) {
    //     // r may contain entity or id/score arrays depending on SDK
    //     if (r.entity) {
    //       results.push({
    //         id: r.entity.memory_id,
    //         text: r.entity.text,
    //         authorUserId: r.entity.author_user_id,
    //         subjectUserId: r.entity.subject_user_id,
    //         groupId: r.entity.group_id,
    //         isGlobal: r.entity.is_global,
    //         category: r.entity.category,
    //         createdAt: r.entity.created_at,
    //         score: r.score ?? null
    //       });
    //     } else if (r.id) {
    //       results.push({ id: r.id, score: r.score ?? null });
    //     }
    //   }
    // } else if (Array.isArray(searchRes)) {
    //   for (const r of searchRes) {
    //     if (r.memory_id) results.push(r);
    //   }
    // }

    // return results;
    return searchRes.results
  }

  // Fetch a single memory by id (null if it doesn't exist)
  async getMemoryById(memoryId: string) {
    const q = await this.milvus.query({
      collection_name: this.milvusCollectionName,
      expr: `memory_id == "${memoryId}"`,
      output_fields: ['memory_id', 'text', 'author_user_id', 'subject_user_id', 'group_id', 'is_global', 'category', 'created_at']
    });
    return q.data.length > 0 ? q.data[0] : null;
  }

  // Optional: query by user id (subject or author)
  async queryByUserId({ userId, queryText, topK = 10, includeGlobal = true }: { userId: string; queryText?: string; topK?: number; includeGlobal?: boolean; }) {
    if (!userId) return { error: 'userId required' };
    const exprParts = [`(subject_user_id == "${userId}" || author_user_id == "${userId}")`];
    if (!includeGlobal) exprParts.push('is_global == false');
    const expr = exprParts.join(' && ');

    if (queryText && queryText.trim().length > 0) {
      return await this.queryMemory({ queryText, topK, expr });
    } else {
      // Milvus query by expr only: use milvus.query (SDK method) to fetch entities matching expr
      const q = await this.milvus.query({ collection_name: this.milvusCollectionName, expr, output_fields: ['memory_id', 'text', 'author_user_id', 'subject_user_id', 'group_id', 'is_global', 'category', 'created_at'] });
      return q;
    }
  }

  async getCoreMemories({ topK = 20, includeGlobal = true }: { topK?: number; includeGlobal?: boolean; }) {
    const exprParts = [`(category == "core")`];
    if (!includeGlobal) exprParts.push('is_global == false');
    const expr = exprParts.join(' && ');
    // Milvus query by expr only: use milvus.query (SDK method) to fetch entities matching expr
    const q = await this.milvus.query({ collection_name: this.milvusCollectionName, expr, output_fields: ['memory_id', 'text', 'author_user_id', 'subject_user_id', 'group_id', 'is_global', 'category', 'created_at'] });
    return q;
  }

  /**
   * Wrapper used by the ExtendedDynamicStructuredTool "memory_write".
   * Always inserts the new memory, then lists the closest existing memories so the AI can decide
   * whether any of them should be updated or deleted.
   */
  async memoryWrite(args: {
    text: string;
    authorUserId?: string;
    subjectUserId?: string;
    groupId?: string;
    isGlobal?: boolean;
    category?: string;
  }) {
    const { text, authorUserId, subjectUserId, groupId, isGlobal = false, category } = args;

    if (!text || text.trim().length === 0) {
      throw Error('text is required to write memory.');
    }

    // Search before inserting so the new memory can't show up as its own neighbour.
    const embedding = await this.getEmbedding(text);
    const similar = ((await this.queryMemory({ queryText: text, topK: SIMILAR_MEMORY_TOP_K, embedding })) || [])
      .filter((m: any) => m.score <= SIMILAR_MEMORY_MAX_DISTANCE); // Index uses L2, lower score = more similar
    const newRow = await this.writeMemory({ text, authorUserId, subjectUserId, groupId, isGlobal, category, embedding });

    if (similar.length === 0) {
      return `Saved memory ${newRow.id}`;
    }
    return `Saved memory ${newRow.id}\nOther similar memories to consider updating/deleting:\n` +
      similar.map((m: any) => `- [${m.memory_id}] (${m.created_at}${m.category ? `, ${m.category}` : ''}) ${m.text}`).join('\n');
  }

  /**
   * Wrapper used by the ExtendedDynamicStructuredTool "memory_update".
   * Replaces the text of an existing memory while keeping its other fields.
   */
  async memoryUpdate(memoryId: string, text: string) {
    const existing = await this.getMemoryById(memoryId);
    if (!existing) {
      throw Error(`Memory ${memoryId} not found.`);
    }
    await this.updateMemory({
      memoryId,
      text,
      authorUserId: existing.author_user_id,
      subjectUserId: existing.subject_user_id,
      groupId: existing.group_id,
      isGlobal: existing.is_global,
      category: existing.category
    });
    return `Updated memory ${memoryId}`;
  }

  /**
   * Wrapper used by the ExtendedDynamicStructuredTool "memory_query".
   * Accepts queryText (or embedding in future) and returns an array of memory objects.
   */
  async memoryQuery(args: {
    queryText?: string;
    groupId?: string;
    subjectUserId?: string;
    includeGlobal?: boolean;
    topK?: number;
  }) {
    const { queryText, groupId, subjectUserId, includeGlobal = true, topK = 5 } = args;

    if (!queryText || queryText.trim().length === 0) {
      return { error: 'queryText is required.' };
    }

    try {
      const rows = await this.queryMemory({
        queryText,
        topK,
        expr: undefined // queryMemory builds expr from args; if you prefer, adapt queryMemory signature
      });

      // If queryMemory already returns normalized objects, return them directly.
      // Otherwise normalize here to a compact shape.
      return Array.isArray(rows) ? rows : [];
    } catch (err: any) {
      console.error('memoryQuery error', err);
      return { error: err?.message ?? String(err) };
    }
  }

  /**
   * Wrapper used by the ExtendedDynamicStructuredTool "memory_query_by_user".
   * Calls the Milvus-backed queryByUserId and returns results (JSON).
   */
  async memoryQueryByUserId(args: {
    userId: string;
    queryText?: string;
    topK?: number;
    includeGlobal?: boolean;
  }) {
    const { userId, queryText, topK = 10, includeGlobal = true } = args;

    if (!userId || userId.trim().length === 0) {
      return { error: 'userId is required' };
    }

    try {
      const res = await this.queryByUserId({ userId, queryText, topK, includeGlobal });
      return res as QueryResults;
    } catch (err: any) {
      console.error('memoryQueryByUserId error', err);
      return { error: err?.message ?? String(err) };
    }
  }

}
