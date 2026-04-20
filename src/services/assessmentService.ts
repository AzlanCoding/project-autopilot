// Originally Written by Bing Chat, Modified by AzlanCoding 
import { Sequelize, ModelStatic, InferCreationAttributes, InferAttributes } from 'sequelize';
import { Assessment } from '../models/Assessment';
import { formatDateTime, getTime } from '../utils/common';
import type Store from './store';
import { type Logger } from 'pino';
import moment from 'moment-timezone';
import { Cron } from "croner";

type AssessmentCreateInput = Omit<InferCreationAttributes<Assessment>, 'id'>;
type AssessmentAttributes = InferAttributes<Assessment>;

export class AssessmentService {
  private store: Store;
  private db: Sequelize;
  private logger: Logger;
  private Model: ModelStatic<Assessment>;
  private job_mappings: { [index: number]: Cron[] } = {};

  constructor(store: Store, logger: Logger) {
    this.store = store
    this.db = this.store.db;
    this.logger = logger;
    this.Model = this.db.models.AssessmentStore as ModelStatic<Assessment>;
  }

  private generateAssessmentJobs(assessment: Assessment) {
    if (this.job_mappings[assessment.id]) {
      this.cancelAssessmentJobs(assessment.id)
    }

    const generateJob = (coming_in: string) => {
      return () => {
        (async () => {
          this.logger.info(`Assignment Reminder Message Job executing`);
          await this.store.ai_scheduled_task_runner!(async () => `Please send a reminder to the "${assessment.subject}" group chat to remind students that the assessment "${assessment.title}" is in ${coming_in}. It will be held on ${formatDateTime(Number(assessment.date))}. Include the following assessment description below.\n\n Assessment Description:\n${assessment.description}\n\nYou might need to get the group chat id by using the list_groups tool. Using the group chat ID you will be able to send the message to that group chat ID.`)
          this.logger.info(`Assignment Reminder Message Job Finished executed`);
        })().catch(error => {
          this.logger.error(error, 'Error executing Assignment Reminder Message Job');
        })
      }
    };

    this.job_mappings[assessment.id] = [
      new Cron(new Date(Number(assessment.date)).toISOString(), () => this.destroy(assessment.id)),
      ...([
        moment(Number(assessment.date)).add(-3, 'weeks') > moment() ? new Cron(moment(Number(assessment.date)).add(-3, 'weeks').toDate().toISOString(), generateJob("3 weeks")) : null,
        moment(Number(assessment.date)).add(-2, 'weeks') > moment() ? new Cron(moment(Number(assessment.date)).add(-2, 'weeks').toDate().toISOString(), generateJob("2 weeks")) : null,
        moment(Number(assessment.date)).add(-1, 'week') > moment() ? new Cron(moment(Number(assessment.date)).add(-1, 'week').toDate().toISOString(), generateJob("1 week")) : null,
        moment(Number(assessment.date)).add(-3, 'days') > moment() ? new Cron(moment(Number(assessment.date)).add(-3, 'days').toDate().toISOString(), generateJob("3 days")) : null,
        moment(Number(assessment.date)).add(-2, 'days') > moment() ? new Cron(moment(Number(assessment.date)).add(-2, 'days').toDate().toISOString(), generateJob("2 days")) : null,
        moment(Number(assessment.date)).add(-1, 'day') > moment() ? new Cron(moment(Number(assessment.date)).add(-1, 'day').toDate().toISOString(), generateJob("1 day (tomorrow)")) : null,
        moment(Number(assessment.date)).add(-12, 'hours') > moment() ? new Cron(moment(Number(assessment.date)).add(-12, 'hours').toDate().toISOString(), generateJob("12 Hours")) : null,
        moment(Number(assessment.date)).add(-3, 'hours') > moment() ? new Cron(moment(Number(assessment.date)).add(-3, 'hours').toDate().toISOString(), generateJob("3 Hours")) : null
      ].filter(j => j != null)),
    ];
  }

  private cancelAssessmentJobs(assessment_id: number) {
    if (this.job_mappings[assessment_id]) {
      this.job_mappings[assessment_id].forEach(job => {
        job.stop();
      });
      delete this.job_mappings[assessment_id];
    }
  }

  async initService() {
    const now = getTime();
    const assessments = await this.findAll();
    await Promise.all(assessments.map(async (assessment) => {
      if (now < Number(assessment.date)) {
        this.generateAssessmentJobs(assessment);
      }
      else {
        await this.destroy(assessment.id);
      }
    }));
  }

  async create(data: AssessmentCreateInput): Promise<Assessment> {
    if (data.date < getTime()) {
      throw Error("Date cannot be in the past");
    }
    const new_assessment = await this.Model.create(data);
    this.generateAssessmentJobs(new_assessment);
    return new_assessment
  }

  async findById(id: number): Promise<Assessment | null> {
    return this.Model.findByPk(id);
  }

  async findAll(): Promise<Assessment[]> {
    return this.Model.findAll();
  }

  async update(id: number, updates: Partial<AssessmentAttributes>): Promise<Assessment | null> {
    if (updates.date && updates.date < getTime()) {
      throw Error("Date cannot be in the past");
    }
    const inst = await this.findById(id);
    if (!inst) return null;
    const new_assessment = await inst.update(updates, { where: { id } });

    if (updates.date) {
      this.cancelAssessmentJobs(id);
      this.generateAssessmentJobs(new_assessment);
    }

    return new_assessment;
  }

  async destroy(id: number): Promise<void> {
    await this.Model.destroy({ where: { id } });
    this.cancelAssessmentJobs(id);
  }
}
