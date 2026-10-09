import { Sequelize, ModelStatic, InferCreationAttributes, InferAttributes } from 'sequelize';
import { ScheduledTask } from '../models/ScheduledTask';
import { formatDateTime, getTime } from '../utils/common';
import type Store from './store';
import { type Logger } from 'pino';
import { Cron } from "croner";

export const SCHEDULE_TIMEZONE = 'Asia/Singapore';

type ScheduledTaskCreateInput = Omit<InferCreationAttributes<ScheduledTask>, 'id' | 'createdAt' | 'lastRunAt'>;
type ScheduledTaskAttributes = InferAttributes<ScheduledTask>;

export class ScheduledTaskService {
  private store: Store;
  private db: Sequelize;
  private logger: Logger;
  private Model: ModelStatic<ScheduledTask>;
  private jobs: { [index: string]: Cron } = {};

  constructor(store: Store, logger: Logger) {
    this.store = store;
    this.db = this.store.db;
    this.logger = logger;
    this.Model = this.db.models.ScheduledTaskStore as ModelStatic<ScheduledTask>;
  }

  /**
   * Throws if the task's timing is invalid. Croner throws on bad patterns, so construct a paused job to validate.
   */
  private validate(data: Pick<ScheduledTaskAttributes, 'recurring' | 'runAt' | 'cronPattern'>) {
    if (data.recurring) {
      if (!data.cronPattern) {
        throw Error("cronPattern is required for recurring tasks.");
      }
      try {
        new Cron(data.cronPattern, { paused: true, timezone: SCHEDULE_TIMEZONE }).stop();
      }
      catch (e: any) {
        throw Error(`Invalid cronPattern "${data.cronPattern}": ${e?.message ?? e}`);
      }
    }
    else {
      if (data.runAt == null || isNaN(Number(data.runAt))) {
        throw Error("runAt is required for one-time tasks.");
      }
      if (Number(data.runAt) <= getTime()) {
        throw Error("runAt cannot be in the past.");
      }
    }
  }

  private cancelJob(id: string) {
    if (this.jobs[id]) {
      this.jobs[id].stop();
      delete this.jobs[id];
    }
  }

  private scheduleJob(task: ScheduledTask, runAtOverride?: number) {
    this.cancelJob(task.id);
    const callback = () => {
      this.runTask(task.id).catch(error => {
        this.logger.error(error, `Error executing scheduled task ${task.id}`);
      });
    };
    this.jobs[task.id] = task.recurring
      ? new Cron(task.cronPattern!, { timezone: SCHEDULE_TIMEZONE, protect: true }, callback)
      : new Cron(new Date(runAtOverride ?? Number(task.runAt)), { protect: true }, callback);
  }

  /**
   * Builds the instruction sent to the AI when a task fires.
   */
  buildTaskPrompt(task: ScheduledTask): string {
    // The chat the task relates to and its history are added by ai_scheduled_task_runner
    return `This is a task you scheduled for yourself on ${formatDateTime(Number(task.createdAt))}.\n` +
      `Task ID: ${task.id} (${task.recurring ? `recurring, cron "${task.cronPattern}"` : 'one-time'})\n` +
      (task.lastRunAt ? `Last ran: ${formatDateTime(Number(task.lastRunAt))}\n` : '') +
      `Task: ${task.task}\n\n` +
      `Do the task now. Only send a message if the task calls for it.` +
      (task.recurring ? ` If the task is done or no longer needed, cancel it with the cancel_scheduled_task tool.` : '');
  }

  async runTask(id: string) {
    const task = await this.findById(id);
    if (!task) {
      this.cancelJob(id);
      return;
    }
    this.logger.info(`Scheduled task ${id} executing`);
    const prompt = this.buildTaskPrompt(task);
    if (task.recurring) {
      await task.update({ lastRunAt: getTime() });
    }
    else {
      // One-time tasks are removed before running so a crash mid-run doesn't make them repeat forever.
      await this.destroy(id);
    }
    await this.store.ai_scheduled_task_runner!(async () => prompt, undefined, { requireMessage: false, contextChatId: task.contextChatId });
    this.logger.info(`Scheduled task ${id} finished executing`);
  }

  /**
   * Schedules all saved tasks. Call after the AI and bot are set up since tasks use `ai_scheduled_task_runner`.
   * @param missedTaskDelayMs One-time tasks missed while offline run after this delay (gives WhatsApp time to connect).
   */
  async initService(missedTaskDelayMs: number = 60 * 1000) {
    const now = getTime();
    const tasks = await this.findAll();
    for (const task of tasks) {
      if (!task.recurring && Number(task.runAt) <= now) {
        this.logger.info(`Scheduled task ${task.id} was missed, running in ${missedTaskDelayMs}ms`);
        this.scheduleJob(task, now + missedTaskDelayMs);
      }
      else {
        this.scheduleJob(task);
      }
    }
  }

  nextRun(id: string): Date | null {
    return this.jobs[id]?.nextRun() ?? null;
  }

  async create(data: ScheduledTaskCreateInput): Promise<ScheduledTask> {
    this.validate(data);
    const task = await this.Model.create({ ...data, createdAt: getTime() });
    this.scheduleJob(task);
    return task;
  }

  async findById(id: string): Promise<ScheduledTask | null> {
    return this.Model.findByPk(id);
  }

  async findAll(): Promise<ScheduledTask[]> {
    return this.Model.findAll();
  }

  async update(id: string, updates: Partial<Pick<ScheduledTaskAttributes, 'task' | 'recurring' | 'runAt' | 'cronPattern'>>): Promise<ScheduledTask | null> {
    const inst = await this.findById(id);
    if (!inst) return null;
    const merged = {
      recurring: updates.recurring ?? inst.recurring,
      runAt: updates.runAt !== undefined ? updates.runAt : inst.runAt,
      cronPattern: updates.cronPattern !== undefined ? updates.cronPattern : inst.cronPattern,
    };
    this.validate(merged);
    const updated = await inst.update({ ...updates, ...merged });
    this.scheduleJob(updated);
    return updated;
  }

  async destroy(id: string): Promise<void> {
    await this.Model.destroy({ where: { id } });
    this.cancelJob(id);
  }
}
