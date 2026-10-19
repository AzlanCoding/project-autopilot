import AI from './src/services/ai';
import Store from './src/services/store';
import 'dotenv/config'
import { SofiaBot } from './src/services/botService';
import { startWebServer } from './src/services/webServer';
import { createLogger } from './src/config/logger';
import readline from 'readline';
import getCalendarEvents from './src/utils/getCalendarEvents';
import { Cron } from "croner";
import moment from 'moment-timezone';
import { describeDateWeek } from './src/utils/common';


const main = async () => {

  console.log(`[${new Date().toISOString()}] Starting Sofia...`);
  const logger = createLogger();
  const db = new Store(logger);

  // Ensure this works.
  await getCalendarEvents(true);

  await db.init();
  await db.ensureMilvusCollection();
  await db.stickers.ensureCollection();
  startWebServer(db, logger);

  process.on('SIGINT', async () => {
    await Promise.all([db.unloadMilvus()]);
    process.exit(0);
  });

  const ai = new AI(db, logger);

  // Set up job to send daily message
  // '0 0 7 * * 1-5' means: At 07:00:00 on Monday through Friday
  new Cron('0 0 7 * * 1-5', function () {
    (async () => {
      logger.info(`Daily Message Job executing`);
      const data = await ai.timetableTool.func({});
      // Worked out here so Sofia doesn't need a tool call for it
      const week = describeDateWeek(moment.tz('Asia/Singapore').format('YYYY-MM-DD'));
      if (data == "No events found for the specified date.") {
        logger.info(`Daily Message Job Cancelled due to no events`);
        return;
      }
      await db.ai_scheduled_task_runner!(
        async () => `Send the daily 7am morning message with today's timetable to the "NYP IT2504 PEM & PCS" group chat (get it from list_groups; never use the folder-only "NYP IT2504" group).
Today's timetable (from get_timetable) is below, already split into one section per specialisation track, each titled with that track's calendar name (e.g. "IT2504 Applied AI & Operations Timetable"). Today's semester and week number are below too, no tool calls are needed for them.
Send the whole thing as 1 message. Do not end with any question to the class.

Structure the message exactly like this:

1. Opening line: greeting + weekday + date + Semester and Week number.
2. Then these three sections, in this order, one for each section of the timetable. Each section lists every class for that track, including the modules the whole class takes (e.g. IT2121 Responsible AI for Sustainability, IT2134 IT Innovation Project, IT-DIT PEM contact time):
*🤖 Applied AI & Operations*
*☁️ DevOps & Automation in the Cloud*
*🔐 Cybersecurity*
3. Under each heading, one bullet per timetable block, in time order, then any (ELEARN) blocks at the end of the section, keeping every detail from the timetable:
- *09:00 - 11:50* · IT2122 Applied Deep Learning · LAB02 · Room L.532
- <Any Additional Info if given>
4. Blocks marked (ELEARN) have no time. Write them like this, and never give them a time:
- IT2121 Responsible AI for Sustainability · LEC01 · e-learning
5. If a section has no blocks today, write exactly:
- No lessons for today
Never say "no on-campus lesson" — there may still be e-learning.
6. Close with one warm encouraging line. Don't mention about e-learning.

Accuracy rule (most important): transcribe EVERY block from the timetable exactly once per section, with its module code, times, section and room. Do not merge sections, paraphrase away or drop any lesson. Before sending, count the blocks in each section of the timetable and the bullets in that section of your message — they must match. Never invent a lesson that is not in the timetable.

Today's semester and week: ${week}

Today's timetable:
${data}`
      );

      logger.info(`Daily Message Job Finished executed`);
    })().catch(error => {
      logger.error(error, 'Error executing daily message scheduled job');
    })
  });


  const bot = new SofiaBot(logger, ai, db);
  await bot.connect();
  await db.scheduledTask.initService();

  // console.log("Starting...");
  // await ai.run();

  // const rl = readline.createInterface({
  //   input: process.stdin,
  //   output: process.stdout,
  // });
  // const eval_cmd = () => {
  //   rl.question('Enter command: ', (code: string) => {
  //     try {
  //       console.dir(eval(code))
  //     }
  //     catch (e) {
  //       console.error(e);
  //     }
  //     finally {
  //       eval_cmd();
  //     }
  //   })
  // }
  // eval_cmd();
}

main().catch(e => {
  // Exit so `restart: unless-stopped` retries, e.g. when Milvus is not ready yet, instead of hanging with open connections.
  console.error(`[${new Date().toISOString()}] Sofia failed to start:`, e);
  process.exit(1);
});