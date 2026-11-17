import type { SearchResult, Source } from "../interface.ts";
import {
  ConfigManager,
  defaultOpencodeTools,
  type OpencodeConfig,
} from "../../config.ts";
import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";
import { readClipboard } from "../../utils/clipboard.ts";

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
  onClearThoughts?: () => void;
}

export class AiSource implements Source {
  id = "ai";
  name = "AI Assistant";
  description = "Ask AI questions via OpenCode";
  trigger = "ai";
  #configManager: ConfigManager;
  #opencodeInstance?: Awaited<ReturnType<typeof createOpencode>>;
  #opencodeClient?: Awaited<ReturnType<typeof createOpencode>>["client"];
  #enabled = false;
  #sessionId?: string;
  #abortController?: AbortController;

  #initializingOpencode: Promise<OpencodeClient> | null = null;
  #currentModel?: string;
  #opencodeConfig?: OpencodeConfig;

  constructor(config = new ConfigManager()) {
    this.#configManager = config;
  }

  async init(): Promise<void> {
    this.#opencodeConfig = await this.#configManager.getOpencodeConfig();
    this.#currentModel = await this.#configManager.getModel();

    this.#enabled = true;
    void this.#warmupOpencode();
  }

  async #warmupOpencode(): Promise<void> {
    try {
      await this.#ensureOpencodeClient();
      console.log("[AI/OpenCode] Server pre-warmed and ready");
    } catch (e) {
      console.log("[AI/OpenCode] Pre-warm failed:", e);
    }
  }

  async #ensureOpencodeClient(): Promise<OpencodeClient> {
    if (!this.#enabled) throw new Error("AI Assistant is disabled");
    if (this.#opencodeClient) return this.#opencodeClient;
    const initializing = this.#initializingOpencode ??= this
      .#createOpencodeClient();
    try {
      return await initializing;
    } finally {
      if (this.#initializingOpencode === initializing) {
        this.#initializingOpencode = null;
      }
    }
  }

  #getPermissionConfig(): {
    bash?: "allow" | "deny" | "ask";
    read?: "allow" | "deny" | "ask";
    grep?: "allow" | "deny" | "ask";
    glob?: "allow" | "deny" | "ask";
    edit?: "allow" | "deny" | "ask";
    write?: "allow" | "deny" | "ask";
    task?: "allow" | "deny" | "ask";
    external_directory?: "allow" | "deny" | "ask";
  } {
    const tools = this.#opencodeConfig?.tools;
    const t = tools ?? defaultOpencodeTools;
    return {
      bash: t.bash ? "allow" : "deny",
      read: t.read ? "allow" : "deny",
      grep: t.grep ? "allow" : "deny",
      glob: t.glob ? "allow" : "deny",
      edit: t.edit ? "allow" : "deny",
      write: t.write ? "allow" : "deny",
      task: t.task ? "allow" : "deny",
      external_directory: t.external_directory ? "allow" : "deny",
    };
  }

  async #createOpencodeClient(): Promise<OpencodeClient> {
    console.log("[AI/OpenCode] Spawning new server...");

    // Create abort controller for cleanup
    const controller = this.#abortController = new AbortController();

    try {
      const opencode = await createOpencode({
        timeout: 30000,
        port: 0,
        signal: controller.signal,
        config: {
          permission: this.#getPermissionConfig(),
          model: this.#currentModel,
        },
      });
      if (controller.signal.aborted) {
        opencode.server.close();
        throw controller.signal.reason;
      }
      this.#opencodeInstance = opencode;
      this.#opencodeClient = opencode.client;
      console.log("[AI/OpenCode] Created server at:", opencode.server.url);
      return opencode.client;
    } catch (createErr) {
      console.log("[AI/OpenCode] Failed to create server:", createErr);
      throw new Error("OpenCode not available");
    }
  }

  getProvider(): string {
    return "opencode";
  }

  getModel(): string | undefined {
    return this.#currentModel;
  }

  // deno-lint-ignore require-await
  async search(query: string): Promise<SearchResult[]> {
    if (!this.#enabled) return [];

    if (!query.trim()) {
      return [{
        title: "AI (OpenCode)",
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

    yield* this.#streamOpencode(query, {
      includeClipboard,
      callbacks,
      signal,
    });
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
        const clipboardText = await readClipboard();
        if (clipboardText && clipboardText.trim()) {
          contextContent = `User clipboard: ${clipboardText.trim()}\n\n`;
        }
      }

      const fullMessage = contextContent + query;
      console.log("[AI/OpenCode] Full message:", fullMessage.slice(0, 200));

      // Get client (reuse if available)
      const client = await this.#ensureOpencodeClient();
      if (signal?.aborted || client !== this.#opencodeClient) return;

      // Reuse existing session or create new one
      let sessionId = this.#sessionId;
      if (!sessionId) {
        console.log("[AI/OpenCode] Creating new session...");
        const session = await client.session.create({
          signal,
          body: {
            title: "DG AI Query",
          },
        });
        if (signal?.aborted || client !== this.#opencodeClient) return;
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
        signal,
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: fullMessage }],
        },
      });

      console.log("[AI/OpenCode] Async message sent, listening for events...");

      const events = await client.event.subscribe({ signal });
      const handledToolCalls = new Set<string>();
      const partIdToType = new Map<string, string>();
      let done = false;
      let lastMessageId = "";

      for await (const event of events.stream) {
        const eventProps = event.properties as Record<string, unknown>;
        const eventSessionId = eventProps.sessionID as string | undefined;

        if (eventSessionId !== sessionId) {
          continue;
        }

        if (signal?.aborted) {
          break;
        }

        const eventType = event.type as string;

        if (eventType === "session.idle") {
          console.log("[AI/OpenCode] Session idle, done");
          done = true;
        }

        if (eventType === "permission.asked") {
          console.log(
            "[AI/OpenCode] Permission asked:",
            (eventProps as { permission?: string }).permission,
          );
        }

        if (eventType === "permission.replied") {
          console.log(
            "[AI/OpenCode] Permission replied:",
            JSON.stringify(eventProps).slice(0, 100),
          );
        }

        if (eventType === "message.part.delta") {
          const deltaProps = eventProps as {
            delta?: string;
            messageID?: string;
            partID?: string;
          };
          if (deltaProps.delta) {
            lastMessageId = deltaProps.messageID || "";

            const partType = partIdToType.get(deltaProps.partID || "");

            if (partType === "text" || !partType) {
              callbacks.onText(deltaProps.delta);
              yield deltaProps.delta;
            }
          }
        }

        if (eventType === "message.part.updated") {
          const partProps = eventProps as {
            part?: {
              id?: string;
              type?: string;
              tool?: string;
              state?: {
                status?: string;
                input?: Record<string, unknown>;
                output?: string;
                error?: string;
              };
              callID?: string;
              reason?: string;
            };
          };
          const part = partProps.part;

          if (part?.id && part.type) {
            partIdToType.set(part.id, part.type);
          }

          if (part?.type === "step-finish") {
            callbacks.onClearThoughts?.();
          }

          if (part?.type === "tool" && part.state) {
            if (part.callID && !handledToolCalls.has(part.callID)) {
              if (
                part.state.input && Object.keys(part.state.input).length > 0
              ) {
                handledToolCalls.add(part.callID);
                const toolName = part.tool || "unknown";
                const toolInput = (part.state.input || {}) as Record<
                  string,
                  unknown
                >;

                let toolDesc = `Using tool: ${toolName}`;
                const path = toolInput.path || toolInput.filePath ||
                  toolInput.file;
                const command = toolInput.command || toolInput.script ||
                  toolInput.code;

                if (command) {
                  toolDesc = `Running: ${command}`;
                } else if (path) {
                  const action = toolName === "read"
                    ? "Reading"
                    : toolName === "write"
                    ? "Writing"
                    : toolName === "edit"
                    ? "Editing"
                    : "Accessing";
                  toolDesc = `${action}: ${path}`;
                } else if (toolInput.pattern) {
                  toolDesc = `Searching for: ${toolInput.pattern}`;
                } else {
                  // Fallback: show first key/value if available
                  const keys = Object.keys(toolInput);
                  if (keys.length > 0) {
                    const firstVal = String(toolInput[keys[0]]);
                    toolDesc = `${toolName}: ${firstVal.slice(0, 50)}${
                      firstVal.length > 50 ? "..." : ""
                    }`;
                  }
                }

                callbacks.onToolRequest(toolName, toolInput);
                callbacks.onToolResult(toolDesc);
              }
            }

            if (part.state.status === "completed") {
              const output = part.state.output || "";
              callbacks.onToolResult(`Output: ${output.slice(0, 200)}`);
            }

            if (part.state.status === "error") {
              const error = part.state.error || "Unknown error";
              callbacks.onToolResult(`Error: ${error}`);
            }
          }

          if (part?.type === "step-finish") {
            if (
              part.reason === "stop" || part.reason === "length"
            ) {
              done = true;
            }
          }
        }

        if (eventType === "message.updated") {
          const msgProps = eventProps as {
            info?: {
              id?: string;
              finish?: string;
              time?: { completed?: number };
              error?: unknown;
            };
          };
          const info = msgProps.info;

          if (info) {
            lastMessageId = info.id || lastMessageId;

            if (info.error) {
              callbacks.onError(String(info.error));
              done = true;
            }
          }
        }

        if (done) {
          break;
        }
      }

      try {
        // @ts-ignore - cancel method may not be in types
        events.stream.cancel?.();
      } catch {
        // Ignore errors during cleanup
      }

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

  clearConversation() {
    // Clear the session so a new one is created next time
    this.#sessionId = undefined;
  }

  hasConversation(): boolean {
    return !!this.#sessionId;
  }

  async setModel(model: string): Promise<boolean> {
    try {
      this.#currentModel = model;
      await this.#configManager.setModel(model);

      // Reset existing connection to use new model on next request
      await this.#disconnect();

      // Clear session so we start fresh with the new model
      this.clearConversation();

      // Pre-warm with the new model
      if (this.#enabled) void this.#warmupOpencode();
      return true;
    } catch (e) {
      console.error("[AI/OpenCode] Failed to set model:", e);
      return false;
    }
  }

  destroy(): Promise<void> {
    this.#enabled = false;
    return this.#disconnect();
  }

  async #disconnect(): Promise<void> {
    const initializing = this.#initializingOpencode;
    this.#abortController?.abort();
    this.#abortController = undefined;
    this.#opencodeInstance?.server.close();
    this.#sessionId = undefined;
    this.#opencodeClient = undefined;
    this.#opencodeInstance = undefined;
    await initializing?.catch(() => {});
  }
}
