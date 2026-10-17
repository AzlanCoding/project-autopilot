## Project Autopilot
Project Autopilot is an AI powered class assistant that aims to help make learning easier for students. It aims to help students in from both academic and emotional well-being. It is integrated with WhatsApp through the [Baileys](https://github.com/WhiskeySockets/Baileys) library, a socket-based TS/JavaScript API for WhatsApp Web. The integration of WhatsApp allows students to easily chat with the agent (named Sofia). Sofia is designed to be as human like as possible and is meant to fit into a class of gen-z students aged between 18 to 20 years old. She is a very curious and energetic girl that values friendships. Overall, Sofia is supposed to be like a friend to the class.

## Note
This project is partially vibe-coded but also contains a substantial amount of human-written code. The following models were used:
*   [Locally Running] gpt-oss 20B
*   [Locally Running] Gemma 4 (e4b)
*   [Locally Running] Qwen 2.5 Coder (1.5B) (Autocomplete only)
*   [Remotely Running] Bing Chat (a.k.a Microsoft Copilot)
*   [Remotely Running] ChatGPT


## Class Context
This project is only meant to be used by 1 class. This class named IT2504 is a class that is studying the Diploma in Information Technology at Nanyang Polytechnic Singapore.


## Features
*   Integrates with a single Google account to get calendar events from Google Calendar API and sends them to the class group chat every school day (weekdays). This “daily” message sends at 7am every school day morning and should give some form of encouragement to the class.
*   Uses tool calling to send messages to other chats while chatting with another person. (e.g, uses tool call when AI is asked to text someone else happy birthday!)
*   Able to reply in a multi-user environment such as group chats.
*   Automatically send messages to remind the class about upcoming assignments and assessment. Automatically send daily message which is 
*   Able to retain a universal memory based on conversations with classmates. Related memory is included in the prompt before any conversation or scheduled task starts.
*   Sofia will wait for user to finish typing for 3 seconds after a message is received before taking any action. This means that when a message is sent, Sofia should only take action after 3 seconds if no new message was sent or no typing activity was detected. This also attempts to help prevent spam. Note that typing activity detection does not affect this for group chats.


## Future Proposed Features
*   Web console for management.
*   Should maintain an internal collection of stickers and GIFs. Only approved stickers and GIFs can be used. Adding and approving of stickers and GIFs can be done through the web console. Web console should also allow for adding additional description for GIFs and stickers so that searching would be easier.
*   Able to send GIFs and stickers at the end of messages when replying to a student. Where appropriate, sofia should also be only reply with a sticker or gif. (e.g., Instead of saying thank you, sofia should send a gif or sticker that has thank you in it.)
*   Able to add stickers to internal collection used by other students when received, however, they need to be approved first before they can be used.
*   Able to process pdf documents.
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
*   Docker: `docker compose up -d --build` starts Milvus and the bot (if Milvus is not ready yet, the bot exits and Docker restarts it), then scan the QR code from `docker compose logs -f sofia`. Everything restarts unless stopped. `.env` and `assets/` are mounted into the container.


## Known Issues
### Sofia says she'll do something, then stops ("ghosting")
Sometimes Sofia ends a reply by announcing an action without actually doing it, e.g. "Going in now! 🚀" right before she was meant to send a message, and then nothing happens. The model response finished normally (`response.completed`) with only text and no tool call, so Qwen decided it was done. It isn't the OpenAI client: DashScope sends no hidden "completed" signal, the Chat Completions route behaves the same, and replaying the exact request that ghosted 60 times (streamed, not streamed, Chat Completions, thinking off) never reproduced it. `tool_choice: "required"` would force a tool call every turn, but DashScope only allows it with a single tool.

It matches a known Qwen3 issue with thinking mode, [QwenLM/Qwen3#1817](https://github.com/QwenLM/Qwen3/issues/1817):
> Thinking mode plans tool calls but fails to execute them ~60% of the time

where the reporter describes the model planning the tool call in its reasoning, then responding as if it had been made. Sofia's reasoning when she ghosted read: *"I'm planning to test the new multi-message format by sending three bite-sized messages to the Testing Group Chat, then I'll show Azlan what I'm sending and confirm once it goes through."*

Workarounds (`src/services/unfinishedReply.ts`):
*   When a reply ends with text and no tool call, the decision model checks how it ends (only its last message: judging the whole reply let earlier parts outweigh the ending, so an offer like "Want me to fire one more dry run…?" was flagged and Sofia did the dry run without being asked). If it says she is about to act (score of 0.3 or more), she is told to make the tool call, or to call `end_message` if she asked a question or made an offer and is waiting for the user, and gets one more turn. Only one nudge per reply. Every check is logged as `Unfinished reply check` with its score and the ending it judged, so the threshold can be tuned.
*   The prompt tells her to make the tool call in the same response as announcing it, and `send_message` no longer asks her to show the message *before* calling it.

## TODO
*   ~~Add Tool Calls to chat history~~
*   ~~Change prompts to `AI Class Assistant` instead of class chairperson.~~
*   ~~Verify that RAG works.~~
*   ~~Add tool for sofia to schedule herself to do certain tasks.~~
*   Add tool for sofia to get the timetable for the whole week given a week number (e.g. week 12). This will allow her to find out what is the date of the lesson in week n.
*   ~~Add tool for sofia to get a chat history.~~
*   ~~Change memory tool. Make it tell sofia related memory and suggest to delete when creating memory.~~
*   PDF Document Support
*   Web Console
*   ~~Sticker & GIF support.~~