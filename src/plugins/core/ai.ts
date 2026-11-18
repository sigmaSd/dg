import type { SearchResult, Source } from "../interface.ts";
import { ConfigManager } from "../../config.ts";
import { readClipboard } from "../../utils/clipboard.ts";
import { Opencode, type OpencodeModel } from "./opencode.ts";

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
  #opencode?: Opencode;
  #sessionId?: string;
  #selectedModel?: string;
  #defaultModel?: string;
  #active?: AbortController;

  constructor(config = new ConfigManager()) {
    this.#configManager = config;
  }

  async init(): Promise<void> {
    const settings = await this.#configManager.getOpencodeConfig();
    this.#selectedModel = settings?.model?.trim() || undefined;
    this.#opencode = await Opencode.open(settings?.tools);
  }

  getModel(): string | undefined {
    return this.#selectedModel ?? this.#defaultModel;
  }

  getDefaultModel(): string | undefined {
    return this.#defaultModel;
  }

  async listModels(signal: AbortSignal): Promise<OpencodeModel[]> {
    const opencode = this.#opencode;
    if (!opencode) throw new Error("AI Assistant is disabled.");
    const { models, defaultModel } = await opencode.models(signal);
    if (this.#opencode === opencode) this.#defaultModel = defaultModel;
    return models;
  }

  search(query: string): Promise<SearchResult[]> {
    const results: SearchResult[] = this.#opencode
      ? [{
        title: query.trim() ? "🤖 AI Response" : "AI (OpenCode)",
        subtitle: query.trim()
          ? "Streaming..."
          : `Type '${this.trigger} <question>' to ask anything`,
        icon: "dialog-information",
        score: 100,
        ...(query.trim() ? { id: "ai-stream" } : {}),
        onActivate: () => {},
      }]
      : [];
    return Promise.resolve(results);
  }

  async *streamResponse(
    query: string,
    { includeClipboard = false, callbacks, signal }: StreamOptions,
  ): AsyncGenerator<string> {
    this.#active?.abort();
    const active = this.#active = new AbortController();
    const runSignal = signal
      ? AbortSignal.any([active.signal, signal])
      : active.signal;
    try {
      const opencode = this.#opencode;
      if (!opencode) throw new Error("AI Assistant is disabled.");
      const clipboard = includeClipboard ? (await readClipboard()).trim() : "";
      const prompt = clipboard
        ? `User clipboard: ${clipboard}\n\n${query}`
        : query;
      const calls = new Set<string>();
      for await (
        const event of opencode.run(prompt, {
          model: this.#selectedModel,
          sessionId: this.#sessionId,
          signal: runSignal,
        })
      ) {
        if (runSignal.aborted) return;
        if (event.sessionID) this.#sessionId = event.sessionID;
        const part = event.part;
        if (event.type === "text" && part?.text) {
          callbacks.onText(part.text);
          yield part.text;
        } else if (event.type === "tool_use" && part?.tool && part.state) {
          if (!part.callID || !calls.has(part.callID)) {
            if (part.callID) calls.add(part.callID);
            callbacks.onToolRequest(part.tool, part.state.input ?? {});
          }
          if (part.state.status === "completed") {
            callbacks.onToolResult(
              `Output: ${(part.state.output ?? "").slice(0, 200)}`,
            );
          } else if (part.state.status === "error") {
            callbacks.onToolResult(
              `Error: ${part.state.error ?? "Unknown error"}`,
            );
          }
        } else if (event.type === "step_finish") {
          callbacks.onClearThoughts?.();
        } else if (event.type === "error") {
          const error = event.error;
          throw new Error(
            typeof error === "string"
              ? error
              : error?.data?.message ?? error?.message ??
                "OpenCode request failed.",
          );
        }
      }
      if (!runSignal.aborted) callbacks.onDone();
    } catch (error) {
      if (!runSignal.aborted) {
        callbacks.onError(
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      if (this.#active === active) this.#active = undefined;
    }
  }

  clearConversation(): void {
    this.#active?.abort();
    this.#sessionId = undefined;
  }

  hasConversation(): boolean {
    return Boolean(this.#sessionId);
  }

  async setModel(model: string): Promise<boolean> {
    try {
      await this.#configManager.setOpencodeConfig({ model });
      this.#selectedModel = model || undefined;
      this.clearConversation();
      return true;
    } catch (error) {
      console.error("Failed to select OpenCode model:", error);
      return false;
    }
  }

  async destroy(): Promise<void> {
    this.clearConversation();
    const opencode = this.#opencode;
    this.#opencode = undefined;
    this.#defaultModel = undefined;
    await opencode?.close();
  }
}
