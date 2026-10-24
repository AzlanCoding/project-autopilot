# AGENTS.md

Guide for coding agents working on Project Autopilot. `README.md` covers features, setup, environment variables and known
issues for humans; this file covers what you need to change the code safely.

## Always

- **Whenever the system prompt changes, add an entry to `src/static/prompts/changelog.json`.** This includes any edit to
  `src/static/prompts/system.md`, and changes to tools or prompts in code that change what Sofia should do (a new tool, a
  new argument, different behaviour). Append `{ "date": "<when it goes live, ISO 8601 +08:00>", "summary": "<what Sofia
  should do differently>" }`, written to Sofia (e.g. "You can now..."). The note is inserted into her chat history at
  that time; without it she keeps copying the style and habits of her older messages. Check
  `tests/promptChangelog.test.ts` still passes.
- **Never put real WhatsApp IDs in tests.** Phone number jids (`<number>@s.whatsapp.net`) contain real phone numbers,
  and LIDs (`<number>@lid`) and group ids identify real people and chats. Don't copy them from logs or the database into
  `tests/` or test fixtures like `tests/seed.example.json`, even when reproducing a bug from a real chat. Use obviously
  fake ones (`6590000000@s.whatsapp.net`, `100000000000000@lid`, `123@g.us`).
- **Don't stage or commit.** Azlan reads the code before committing: staged files are files he has already read. Leave
  your changes unstaged (no `git add`, `git rm` or `git mv`; use plain `rm`/`mv` instead), and don't unstage, reset or
  overwrite his staged changes. Editing a file he has already staged is fine; he'll see the unstaged changes on top.

## What this is

Sofia is a WhatsApp bot for one class (IT2504, Nanyang Polytechnic, Singapore). She chats 1-to-1 and in group chats,
remembers things about classmates, reads the class timetable from Google Calendar, tracks assignments and assessments,
sends stickers, GIFs and polls, messages other chats, and schedules tasks for herself. Her personality matters as much as
her features (see `notes/sofia-personality.md` and the system prompt).

