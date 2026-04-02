import type { SearchResult, Source } from "../interface.ts";
import { ConfigManager } from "../../config.ts";
import { normalizeInputToArray, OpenRouter, tool } from "@openrouter/sdk";
import { z } from "zod";
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";

interface StreamOptions {
  includeClipboard?: boolean;
  callbacks: StreamCallback;
  signal?: AbortSignal;
}

interface StreamCallback {
  onText: (text: string) => void;
  onToolRequest: (tool: string, args: Record<string, unknown>) => void;
  onToolResult: (result: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
}

type AiProvider = "openrouter" | "opencode";

const runCommandTool = tool({
  name: "run_command",
  description: "Execute a shell command and return the output",
  inputSchema: z.object({
    command: z.string().describe("The shell command to execute"),
  }),
  outputSchema: z.object({
    output: z.string().describe("The command output or error"),
  }),
  execute: async ({ command }: { command: string }) => {
    try {
      const parts = command.split(" ");
      const cmd = new Deno.Command(parts[0], {
        args: parts.slice(1),
        stdout: "piped",
        stderr: "piped",
      });
      const { stdout, stderr } = await cmd.output();

      const stdoutText = new TextDecoder().decode(stdout);
      const stderrText = new TextDecoder().decode(stderr);

      return { output: stdoutText || stderrText || "Command completed" };
    } catch (e) {
      return { output: `Error: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
});

const SYSTEM_INSTRUCTIONS =
  `You are a helpful AI assistant. Be concise. Only use run_command when the user explicitly asks to run a shell command (e.g., "run ls", "execute ffmpeg").`;

export class AiSource implements Source {
  id = "ai";
  name = "AI Assistant";
  description = "Ask AI questions via OpenRouter or OpenCode";
  trigger = "ai";
  #configManager = new ConfigManager();
  #openrouterKey?: string;
  #opencodeUrl?: string;
  #opencodeEnabled?: boolean;
  #client?: OpenRouter;
  #provider: AiProvider = "openrouter";
  #opencodeInstance?: Awaited<ReturnType<typeof createOpencode>>;
  #opencodeClient?: Awaited<ReturnType<typeof createOpencode>>["client"];
  #createdOwnServer = false;
  #sessionId?: string;

  constructor() {}

  async init(): Promise<void> {
    this.#opencodeUrl = await this.#configManager.getOpencodeServerUrl();
    this.#opencodeEnabled = await this.#configManager.isOpencodeEnabled();

    if (this.#opencodeUrl || this.#opencodeEnabled) {
      this.#provider = "opencode";
    } else {
      this.#openrouterKey = await this.#configManager.getApiKey();
      if (this.#openrouterKey) {
        this.#client = new OpenRouter({ apiKey: this.#openrouterKey });
      }
    }
  }

  async #ensureOpencodeClient(): Promise<
    Awaited<ReturnType<typeof createOpencode>>["client"]
  > {
    // If we have a client, assume it's still working
    if (this.#opencodeClient) {
      return this.#opencodeClient;
    }

    console.log("[AI/OpenCode] Getting OpenCode client...");

    if (this.#opencodeUrl) {
      // Connect to existing server using client
      const client = createOpencodeClient({
        baseUrl: this.#opencodeUrl,
      });
      this.#opencodeClient = client;
      console.log("[AI/OpenCode] Using existing server:", this.#opencodeUrl);
      return this.#opencodeClient;
    } else if (this.#opencodeEnabled) {
      // Try to create new instance first (SDK will spawn opencode server)
      console.log("[AI/OpenCode] Trying to create new server instance...");
      try {
        const opencode = await createOpencode({ timeout: 30000 });
        this.#opencodeInstance = opencode;
        this.#opencodeClient = opencode.client;
        this.#createdOwnServer = true;
        console.log("[AI/OpenCode] Created server at:", opencode.server.url);
        return this.#opencodeClient;
      } catch (createErr) {
        console.log("[AI/OpenCode] Failed to create server:", createErr);
        // Fall back to connecting to existing server on default port
        const existingUrl = "http://127.0.0.1:4096";
        console.log("[AI/OpenCode] Trying existing server at:", existingUrl);
        const client = createOpencodeClient({
          baseUrl: existingUrl,
        });
        this.#opencodeClient = client;
        return this.#opencodeClient;
      }
    } else {
      throw new Error("OpenCode not configured");
    }
  }

  getProvider(): string {
    return this.#provider;
  }

  // deno-lint-ignore require-await
  async search(query: string): Promise<SearchResult[]> {
    const hasOpencode = !!this.#opencodeUrl || !!this.#opencodeEnabled;
    const hasOpenrouter = !!this.#openrouterKey;

    if (!hasOpencode && !hasOpenrouter) {
      return [{
        title: "No AI Provider",
        subtitle: "Set opencodeEnabled: true or add openrouterApiKey in config",
        icon: "dialog-error",
        score: 100,
        onActivate: () => {},
      }];
    }

    if (!query.trim()) {
      const providerName = this.#provider === "opencode"
        ? "OpenCode"
        : "OpenRouter";
      return [{
        title: `AI (${providerName})`,
        subtitle: "Type 'ai <question>' to ask anything",
        icon: "dialog-information",
        score: 100,
        onActivate: () => {},
      }];
    }

    return [{
      title: "🤖 AI Response",
      subtitle: "Streaming...",
      icon: "dialog-information",
      score: 100,
      id: "ai-stream",
      onActivate: () => {},
    }];
  }

  async *streamResponse(
    query: string,
    options: StreamOptions,
  ): AsyncGenerator<string> {
    const { includeClipboard = false, callbacks, signal } = options;

    if (this.#provider === "opencode") {
      yield* this.#streamOpencode(query, {
        includeClipboard,
        callbacks,
        signal,
      });
    } else if (this.#client && this.#openrouterKey) {
      yield* this.#streamOpenrouter(query, {
        includeClipboard,
        callbacks,
        signal,
      });
    } else {
      callbacks.onError("No AI provider configured");
    }
  }

  async *#streamOpenrouter(
    query: string,
    options: StreamOptions,
  ): AsyncGenerator<string> {
    const { includeClipboard = false, callbacks, signal } = options;

    const messages: { role: string; content: string }[] = [];

    if (includeClipboard) {
      const clipboardText = await this.#readClipboard();
      if (clipboardText && clipboardText.trim()) {
        messages.push({
          role: "user",
          content: `My clipboard has: "${clipboardText.trim()}"`,
        });
      }
    }

    messages.push({ role: "user", content: query });

    const maxRetries = 3;
    const baseDelay = 2000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (signal?.aborted) {
        return;
      }

      try {
        const result = this.#client!.callModel({
          model: "minimax/minimax-m2.5:free",
          instructions: SYSTEM_INSTRUCTIONS,
          // deno-lint-ignore no-explicit-any
          input: normalizeInputToArray(messages as any),
          tools: [runCommandTool],
        });

        let fullText = "";

        for await (const delta of result.getTextStream()) {
          if (signal?.aborted) {
            return;
          }
          fullText += delta;
          callbacks.onText(delta);
          yield delta;
        }

        callbacks.onDone();
        return;
      } catch (e) {
        if (signal?.aborted) {
          return;
        }

        const err = e instanceof Error ? e : new Error(String(e));
        const statusCode =
          (err as unknown as { statusCode?: number }).statusCode;
        const isRetryable = statusCode === 429 ||
          (statusCode !== undefined && statusCode >= 500 && statusCode < 600);

        console.error(
          `[AI/OpenRouter] Error (attempt ${attempt + 1}/${maxRetries}):`,
          {
            statusCode,
            message: err.message,
          },
        );

        if (isRetryable && attempt < maxRetries - 1) {
          const delay = baseDelay * Math.pow(2, attempt);
          console.log(`[AI/OpenRouter] Retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        callbacks.onError(this.#formatUserError(err, statusCode));
        return;
      }
    }
  }

  async *#streamOpencode(
    query: string,
    options: StreamOptions,
  ): AsyncGenerator<string> {
    const { includeClipboard = false, callbacks, signal } = options;

    console.log("[AI/OpenCode] Starting with SDK");

    try {
      let contextContent = "";

      if (includeClipboard) {
        const clipboardText = await this.#readClipboard();
        if (clipboardText && clipboardText.trim()) {
          contextContent = `User clipboard: ${clipboardText.trim()}\n\n`;
        }
      }

      const fullMessage = contextContent + query;
      console.log("[AI/OpenCode] Full message:", fullMessage.slice(0, 200));

      // Get client (reuse if available)
      const client = await this.#ensureOpencodeClient();

      // Reuse existing session or create new one
      let sessionId = this.#sessionId;
      if (!sessionId) {
        console.log("[AI/OpenCode] Creating new session...");
        // deno-lint-ignore no-explicit-any
        const session = await (client.session.create as any)({
          body: {
            title: "DG AI Query",
            permission: [
              { permission: "bash", pattern: "*", action: "allow" },
            ],
          },
        });
        sessionId = session.data?.id;
        if (!sessionId) {
          callbacks.onError("Failed to create session");
          return;
        }
        this.#sessionId = sessionId;
        console.log("[AI/OpenCode] Session created:", sessionId);
      } else {
        console.log("[AI/OpenCode] Reusing session:", sessionId);
      }

      // Send message asynchronously
      console.log("[AI/OpenCode] Sending async message...");
      await client.session.promptAsync({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: fullMessage }],
        },
      });

      console.log("[AI/OpenCode] Async message sent, polling for response...");

      // Poll for messages
      let done = false;
      let lastMessageId = "";
      const handledToolCalls = new Set<string>();

      while (!done && !signal?.aborted) {
        await new Promise((r) => setTimeout(r, 500));

        // Get messages
        const messagesResp = await client.session.messages({
          path: { id: sessionId },
          query: { limit: 50 },
        });

        const messages = messagesResp.data || [];

        if (messages.length === 0) {
          console.log("[AI/OpenCode] No messages yet, continuing poll...");
          continue;
        }

        // Find the latest ASSISTANT message
        let latestWrapper = null;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.info?.role === "assistant") {
            latestWrapper = messages[i];
            break;
          }
        }

