## Background
Project Autopilot is an AI powered class assistant that aims to help make learning easier for students. It aims to help students in from both academic and emotional well-being. It is integrated with WhatsApp through the [Baileys](https://github.com/WhiskeySockets/Baileys) library, a socket-based TS/JavaScript API for WhatsApp Web. The integration of WhatsApp allows students to easily chat with the agent (named Sofia). Sofia is designed to be as human like as possible and is meant to fit into a class of gen-z students aged between 18 to 20 years old. She is a very curious and energetic girl that values friendships. (Please refer to `notes/sofia-personality.md` for more details) Overall, Sofia is supposed to be like a friend to the class.

## Note
This project is mostly vibe-coded but also contained a substantial amount of human-written code. The following models were used:
*   [Localy Running] gpt-oss 20B
*   [Localy Running] Gemma 4 (e4b)
*   [Localy Running] Qwen 2.5 Coder (1.5B) (Autocomplete only)
*   [Remotely Running] Bing Chat (a.k.a Copilot)
*   [Remotely Running] ChatGPT


## Class Context
This project is only meant to be used by 1 class. This class named IT2504 is a class that is studying the Diploma in Information Technology at Nanyang Polytechnic Singapore.


## Features
*   Integrates with a single Google account to get calendar events from Google Calendar API and sends them to the class group chat every school day (weekdays). This “daily” message sends at 7am every school day morning and should give some form of encouragement to the class.
*   Uses tool calling to send messages to other chats while chatting with another person. (e.g, uses tool call when AI is asked to text someone else happy birthday!)
*   Able to reply in a multi-user environment such as group chats. Uses `qwen-flash` model to decide whether Sofia should say something or not.
*   Automatically send messages to remind the class about upcoming assignments and assessment. Automatically send daily message which is 
*   Needs to be able to retain a universal memory based on conversations with classmates. Related memory is included in the prompt before any conversation or scheduled task starts.
*   Sofia will wait for user to finish typing for 3 seconds after a message is received before taking any action. This means that when a message is sent, Sofia should only take action after 3 seconds if no new message was sent or no typing activity was detected. This also attempts to help prevent spam.


## Future Proposed Features
*   Has a web console for management.
*   Should maintain an internal collection of stickers and gifs. Only approved stickers and gifs can be used. Adding and approving of stickers and gifs can be done through the web console. Web console should also allow for adding additional description for gifs and stickers so that searching would be easier.
*   Able to send gifs and stickers at the end of messages when replying to a student. Where appropriate, sofia should also be only reply with a sticker or gif. (e.g., Instead of saying thank you, sofia should send a gif or sticker that has thank you in it.)
*   Able to add stickers to internal collection used by other students when received, however, they need to be approved first before they can be used.
*   Able to process pdf documents.
  

## Tech Stack
*   NodeJS with Typescript
*   Alibaba Model Studio
*   PostgreSQL DB
*   Milvus Standalone Vector DB
    

## Important Notes
*   When messages are scheduled to be sent, the messages should only be written when they are scheduled so that any context of new memory can be used.    
    
  
## TODO
*   ~~Add Tool Calls to chat history~~
*   ~~Change prompts to `AI Class Assistant` instead of class chairperson.~~
*   Add tool for sofia to schedule herself to do certain tasks.
*   Add tool for sofia to get the timetable for the whole week given a week number (e.g. week 12). This will allow her to find out what is the date of the lesson in week n.
*   Add tool for sofia to get a chat history.
*   Change memory tool. Make it tell sofia related memory and suggest to delete when creating memory.
*   Verify that RAG works.
*   PDF Document Support
*   Web Console
*   Sticker & GIF support.