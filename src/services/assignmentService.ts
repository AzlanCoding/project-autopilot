// Originally Written by Bing Chat, Modified by AzlanCoding 
import { Sequelize, ModelStatic, InferCreationAttributes, InferAttributes } from 'sequelize';
import { Assignment } from '../models/Assignment';
import { scheduleJob, cancelJob, Job } from 'node-schedule';
import { formatDateTime, getTime } from '../utils/common';
import type Store from './store';
import { type Logger } from 'pino';
import moment from 'moment-timezone';

type AssignmentCreateInput = Omit<InferCreationAttributes<Assignment>, 'id'>;
type AssignmentAttributes = InferAttributes<Assignment>;

export class AssignmentService {
  private store: Store;
  private db: Sequelize;
  private logger: Logger;
  private Model: ModelStatic<Assignment>;
  private job_mappings: { [index: number]: Job[] } = {};

  constructor(store: Store, logger: Logger) {
    this.store = store;
    this.db = this.store.db;
    this.logger = logger;
    this.Model = this.db.models.AssignmentStore as ModelStatic<Assignment>;
  }

  private generateAssignmentJobs(assignment: Assignment) {
    if (this.job_mappings[assignment.id]) {
      this.cancelAssignmentJobs(assignment.id)
    }

    const generateJob = (coming_in: string) => {
      return () => {
        (async () => {
          this.logger.info(`Assessment Reminder Message Job executing`);
          await this.store.ai_scheduled_task_runner!(async () => `Please send a reminder to the "${assignment.subject}" group chat to remind students that the assignment "${assignment.title}" is due in ${coming_in}. It will be due on ${formatDateTime(assignment.dueDate)}. Include the following assignment description below.\n\n Assignment Description:\n${assignment.description}\n\nYou might need to get the group chat id by using the list_groups tool. Using the group chat ID you will be able to send the message to that group chat ID.`)
          this.logger.info(`Assessment Reminder Message Job Finished executed`);
        })().catch(error => {
          this.logger.error(error, 'Error executing Assessment Reminder Message Job');
        })
      }
    };

    this.job_mappings[assignment.id] = [
      scheduleJob(new Date(assignment.dueDate), () => this.destroy(assignment.id)),
      ...([
        moment(assignment.dueDate).add(-3, 'weeks') > moment() ? scheduleJob(moment(assignment.dueDate).add(-3, 'weeks').toDate(), generateJob("3 weeks")) : null,
        moment(assignment.dueDate).add(-2, 'weeks') > moment() ? scheduleJob(moment(assignment.dueDate).add(-2, 'weeks').toDate(), generateJob("2 weeks")) : null,
        moment(assignment.dueDate).add(-1, 'week') > moment() ? scheduleJob(moment(assignment.dueDate).add(-1, 'week').toDate(), generateJob("1 week")) : null,
        moment(assignment.dueDate).add(-3, 'days') > moment() ? scheduleJob(moment(assignment.dueDate).add(-3, 'days').toDate(), generateJob("3 days")) : null,
        moment(assignment.dueDate).add(-2, 'days') > moment() ? scheduleJob(moment(assignment.dueDate).add(-2, 'days').toDate(), generateJob("2 days")) : null,
        moment(assignment.dueDate).add(-1, 'day') > moment() ? scheduleJob(moment(assignment.dueDate).add(-1, 'day').toDate(), generateJob("1 day (tomorrow)")) : null,
        moment(assignment.dueDate).add(-12, 'hours') > moment() ? scheduleJob(moment(assignment.dueDate).add(-12, 'hours').toDate(), generateJob("12 Hours")) : null,
        moment(assignment.dueDate).add(-3, 'hours') > moment() ? scheduleJob(moment(assignment.dueDate).add(-3, 'hours').toDate(), generateJob("3 Hours")) : null
      ].filter(j => j != null)),
    ];
  }

  private cancelAssignmentJobs(assignment_id: number) {
    if (this.job_mappings[assignment_id]) {
      this.job_mappings[assignment_id].forEach(job => {
        cancelJob(job)
      });
      delete this.job_mappings[assignment_id];
    }
  }

  async initService() {
    const now = getTime();
    const assignments = await this.findAll();
    await Promise.all([assignments.map(async (assignment) => {
      if (now < assignment.dueDate) {
        this.generateAssignmentJobs(assignment)
      }
      else {
        await this.destroy(assignment.id);
      }
    })]);
  }

  async create(data: AssignmentCreateInput): Promise<Assignment> {
    if (data.dueDate < getTime()) {
      throw Error("Due Date cannot be in the past");
    }
    const new_assignment = await this.Model.create(data);
    this.generateAssignmentJobs(new_assignment);
    return new_assignment;
  }

  async findById(id: number): Promise<Assignment | null> {
    return this.Model.findByPk(id);
  }

  async findAll(): Promise<Assignment[]> {
    return this.Model.findAll();
  }

  async update(id: number, updates: Partial<AssignmentAttributes>): Promise<Assignment | null> {
    if (updates.dueDate && updates.dueDate < getTime()) {
      throw Error("Due Date cannot be in the past");
    }
    const inst = await this.findById(id);
    if (!inst) return null;
    const new_assignment = await inst.update(updates);

    if (updates.dueDate) {
      this.cancelAssignmentJobs(new_assignment.id);
      this.generateAssignmentJobs(new_assignment);
    }

    return new_assignment;
  }

  async destroy(id: number): Promise<void> {
    await this.Model.destroy({ where: { id: id } });
    this.cancelAssignmentJobs(id);
  }
}