- **Runtime:** Node 24, TypeScript compiled with `tsc` to `dist/` (CommonJS). pnpm.
- **WhatsApp:** [Baileys](https://github.com/WhiskeySockets/Baileys) `7.0.0-rc14`, with `baileys-bottle-devstroupe` storing the
  session and messages in PostgreSQL (`BAILEYS_BOTTLE_SQL_DATABASE_URL`).
- **Models:** Alibaba Model Studio through the `openai` SDK on its OpenAI compatible endpoint (`MODELSTUDIO_BASE_URL`).
  Chat uses the **Responses API**, streamed (`CHAT_MODEL`, default `qwen3.8-flash`). Embeddings are `text-embedding-v4`
  (2048 dims). Group reply and unfinished-reply checks use the decision model (`decision-model-preview`, `/systemone`).
- **Data:** PostgreSQL through Sequelize (`SQL_DATABASE_URL`), Milvus for vectors (`memories_vectors`, `sticker_vectors`).
- **Deploy:** Docker (`docker compose up -d --build`), host networking, `.env` and `assets/` mounted, `TZ=Asia/Singapore`.

## Commands

| Command | What it does |
|---|---|
| `pnpm tsc` | Typecheck and build (there is no separate lint step) |
| `pnpm test` | Build, then run every test in `dist/tests/` with `node --test` |
| `pnpm tsc && node --test dist/tests/<name>.test.js` | Run one test file |
| `LIVE_TESTS=true pnpm test` | Also run the live decision model tests (`tests/replyDecision.test.ts`, needs API keys) |
| `pnpm cli --seed tests/seed.example.json --user Azlan` | Chat with Sofia in the terminal, WhatsApp tools mocked (see `cli.ts`) |
| `pnpm run run` | Build and start the real bot (needs WhatsApp login, Postgres, Milvus, Google credentials) |

Tests import from `../src/...` and are compiled with everything else, so a test removed from `tests/` can leave a stale
`.js` in `dist/tests/` that still runs. Delete it from `dist/` too.

## Layout

```
main.ts                    Startup: Store, Milvus collections, web UI, AI, 7am weekday daily message (croner), SofiaBot
cli.ts                     Terminal chat with a MockChatAdapter
src/services/
  ai.ts                    AI class: every tool, the reply loop (processChatv3), system prompt, scheduled task runner
  botService.ts            SofiaBot: Baileys connection, message handling, history loading, sending (implements ChatAdapter)
  bufferSystem.ts          Per-chat wait-until-quiet buffer (3s, typing-aware) and the "new message while replying" flag
  replyDecision.ts         Should Sofia reply in a group? (@mention, name, then the decision model)
  unfinishedReply.ts       Detects replies that announce an action without doing it, and the nudge
  store.ts                 Store: Sequelize models + services, Milvus memory read/write/query, embeddings
  userService.ts           Users, and formatAndMergeMessages (turns chat history into model input)
  ToolCallHistService.ts   Saves tool calls/results after each message so later replies see them
  scheduledTaskService.ts  Sofia's self-scheduled tasks (one-time or cron, Asia/Singapore)
  stickerService.ts        Stickers/GIFs: convert, describe with the vision model, index in Milvus, search
  pollService.ts           Polls and decrypted votes (Baileys doesn't decrypt votes, see README)
  assignmentService.ts, assessmentService.ts, calendarService.ts
  webServer.ts             Express web UI for stickers, GIFs and users (basic auth, localhost only)
  chatContext.ts           AsyncLocalStorage with the chat Sofia is replying in (used by tools)
src/models/                Sequelize models, each with a static register(sequelize)
src/utils/                 common.ts (time, semesters/weeks, message splitting), media.ts (sharp/ffmpeg), vision.ts,
                           getCalendarEvents.ts (Google Calendar), promptChangelog.ts
src/static/prompts/        system.md (Sofia's system prompt, read at runtime) and changelog.json
src/static/webui.html      Web UI page
notes/reply-flow.md        How a message becomes a reply, with every check on the way. Keep it in sync.
tests/                     node:test unit tests
```

## How a reply happens

Read `notes/reply-flow.md` before changing anything in this path. In short:

1. `SofiaBot` gets `messages.upsert` → `BufferSystem.bufferCall` waits for the chat to go quiet.
2. The run loads the chat (`loadChat`), finds unseen messages, and in groups asks `decideGroupReply` whether to reply.
3. The system prompt comes from `AI.generatePrompt` (system.md + memories + chat info), history from `formatHistory` →
   `formatAndMergeMessages` (last 24 merged messages, with past tool calls replayed from `ToolCallHist`).
4. `AI.processChatv3` streams the Responses API. Blank lines split the text into separate WhatsApp messages. Tool calls
   run as soon as they finish streaming, then the next request runs. The reply ends with text only, or with `end_message`
   (or a tool called with `end_message: true`).
5. Messages that arrive mid-reply are added at safe points (after thinking, a sent message, or a tool call) via
   `hasNewMessages` / `messagesDuringReply`; anything left over gets a new buffered run afterwards.

Scheduled tasks and the daily message go through `Store.ai_scheduled_task_runner` (set up in the `AI` constructor), which
builds its own prompt and calls `processChatv3` without WhatsApp streaming.

## Tools

Tools are `ExtendedDynamicStructuredTool(fields, usage_str)` (a LangChain `DynamicStructuredTool` plus a usage string
shown when a call fails). The zod schema is sent as JSON Schema with `strict: true`.

- Tools that don't need WhatsApp are created in the `AI` constructor and listed in `this.tools`.
- Tools that need the chat platform (`send_message`, `send_sticker_gif`, `view_media`, `list_groups`, `read_chat_history`,
  `send_poll`, `read_poll`) are created in `registerChatTools(adapter)` and pushed onto `this.tools`.
- `ChatAdapter` is implemented by `SofiaBot`, by `MockChatAdapter` in `cli.ts`, and by inline fakes in
  `tests/sendMessage.test.ts` and `tests/polls.test.ts`. Change all of them when you change the interface.
- Model Studio's built-in tools (`code_interpreter`, `web_search`, `web_extractor`, set by `BUILTIN_TOOLS` in
  `src/config/modelStudio.ts`, off by default) are sent alongside the function tools. Their instructions are added to
  the prompt at runtime by `builtinToolsPrompt()` (not in system.md) so Sofia is only told about the ones she has. Alibaba runs them within the response, so their
  items (`web_search_call`, `web_extractor_call`, `code_interpreter_call`) arrive already done: `processChatv3` keeps
  them in the history and yields them as `builtin_tool_call` (saved to `ToolCallHist`). They only work on the Responses
  API; Chat Completions' `enable_code_interpreter` can't be combined with function tools.
- Follow the existing descriptions: say when to use the tool, mark arguments `[Required]` / `[Optional]`, give dates as
  ISO 8601 in Singapore time with an example (`2026-04-16T11:47:12+08:00`), and return readable text or JSON with dates
  formatted by `formatDateTime`.
- Errors thrown by a tool are returned to Sofia as `Tool execution error:...` with the usage string, so throw clear,
  actionable messages (e.g. which tool gives the right id).
- IDs: users are UUIDs from `UserStore` (`user_list`), groups end with `@g.us` (`list_groups`). WhatsApp users can appear
  under a phone number jid or a LID; `loadChatById` loads both.
- If a tool changes what Sofia should do, update `system.md` and add a changelog entry (below).

## Conventions

- **Style:** 2-space indent, semicolons, `async/await`. Match the file you're in; quote style is mixed.
- **Comments:** JSDoc on exported functions and non-obvious members. Comments explain *why*: the bug it prevents or the
  behaviour that was tested, often with a concrete example or date (see the end of `replyDecision.ts`). Don't narrate
  what the code does.
