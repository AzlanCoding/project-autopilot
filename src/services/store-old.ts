// import { Attributes, DataTypes, Model, ModelAttributes, Op, Sequelize } from 'sequelize'
// import { convertHoursToReadableTime, genSnowId, parseTimestamp } from '../utils/common';
// // import { setBigTimeout } from "../../node_modules/setbigtimeout/esm/mod";// Dumb fix but it works
// // import { setBigTimeout } from "setbigtimeout";
// import { makeWASocket, WAMessage } from 'baileys';
// import fs from 'fs';

// type Table = ModelAttributes<Model, Attributes<Model>>

// const TableWithIDCol: Table = {
//   id: {
//     type: DataTypes.BIGINT,
//     allowNull: false,
//     primaryKey: true,
//     unique: true,
//   },
// }

// export const AnnouncementStore: Table = {
//   ...TableWithIDCol,
//   data: {
//     type: DataTypes.TEXT,
//     allowNull: false,
//   },
//   dismissDate: {
//     type: DataTypes.BIGINT,
//     allowNull: true,
//   }
// };

// export const AssignmentStore: Table = {
//   ...TableWithIDCol,
//   subject: {
//     type: DataTypes.STRING,
//     allowNull: false,
//   },
//   title: {
//     type: DataTypes.STRING,
//     allowNull: false,
//   },
//   description: {
//     type: DataTypes.TEXT,
//     allowNull: true,
//   },
//   dueDate: {
//     type: DataTypes.BIGINT,
//     allowNull: true,
//   }
// }

// export const AssessmentStore: Table = {
//   ...TableWithIDCol,
//   subject: {
//     type: DataTypes.STRING,
//     allowNull: false,
//   },
//   title: {
//     type: DataTypes.STRING,
//     allowNull: false,
//   },
//   description: {
//     type: DataTypes.TEXT,
//     allowNull: true,
//   },
//   date: {
//     type: DataTypes.BIGINT,
//     allowNull: true,
//   }
// }


// export const tables: { [index: string]: Table } = { AnnouncementStore, AssignmentStore, AssessmentStore };

// // Reference: https://stackoverflow.com/a/41429145/18573662
// class ItemExpiredError extends Error {
//   constructor(msg: string) {
//     super(msg);
//     Object.setPrototypeOf(this, ItemExpiredError.prototype);
//   }
// }

// interface AppSettings {
//   subjects: { [key: string]: string },
//   reminders: number[]
// }

// const SETTINGS_PATH = './assets/settings.json'

// export default class Store {
//   db: Sequelize;
//   settings: AppSettings;
//   sock: ReturnType<typeof makeWASocket> | undefined;

//   constructor() {
//     if (!process.env.SQL_DATABASE_URL) {
//       throw Error(`Environment variable 'SQL_DATABASE_URL' is not defined`)
//     }
//     if (!fs.existsSync(SETTINGS_PATH)) {
//       throw Error(`\`settings.json\` is missing!`)
//     }
//     this.db = new Sequelize(process.env.SQL_DATABASE_URL);
//     this.settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, { encoding: 'utf8' }))
//   }

//   async init() {
//     await this.db.authenticate();
//     for (let table in tables) {
//       const tbl = this.db.define(table, tables[table]);
//       await tbl.sync({ alter: true })
//     }
//   }

//   async postSockInit() {
//     const assignments = await this.listAssignments();
//     const assessments = await this.listAssesments();
//     for (let i = 0; i < assignments.length; i++) {
//       this.sendReminder('assignment', assignments[i])
//     }
//     for (let i = 0; i < assessments.length; i++) {
//       this.sendReminder('assesment', assessments[i])
//     }
//   }

//   async validateDate(date: Date) {
//     if (new Date() > date) {
//       throw new ItemExpiredError(`${date.toISOString()} has already passed.`);
//     }
//   }

//   async sendMessage(chat: string, message: string) {
//     const replyMsg: WAMessage = {
//       message: {
//         conversation: `This is an automated message.`
//       },
//       key: {
//         id: 'autoCmd' + Math.floor(process.uptime()),
//         remoteJid: `${process.env.WHATSAPP_ANNOUNCE_GRP}@g.us`,
//         fromMe: false,
//         participant: this.sock!.user?.lid,
//       },
//       messageTimestamp: Math.floor((new Date()).getTime() / 1000),
//       pushName: 'IT2504 Bot',
//       broadcast: false,
//     };

