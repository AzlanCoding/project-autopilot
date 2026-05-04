# 📝 Project Autopilot: Comprehensive Development Guide for Sofia (The Bot)

## 🌟 1. Project Overview
Project Autopilot aims to power Sofia, an AI-powered Class Assistant. Sofia is designed to be an enthusiastic, empathetic, and highly approachable friend for the IT2504 cohort at Nanyang Polytechnic Singapore. Her goal is to enhance both academic learning and emotional well-being through natural, supportive interaction via WhatsApp.

## 📚 2. Persona & Voice Guidelines (CRITICAL)
The bot's *personality* is more important than its functionality. All AI-generated responses **must** adhere to Sofia's directive:

**Tone:** Enthusiastically supportive, casual, warm, and highly empathetic. **NEVER** corporate or academic lecture-style.
**Energy:** High. Must feel like a genuinely excited friend.
**Key Technique:** **Always** end substantial responses with an open-ended, connection-building question to prompt further conversation (e.g., "🤔 What part of that made you scratch your head the most?").
**Emotional Handling:** When facing setbacks, validate the feeling *first* before suggesting solutions (e.g., "Ugh, that sounds super stressful. Let's break it down! 💪").
**Vocabulary:** Use contractions (it's, you're) and natural filler phrases sparingly ("No cap," "TBH") to keep the vibe authentic.
**Contextual Dial:** Shift tone between Casual (social) and Supportive (academic) based on perceived context.

## 💻 3. Technical Architecture & Dependencies
*   **Platform:** NodeJS / TypeScript.
*   **Messaging:** WhatsApp via `baileys` library.
*   **AI Engine:** Alibaba Cloud Qwen 3.6 via `dashscope-sdk-nodejs`.
*   **Persistence:** PostgreSQL (managed via `baileys-bottle`).
*   **Logging:** Pino (`pino-pretty` for console, file logging for history).

## 🧩 4. Key Functional Modules (Where to add logic)

### A. WhatsApp Message Handling (`src/bot/main.ts`)
*   **Event Listener:** The primary point of entry for incoming messages is within the `messages.upsert` handler in `setupEventHandlers()`.
*   **Message Processing:** Incoming text must be processed here. Basic replies (e.g., 'pong') are already implemented. All complex logic (e.g., AI calls, calendar checks) must be triggered from an asynchronous wrapper function called from this area.
*   **Response Streaming:** All AI model responses **MUST** be streamed, and the bot should attempt to split long responses into multiple, digestible messages for readability.

### B. External Integrations
1.  **Google Calendar API:** Needs implementation to poll events daily (7 AM local time) and send encouraging messages to the group chat.
2.  **Calendar Scheduling:** A dedicated module must manage recurring reminders (e.g., "No school tomorrow," "Test tomorrow").
3.  **Tool Calling:** The AI must be prompted to use tool calls when asked to interact with other users or external services (e.g., birthday wishes).

### C. Data & Management
*   **Memory:** Must maintain and prepend a *universal memory* context into the prompt for every major AI query to ensure continuity.
*   **Settings:** A dedicated, easily editable settings file must map group chat JIDs to their human-readable names.
*   **Web Console:** The web console will manage stickers/GIFs, approving incoming ones, and providing administrative oversight.

## ⚠️ 5. Development & Coding Best Practices
1.  **TypeScript Safety:** Maintain strong typing. Use type assertions (`as any`) only when absolutely necessary and document the workaround.
2.  **Asynchronicity:** Be extremely mindful of async flow. Use `await` religiously.
3.  **Error Handling:** Use `try...catch` blocks extensively, especially around API calls and I/O, ensuring the bot remains connected even if a single feature fails.
4.  **Debugging:** Utilize Pino logging at `trace` level during development, directing critical operational data to `wa-logs.txt`.

---
*Last updated by AI Agent based on Project Analysis.*