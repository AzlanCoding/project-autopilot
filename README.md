## Background
Project Autopilot is an AI powered class chairperson that aims to help make learning easier for students. It aims to help students in from both academic and emotional well-being. It is integrated with WhatsApp through the [Baileys](https://github.com/WhiskeySockets/Baileys) library, a socket-based TS/JavaScript API for WhatsApp Web. The integration of WhatsApp allows students to easily chat with the agent (named Sofia). Sofia is designed to be as human like as possible and is meant to fit into a class of gen-z students aged between 18 to 20 years old. She is a very curious and energetic girl that values friendships. (Please refer to `notes/sofia-personality.md` for more details) Overall, Sofia is supposed to be like a friend to the class.

## Note
This project is mostly vibe-coded but also contained a substantial amount of human-written code. The following models were used:
*   [Localy Running] gpt-oss 20B
*   [Localy Running] Gemma 4 (e4b)
*   [Localy Running] Qwen 2.5 Coder (1.5B) (Autocomplete only)
*   [Remotely Running] Bing Chat (a.k.a Copilot)
*   [Remotely Running] ChatGPT


## Class Context
This project is only meant to be used by 1 class. This class named IT2504 is a class that is studying the Diploma in Information Technology at Nanyang Polytechnic Singapore.

## Current Project State
Only `main.ts` has been written which contains some boilerplate code to set up a WhatsApp Bot with the Baileys library. This file needs to be refactored and moved elsewhere.

## Proposed Features
*   Integrates with a single Google account to get calendar events from Google Calendar API and sends them to the class group chat every school day (weekdays). This “daily” message sends at 7am every school day morning and should give some form of encouragement to the class.
*   Can automatically schedule tasks to send messages to remind the class about upcoming events (e.g., there is no school tmr or there is a test tmr)
*   Uses tool calling to send messages to other chats while chatting with another person. (e.g, uses tool call when AI is asked to text someone else happy birthday!)
*   Has a web console for management.
*   Should maintain an internal collection of stickers and gifs. Only approved stickers and gifs can be used. Adding and approving of stickers and gifs can be done through the web console. Web console should also allow for adding additional description for gifs and stickers so that searching would be easier.
*   Able to send gifs and stickers at the end of messages when replying to a student. Where appropriate, sofia should also be only reply with a sticker or gif. (e.g., Instead of saying thank you, sofia should send a gif or sticker that has thank you in it.)
*   Able to add stickers to internal collection used by other students when received, however, they need to be approved first before they can be used.
*   Able to reply in a multi-user environment such as group chats. Uses `qwen-flash` model to decide whether Sofia should say something or not.
    

  

## Tech Stack
*   NodeJS with Typescript
*   Alibaba Cloud Qwen 3.6 using the brand new `dashscope-sdk-nodejs` library
*   PostgreSQL DB
*   Milvus Standalone Vector DB
    

  

## Important Notes
*   Needs to be able to retain a universal memory based on conversations with classmates. Related memory is included in the prompt before any conversation or scheduled task starts.
*   When messages are scheduled to be sent, the messages should only be written when they are scheduled so that any context of new memory can be used.
*   Needs to have an editable settings file that contains the mapping to all the group chats and chat ids to the group chat names.
*   AI coding agent should not write any code for Dashscope API since it is very new and is not trained with it. It can    
    however, write base code like a class containing an empty function to initialise the DashScope client and query a response.    
*   Sofia should use emoji but not excessively and only where appropriate. (Do not use emoji when talking to a teacher.)
*   Sofia should automatically determine if she is talking to a student or a teacher. There should be no build in logic to prevent student only functions to be done  
    (e.g., if Sofia deems the current conversation with a teacher to be appropriate, it can use stickers and gifs in messages.)
*   Replies by the AI model should be streamed, every double new line `\n\n` marks the end of a message. Sofia should try to split her response in to a few bite-sized messages that make it easy for students to understand.
*   Sofia should use a few gen-z terms but should not use vulgar language. If chatting with a teacher act formally unless teacher talks informally.
*   Sofia should wait for user to finish typing for 3 seconds after a message is received before taking any action. This means that when a message is sent, Sofia should only take action after 3 seconds if no new message was sent or no typing activity was detected. This also attempts to help prevent spam.
    
  
## TODO
*   Change scheduled task to use structured response instead of asking AI to use tool calls.
*   Sticker & GIF support.