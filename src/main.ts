/**
 * Main entry point for the DG Launcher application.
 * This module initializes the GTK application and the plugin system.
 * @module
 */

import {
  Align,
  Application,
  Box,
  Entry,
  HeaderBar,
  Image,
  Label,
  ListBox,
  ListBoxRow,
  Orientation,
  ScrolledWindow,
} from "@sigmasd/gtk/gtk4";
import {
  AdwApplicationWindow,
  MessageDialog,
  Spinner,
  ToolbarView,
} from "@sigmasd/gtk/adw";
import { EventLoop } from "@sigmasd/gtk/eventloop";
import type { SearchResult, Source } from "./plugins/interface.ts";
import { PluginLoader } from "./loader.ts";
import { SimpleAction } from "@sigmasd/gtk/gio";
import type { AiSource } from "./plugins/core/ai.ts";
import { readClipboard } from "./utils/clipboard.ts";
import { Fzf } from "fzf";
import type { CachedModel } from "./config.ts";

const APP_ID = "io.github.sigmasd.dg";
const APP_FLAGS = 0;
const DEBUG = Deno.env.get("DEBUG") === "1";

function debug(...args: unknown[]) {
  if (DEBUG) console.log(...args);
}

class DGApp {
  #app: Application;
  #win?: AdwApplicationWindow;
  #eventLoop: EventLoop;
  #listBox?: ListBox;
  #searchEntry?: Entry;
  #statusLabel?: Label;
  #spinner?: Spinner;
  #bottomBox?: Box;
  #modelLabel?: Label;
  #scrolledWindow?: ScrolledWindow;

  #loader: PluginLoader;
  #plugins: Source[] = [];
  #aiSource?: AiSource;
  #currentResults: SearchResult[] = [];
  #latestSearchId = 0;
  #debounceTimer: number | null = null;
  #aiMode = false;
  #aiText = "";
  #aiMessages: { role: "user" | "assistant"; content: string }[] = [];
  #aiAbortController: AbortController | null = null;
  #aiFollowupTimer: number | null = null;

  #modelMode = false;
  #modelList: CachedModel[] = [];
  #fuse: Fzf<CachedModel[]> | null = null;
  #modelFilterFree = false;
  #savedAiMode = false;

