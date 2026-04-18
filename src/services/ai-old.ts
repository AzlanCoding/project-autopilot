import { OpenAI } from "openai";
import { type Logger } from "pino";
import * as fs from "fs/promises";
import * as path from "path";

interface ToolCall {
  tool_params: any;
  tool_function: (...args: any[]) => Promise<any>;
}

/**
 * A service class to handle chat completions with OpenAI, including tool calling.
 */
export class AI {
  private openai: OpenAI;
  private logger: Logger;
  private systemPrompt: string | null = null;
  private tools: Record<string, ToolCall> = {};

  constructor(apiKey: string, logger: Logger) {
    this.openai = new OpenAI({ apiKey });
    this.logger = logger;
    this.logger.info("AI Service initialized.");
  }

  /**
   * Register a tool inside the class
   */
  registerTool(name: string, tool: ToolCall) {
    this.tools[name] = tool;
    this.logger.info(`Tool registered: ${name}`);
  }

  /**
   * Loads the system prompt from a file
   */
  async setSystemPrompt(promptFilePath: string): Promise<void> {
    try {
      const absolutePath = path.resolve(promptFilePath);
      const content = await fs.readFile(absolutePath, "utf-8");
      this.systemPrompt = content.replace('\n', '');
      this.logger.info(`Loaded system prompt from: ${promptFilePath}`);
    } catch (error) {
      this.logger.error(error, "Failed to load system prompt:");
      throw new Error(`Could not load system prompt from ${promptFilePath}`);
    }
  }

  /**
   * Streaming chat completion
   * Emits chunks whenever a double newline is encountered
   */
  async getChatCompletion(
    messages: { role: "user" | "system" | "assistant"; content: string }[],
    onChunk: (chunk: string) => void
  ): Promise<void> {
    this.logger.info("Calling OpenAI with streaming enabled.");

    try {
      const stream = await this.openai.chat.completions.create({
        model: "gpt-4-turbo",
        messages,
        stream: true,
      });

      let buffer = "";

      for await (const part of stream as any) {
        const token = part.choices?.[0]?.delta?.content || "";
        if (!token) continue;

        buffer += token;

        let splitIndex: number;
        while ((splitIndex = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, splitIndex + 2);
          buffer = buffer.slice(splitIndex + 2);
          onChunk(chunk);
        }
      }

      // Flush remaining content
      if (buffer.length > 0) {
        onChunk(buffer);
      }

    } catch (error) {
      this.logger.error(error, "Error during streaming chat completion:");
      throw error;
    }
  }

  /**
   * Handles chat with tool calling support
   */
  async handleChatWithTools(
    messages: { role: "user" | "system" | "assistant"; content: string }[]
  ): Promise<{ responseContent: string; toolCalls?: { name: string; toolInput: any }[] }> {
    this.logger.info("Starting chat with tool support.");

    const toolsForApi = Object.keys(this.tools).map((toolName) => ({
      type: "function" as const,
      function: {
        name: toolName,
        description: `A tool available for ${toolName}.`,
        parameters: {
          type: "object",
          properties: {},
        },
      },
    }));

    try {
      // Initial request
      const chatCompletion = await this.openai.chat.completions.create({
        model: "qwen3.5:latest",
        messages,
        tools: toolsForApi,
        tool_choice: "auto",
      });

      const message = chatCompletion.choices[0].message;

      // Handle tool calls
      if (message.tool_calls) {
        const toolCalls = message.tool_calls.map((toolCall: any) => {
          let parsedArgs = {};
          try {
            parsedArgs = toolCall.function.arguments
              ? JSON.parse(toolCall.function.arguments)
              : {};
          } catch (e) {
            this.logger.error(e, "Failed to parse tool arguments");
          }

          return {
            name: toolCall.function.name,
            toolInput: parsedArgs,
          };
        });

        this.logger.info(`Model requested ${toolCalls.length} tool call(s).`);

        const toolMessageContent: any[] = [];

        for (const toolCall of toolCalls) {
          const toolFn = this.tools[toolCall.name];

          if (!toolFn) {
            this.logger.error(`Tool ${toolCall.name} not found.`);
            throw new Error(`Tool ${toolCall.name} is not available.`);
          }

          const args = Array.isArray(toolCall.toolInput)
            ? toolCall.toolInput
            : [toolCall.toolInput];

          const result = await toolFn.tool_function(...args);

          toolMessageContent.push({
            role: "tool",
            name: toolCall.name,
            content: JSON.stringify(result),
          });
        }

        this.logger.info("Tool calls executed. Sending results back to model.");

        const followUpMessages = [
          ...messages,
          { role: "assistant", content: "Executing requested tools..." },
          ...toolMessageContent,
        ];

        const finalCompletion = await this.openai.chat.completions.create({
          model: "gpt-4-turbo",
          messages: followUpMessages,
        });

        return {
          responseContent: finalCompletion.choices[0].message.content || "",
          toolCalls,
        };
      }

      // No tool calls
      return {
        responseContent: message.content || "",
      };

    } catch (error) {
      this.logger.error(error, "Error in handleChatWithTools:");
      throw error;
    }
  }
}