        if (!latestWrapper) {
          latestWrapper = messages[messages.length - 1];
        }

        if (!latestWrapper?.info) {
          console.log("[AI/OpenCode] No valid message wrapper, continuing...");
          continue;
        }

        const latestMsg = latestWrapper.info;
        const msgId = latestMsg.id;
        const isUserMsg = latestMsg.role === "user";

        // AssistantMessage has error and time.completed, UserMessage doesn't
        const assistantMsg = latestMsg as {
          error?: unknown;
          time?: { completed?: number };
        };
        const hasError = !!assistantMsg.error;
        const isComplete = !!assistantMsg.time?.completed;

        console.log(
          "[AI/OpenCode] Message:",
          msgId,
          "role:",
          latestMsg.role,
          "completed:",
          isComplete,
          "error:",
          hasError,
        );

        // Get parts with separate call
        const msgResp = await client.session.message({
          path: { id: sessionId, messageID: msgId },
        });

        const parts = msgResp.data?.parts || [];

        console.log(
          "[AI/OpenCode] Got",
          parts.length,
          "parts for message",
          msgId,
        );

        if (msgId === lastMessageId && (isComplete || hasError || isUserMsg)) {
          console.log("[AI/OpenCode] Message complete, done");
          done = true;
        }

        if (isUserMsg) {
          console.log(
            "[AI/OpenCode] User message, waiting for assistant response...",
          );
          lastMessageId = msgId;
          continue;
        }

