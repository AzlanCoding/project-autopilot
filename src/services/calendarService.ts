import { Logger } from 'pino';
import readline from 'readline';
import { google } from 'googleapis';
import moment from 'moment-timezone';
import * as fs from 'fs';

const CLIENT_SECRET_PATH = './assets/client_secret.json';
const TOKEN_PATH = './assets/token.json';


/**
 * Service responsible for interacting with Google Calendar API.
 * Handles fetching, processing, and formatting calendar events into a clean summary.
 */
export class CalendarService {
    private logger: Logger;
    private calendarClient: any; // This will hold the initialized google.calendar v3 service

    /**
     * Initializes the service by performing OAuth authentication if necessary.
     * @param logger Pino logger instance.
     * @param credentialsClient The initialized OAuth2Client or a pre-configured calendar service object.
     */
    constructor(logger: Logger) {
        this.logger = logger;

    }

    async init() {
        let oAuth2Client: any;
        // --- Fallback/Initial Setup (Should ideally be done in a separate setup method) ---
        this.logger.warn("No client provided. Attempting to load credentials from file.");
        try {
            const content = fs.readFileSync(CLIENT_SECRET_PATH, { encoding: 'utf8' });
            const credentials = JSON.parse(content);
            const { client_secret, client_id, redirect_uris } = credentials.installed;

            oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

            // Check for token and authenticate if needed (This synchronous part mimics the required flow)
            if (fs.existsSync(TOKEN_PATH)) {
                const token = fs.readFileSync(TOKEN_PATH, { encoding: 'utf8' });
                oAuth2Client.setCredentials(JSON.parse(token));
            } else {
                // this.logger.error("Token not found. Must run manual OAuth flow first.");
                // // In a production setup, you might halt initialization or throw an error here.
                await this.getAccessToken(oAuth2Client);
            }
        } catch (e) {
            this.logger.error(e, "Failed to load credentials or initialize OAuth client.");
            throw new Error("Calendar Service initialization failed due to missing credentials.");
        }

        // Create Calendar API service object using the authenticated client
        this.calendarClient = google.calendar({ version: 'v3', auth: oAuth2Client });
    }

    /**
     * Fetches upcoming events for the specified time range and returns a plain text summary array.
     * @param calendarId The ID of the calendar to check (e.g., primary or a specific ID).
     * @param start The start date/time.
     * @param end The end date/time.
     * @returns A promise that resolves to an array of plain text event summaries, or an empty array if none found/error.
     */
    async getUpcomingEvents(calendarId: string, start: Date, end: Date): Promise<string[]> {
        this.logger.info(`Fetching events for Calendar ID: ${calendarId} from ${moment(start).tz('Asia/Singapore').startOf('day').utc().toISOString()} to ${moment(end).tz('Asia/Singapore').endOf('day').utc().toISOString()}`);

        try {
            const res = await this.calendarClient.events.list({
                calendarId: calendarId,
                timeMin: moment(start).utc().toISOString(),
                timeMax: moment(end).utc().toISOString(),
                maxResults: 50,
                singleEvents: true,
                orderBy: 'startTime',
            });

            const events = res.data.items;
            if (!events || events.length === 0) {
                this.logger.info('No upcoming events found!');
                return [];
            }

            const plainTextSummaries: string[] = [];

            for (const event of events) {
                // Basic structure validation
                if (!event.start || !event.end || !event.summary) continue;

                const evt_start = moment(event.start.dateTime || event.start.date).format('HH:mm');
                const evt_end = moment(event.end.dateTime || event.end.date).format('HH:mm');
                const description = event.description || '';
                const location = event.location || '';

                // Plain text summary format (removing all formatting)
                const formattedSummary = `[${event.summary}] Time: ${evt_start} — ${evt_end}. Location: ${location}. Details: ${description}`;
                plainTextSummaries.push(formattedSummary);
            }

            return plainTextSummaries;
        } catch (err) {
            this.logger.error(err, 'Error fetching calendar events:');
            // Rethrowing a standardized error structure might be better in production, 
            // but returning an empty array fulfills the "return an array" contract.
            throw new Error(`Failed to retrieve calendar events: ${err instanceof Error ? err.message : String(err)}`);
        }
    }


    private getAccessToken(oAuth2Client: any): Promise<void> {
        return new Promise((resolve, reject) => {
            const authUrl = oAuth2Client.generateAuthUrl({
                access_type: 'offline',
                scope: ['https://www.googleapis.com/auth/calendar.readonly'],
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
}