- **Errors:** `this.logger.error(e, 'What failed')` and keep the bot running. One failing feature must never stop replies.
- **Types:** `strict` is on. `as any` only where the SDK types lack something (e.g. Model Studio extensions), with a comment.
- **Time:** Singapore time everywhere. Use `moment-timezone` with `SCHEDULE_TIMEZONE` (`'Asia/Singapore'`) to parse
  dates, and `formatDateTime` / `parseTimestamp` to show them. WhatsApp message times are Unix **seconds**.
- **Tests:** `node:test` + `node:assert/strict`, no mocking library. Build objects with `Object.create(X.prototype)` and
  `Object.assign` fakes (see `fakeAI` in `tests/processChat.test.ts` for a scripted Responses API stream). Name tests by
  the behaviour, e.g. `'a sticker sent with end_message ends the reply: no more text and no further request'`. Add a
  test with every behaviour change.
- **System prompt:** when you change `src/static/prompts/system.md`, add an entry to `src/static/prompts/changelog.json`
  (`date` = when it goes live, `summary` = what Sofia should do differently). `formatAndMergeMessages` inserts the note
  into her history at that time so she stops copying her older messages.
- **Docs:** update `README.md` (features, env vars, known issues) and `notes/reply-flow.md` when behaviour changes.
  New env vars go in `.sample.env` with a comment.
- **Database:** models sync with `alter: true` at startup, so columns are added automatically. New columns need to work
  on existing rows (no `DEFAULT now()` stamping old rows, see `ToolCallHist`).
- **Git:** Azlan reviews, stages, commits and pushes. Leave changes unstaged and uncommitted unless asked (see Always). Commit messages are short Title Case
  summaries (``Add an `after` argument for `read_chat_history` ``).

## Gotchas

- **Timezone-dependent tests.** `formatDateTime` uses the machine's local time. Production pins `TZ=Asia/Singapore`, and
  some tests (`tests/history.test.ts`) expect it. Run tests in Singapore time (`TZ=Asia/Singapore pnpm test`).
- **Model Studio quirks:**
  - The Responses API silently drops base64 `input_video` parts on `qwen3.8-flash`, so `vision.ts` uses Chat Completions
    (`video_url`). Base64 videos must be under 10MB once encoded.
  - The decision model is only on the workspace URL (`MODELSTUDIO_WORKSPACE_URL`), not the shared dashscope host.
  - Qwen returns its thinking in full in the reasoning item's `summary`, DeepSeek leaves `summary` empty and uses
    `content`. Both are passed back in the next request.
  - Failed requests (e.g. an unknown model id) arrive as a `response.failed` event, not an HTTP error. Model ids are
    case-sensitive (`deepseek-v4.1-flash-1017`, not `DeepSeek-V4.1-Flash-1017`).
  - Aborting a streamed response (`AbortController`) ends the `for await` quietly, it doesn't throw. Check `signal.aborted`.
  - `tool_choice: "required"` only works with a single tool, which is why the unfinished-reply nudge exists.
- **Text already sent can't be taken back.** Anything yielded as `chunk_display` is on WhatsApp. Keep it in the history
  (as an assistant message) when changing the reply loop, or Sofia repeats herself.
- **Tools run once.** A tool runs when its call finishes streaming and its call + output are pushed to the history before
  the next request. Never re-send a request without them or the action happens twice.
- **`TESTING=true`** stops Sofia replying on WhatsApp and blocks memory writes and scheduled task changes.
- **Baileys poll votes** are decrypted by the bot itself (`handlePollMessage`), see README before upgrading Baileys.
- **Group senders** are resolved LID → phone number; unknown or unmapped senders show as "Unknown User" (never an error).
  Only private chats with unknown users are rejected.
- **`ffmpeg`** is needed for GIFs and videos (installed in the Docker image). Media tests skip without it.

## Legacy code

`ai.ts` still has the LangChain-era chat loop commented out (`processChat`, `processChatv2`) and a bound LangChain
`ChatOpenAI` model (`this.model` / `bindModel`) that nothing uses for replies. `processChatv3` with the `openai` client
is the only reply path. Don't build on the old code. LangChain is still used for the tool base class and embeddings.

## Testing against the live API

When a change depends on how Model Studio behaves, test it for real before relying on it (several quirks above were
found this way). Write throwaway scripts outside the repo (`tsc` compiles every `.ts` in it) and run them with
`npx ts-node --transpile-only -P tsconfig.json <script>` from the repo root, importing from the repo's `src/` (import
packages such as `openai` by their path in the repo's `node_modules`, since they resolve from the script's folder). Keep them small: they spend
real API credit. Production logs are pino JSON in `log.log` inside the container
(`docker compose exec -T sofia cat log.log`).