        lastMessageId = msgId;

        // Process parts
        for (const part of parts) {
          if (signal?.aborted) break;

          if (part.type === "text" && part.text) {
            console.log("[AI/OpenCode] Text:", part.text.slice(0, 50));
            callbacks.onText(part.text);
            yield part.text;
          }

          if (part.type === "tool") {
            console.log(
              "[AI/OpenCode] Tool:",
              part.tool,
              "state:",
              part.state?.status,
              "callID:",
              part.callID,
            );

            // With "allow" permission, tool executes immediately - just notify user
            if (
              (part.state?.status === "pending" ||
                part.state?.status === "running") &&
              part.callID && !handledToolCalls.has(part.callID)
            ) {
              handledToolCalls.add(part.callID);

              const toolName = part.tool;
              const toolInput = part.state.input || {};
              const command = toolInput.command as string || "";

              console.log("[AI/OpenCode] Tool executing:", command);

              // Show informational notification (non-blocking) instead of blocking dialog
              callbacks.onToolRequest(toolName, toolInput);

              // No need to respond to permission - "allow" handles it
              callbacks.onToolResult(`Running: ${command}`);
            }

            if (part.state?.status === "completed") {
              const output = part.state.output || "";
              console.log(
                "[AI/OpenCode] Tool completed, output:",
                output.slice(0, 100),
              );
              // Show the actual output
              callbacks.onToolResult(`Output: ${output.slice(0, 200)}`);
            }

            if (part.state?.status === "error") {
              const error = part.state.error || "Unknown error";
              console.log("[AI/OpenCode] Tool error:", error);
              callbacks.onToolResult(`Error: ${error}`);
            }
          }

          if (part.type === "step-finish") {
            console.log("[AI/OpenCode] Step finished, reason:", part.reason);
            if (part.reason === "stop" || part.reason === "length") {
              done = true;
            }
          }
        }
      }

      console.log("[AI/OpenCode] Done");
      callbacks.onDone();
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        console.log("[AI/OpenCode] Request aborted");
        return;
      }
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error("[AI/OpenCode] Error:", errMsg);
      callbacks.onError(errMsg);
    } finally {
      // Keep server alive for next request - don't close it
      // The server will be reused on next query
      console.log("[AI/OpenCode] Keeping server alive for next request");
    }
  }

  async #executeBash(command: string): Promise<string> {
    console.log("[AI/OpenCode] Executing bash:", command);
    try {
      const parts = command.split(" ");
      const cmd = new Deno.Command(parts[0], {
        args: parts.slice(1),
        stdout: "piped",
        stderr: "piped",
      });
      const { stdout, stderr } = await cmd.output();

      const stdoutText = new TextDecoder().decode(stdout);
      const stderrText = new TextDecoder().decode(stderr);

      return stdoutText || stderrText || "Command completed with no output";
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  #formatUserError(error: Error, statusCode?: number): string {
    console.error("[AI/OpenRouter] Final error:", {
      statusCode,
      message: error.message,
    });

    switch (statusCode) {
      case 401:
        return "Invalid API key. Check your openrouterApiKey in config.";
      case 402:
        return "No credits remaining. Add credits at openrouter.ai";
      case 429:
        return "Rate limited. Try again in a moment.";
      case 503:
        return "Service unavailable. Try again later.";
      default:
        return error.message || "An error occurred";
    }
  }

  async #readClipboard(): Promise<string> {
    try {
      if (Deno.build.os === "linux") {
        const cmd = new Deno.Command("wl-paste", {
          stdout: "piped",
          stderr: "piped",
        });
        const { stdout } = await cmd.output();
        return new TextDecoder().decode(stdout);
      } else if (Deno.build.os === "windows") {
        const cmd = new Deno.Command("powershell", {
          args: ["-Command", "Get-Clipboard"],
          stdout: "piped",
          stderr: "piped",
        });
        const { stdout } = await cmd.output();
        return new TextDecoder().decode(stdout);
      }
    } catch {
      return "";
    }
    return "";
  }

  clearConversation() {
    // Clear the session so a new one is created next time
    this.#sessionId = undefined;
  }

  hasConversation(): boolean {
    return !!this.#sessionId;
  }
}
