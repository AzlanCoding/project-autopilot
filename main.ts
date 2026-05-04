import AI from './src/services/ai';
import Store from './src/services/store';
import 'dotenv/config'
import { SofiaBot } from './src/services/botService';
import { createLogger } from './src/config/logger';
import readline from 'readline';
import getCalendarEvents from './src/utils/getCalendarEvents';
import { Cron } from "croner";


const main = async () => {

  const logger = createLogger();
  const db = new Store(logger);

  // Ensure this works.
  await getCalendarEvents(true);

  await db.init();
  await db.ensureMilvusCollection();

  process.on('SIGINT', async () => {
    await Promise.all([db.unloadMilvus()]);
    process.exit(0);
  });

  const ai = new AI(db, logger);

  // // Set up job to send daily message
  // // '0 0 7 * * 1-5' means: At 07:00:00 on Monday through Friday
  // new Cron('0 0 7 * * 1-5', function () {
  //   (async () => {
  //     logger.info(`Daily Message Job executing`);
  //     const data = await ai.timetableTool.func({});
  //     if (data == "No events found for the specified date.") {
  //       logger.info(`Daily Message Job Cancelled due to no events`);
  //       return;
  //     }
  //     await db.ai_scheduled_task_runner!(
  //       async () => `Please use send your daily 7am morning message with today's timetable "${data}" to the "IT2504 PEM & PCS" group chat. You might need to get the group chat id by using the list_groups tool. Using the group chat ID you will be able to send the message to that group chat ID. Do not end your message with any questions to the class. If it esist, remove the classes that is only for Azlan (e.g, the green screen and visual effects class).`
  //     );

  //     logger.info(`Daily Message Job Finished executed`);
  //   })().catch(error => {
  //     logger.error(error, 'Error executing daily message scheduled job');
  //   })
  // });


  const bot = new SofiaBot(logger, ai, db);
  await bot.connect();

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

main().catch(console.error);