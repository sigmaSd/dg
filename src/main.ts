/**
 * Main entry point for the DG Launcher application.
 * This module initializes the GTK application and the plugin system.
 * @module
 */

import {
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
  Spinner,
} from "@sigmasd/gtk/gtk4";
import {
  AdwApplicationWindow,
  MessageDialog,
  ToolbarView,
} from "@sigmasd/gtk/adw";
import { EventLoop } from "@sigmasd/gtk/eventloop";
import type { SearchResult, Source } from "./plugins/interface.ts";
import { PluginLoader } from "./loader.ts";
import { SimpleAction } from "@sigmasd/gtk/gio";
import type { AiSource } from "./plugins/core/ai.ts";

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

    this.#setLoading(false);
    // Use the current text in the entry if the user already started typing
    const currentQuery = this.#searchEntry?.getText() || "";
    void this.#updateSearch(currentQuery);
  }

  #setLoading(loading: boolean, message?: string) {
    if (this.#spinner) {
      if (loading) this.#spinner.start();
      else this.#spinner.stop();
    }
    if (this.#statusLabel) {
      this.#statusLabel.setText(message || "");
    }
    if (this.#bottomBox) {
      this.#bottomBox.setVisible(loading || !!message);
    }
  }

  #setupActions() {
    if (!this.#win) return;

    // Quit Action (Ctrl+Q)
    const quitAction = new SimpleAction("quit");
    quitAction.connect("activate", async () => {
      console.log("Quit action activated");

      // Clear AI conversation
      this.#aiSource?.clearConversation();

      // Cleanup all plugins
      for (const plugin of this.#plugins) {
        try {
          await plugin.destroy?.();
        } catch (e) {
          console.error(`Error cleaning up plugin ${plugin.id}:`, e);
        }
      }

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
      if (this.#aiMode && this.#aiSource) {
        // In AI mode, Enter sends follow-up
        const rawQuery = this.#searchEntry?.getText() || "";
        // Strip "ai " prefix for follow-ups too
        const query = rawQuery.startsWith("ai ")
          ? rawQuery.slice(3).trim()
          : rawQuery;
        console.log("[Main] AI follow-up, query:", query);
        if (query.trim()) {
          // Store user message in conversation history
          this.#aiMessages.push({ role: "user", content: query });
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
        }
      }
    });

    searchBox.append(this.#searchEntry);
    contentBox.append(searchBox);

    // Results List
    const scrolled = new ScrolledWindow();
    scrolled.setProperty("vexpand", true);
    scrolled.setProperty("hscrollbar-policy", 2); // GTK_POLICY_NEVER

    this.#listBox = new ListBox();
    this.#listBox.setProperty("selection-mode", 1);
    this.#listBox.setMarginTop(0);
    this.#listBox.setMarginBottom(12);
    this.#listBox.setMarginStart(12);
    this.#listBox.setMarginEnd(12);

    this.#listBox.onRowActivated((_row, index) => {
      void this.#activateResult(index);
    });
    scrolled.setChild(this.#listBox);
    contentBox.append(scrolled);

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
    this.#bottomBox.append(this.#statusLabel);

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

  async #enterAiMode(query: string) {
    console.log("[Main] #enterAiMode called, query:", query);

    if (!this.#aiSource || !query.trim()) {
      console.log("[Main] Early return - no source or empty query");
      return;
    }

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

    // Hide list, show streaming text
    if (this.#listBox) {
      let child = this.#listBox.getFirstChild();
      while (child) {
        const next = this.#listBox.getNextSibling(child);
        this.#listBox.remove(child);
        child = next;
      }
    }

    // Start streaming
    const callbacks = {
      onText: (text: string) => {
        console.log("[Main] onText received:", text.slice(0, 50));
        this.#aiText += text;
        this.#updateAiDisplay();
      },
      onToolRequest: (tool: string, args: Record<string, unknown>) => {
        console.log("[Main] onToolRequest:", tool, args);
        // Silently handle - don't show popup
      },
      onToolResult: (result: string) => {
        console.log("[Main] onToolResult:", result.slice(0, 50));
        // Append tool result to AI text for display
        this.#aiText += "\n" + result;
        this.#updateAiDisplay();
      },
      onDone: () => {
        console.log("[Main] onDone");
        this.#setLoading(false);
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

  #updateAiDisplay() {
    if (!this.#listBox) return;

    let row = this.#listBox.getFirstChild() as ListBoxRow | null;
    let label: Label | null = null;

    if (!row) {
      row = new ListBoxRow();
      const mainBox = new Box(Orientation.VERTICAL, 8);
      label = new Label(this.#aiText || "...");
      label.setProperty("xalign", 0);
      label.setProperty("wrap", true);
      label.setProperty("wrap-mode", 2); // WORD
      label.setProperty("width-chars", 50);
      mainBox.append(label);
      row.setChild(mainBox);
      this.#listBox.append(row);
    } else {
      const mainBox = row.getChild() as Box;
      label = mainBox.getFirstChild() as Label;
    }

    if (label) {
      label.setMarkup(
        `<span size="large">${
          this.#escapeMarkup(this.#aiText || "Thinking...")
        }</span>`,
      );
    }
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
      const providerName = this.#aiSource?.getProvider() === "opencode"
        ? "OpenCode"
        : "OpenRouter";
      const hasClipboard = args.includes("$clipboard") || args.includes("$cb");

      if (parts.length === 1) {
        // Just "ai" or "$clipboard" - show help
        results = [{
          title: `AI (${providerName})`,
          subtitle: hasClipboard
            ? "Press Enter with clipboard context"
            : "Type a question and press Enter",
          icon: "dialog-information",
          score: 100,
          onActivate: () => {},
        }];
      } else {
        // Has query - show "press enter to send"
        results = [{
          title: `Ask AI (${providerName})`,
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
    // Don't hide app if in AI mode (thinking or response shown)
    if (this.#aiMode) {
      return;
    }

    if (index >= 0 && index < this.#currentResults.length) {
      const result = this.#currentResults[index];
      try {
        await result.onActivate();
        this.#win?.setVisible(false);
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
        const clipboardText = await this.#readClipboard();
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
      console.warn("[Main] Failed to read clipboard");
    }
    return "";
  }
}

if (import.meta.main) {
  const app = new DGApp();
  await app.run();
}
