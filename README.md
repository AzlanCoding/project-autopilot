## Project Autopilot
Project Autopilot is an AI powered class assistant that aims to help make learning easier for students. It aims to help students in from both academic and emotional well-being. It is integrated with WhatsApp through the [Baileys](https://github.com/WhiskeySockets/Baileys) library, a socket-based TS/JavaScript API for WhatsApp Web. The integration of WhatsApp allows students to easily chat with the agent (named Sofia). Sofia is designed to be as human like as possible and is meant to fit into a class of gen-z students aged between 18 to 20 years old. She is a very curious and energetic girl that values friendships. Overall, Sofia is supposed to be like a friend to the class.

## Note
This project is partially vibe-coded but also contains a substantial amount of human-written code. The following models were used:
*   [Locally Running] gpt-oss 20B
*   [Locally Running] Gemma 4 (e4b)
*   [Locally Running] Qwen 2.5 Coder (1.5B) (Autocomplete only)
*   [Remotely Running] Bing Chat (a.k.a Microsoft Copilot)
*   [Remotely Running] ChatGPT
*   Opus 5.5 (I tried claude code pro for a bit)


## Class Context
This project is only meant to be used by 1 class. This class named IT2504 is a class that is studying the Diploma in Information Technology at Nanyang Polytechnic Singapore.


## Features
*   Integrates with a single Google account to get calendar events from Google Calendar API and sends them to the class group chat every school day (weekdays). This “daily” message sends at 7am every school day morning and should give some form of encouragement to the class.
*   Uses tool calling to send messages to other chats while chatting with another person. (e.g, uses tool call when AI is asked to text someone else happy birthday!)
*   Able to reply in a multi-user environment such as group chats.
*   Automatically send messages to remind the class about upcoming assignments and assessment. Automatically send daily message which is 
*   Able to retain a universal memory based on conversations with classmates. Related memory is included in the prompt before any conversation or scheduled task starts.
*   Searches the web and reads web pages (`USE_WEB_TOOLS=true`, off by default), e.g. for news or the weather. On Model Studio these are its built-in `web_search` and `web_extractor` tools, run on Alibaba's side within one request (a news question took 46k-111k input tokens against ~5k for a normal reply). When chatting through DeepSeek they are `web_search` and `web_fetch` tools calling DeepSeek's [Search & Fetch APIs](https://api-docs.deepseek.com/guides/search) ($0.75 per 1,000 requests each).
*   Chats through Alibaba Model Studio by default, or another OpenAI compatible provider with the Responses API by setting `CHAT_BASE_URL`, `CHAT_API_KEY` and `CHAT_MODEL` (e.g. DeepSeek: `https://api.deepseek.com` and `deepseek-flash`, which replied ~2-3x faster than Model Studio's DeepSeek in testing). Embeddings, the group reply decision model and sticker descriptions always use Model Studio.
*   Helps the GDG on Campus NYP club (GDGoC NYP), which Sofia is a member of, with her own Google Workspace account (`sofia@nyp-gdg.com`): reads, writes and reviews Google Docs (including tables and tabs, which she can add, rename and delete), Sheets (tabs, merged cells, formatting, duplicating a tab within a Sheet or into another one) and Slides (text, tables, images, copying branding between slides, duplicating slides within a deck or into another deck), manages files in the club's shared drive (create, copy, move, rename, trash, convert .docx/.xlsx/.pptx to a Google copy), reads and writes comments, shares files and transfers ownership, finds people's emails in the directory, and finds images and GIFs to insert. She decides from a person's user description whether they're a GDGoC member and only changes club files for members. See *Google Workspace (GDGoC)* below to set it up.
*   Makes images with Qwen-Image 3.0 (`generate_image`: illustrations, backgrounds, simple infographics; `edit_image`: change an image with an instruction, from up to 3 images) and Google's Material Symbols icons in any colour (`search_icons`, `material_icon`). Results can be inserted into Slides and Docs, sent on WhatsApp, or saved into Drive (`drive_manage` action `upload`, which also saves files and images people send in the chat). `IMAGE_MODEL` (default `qwen-image-3.0`) and `IMAGE_MODEL_PRO` (`qwen-image-3.0-pro`, for detailed images with text) set the models; an image takes about 40-80 seconds.
*   Creates, reads and edits plain files in Drive (Markdown, HTML, CSV, JSON, code) with `drive_file`, the way coding agents edit code: numbered line windows, exact find-and-replace edits that must match once, and edits refused if the file changed since it was read. `fetch_url` reads the raw text of a public file (e.g. a GitHub README or spec; GitHub page links are read as raw files), up to 20,000 characters at a time.
*   Reads PDFs sent on WhatsApp or stored in Drive (`read_pdf`, page by page) and looks at pages as images (`view_pdf_page`), using poppler.
*   Sends files and images on WhatsApp (`send_file`): Docs, Sheets and Slides as PDF (or docx/xlsx/pptx), a slide or PDF page as an image, Drive files, and images pulled out of PDFs, Docs and Slides (`extract_images`).
*   Knows who is in a group chat: the group's description and every participant with their user description are in her prompt, and `get_group_info` shows any group.
*   Sends WhatsApp polls and reads their votes (who voted for what). See *Baileys doesn't decrypt poll votes* under Known Issues.
*   Sofia will wait for user to finish typing for 3 seconds after a message is received before taking any action. This means that when a message is sent, Sofia should only take action after 3 seconds if no new message was sent or no typing activity was detected. This also attempts to help prevent spam. Note that typing activity detection does not affect this for group chats.


## Future Proposed Features
*   Web console for management.
*   Should maintain an internal collection of stickers and GIFs. Only approved stickers and GIFs can be used. Adding and approving of stickers and GIFs can be done through the web console. Web console should also allow for adding additional description for GIFs and stickers so that searching would be easier.
*   Able to send GIFs and stickers at the end of messages when replying to a student. Where appropriate, sofia should also be only reply with a sticker or gif. (e.g., Instead of saying thank you, sofia should send a gif or sticker that has thank you in it.)
*   Able to add stickers to internal collection used by other students when received, however, they need to be approved first before they can be used.
*   Able to schedule reminders automatically (E.g., user asks sofia to remind them to do something in the morning)
  

## Tech Stack
*   NodeJS with Typescript
*   Alibaba Model Studio
*   PostgreSQL DB
*   Milvus Standalone Vector DB
    

## Important Notes
*   When messages are scheduled to be sent, the messages should only be written when they are scheduled so that any context of new memory can be used.    
*   When changing `src/static/prompts/system.md`, add an entry to `src/static/prompts/changelog.json` with the time the change goes live and what Sofia should do differently. A note is inserted into her chat history at that point so she stops copying the style of her older messages.
*   `GOOGLE_CAL_ID` can list several Google Calendars, comma separated, e.g. one per specialisation track. `get_timetable` lists each calendar as its own section, titled with the calendar's name (e.g. "IT2504 Applied AI & Operations Timetable") in the order listed, with its classes in time order. With one calendar the timetable isn't split into sections.


## Running
*   `pnpm run run` builds and starts the bot. Set `CHAT_MODEL` in `.env` to change the Alibaba Model Studio model (defaults to `qwen3.8-flash`). Set `MODELSTUDIO_WORKSPACE_URL` to your workspace's OpenAI compatible URL (e.g. `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`), it is needed for the decision model that decides when Sofia replies in group chats.
*   `pnpm test` runs the unit tests. `LIVE_TESTS=true pnpm test` also runs hand written group chats against the real decision model to check when Sofia replies (`tests/replyDecision.test.ts`).
*   `pnpm cli --seed tests/seed.example.json --user Azlan --allow-writes` chats with Sofia in the terminal without WhatsApp. `send_message`, `list_groups` and `read_chat_history` use an in-memory mock, everything else is real, so point `SQL_DATABASE_URL` and `MILVUS_ADDRESS` at a test database when using `--allow-writes`. Lines can be piped in through stdin to script a conversation. See `cli.ts` for commands.
*   Web UI: set `WEBUI_PASSWORD` in `.env` (and optionally `WEBUI_PORT`, default 3000) to manage Sofia's stickers and GIFs (including importing many at once) and her users (`UserStore`). It listens on localhost only, so open it through SSH port forwarding (`ssh -L 3000:localhost:3000 ...`) at http://localhost:3000 and log in with any username and the password. Uploads are approved straight away, stickers and GIFs Sofia receives wait as pending until approved. Files are stored in `assets/stickers/`, approved descriptions are embedded in the `sticker_vectors` Milvus collection for `search_sticker_gif`. Needs `ffmpeg` (included in the Docker image) for GIFs. Sofia can't view videos unless `ENABLE_VIDEO=true` is set, since viewing one downloads the whole file just to show her the first frame (GIFs can always be viewed).
*   Docker: `docker compose up -d --build` starts Milvus and the bot (if Milvus is not ready yet, the bot exits and Docker restarts it), then scan the QR code from `docker compose logs -f sofia`. Everything restarts unless stopped. `.env`, `assets/` and `logs/` are mounted into the container.
*   Logs: pino JSON in `logs/` (on the host with Docker), a new file each day (`sofia.<date>.<n>.log`, or sooner past `LOG_MAX_SIZE`), with `logs/current.log` linking to today's and the last `LOG_KEEP_FILES` (30) files kept. Read them with e.g. `tail -f logs/current.log | npx pino-pretty`.


## Google Workspace (GDGoC)
Sofia uses her own account, `sofia@nyp-gdg.com` (Google Workspace Essentials Starter, free), with the Drive, Docs, Sheets, Slides and People APIs (all free). The Workspace tools are only added once she's signed in.

1.  In Google Cloud, signed in with an `nyp-gdg.com` admin account: create a project in the `nyp-gdg.com` organisation, enable the **Google Drive, Docs, Sheets, Slides and People APIs**, and set up the consent screen as **Internal** (or External and **published to production**, not Testing, whose tokens expire after 7 days). Add the scopes `.../auth/drive` and `.../auth/directory.readonly`. Create an OAuth client of type **Desktop app** and save its JSON as `assets/workspace_client_secret.json`.
2.  Add `sofia@nyp-gdg.com` to the club's shared drive as a **Content manager**. In the admin console, keep contact sharing on (Directory → Directory settings → Sharing settings) for `directory_search`, and allow link sharing (Apps → Google Workspace → Drive and Docs) so private images can be inserted.
3.  Run `pnpm google-auth`, open the link and sign in as Sofia. It saves `assets/google-workspace-token.json` and lists the shared drives with their ids: set `GDG_SHARED_DRIVE_ID` in `.env` to the club's (new files go there). `pnpm google-auth --check` tests the token. Over SSH, paste the address the browser ends up on (`http://127.0.0.1:...`) into the terminal.
4.  Put "GDGoC member" in the description of club members in the web UI's user list, so Sofia knows who can ask her to change club files.

How it works and its limits:
*   Reading gives Sofia Markdown or a structure view with the ids and positions she needs to edit: Doc paragraphs and table cells with their character indices, Sheet grids with merged cells, every element on a slide. Common edits have tools (`docs_edit`, `sheets_edit`, `slides_edit`); anything else goes through `docs_batch_update`, `sheets_batch_update` and `slides_batch_update`, the APIs' own requests.
*   Docs and Slides can only insert images from public links. Images that aren't public (sent on WhatsApp, or a Drive file such as a logo) are shared by link only while they're inserted, then unshared. Sheets shows images with `=IMAGE(link)`, which needs a link that stays public.
*   Image search uses Model Studio's `web_search_image` in a separate request to `qwen3.8-flash` (`IMAGE_SEARCH_MODEL`), because DeepSeek models don't support it. Each search takes about 20 seconds. Tenor's GIF API was shut down in June 2026, so GIFs come from image search too.
*   The Docs and Sheets APIs only work on Google files, so `.docx`, `.xlsx` and `.pptx` files are read through a temporary converted copy (deleted afterwards) and edited by converting them to a Google copy next to the original.
*   Links can be Google links, file ids, Drive shortcuts (opened as their target) or short links that redirect to a Google file (e.g. `goo.gle/...`, followed without opening private addresses).
*   Smart chips: Docs take people, date and Drive file chips (plus page breaks); Sheets take people and Drive file chips (Sheets has no date chips, and other links can't be chips). Docs comments can be attached to quoted text and assigned to someone; Sheets and Slides comments quote the passage in the text. Docs suggestion mode isn't available in the API.
*   The Slides API can't copy slides between decks, so `slides_edit` duplicate_slide with `to_url` rebuilds the slide there (`src/services/slideCopy.ts`): shapes, text styles and lists, images, lines, tables, groups and videos, with the look placeholders inherit from their layout and master resolved, the background and the template's own shapes and logos. Charts become images, word art isn't copied, lists use the closest bullet preset, and placeholders become plain text boxes unless the other deck uses the same template (or design "destination" is asked for). Sheet tabs copied into another Sheet lose references to its other tabs (`#REF!`), which Sofia is told about.
*   Files in a shared drive belong to the drive, so their ownership can't be transferred. Ownership of My Drive files moves immediately within `nyp-gdg.com`; people outside have to accept it.

## Known Issues
### Sofia says she'll do something, then stops ("ghosting")
Sometimes Sofia ends a reply by announcing an action without actually doing it, e.g. "Going in now! 🚀" right before she was meant to send a message, and then nothing happens. The model response finished normally (`response.completed`) with only text and no tool call, so Qwen decided it was done. It isn't the OpenAI client: DashScope sends no hidden "completed" signal, the Chat Completions route behaves the same, and replaying the exact request that ghosted 60 times (streamed, not streamed, Chat Completions, thinking off) never reproduced it. `tool_choice: "required"` would force a tool call every turn, but DashScope only allows it with a single tool.

It matches a known Qwen3 issue with thinking mode, [QwenLM/Qwen3#1817](https://github.com/QwenLM/Qwen3/issues/1817):
> Thinking mode plans tool calls but fails to execute them ~60% of the time

where the reporter describes the model planning the tool call in its reasoning, then responding as if it had been made. Sofia's reasoning when she ghosted read: *"I'm planning to test the new multi-message format by sending three bite-sized messages to the Testing Group Chat, then I'll show Azlan what I'm sending and confirm once it goes through."*

Workarounds (`src/services/unfinishedReply.ts`):
*   When a reply ends with text and no tool call, the decision model checks how it ends (only its last message: judging the whole reply let earlier parts outweigh the ending, so an offer like "Want me to fire one more dry run…?" was flagged and Sofia did the dry run without being asked). If it says she is about to act (score of 0.3 or more), she is told to make the tool call, or to call `end_message` if she asked a question or made an offer and is waiting for the user, and gets one more turn. Only one nudge per reply. Every check is logged as `Unfinished reply check` with its score and the ending it judged, so the threshold can be tuned.
*   The prompt tells her to make the tool call in the same response as announcing it, and `send_message` no longer asks her to show the message *before* calling it.

### Baileys doesn't decrypt poll votes
Votes on WhatsApp polls arrive encrypted with the poll's secret key (`messageContextInfo.messageSecret`), and only name the picked options by their SHA-256 hash. In Baileys `7.0.0-rc14` (the version in `package.json`), the code that decrypts votes and emits them as `pollUpdates` in a `messages.update` event is commented out in `node_modules/baileys/lib/Utils/process-message.js` (the `content?.pollUpdateMessage` block, marked "TODO: make standalone, remove getMessage reference"). `decryptPollVote` and `getAggregateVotesInPollMessage` are still exported, but nothing calls them.

Workaround (`src/services/pollService.ts`, `src/models/Poll.ts`):
*   Every poll Sofia sends or sees is saved in `PollStore` with its question, options and secret key.
*   Each vote (`pollUpdateMessage`) is decrypted with `decryptPollVote` in `SofiaBot.handlePollMessage`, trying each phone number and lid jid the poll's creator and the voter may be known by, and the latest vote per person is kept in `PollVoteStore`.
*   `read_poll` reads the votes from `PollVoteStore`. Only polls sent or seen since this was added can be read.

Switching back to Baileys: after upgrading Baileys, check whether that `pollUpdateMessage` block in `process-message.js` is active again. If it is, give `makeWASocket` a `getMessage` that returns the poll message from the store (Baileys needs it to find the poll's secret key), and Baileys will emit `messages.update` events with `pollUpdates`. Then `read_poll` can use `getAggregateVotesInPollMessage` on the poll message, and `handlePollMessage`, `PollVoteStore` and most of `PollService` can be removed. Check that votes still decrypt for people with lid jids before removing the workaround.

## TODO
*   ~~Add Tool Calls to chat history~~
*   ~~Change prompts to `AI Class Assistant` instead of class chairperson.~~
*   ~~Verify that RAG works.~~
*   ~~Add tool for sofia to schedule herself to do certain tasks.~~
*   Add tool for sofia to get the timetable for the whole week given a week number (e.g. week 12). This will allow her to find out what is the date of the lesson in week n.
*   ~~Add tool for sofia to get a chat history.~~
*   ~~Change memory tool. Make it tell sofia related memory and suggest to delete when creating memory.~~
*   ~~PDF Document Support~~
*   Web Console
*   ~~Sticker & GIF support.~~