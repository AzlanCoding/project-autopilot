import fs from 'fs';
import readline from 'readline';
import { google } from 'googleapis';
import moment from 'moment-timezone';
import 'dotenv/config'
// Optionally, if you want to automatically open the URL using the default browser:
// import open from 'open';

if (!process.env.GOOGLE_CAL_ID) {
  throw Error(`Environment variable 'GOOGLE_CAL_ID' is not defined`)
}

let IGNORED_MODULES = new Array();
if (process.env.IGNORED_MODULES) {
  IGNORED_MODULES = process.env.IGNORED_MODULES.split(',')
}

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];
const TOKEN_PATH = './assets/token.json';
const CLIENT_SECRET_PATH = './assets/client_secret.json';

export default async function getCalendarEvents(parseForBot?: boolean, date?: string): Promise<string | undefined> {
  // Load client secrets from a local file.
  const content = fs.readFileSync(CLIENT_SECRET_PATH, { encoding: 'utf8' });
  const credentials = JSON.parse(content);
  const { client_secret, client_id, redirect_uris } = credentials.installed;

  // Create an OAuth2 client with the given credentials.
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  // Check if we have previously stored a token.
  if (fs.existsSync(TOKEN_PATH)) {
    const token = fs.readFileSync(TOKEN_PATH, { encoding: 'utf8' });
    oAuth2Client.setCredentials(JSON.parse(token));
  } else {
    await getAccessToken(oAuth2Client);
  }

  // Create Calendar API service.
  const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });

  // // Set the start and end time in UTC for the day in Asia/Singapore.
  // // const start = moment("2025-05-12T16:00:00.000Z").tz('Asia/Singapore').startOf('day').utc().toISOString();
  // // const end = moment("2025-05-12T16:00:00.000Z").tz('Asia/Singapore').endOf('day').utc().toISOString();
  // const start = moment.tz('Asia/Singapore').startOf('day').utc().toISOString();
  // const end = moment.tz('Asia/Singapore').endOf('day').utc().toISOString();

  let start, end;
  if (date) {
    if (!moment(date, "DD/MM/YYYY").isValid()) {
      throw Error("Invalid date. Please give a date in the format DD/MM/YYYY")
    }
    start = moment(date, "DD/MM/YYYY").tz('Asia/Singapore').startOf('day').utc().toISOString();
    end = moment(date, "DD/MM/YYYY").tz('Asia/Singapore').endOf('day').utc().toISOString();
  }
  else {
    start = moment.tz('Asia/Singapore').startOf('day').utc().toISOString();
    end = moment.tz('Asia/Singapore').endOf('day').utc().toISOString();
  }


  console.log('Getting the upcoming events...');
  try {
    const res = await calendar.events.list({
      calendarId: process.env.GOOGLE_CAL_ID,
      timeMin: start,
      timeMax: end,
      maxResults: 50,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = res.data.items;
    if (!events || events.length === 0) {
      console.log('No upcoming events found!');
      return undefined;
    }

    const output_elearn: string[] = [];
    const output_lesson: string[] = [];

    for (const event of events) {
      const module = event.description?.split(' ')[0]
      if (!IGNORED_MODULES.includes(module) && event.start?.dateTime && event.end?.dateTime && event.summary) {
        const evt_start = moment(event.start.dateTime).format('HH:mm');
        const evt_end = moment(event.end.dateTime).format('HH:mm');
        const description = event.description
          ? event.description.replace(/\n/g, parseForBot ? '\n> ' : '\n   ')
          : '';
        const location = event.location || '';

        if (parseForBot) {
          if (event.summary.startsWith('(ELEARN)')) {
            output_elearn.push(
              `*${event.summary}:*\n> ${description}\n> ${location}`
            );
          } else {
            output_lesson.push(
              `*${event.summary}:*\n> ${evt_start} — ${evt_end}\n> ${description}\n> ${location}`
            );
          }
        }
        else {
          if (event.summary.startsWith('(ELEARN)')) {
            output_elearn.push(
              `*• ${event.summary}:*\n   ${description}\n   ${location}`
            );
          } else {
            output_lesson.push(
              `*• ${event.summary}:*\n   ${evt_start} — ${evt_end}\n   ${description}\n   ${location}`
            );
          }
        }
      }
    }

    return output_lesson.concat(output_elearn).join('\n');
  } catch (err) {
    console.error('An error occurred:', err);
    throw err;
  }
}

function getAccessToken(oAuth2Client: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
    });
    console.log('Authorize this app by visiting this url:', authUrl);

    // Optionally, automatically open the URL in the default browser.
    // Uncomment the next line if you want that functionality and have installed "open".
    // open(authUrl);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('Enter the code from that page here: ', (code: string) => {
      rl.close();
      oAuth2Client.getToken(code, (err: any, token: any) => {
        if (err) {
          console.error('Error while trying to retrieve access token', err);
          return reject(err);
        }
        oAuth2Client.setCredentials(token);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
        console.log('Token stored to', TOKEN_PATH);
        resolve();
      });
    });
  });
}

// Execute main and print the output.
if (require.main === module) {
  getCalendarEvents()
    .then(result => {
      if (result) {
        console.log(result);
      }
    })
    .catch(err => {
      console.error(err);
    });
}