  constructor() {
    this.#app = new Application(APP_ID, APP_FLAGS);
    this.#eventLoop = new EventLoop({ pollInterval: 16 });
    this.#loader = new PluginLoader();

    this.#app.onActivate(() => {
      if (!this.#win) {
        this.#buildUI();
        void this.#initPlugins();
        this.#setupActions();
      }
      this.#win?.present();
      // Focus the entry and select the text
      this.#searchEntry?.grabFocus();
      this.#searchEntry?.selectRegion(0, -1);
    });
  }

  async #initPlugins() {
    console.log("Loading plugins...");
    this.#setLoading(true, "Loading plugins...");
    this.#plugins = await this.#loader.loadPlugins(this.#win);

    // Get AI source reference
    this.#aiSource = this.#plugins.find((p) => p.id === "ai") as
      | AiSource
      | undefined;

    // Pre-warm models list
    void this.#fetchModels();

    this.#setLoading(false);
    // Use the current text in the entry if the user already started typing
    const currentQuery = this.#searchEntry?.getText() || "";
    void this.#updateSearch(currentQuery);
  }

  #setLoading(loading: boolean, message?: string) {
    if (this.#spinner) {
      this.#spinner.setVisible(loading);
    }
    if (this.#statusLabel) {
      this.#statusLabel.setText(message || "");
    }
    if (this.#bottomBox) {
      this.#bottomBox.setVisible(loading || !!message);
    }
  }

  #showModelInStatus() {
    const model = this.#aiSource?.getModel();
    const modelName = model ? model.split("/").pop() : "default";
    if (this.#modelLabel) {
      this.#modelLabel.setText(modelName || "");
    }
    if (this.#bottomBox) {
      this.#bottomBox.setVisible(true);
    }
  }

  #clearStatus() {
    if (this.#statusLabel) {
      this.#statusLabel.setText("");
    }
    if (this.#modelLabel) {
      this.#modelLabel.setText("");
    }
    if (this.#bottomBox) {
      this.#bottomBox.setVisible(false);
    }
  }

  #setupActions() {
    if (!this.#win) return;

    // Quit Action (Ctrl+Q)
    const quitAction = new SimpleAction("quit");
    quitAction.connect("activate", async () => {
      // Clear AI conversation
      this.#aiSource?.clearConversation();

      // Show feedback while waiting for cleanup
      this.#setLoading(true, "Closing OpenCode...");

      // Cleanup all plugins
      for (const plugin of this.#plugins) {
        try {
          if (plugin.id === "ai") {
            // AI plugin needs to wait for port
            await (plugin as { destroy?(waitForPort: boolean): Promise<void> })
              .destroy?.(true);
          } else {
            await plugin.destroy?.();
          }
        } catch (e) {
          console.error(`Error cleaning up plugin ${plugin.id}:`, e);
        }
      }

      this.#setLoading(false);

      if (this.#win) {
        this.#win.destroy();
        this.#win = undefined;
      }
      this.#eventLoop.stop();
      this.#app.quit();
      Deno.exit(0);
    });
    this.#win.addAction(quitAction);
    this.#app.setAccelsForAction("win.quit", ["<Control>q"]);

    // Hide Action (Escape)
    const hideAction = new SimpleAction("hide");
    hideAction.connect("activate", () => {
      if (this.#modelMode) {
        this.#exitModelMode();
        return;
      }
      if (this.#aiMode) {
        this.#exitAiMode();
        this.#setLoading(false);
        if (this.#searchEntry) {
          this.#searchEntry.setText("");
        }
        this.#updateSearch("");
      } else {
        this.#win?.setVisible(false);
      }
    });
    this.#win.addAction(hideAction);
    this.#app.setAccelsForAction("win.hide", ["Escape"]);

    // Model Picker (Ctrl+M)
    const modelAction = new SimpleAction("models");
    modelAction.connect("activate", () => {
      if (this.#modelMode && !this.#modelFilterFree) {
        this.#exitModelMode();
      } else {
        this.#modelFilterFree = false;
        void this.#enterModelMode();
      }
    });
    this.#win.addAction(modelAction);
    this.#app.setAccelsForAction("win.models", ["<Control>m"]);

    // Free Model Picker (Ctrl+Shift+M)
    const freeModelsAction = new SimpleAction("free-models");
    freeModelsAction.connect("activate", () => {
      if (this.#modelMode && this.#modelFilterFree) {
        this.#exitModelMode();
      } else {
        this.#modelFilterFree = true;
        void this.#enterModelMode();
      }
    });
    this.#win.addAction(freeModelsAction);
    this.#app.setAccelsForAction("win.free-models", ["<Control><Shift>m"]);
  }

  #buildUI() {
    if (this.#win) return;

    this.#win = new AdwApplicationWindow(this.#app);
    this.#win.setTitle("DG");
    this.#win.setDefaultSize(600, 500);

    const toolbarView = new ToolbarView();
    const headerBar = new HeaderBar();
    toolbarView.addTopBar(headerBar);

    const contentBox = new Box(Orientation.VERTICAL, 0);

    // Search Entry
    const searchBox = new Box(Orientation.VERTICAL, 0);
    searchBox.setMarginTop(12);
    searchBox.setMarginBottom(12);
    searchBox.setMarginStart(12);
    searchBox.setMarginEnd(12);

    this.#searchEntry = new Entry();
    this.#searchEntry.setProperty(
      "placeholder-text",
      "Type to search apps, or 'ai <question>' for AI...",
    );
    this.#searchEntry.onChanged(() => {
      if (this.#debounceTimer !== null) {
        clearTimeout(this.#debounceTimer);
      }
      this.#debounceTimer = setTimeout(() => {
        this.#debounceTimer = null;
        this.#onSearchChanged();
      }, 150);
    });
    this.#searchEntry.onActivate(() => {
      if (this.#modelMode) {
        void this.#activateResult(0);
        return;
      }
      if (this.#aiMode && this.#aiSource) {
        // In AI mode, Enter sends follow-up
        const rawQuery = this.#searchEntry?.getText() || "";
        // Strip "ai " prefix for follow-ups too
        const query = rawQuery.startsWith("ai ")
          ? rawQuery.slice(3).trim()
          : rawQuery;
        console.log("[Main] AI follow-up, query:", query);
        if (query.trim()) {
          void this.#enterAiMode(query);
          // Keep "ai " prefix, clear the rest, move cursor to end
          this.#searchEntry?.setText("ai ");
          this.#searchEntry?.selectRegion(3, 3);
        }
      } else {
        // Check if it's an AI trigger
        const query = this.#searchEntry?.getText() || "";
        console.log("[Main] Enter pressed, query:", query);
        if (query.startsWith("ai ") && this.#aiSource) {
          console.log("[Main] Triggering AI");
          const processedQuery = query.slice(3).trim();
          void this.#enterAiMode(processedQuery);
          // Keep "ai " prefix for follow-ups, move cursor to end
          this.#searchEntry?.setText("ai ");
          this.#searchEntry?.selectRegion(3, 3);
        } else {
          void this.#activateResult(0);
          this.#win?.setVisible(false);
        }
      }
    });

    searchBox.append(this.#searchEntry);
    contentBox.append(searchBox);

    // Results List
    this.#scrolledWindow = new ScrolledWindow();
    this.#scrolledWindow.setProperty("vexpand", true);
    this.#scrolledWindow.setProperty("hscrollbar-policy", 2); // GTK_POLICY_NEVER

    this.#listBox = new ListBox();
    this.#listBox.setProperty("selection-mode", 1);
    this.#listBox.setMarginTop(0);
    this.#listBox.setMarginBottom(12);
    this.#listBox.setMarginStart(12);
    this.#listBox.setMarginEnd(12);

    this.#listBox.onRowActivated((_row, index) => {
      if (this.#modelMode) {
        void this.#activateResult(index);
      } else if (!this.#aiMode) {
        void this.#activateResult(index);
        this.#win?.setVisible(false);
      }
    });
    this.#scrolledWindow.setChild(this.#listBox);
    contentBox.append(this.#scrolledWindow);

    toolbarView.setContent(contentBox);

    // Status Bar (Bottom)
    this.#bottomBox = new Box(Orientation.HORIZONTAL, 12);
    this.#bottomBox.setMarginTop(8);
    this.#bottomBox.setMarginBottom(8);
    this.#bottomBox.setMarginStart(12);
    this.#bottomBox.setMarginEnd(12);
    this.#bottomBox.setVisible(false); // Hidden by default

    this.#spinner = new Spinner();
    this.#bottomBox.append(this.#spinner);

    this.#statusLabel = new Label("");
    this.#statusLabel.setHalign(Align.START);
    this.#bottomBox.append(this.#statusLabel);

    // Spacer to push model label to the right
    const spacer = new Box(Orientation.HORIZONTAL, 0);
    spacer.setHexpand(true);
    this.#bottomBox.append(spacer);

    // Right-aligned model label
    this.#modelLabel = new Label("");
    this.#modelLabel.setHalign(Align.END);
    this.#bottomBox.append(this.#modelLabel);

    toolbarView.addBottomBar(this.#bottomBox);

    this.#win.setContent(toolbarView);

    this.#win.onCloseRequest(() => {
      this.#aiSource?.clearConversation();
      this.#win?.setVisible(false);
      return true;
    });

    this.#win.present();
  }

  #onSearchChanged() {
    if (!this.#searchEntry) return;
    const query = this.#searchEntry.getText();

    if (this.#modelMode) {
      this.#updateModelSearch(query);
      return;
    }

    // Only handle non-AI searches here
    // AI mode is triggered on Enter key, not on typing
    // Don't exit AI mode when query is empty (Enter was just pressed)
    if (query && !query.startsWith("ai") && this.#aiMode) {
      // Exit AI mode if user types something else
      this.#exitAiMode();
      this.#updateSearch(query);
    } else if (!this.#aiMode) {
      this.#updateSearch(query);
    }
  }

  #updateModelSearch(query: string) {
    const searchId = ++this.#latestSearchId;
    this.#setLoading(false);

    let list = this.#modelList;
    if (this.#modelFilterFree) {
      list = list.filter((m) => m.isFree);
    }

    let filtered: CachedModel[];
    if (query) {
      const fzfInstance = this.#modelFilterFree
        ? new Fzf(list, {
          selector: (m: CachedModel) =>
            `${m.name} ${m.provider}/${m.id} ${m.provider} ${m.id}`,
        })
        : this.#fuse;

      if (fzfInstance) {
        const entries = fzfInstance.find(query);
        filtered = entries.map((entry: { item: CachedModel }) => entry.item);
      } else {
        filtered = [];
      }
    } else {
      filtered = list;
    }

    // Limit to 40 results for performance
    filtered = filtered.slice(0, 40);

    const results: SearchResult[] = filtered.map((m) => ({
      title: m.name,
      subtitle: `${m.provider}/${m.id}${m.isFree ? " (free)" : ""}`,
      icon: "preferences-system-symbolic",
      score: 100,
      onActivate: async () => {
        this.#setLoading(true, `Switching to ${m.name}...`);
        const success = await this.#aiSource?.setModel(`${m.provider}/${m.id}`);
        this.#setLoading(false);
        if (success) {
          this.#statusLabel?.setText(`Model changed to ${m.name}`);
          setTimeout(() => {
            if (this.#statusLabel?.getText() === `Model changed to ${m.name}`) {
              this.#statusLabel?.setText("");
            }
          }, 3000);
        } else {
          this.#statusLabel?.setText(`Failed to change model`);
          setTimeout(() => {
            if (this.#statusLabel?.getText() === `Failed to change model`) {
              this.#statusLabel?.setText("");
            }
          }, 3000);
        }
        // When activating a model, we want to stay in the app and return to previous mode
        this.#exitModelMode();
      },
    }));

    if (searchId === this.#latestSearchId) {
      this.#currentResults = results;
      this.#renderList(results);
    }
  }

  async #fetchModels() {
    const cached = await this.#loader.configManager.getCachedModels();
    if (cached) {
      this.#modelList = cached;
      this.#fuse = new Fzf(this.#modelList, {
        selector: (m: CachedModel) =>
          `${m.name} ${m.provider}/${m.id} ${m.provider} ${m.id}`,
      });
    }

    // Background fetch fresh models
    try {
      const resp = await fetch("https://models.dev/api.json");
      const data = await resp.json();
      const list: CachedModel[] = [];

      for (const [providerId, providerData] of Object.entries(data)) {
        // deno-lint-ignore no-explicit-any
        const models = (providerData as any).models || {};
        for (const [modelId, modelData] of Object.entries(models)) {
          // deno-lint-ignore no-explicit-any
          const m = modelData as any;
          const name = m.name || modelId;
          const isFree = modelId.toLowerCase().includes("free") &&
            m.status !== "deprecated";

          list.push({
            id: modelId,
            name,
            provider: providerId,
            isFree,
          });
        }
      }

      // Deduplicate and sort
      this.#modelList = list.sort((a, b) =>
        `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`)
      );
      this.#fuse = new Fzf(this.#modelList, {
        selector: (m: CachedModel) =>
          `${m.name} ${m.provider}/${m.id} ${m.provider} ${m.id}`,
      });

      // Update cache
      void this.#loader.configManager.setCachedModels(this.#modelList);
    } catch (e) {
      console.error("Failed to fetch models:", e);
    }
  }

  async #enterModelMode() {
    this.#savedAiMode = this.#aiMode;
    this.#modelMode = true;
    this.#aiMode = false; // Temporarily disable AI mode UI for picker

    if (this.#searchEntry) {
      this.#searchEntry.setText("");
      this.#searchEntry.setProperty(
        "placeholder-text",
        this.#modelFilterFree
          ? "Search free models..."
          : "Search all models...",
      );
      this.#searchEntry.grabFocus();
    }

    if (this.#modelList.length === 0) {
      this.#setLoading(true, "Fetching models...");
      await this.#fetchModels();
      this.#setLoading(false);
    }

    this.#updateModelSearch("");
  }

  #exitModelMode() {
    this.#modelMode = false;
    this.#aiMode = this.#savedAiMode;

    if (this.#searchEntry) {
      this.#searchEntry.setText(this.#aiMode ? "ai " : "");
      this.#searchEntry.setProperty(
        "placeholder-text",
        "Type to search apps, or 'ai <question>' for AI...",
      );
      if (this.#aiMode) {
        this.#searchEntry.selectRegion(3, 3);
      }
    }

    if (!this.#aiMode) {
      this.#updateSearch("");
    } else {
      // Restore AI display
      if (this.#listBox) {
        let child = this.#listBox.getFirstChild();
        while (child) {
          const next = this.#listBox.getNextSibling(child);
          this.#listBox.remove(child);
          child = next;
        }
      }
      // Re-render the AI conversation if we have messages
      for (const msg of this.#aiMessages) {
        this.#updateAiDisplay(msg.role, msg.content);
      }
    }
  }

  async #enterAiMode(query: string) {
    console.log("[Main] #enterAiMode called, query:", query);

    if (!this.#aiSource || !query.trim()) {
      console.log("[Main] Early return - no source or empty query");
      return;
    }

    // Update placeholder to show current model
    this.#updateAiPlaceholder();

    // Replace variables like $cb/$clipboard with actual content
    const resolvedQuery = await this.#resolveVariables(query);
    console.log("[Main] Resolved query:", resolvedQuery);

    // Abort any previous request
    if (this.#aiAbortController) {
      console.log("[Main] Aborting previous request");
      this.#aiAbortController.abort();
    }
    this.#aiAbortController = new AbortController();

    this.#aiMode = true;
    this.#aiText = "";
    this.#setLoading(true, "AI is thinking...");
    this.#updateAiPlaceholder();
    this.#showModelInStatus();

    // Hide list, show streaming text
    if (this.#listBox) {
      let child = this.#listBox.getFirstChild();
      while (child) {
        const next = this.#listBox.getNextSibling(child);
        this.#listBox.remove(child);
        child = next;
      }
    }

    // Show initial user question
    this.#updateAiDisplay("user", query);

    // Start streaming
    const callbacks = {
      onText: (text: string) => {
        console.log("[Main] onText received:", text.slice(0, 50));
        this.#aiText += text;
        this.#updateAiDisplay("assistant");
      },
      onToolRequest: (tool: string, args: Record<string, unknown>) => {
        console.log("[Main] onToolRequest:", tool, args);
        // Save current thinking before clearing for tool output
        if (this.#aiText) {
          this.#aiMessages.push({ role: "assistant", content: this.#aiText });
        }
        this.#aiText = ""; // Clear for next assistant block
        // Silently handle - don't show popup
      },
      onToolResult: (result: string) => {
        console.log("[Main] onToolResult:", result.slice(0, 50));
        this.#aiMessages.push({
          role: "assistant",
          content: `[Tool Output] ${result}`,
        });
        this.#aiText = ""; // Clear for next assistant block
        this.#updateAiDisplay("assistant", `[Tool Output] ${result}`);
      },
      onDone: () => {
        console.log("[Main] onDone");
        if (this.#aiText) {
          this.#aiMessages.push({ role: "assistant", content: this.#aiText });
          this.#aiText = "";
        }
        if (this.#spinner) this.#spinner.setVisible(false);
        if (this.#statusLabel) this.#statusLabel.setText("");
        this.#showModelInStatus();
        if (this.#searchEntry) {
          this.#searchEntry.setText("ai ");
          this.#searchEntry.selectRegion(3, 3);
        }
        this.#updateAiPlaceholder();
      },
      onError: (error: string) => {
        console.log("[Main] onError:", error);
        this.#setLoading(true, `Error: ${error}`);
      },
    };

    console.log("[Main] Calling streamResponse...");
    try {
      for await (
        const _ of this.#aiSource.streamResponse(resolvedQuery, {
          callbacks,
          signal: this.#aiAbortController.signal,
        })
      ) {
        // Stream updates happen via callbacks
      }
      console.log("[Main] streamResponse completed");
    } catch (e) {
      console.log("[Main] streamResponse error:", e);
    }
  }

  #updateAiDisplay(
    role: "user" | "assistant" | "tool" = "assistant",
    text?: string,
  ) {
    if (!this.#listBox) return;

    const content = text || this.#aiText;
    if (!content) return;

    const row = new ListBoxRow();
    const mainBox = new Box(Orientation.VERTICAL, 4);
    mainBox.setMarginTop(8);
    mainBox.setMarginBottom(8);
    mainBox.setMarginStart(12);
    mainBox.setMarginEnd(12);

    const label = new Label("");
    label.setProperty("xalign", 0);
    label.setProperty("wrap", true);
    label.setProperty("wrap-mode", 2); // WORD
    label.setProperty("width-chars", 50);

    let bgColor = "";
    let prefix = "";
    let opacity = "100%";

    if (role === "user") {
      bgColor = "rgba(100, 100, 255, 0.1)";
      prefix = "<b>You:</b> ";
    } else if (role === "tool") {
      bgColor = "rgba(150, 150, 150, 0.1)";
      prefix = "<i>[Tool]</i> ";
      opacity = "80%";
    } else {
      prefix = "<b>AI:</b> ";
    }

    const markup = this.#convertToPango(content);
    label.setMarkup(
      `<span alpha="${opacity}">${prefix}${markup}</span>`,
    );

    if (bgColor) {
      // We can't easily set background color of a Box without CSS in GTK4
      // but we can at least style the text differently.
      // For now, let's just use the prefix and opacity.
    }

    mainBox.append(label);
    row.setChild(mainBox);

    // If assistant is streaming, we update the LAST row if it's an assistant row
    const lastRow = this.#listBox.getLastChild() as ListBoxRow | null;
    let updated = false;

    if (role === "assistant" && lastRow) {
      const lastBox = lastRow.getChild() as Box;
      const lastLabel = lastBox.getFirstChild() as Label;
      const lastText = lastLabel.getText();

      // Check if it's an assistant row (starts with AI:)
      // Note: getText() returns the plain text without markup
      if (lastText.startsWith("AI: ")) {
        lastLabel.setMarkup(
          `<span alpha="${opacity}">${prefix}${markup}</span>`,
        );
        updated = true;
      }
    }

    if (!updated) {
      this.#listBox.append(row);
    }

    // Auto-scroll to bottom
    const adjustment = this.#scrolledWindow?.getVadjustment();
    if (adjustment) {
      // Use a small timeout to ensure GTK has updated the layout
      setTimeout(() => {
        adjustment.setValue(adjustment.getUpper() - adjustment.getPageSize());
      }, 50);
    }
  }

  #convertToPango(text: string): string {
    let escaped = this.#escapeMarkup(text);

    // Basic markdown conversion
    // Code blocks: ```code``` -> <tt>code</tt>
    escaped = escaped.replace(
      /```([\s\S]*?)```/g,
      '<tt><span background="#333" foreground="#eee">$1</span></tt>',
    );

    // Inline code: `code` -> <tt>code</tt>
    escaped = escaped.replace(/`([^`]+)`/g, "<tt>$1</tt>");

    // Bold: **text** -> <b>text</b>
    escaped = escaped.replace(/\*\*([^\*]+)\*\*/g, "<b>$1</b>");

    // Italic: *text* -> <i>text</i>
    escaped = escaped.replace(/\*([^\*]+)\*/g, "<i>$1</i>");

    // Newlines to <br/> is not needed for Pango in a wrapping label,
    // but multiple spaces/newlines might need handling.
    // Actually, Pango handles \n fine in labels.

    return escaped;
  }

  #exitAiMode() {
    this.#aiMode = false;
    this.#aiText = "";
    this.#aiMessages = [];
    if (this.#aiAbortController) {
      this.#aiAbortController.abort();
      this.#aiAbortController = null;
    }
    if (this.#aiSource) {
      this.#aiSource.clearConversation();
    }
    this.#resetPlaceholder();
    this.#clearStatus();
  }

  #updateAiPlaceholder() {
    const model = this.#aiSource?.getModel();
    const modelName = model ? model.split("/").pop() : "default";
    if (this.#searchEntry) {
      this.#searchEntry.setProperty(
        "placeholder-text",
        `Ask AI (${modelName})...`,
      );
    }
  }

  #resetPlaceholder() {
    if (this.#searchEntry) {
      this.#searchEntry.setProperty(
        "placeholder-text",
        "Type to search apps, or 'ai <question>' for AI...",
      );
    }
  }

  #updateSearch(query: string) {
    const searchId = ++this.#latestSearchId;
    const t0 = DEBUG ? performance.now() : 0;
    this.#setLoading(false);

    let results: SearchResult[] = [];

    const parts = query.split(" ");
    const trigger = parts[0];
    const args = parts.slice(1).join(" ");

    // Check for AI trigger - only activate on Enter, just show placeholder here
    if (trigger === "ai") {
      const model = this.#aiSource?.getModel();
      const modelName = model ? model.split("/").pop() : "default";
      const hasClipboard = args.includes("$clipboard") || args.includes("$cb");

      if (parts.length === 1) {
        results = [{
          title: `Ask AI (${modelName})`,
          subtitle: hasClipboard
            ? "Press Enter with clipboard context"
            : "Type a question and press Enter",
          icon: "dialog-information",
          score: 100,
          onActivate: () => {},
        }];
      } else {
        results = [{
          title: `Ask AI (${modelName})`,
          subtitle: "Press Enter to send",
          icon: "dialog-information",
          score: 100,
          id: "ai-placeholder",
          onActivate: () => {},
        }];
      }

      this.#currentResults = results;
      this.#renderList(results);
      return;
    }

    // Check if a plugin matches the specific trigger
    // Only trigger if there is at least one space after the trigger
    const triggeredPlugin = parts.length > 1
      ? this.#plugins.find((p) => p.trigger === trigger)
      : undefined;

    const handleResults = (newResults: SearchResult[]) => {
      if (searchId !== this.#latestSearchId) return;
      results = results.concat(newResults);
      const sorted = [...results].sort((a, b) => b.score - a.score).slice(
        0,
        20,
      );
      this.#currentResults = sorted;
      const t1 = DEBUG ? performance.now() : 0;
      this.#renderList(sorted);
      if (DEBUG) {
        debug(
          `[Search] total: ${
            (t1 - t0).toFixed(1)
          }ms, results: ${sorted.length}`,
        );
      }
    };

    const handleDone = () => {
      if (searchId === this.#latestSearchId) {
        this.#setLoading(false);
      }
    };

    if (triggeredPlugin) {
      // Specific plugin search - fire async
      this.#setLoading(true, `Searching ${triggeredPlugin.id}...`);
      triggeredPlugin.search(args).then((r) => {
        handleResults(r);
        handleDone();
      });
    } else {
      // Global search - fire all at once, no blocking
      const globalPlugins = this.#plugins.filter((p) => !p.trigger);
      let pending = globalPlugins.length;

      for (const plugin of globalPlugins) {
        plugin.search(query).then((pluginResults) => {
          handleResults(pluginResults);
          pending--;
          if (pending === 0) handleDone();
        });
      }
      // Hide loading immediately - results will come async
      this.#setLoading(false);
    }
  }

  #renderList(results: SearchResult[]) {
    if (!this.#listBox) return;

    // Don't render in AI mode - we handle that separately
    if (this.#aiMode) return;

    const t0 = DEBUG ? performance.now() : 0;

    let child = this.#listBox.getFirstChild();
    while (child) {
      const next = this.#listBox.getNextSibling(child);
      this.#listBox.remove(child);
      child = next;
    }

    for (const result of results) {
      const row = new ListBoxRow();

      const mainBox = new Box(Orientation.HORIZONTAL, 12);
      mainBox.setMarginTop(8);
      mainBox.setMarginBottom(8);
      mainBox.setMarginStart(10);
      mainBox.setMarginEnd(10);

      if (result.icon) {
        const icon = new Image({
          iconName: result.icon.startsWith("/") ? undefined : result.icon,
          file: result.icon.startsWith("/") ? result.icon : undefined,
        });
        icon.setPixelSize(32);
        icon.setProperty("valign", 3); // GTK_ALIGN_CENTER
        mainBox.append(icon);
      }

      const textBox = new Box(Orientation.VERTICAL, 4);

      const titleLabel = new Label(result.title);
      titleLabel.setProperty("xalign", 0);
      titleLabel.setProperty("ellipsize", 3);
      titleLabel.setMarkup(`<b>${this.#escapeMarkup(result.title)}</b>`);

      const subtitleLabel = new Label(result.subtitle);
      subtitleLabel.setProperty("xalign", 0);
      subtitleLabel.setProperty("ellipsize", 3);
      subtitleLabel.setMarkup(
        `<span size="small" alpha="50%">${
          this.#escapeMarkup(result.subtitle)
        }</span>`,
      );

      textBox.append(titleLabel);
      textBox.append(subtitleLabel);

      mainBox.append(textBox);
      row.setChild(mainBox);
      this.#listBox.append(row);
    }
    if (DEBUG) {
      debug(
        `[Render] ${results.length} rows: ${
          (performance.now() - t0).toFixed(1)
        }ms`,
      );
    }
  }

  async #activateResult(index: number) {
    if (index >= 0 && index < this.#currentResults.length) {
      const result = this.#currentResults[index];
      try {
        await result.onActivate();
      } catch (e) {
        console.error("Activation failed:", e);
        this.#setLoading(
          true,
          `Error: ${e instanceof Error ? e.message : String(e)}`,
        );
        setTimeout(() => this.#setLoading(false), 3000);
      }
    }
  }

  #escapeMarkup(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async run() {
    this.#app.register();

    if (this.#app.getIsRemote()) {
      console.log("Remote instance detected. Activating primary instance...");
      this.#app.activate();
      Deno.exit(0);
    }

    await this.#eventLoop.start(this.#app);
  }

  #showToolPermissionDialog(command: string): Promise<boolean> {
    console.log("[Main] Showing permission dialog for:", command);

    return new Promise((resolve) => {
      const dialog = new MessageDialog(
        this.#win!,
        "Tool Permission",
        `Allow this command to run?\n\n${command}`,
      );

      dialog.addResponse("allow", "Allow");
      dialog.addResponse("deny", "Deny");
      dialog.setDefaultResponse("allow");
      dialog.setCloseResponse("deny");

      dialog.onResponse((response: string) => {
        console.log("[Main] Dialog response:", response);
        const approved = response === "allow";
        dialog.destroy();
        resolve(approved);
      });

      dialog.present();
    });
  }

  #showToolInfoNotification(command: string) {
    console.log("[Main] Showing info notification for:", command);

    // Show a non-blocking info message - stays until user dismisses
    // This gives feedback that something is running
    const dialog = new MessageDialog(
      this.#win!,
      "Running Command",
      `Executing: ${command}\n\nThis message will stay until you dismiss it.`,
    );

    dialog.addResponse("close", "Close");
    dialog.setDefaultResponse("close");
    dialog.setCloseResponse("close");

    dialog.onResponse(() => {
      dialog.destroy();
    });

    dialog.present();
  }

  async #resolveVariables(query: string): Promise<string> {
    let result = query;

    // Replace $cb and $clipboard with clipboard content
    if (result.includes("$cb") || result.includes("$clipboard")) {
      try {
        const clipboardText = await readClipboard();
        if (clipboardText && clipboardText.trim()) {
          result = result.replace(/\$clipboard/gi, clipboardText.trim());
          result = result.replace(/\$cb/gi, clipboardText.trim());
        }
      } catch (e) {
        console.warn("[Main] Failed to read clipboard:", e);
      }
    }

    return result;
  }
}

if (import.meta.main) {
  const app = new DGApp();
  await app.run();
}
