import fs from 'fs';
import readline from 'readline';
import { calendar_v3, google } from 'googleapis';
import moment from 'moment-timezone';
import 'dotenv/config'
// Optionally, if you want to automatically open the URL using the default browser:
// import open from 'open';

if (!process.env.GOOGLE_CAL_ID) {
  throw Error(`Environment variable 'GOOGLE_CAL_ID' is not defined`)
}
/** Calendars to read, `GOOGLE_CAL_ID` is a comma separated list (e.g. one per specialisation track), in section order. */
const CALENDAR_IDS = process.env.GOOGLE_CAL_ID.split(',').map(id => id.trim()).filter(Boolean);

let IGNORED_MODULES = new Array();
if (process.env.IGNORED_MODULES) {
  IGNORED_MODULES = process.env.IGNORED_MODULES.split(',')
}

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];
const TOKEN_PATH = './assets/token.json';
const CLIENT_SECRET_PATH = './assets/client_secret.json';

export interface CalendarEvents {
  name: string,
  events: calendar_v3.Schema$Event[],
}

function formatEvent(event: calendar_v3.Schema$Event, parseForBot?: boolean) {
  const evt_start = moment(event.start!.dateTime).tz('Asia/Singapore').format('HH:mm');
  const evt_end = moment(event.end!.dateTime).tz('Asia/Singapore').format('HH:mm');
  const description = event.description
    ? event.description.replace(/\n/g, parseForBot ? '\n> ' : '\n   ')
    : '';
  const location = event.location || '';
  const elearn = !!event.summary?.startsWith('(ELEARN)');
  const text = parseForBot
    ? (elearn ? `*${event.summary}:*\n> ${description}\n> ${location}` : `*${event.summary}:*\n> ${evt_start} — ${evt_end}\n> ${description}\n> ${location}`)
    : (elearn ? `*• ${event.summary}:*\n   ${description}\n   ${location}` : `*• ${event.summary}:*\n   ${evt_start} — ${evt_end}\n   ${description}\n   ${location}`);
  return { text, elearn };
}

/**
 * Formats a day's events. With several calendars, each is its own section titled with the calendar's name, in the order
 * given, listing all of its classes in time order. With a single calendar there are no sections. Returns undefined if
 * there are no events.
 */
export function formatTimetable(calendars: CalendarEvents[], parseForBot?: boolean): string | undefined {
  const sections = calendars.map(calendar => ({
    calendar,
    events: calendar.events
      .filter(event => !IGNORED_MODULES.includes(event.description?.split(' ')[0]) && event.start?.dateTime && event.end?.dateTime && event.summary)
      .sort((a, b) => moment(a.start!.dateTime).valueOf() - moment(b.start!.dateTime).valueOf()),
  }));
  if (sections.every(s => s.events.length == 0)) {
    return undefined;
  }
  const lines = (events: calendar_v3.Schema$Event[]) => events.map(e => formatEvent(e, parseForBot).text).join('\n');
  if (sections.length == 1) {
    return lines(sections[0].events);
  }
  return sections
    .map(s => `*${s.calendar.name}:*\n${s.events.length ? lines(s.events) : '_No lessons for today_'}`)
    .join('\n\n');
}

/** Calendar names by id, they rarely change so they are only looked up once. */
const calendarNames = new Map<string, string>();

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
    const calendars = await Promise.all(CALENDAR_IDS.map(async (calendarId): Promise<CalendarEvents> => {
      if (!calendarNames.has(calendarId)) {
        calendarNames.set(calendarId, (await calendar.calendars.get({ calendarId })).data.summary ?? calendarId);
      }
      const name = calendarNames.get(calendarId)!;
      const res = await calendar.events.list({
        calendarId,
        timeMin: start,
        timeMax: end,
        maxResults: 50,
        singleEvents: true,
        orderBy: 'startTime',
      });
      return { name, events: res.data.items ?? [] };
    }));
    const timetable = formatTimetable(calendars, parseForBot);
    if (!timetable) {
      console.log('No upcoming events found!');
    }
    return timetable;
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