//     this.sock!.sendMessage(chat, {
//       text: message + "\n\n```Message sent by IT2504-Bot. send /help for more info.```",
//     }, { quoted: replyMsg })
//   }

//   sendReminder(type: "assignment" | "assesment", item: any) {
//     const now = (new Date()).getTime();
//     const date: number = Number(type == 'assesment' ? item.date : item.dueDate);
//     const reminders: [number, number][] = this.settings.reminders.map((val: number) => ([date - val * 3600000, val] as [number, number])).filter((val2) => val2[0] > now).sort((a, b) => a[0] - b[0])
//     const nextReminder = reminders.length > 0 ? reminders[0] : undefined
//     if (nextReminder) {
//       console.log(`Next reminder for ${item.title} scheduled on ${new Date(nextReminder[0]).toString()}.`);
//       setBigTimeout(() => {
//         const group = this.settings.subjects[item.subject];
//         const msg = `*Reminder:*\nThe ${type} \`${item.title}\` is due in ${convertHoursToReadableTime(nextReminder[1])} on ${parseTimestamp(date)}!${item.description ? "\n*Details:*\n" + item.description : ""}`;
//         this.sendMessage(group, msg).then(() => {
//           this.sendReminder(type, item);
//         });
//       }, nextReminder[0] - now);
//     }
//     else {
//       console.log(`Deletion of ${item.title} scheduled on ${parseTimestamp(date)}.`);
//       setBigTimeout(() => {
//         (type == 'assignment' ? this.db.models.AssignmentStore : this.db.models.AssessmentStore).destroy({
//           where: { id: item.id }
//         }).then(() => {
//           console.log(`Deleted ${type} ${item.title} scheduled on ${parseTimestamp(date)}!`);
//         })
//       }, date - now >= 0 ? date - now : 1);
//     }
//   }

//   async addAnnouncement(announcement: string, dismissDate: Date) {
//     this.validateDate(dismissDate);
//     const announcement_obj = {
//       id: genSnowId(),
//       data: announcement,
//       dismissDate: dismissDate.getTime()
//     }
//     await this.db.models.AnnouncementStore.create(announcement_obj)
//   }

//   async listAnnouncements() {
//     await this.db.models.AnnouncementStore.destroy({
//       where: {
//         dismissDate: {
//           [Op.lte]: (new Date()).getTime(),
//         }
//       }
//     })
//     return await this.db.models.AnnouncementStore.findAll({
//       order: [['dismissDate', 'ASC']]
//     });
//   }

//   async addAssignment(subject: string, title: string, dueDate: Date, description?: string) {
//     this.validateDate(dueDate);
//     const assignment_obj = {
//       id: genSnowId(),
//       subject,
//       title,
//       description,
//       dueDate: dueDate.getTime()
//     }
//     await this.sendMessage(this.settings.subjects[subject], `*Assignment Registered:*\n A new assignment \`${title}\` will be due on ${parseTimestamp(Number(dueDate.getTime()))}. Reminders for this announcement will be automatically sent in this chat.${description ? "\n*Details:*\n" + description : ""}`)
//     await this.db.models.AssignmentStore.create(assignment_obj)
//     this.sendReminder("assignment", assignment_obj)
//   }

//   async addAssesment(subject: string, title: string, date: Date, description?: string) {
//     this.validateDate(date)
//     const assesment_obj = {
//       id: genSnowId(),
//       subject,
//       title,
//       description,
//       date: date.getTime()
//     }
//     await this.sendMessage(this.settings.subjects[subject], `*Test Registered:*\n A new test \`${title}\` will be on ${parseTimestamp(Number(date.getTime()))}. Reminders for this test will be automatically sent in this chat.${description ? "\n*Details:*\n" + description : ""}`)
//     await this.db.models.AssessmentStore.create(assesment_obj)
//     this.sendReminder('assesment', assesment_obj)
//   }

//   async listAssignments() {
//     await this.db.models.AssignmentStore.destroy({
//       where: {
//         dueDate: {
//           [Op.lte]: (new Date()).getTime(),
//         }
//       }
//     })
//     return await this.db.models.AssignmentStore.findAll({
//       order: [['dueDate', 'ASC']]
//     });
//   }

//   async listAssesments() {
//     await this.db.models.AssessmentStore.destroy({
//       where: {
//         date: {
//           [Op.lte]: (new Date()).getTime(),
//         }
//       }
//     })
//     return await this.db.models.AssessmentStore.findAll({
//       order: [['date', 'ASC']]
//     });
//   }
// }