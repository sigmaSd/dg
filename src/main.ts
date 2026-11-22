/**
 * Main entry point for the DG Launcher application.
 * This module initializes the GTK application and the plugin system.
 * @module
 */

import {
  Align,
  Application,
  Box,
  Button,
  Entry,
  EventControllerKey,
  HeaderBar,
  Image,
  Label,
  ListBox,
  ListBoxRow,
  Orientation,
  PropagationPhase,
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
import { G_TYPE_INT } from "@sigmasd/gtk/gobject";
import { AiSource } from "./plugins/core/ai.ts";
import { FileSearchError } from "./plugins/core/file-search.ts";
import { isPathQuery } from "./plugins/core/paths.ts";
import { terminalCommand } from "./plugins/core/terminal.ts";
import { readClipboard } from "./utils/clipboard.ts";
import { Fzf } from "fzf";
import {
  type AppearanceSettings,
  defaultAppearance,
  type OpencodeConfig,
} from "./config.ts";
import type { OpencodeModel } from "./plugins/core/opencode.ts";
import { createIcon } from "./ui/choice-picker.ts";
import { LauncherTheme, styleWindow } from "./ui/launcher-theme.ts";
import { resultStep } from "./ui/result-keys.ts";
import { createGtkDesktopLaunch } from "./ui/desktop-launch.ts";
import { createPathPreferences } from "./ui/path-preferences.ts";
import {
  openPreferences,
  type PluginPreferencesPage,
} from "./ui/preferences.ts";
import { createAiPreferences } from "./ui/ai-preferences.ts";
import { createTerminalPreferences } from "./ui/terminal-preferences.ts";

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
  #searchMessage?: Label;
  #statusLabel?: Label;
  #spinner?: Spinner;
  #bottomBox?: Box;
  #footer?: Box;
  #layoutQueued = false;
  #closing = false;
  #modelLabel?: Label;
  #scrolledWindow?: ScrolledWindow;
  #preferences?: ReturnType<typeof openPreferences>;
  #openingPreferences = false;
  #preferencesAction?: SimpleAction;
  #appearance = defaultAppearance;
  #theme = new LauncherTheme();
  #modelActions: SimpleAction[] = [];

  #loader: PluginLoader;
  #plugins: Source[] = [];
  #aiSource?: AiSource;
  #currentResults: SearchResult[] = [];
  #currentResultsQuery?: string;
  /** Result picked with the arrow keys. Cleared whenever the query changes. */
  #selectedResult?: SearchResult;
  #runningTerminalCommand = false;
  #latestSearchId = 0;
  #pendingTriggeredSearch?: {
    query: string;
    controller: AbortController;
    done: Promise<void>;
  };
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #aiMode = false;
  #aiText = "";
  #aiMessages: { role: "user" | "assistant"; content: string }[] = [];

  #modelMode = false;
  #modelFilterFree = false;
  #modelList: OpencodeModel[] = [];
  #modelFetch?: AbortController;
  #fuse: Fzf<OpencodeModel[]> | null = null;

  #aiAbortController?: AbortController;
  #savedAiMode = false;

  constructor() {
    this.#app = new Application(APP_ID, APP_FLAGS);
    this.#eventLoop = new EventLoop({ pollInterval: 16 });
    this.#loader = new PluginLoader(
      createGtkDesktopLaunch(() => this.#win?.getDisplay().ptr),
      () => this.#refreshPlugins(),
    );

    // Clean up on signal termination (Ctrl+C, kill, etc.)
    Deno.addSignalListener("SIGINT", async () => {
      await this.#cleanupAndExit();
    });
    Deno.addSignalListener("SIGTERM", async () => {
      await this.#cleanupAndExit();
    });

    this.#app.onActivate(() => {
      if (this.#closing) return;
      if (this.#preferences) {
        this.#preferences.present();
        return;
      }
      if (!this.#win) {
        this.#buildUI();
        void this.#initPlugins();
        this.#setupActions();
      }
      this.#win?.present();
      // Focus the entry and select the text
      this.#searchEntry?.grabFocus();
      // Restore AI state if we are in AI mode
      if (this.#aiMode) {
        this.#updateAiPlaceholder();
        this.#showModelInStatus();
        // Re-render the whole AI conversation
        if (this.#listBox) {
          let child = this.#listBox.getFirstChild();
          while (child) {
            const next = this.#listBox.getNextSibling(child);
            this.#listBox.remove(child);
            child = next;
          }
        }
        for (const msg of this.#aiMessages) {
          this.#updateAiDisplay(msg.role, msg.content);
        }
        if (this.#aiText) {
          this.#updateAiDisplay("assistant");
        }
        this.#restoreAiEntry();
      } else {
        this.#searchEntry?.selectRegion(0, -1);
      }
    });
  }

  async #initPlugins() {
    console.log("Loading plugins...");
    await this.#loader.loadPlugins(this.#win);
    this.#preferencesAction?.setProperty("enabled", true);
    this.#refreshPlugins();
  }

  #refreshPlugins() {
    const previousAi = this.#aiSource;
    this.#plugins = this.#loader.activeSources;
    const ai = this.#plugins.find((source): source is AiSource =>
      source instanceof AiSource
    );
    if (previousAi && !ai) {
      this.#modelFetch?.abort();
      this.#modelList = [];
      this.#fuse = null;
      this.#savedAiMode = false;
      if (this.#modelMode) this.#exitModelMode();
      if (this.#aiMode || this.#aiAbortController) this.#exitAiMode();
    }
    this.#aiSource = ai;
    for (const action of this.#modelActions) {
      action.setProperty("enabled", Boolean(ai));
    }
    if (!previousAi && ai) void this.#fetchModels();
    if (!this.#aiMode && !this.#modelMode) {
      this.#resetPlaceholder();
      void this.#updateSearch(this.#searchEntry?.getText() ?? "");
    }
  }

  #queueLauncherLayout() {
    if (this.#closing || this.#layoutQueued) return;
    this.#layoutQueued = true;
    setTimeout(() => {
      this.#layoutQueued = false;
      if (this.#closing || !this.#win) return;
      const hasRows = Boolean(this.#listBox?.getFirstChild());
      this.#scrolledWindow?.setVisible(hasRows);
      this.#footer?.setVisible(
        hasRows || Boolean(this.#bottomBox?.getVisible()),
      );
      const width = Number(this.#win.getProperty("default-width", G_TYPE_INT));
      this.#win.setDefaultSize(width > 0 ? width : 640, hasRows ? -1 : 1);
    }, 0);
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
    this.#queueLauncherLayout();
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
    this.#queueLauncherLayout();
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
    this.#queueLauncherLayout();
  }

  async #cleanupAndExit(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#preferences?.setVisible(false);
    this.#win?.setVisible(false);
    clearTimeout(this.#debounceTimer ?? undefined);
    this.#debounceTimer = null;
    ++this.#latestSearchId;
    this.#cancelTriggeredSearch();
    this.#aiSource?.clearConversation();
    this.#modelFetch?.abort();

    for (const plugin of this.#plugins) {
      try {
        await plugin.destroy?.();
      } catch (e) {
        console.error(`Error cleaning up plugin ${plugin.id}:`, e);
      }
    }

    this.#preferences?.destroy();
    this.#preferences = undefined;
    if (this.#win) {
      this.#win.destroy();
      this.#win = undefined;
    }
    this.#eventLoop.stop();
    this.#app.quit();
    Deno.exit(0);
  }

  #setupActions() {
    if (!this.#win) return;

    const preferences = new SimpleAction("preferences");
    preferences.setProperty("enabled", false);
    preferences.connect("activate", () => void this.#showPreferences());
    this.#win.addAction(preferences);
    this.#app.setAccelsForAction("win.preferences", ["<Control>comma"]);
    this.#preferencesAction = preferences;

    // Quit Action (Ctrl+Q)
    const quitAction = new SimpleAction("quit");
    quitAction.connect("activate", async () => {
      await this.#cleanupAndExit();
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
      // In AI mode, just hide - preserve conversation state
      if (this.#aiMode) {
        this.#win?.setVisible(false);
        return;
      }
      this.#win?.setVisible(false);
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
    modelAction.setProperty("enabled", false);
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
    freeModelsAction.setProperty("enabled", false);
    this.#modelActions = [modelAction, freeModelsAction];
    this.#app.setAccelsForAction("win.free-models", ["<Control><Shift>m"]);
  }

  async #showPreferences() {
    if (!this.#win || this.#openingPreferences) return;
    if (this.#preferences) {
      this.#preferences.present();
      return;
    }
    this.#openingPreferences = true;
    const paths = this.#loader.pathSource;
    const terminal = this.#loader.terminalSource;
    try {
      const [aiConfig, terminalPreferences] = await Promise.all([
        this.#loader.configManager.getOpencodeConfig(),
        terminal?.preferences(),
      ]);
      if (!this.#win) return;
      const pages = new Map<string, PluginPreferencesPage>([
        [`core:${paths.id}`, {
          icon: "folder-symbolic",
          create: (window, setBusy) =>
            createPathPreferences(window, paths, setBusy, () => {
              const query = this.#searchEntry?.getText() ?? "";
              if (!this.#aiMode && !this.#modelMode && isPathQuery(query)) {
                void this.#updateSearch(query);
              }
            }),
        }],
        ["core:ai", {
          icon: "applications-science-symbolic",
          availableWhenDisabled: true,
          create: (window, setBusy) =>
            createAiPreferences(
              window,
              aiConfig,
              setBusy,
              (settings) => this.#saveAiSettings(settings),
            ),
        }],
      ]);
      if (terminal && terminalPreferences) {
        pages.set(`core:${terminal.id}`, {
          icon: "utilities-terminal-symbolic",
          create: (_window, setBusy) =>
            createTerminalPreferences(
              terminalPreferences,
              setBusy,
              (settings) => terminal.saveSettings(settings),
            ),
        });
      }
      this.#preferences = openPreferences(
        this.#win,
        this.#app,
        this.#loader.controls,
        pages,
        {
          settings: this.#appearance,
          preview: (settings) => this.#theme.preview(settings),
          save: (settings) => this.#saveAppearance(settings),
        },
        (key, enabled, window) => this.#loader.setEnabled(key, enabled, window),
        async (key, trigger) => {
          const prefix = this.#aiPrefix();
          await this.#loader.setTrigger(key, trigger);
          const text = this.#searchEntry?.getText();
          if (this.#aiMode && key === "core:ai" && text?.startsWith(prefix)) {
            this.#searchEntry?.setText(
              this.#aiPrefix() + text.slice(prefix.length),
            );
          }
        },
        () => {
          this.#win?.removeCssClass("dg-settings-open");
          this.#preferences = undefined;
        },
      );
      this.#win.addCssClass("dg-settings-open");
    } catch (error) {
      console.error("Could not open Preferences:", error);
      this.#setLoading(false, "Could not open Preferences.");
    } finally {
      this.#openingPreferences = false;
    }
  }

  async #saveAppearance(settings: AppearanceSettings): Promise<void> {
    await this.#loader.configManager.setAppearance(settings);
    this.#appearance = settings;
  }

  async #saveAiSettings(settings: OpencodeConfig) {
    await this.#loader.configManager.setOpencodeConfig(settings);
    if (!this.#aiSource) return;
    this.#aiAbortController?.abort();
    this.#modelFetch?.abort();
    await this.#aiSource.destroy();
    await this.#aiSource.init();
    void this.#fetchModels();
    if (this.#aiMode) {
      this.#setLoading(false);
      this.#updateAiPlaceholder();
      this.#showModelInStatus();
    } else if (!this.#modelMode) {
      void this.#updateSearch(this.#searchEntry?.getText() ?? "");
    }
  }

  #buildUI() {
    if (this.#win) return;

    this.#win = new AdwApplicationWindow(this.#app);
    this.#win.setTitle("DG");
    this.#win.setSizeRequest(360, -1);
    this.#win.setDefaultSize(640, 1);
    this.#theme.install(this.#win, this.#appearance);

    const toolbarView = new ToolbarView();
    const headerBar = new HeaderBar();
    styleWindow(this.#win, toolbarView, headerBar);
    headerBar.addCssClass("dg-launcher-header");
    headerBar.setProperty("show-title-buttons", false);
    const preferences = new Button();
    preferences.setIconName("emblem-system-symbolic");
    preferences.setTooltipText("Preferences (Ctrl+,)");
    preferences.setProperty("action-name", "win.preferences");
    const close = new Button();
    close.setIconName("window-close-symbolic");
    close.setTooltipText("Close Launcher");
    close.setProperty("action-name", "window.close");
    toolbarView.addTopBar(headerBar);
    const contentBox = new Box(Orientation.VERTICAL, 0);

    const searchField = new Box(Orientation.HORIZONTAL, 10);
    searchField.addCssClass("dg-search-field");
    searchField.setHexpand(true);
    const searchIcon = new Image({ iconName: "system-search-symbolic" });
    searchIcon.setPixelSize(18);
    searchIcon.setValign(Align.CENTER);
    searchField.append(searchIcon);

    this.#searchEntry = new Entry();
    this.#searchEntry.addCssClass("dg-search-entry");
    this.#searchEntry.setHexpand(true);
    this.#resetPlaceholder();
    this.#searchEntry.onChanged(() => {
      this.#selectedResult = undefined;
      this.#cancelTriggeredSearch();
      ++this.#latestSearchId;
      this.#currentResultsQuery = undefined;
      this.#searchMessage?.setVisible(false);
      this.#queueLauncherLayout();
      if (this.#debounceTimer !== null) {
        clearTimeout(this.#debounceTimer);
      }
      this.#debounceTimer = setTimeout(() => {
        this.#debounceTimer = null;
        this.#onSearchChanged();
      }, 150);
    });
    // Up and Down move through the results while focus stays in the entry,
    // so typing keeps editing the query. Capture runs before the entry's
    // own key handling, which would otherwise move focus into the list.
    const resultKeys = new EventControllerKey();
    resultKeys.setPropagationPhase(PropagationPhase.CAPTURE);
    resultKeys.onKeyPressed((keyval, _keycode, state) => {
      const step = resultStep(keyval, state);
      return step !== 0 && this.#moveSelection(step);
    });
    this.#searchEntry.addController(resultKeys);
    this.#searchEntry.onActivate(() => {
      if (this.#modelMode) {
        void this.#activateResult(this.#selectedIndex());
        return;
      }
      const query = this.#searchEntry?.getText() || "";
      const aiPrefix = this.#aiPrefix();
      if (isPathQuery(query) || this.#terminalCommand(query) !== undefined) {
        void this.#activateSearch(query);
        return;
      }
      const triggered = this.#triggeredPlugin(query);
      if (triggered && triggered !== this.#aiSource) {
        if (query.slice(query.indexOf(" ") + 1).trim()) {
          void this.#activateSearch(query);
        }
        return;
      }
      if (this.#aiMode && this.#aiSource) {
        // In AI mode, Enter sends follow-up
        const rawQuery = this.#searchEntry?.getText() || "";
        const query = rawQuery.startsWith(aiPrefix)
          ? rawQuery.slice(aiPrefix.length).trim()
          : rawQuery;
        console.log("[Main] AI follow-up, query:", query);
        if (query.trim()) {
          void this.#enterAiMode(query);
          this.#resetAiEntry();
        }
      } else {
        // Check if it's an AI trigger
        console.log("[Main] Enter pressed, query:", query);
        if (query.startsWith(aiPrefix) && this.#aiSource) {
          console.log("[Main] Triggering AI");
          const processedQuery = query.slice(aiPrefix.length).trim();
          if (processedQuery === "/clear") {
            this.#aiMessages = [];
            this.#aiText = "";
            this.#statusLabel?.setText("Conversation cleared");
            this.#resetAiEntry();
            // Clear display
            if (this.#listBox) {
              let child = this.#listBox.getFirstChild();
              while (child) {
                const next = this.#listBox.getNextSibling(child);
                this.#listBox.remove(child);
                child = next;
              }
            }
            this.#queueLauncherLayout();
            return;
          }
          void this.#enterAiMode(processedQuery);
          this.#resetAiEntry();
        } else {
          void this.#activateResult(this.#selectedIndex());
        }
      }
    });

    searchField.append(this.#searchEntry);
    const headerContent = new Box(Orientation.HORIZONTAL, 8);
    headerContent.setHexpand(true);
    headerContent.append(searchField);
    headerContent.append(preferences);
    headerContent.append(close);
    headerBar.setProperty("title-widget", headerContent);
    this.#searchMessage = new Label("");
    this.#searchMessage.addCssClass("dg-search-message");
    this.#searchMessage.setXalign(0);
    this.#searchMessage.setWrap(true);
    this.#searchMessage.setMarginTop(4);
    this.#searchMessage.setMarginBottom(4);
    this.#searchMessage.setMarginStart(16);
    this.#searchMessage.setMarginEnd(16);
    this.#searchMessage.addCssClass("dim-label");
    this.#searchMessage.setVisible(false);
    contentBox.append(this.#searchMessage);

    // Results List
    this.#scrolledWindow = new ScrolledWindow();
    this.#scrolledWindow.setProperty("vexpand", true);
    this.#scrolledWindow.setProperty("hscrollbar-policy", 2); // GTK_POLICY_NEVER
    this.#scrolledWindow.setProperty("propagate-natural-height", true);
    this.#scrolledWindow.setProperty("max-content-height", 350);
    this.#scrolledWindow.setVisible(false);

    this.#listBox = new ListBox();
    this.#listBox.addCssClass("dg-results");
    this.#listBox.setProperty("selection-mode", 1);
    this.#listBox.setMarginTop(0);
    this.#listBox.setMarginBottom(8);
    this.#listBox.setMarginStart(12);
    this.#listBox.setMarginEnd(12);

    this.#listBox.onRowActivated((_row, index) => {
      if (this.#modelMode) {
        void this.#activateResult(index);
      } else if (!this.#aiMode) {
        void this.#activateResult(index);
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

    const footer = this.#footer = new Box(Orientation.VERTICAL, 0);
    footer.addCssClass("dg-footer");
    footer.setVisible(false);
    footer.append(this.#bottomBox);
    const shortcuts = new Box(Orientation.HORIZONTAL, 0);
    shortcuts.setMarginTop(8);
    shortcuts.setMarginBottom(8);
    shortcuts.setMarginStart(16);
    shortcuts.setMarginEnd(16);
    const hide = new Box(Orientation.HORIZONTAL, 6);
    const escapeKey = new Label("Esc");
    escapeKey.addCssClass("dg-keycap");
    hide.append(escapeKey);
    hide.append(new Label("Hide"));
    hide.setHexpand(true);
    shortcuts.append(hide);
    const settings = new Box(Orientation.HORIZONTAL, 6);
    const preferencesKey = new Label("Ctrl+,");
    preferencesKey.addCssClass("dg-keycap");
    settings.append(preferencesKey);
    settings.append(new Label("Preferences"));
    shortcuts.append(settings);
    footer.append(shortcuts);
    toolbarView.addBottomBar(footer);

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
    if (
      query && query !== this.#aiSource?.trigger &&
      !query.startsWith(this.#aiPrefix()) && this.#aiMode
    ) {
      // Exit AI mode if user types something else
      this.#exitAiMode();
      this.#updateSearch(query);
    } else if (!this.#aiMode) {
      this.#updateSearch(query);
    }
  }

  #updateModelSearch(query: string) {
    this.#currentResultsQuery = undefined;
    const searchId = ++this.#latestSearchId;
    this.#setLoading(false);

    let list = this.#modelList;
    if (this.#modelFilterFree) {
      list = list.filter((m) => m.isFree);
    }

    let filtered: OpencodeModel[];
    if (query) {
      const fzfInstance = this.#modelFilterFree
        ? new Fzf(list, {
          selector: (m: OpencodeModel) =>
            `${m.name} ${m.provider}/${m.id} ${m.provider} ${m.id}`,
        })
        : this.#fuse;

      if (fzfInstance) {
        const entries = fzfInstance.find(query);
        filtered = entries.map((entry: { item: OpencodeModel }) => entry.item);
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
      onActivate: () => this.#selectModel(`${m.provider}/${m.id}`, m.name),
    }));
    if (
      !this.#modelFilterFree &&
      "opencode default".includes(query.trim().toLowerCase())
    ) {
      results.unshift({
        title: "Use OpenCode default",
        subtitle: this.#aiSource?.getDefaultModel() ??
          "Use OpenCode’s configured model",
        icon: "preferences-system-symbolic",
        score: 100,
        onActivate: () => this.#selectModel("", "OpenCode default"),
      });
      results.splice(40);
    }

    if (searchId === this.#latestSearchId) {
      this.#currentResults = results;
      this.#renderList(results);
    }
  }

  async #selectModel(model: string, name: string) {
    this.#setLoading(true, `Switching to ${name}...`);
    const success = await this.#aiSource?.setModel(model);
    this.#exitModelMode();
    this.#setLoading(
      false,
      success ? `Model changed to ${name}` : "Failed to change model",
    );
    if (this.#aiMode) this.#showModelInStatus();
  }

  async #fetchModels() {
    const source = this.#aiSource;
    if (!source) return;
    this.#modelFetch?.abort();
    const controller = this.#modelFetch = new AbortController();
    const { signal } = controller;
    try {
      const models = await source.listModels(signal);
      if (signal.aborted || this.#aiSource !== source) return;
      this.#modelList = models;
      this.#fuse = new Fzf(models, {
        selector: (m: OpencodeModel) => `${m.name} ${m.provider}/${m.id}`,
      });
      if (this.#modelMode) {
        this.#updateModelSearch(this.#searchEntry?.getText() ?? "");
        if (!models.length) {
          this.#setLoading(false, "OpenCode reported no available models.");
        }
      } else if (this.#aiMode) {
        this.#updateAiPlaceholder();
        this.#showModelInStatus();
      }
    } catch (error) {
      if (signal.aborted || this.#aiSource !== source) return;
      if (this.#modelMode) {
        this.#setLoading(
          false,
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      if (this.#modelFetch === controller) this.#modelFetch = undefined;
    }
  }

  async #enterModelMode() {
    if (!this.#modelMode) this.#savedAiMode = this.#aiMode;
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

    this.#updateModelSearch("");
    if (this.#modelList.length === 0) {
      this.#setLoading(true, "Fetching models...");
    }
    await this.#fetchModels();
  }

  #exitModelMode() {
    this.#modelMode = false;
    this.#aiMode = this.#savedAiMode;

    if (this.#aiMode) this.#resetAiEntry();
    else this.#searchEntry?.setText("");

    if (!this.#aiMode) {
      this.#resetPlaceholder();
      this.#updateSearch("");
    } else {
      this.#updateAiPlaceholder();
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
      this.#queueLauncherLayout();
    }
  }

  async #enterAiMode(query: string) {
    console.log("[Main] #enterAiMode called, query:", query);

    const source = this.#aiSource;
    if (!source || !query.trim()) {
      console.log("[Main] Early return - no source or empty query");
      return;
    }
    // A follow-up adds to the conversation already on screen.
    const followUp = this.#aiMode;

    // Update placeholder to show current model
    this.#updateAiPlaceholder();

    // Abort any previous request
    if (this.#aiAbortController) {
      console.log("[Main] Aborting previous request");
      this.#aiAbortController.abort();
    }
    const controller = this.#aiAbortController = new AbortController();
    const { signal } = controller;

    // Replace variables like $cb/$clipboard with actual content
    const resolvedQuery = await this.#resolveVariables(query);
    if (signal.aborted || source !== this.#aiSource) return;
    console.log("[Main] Resolved query:", resolvedQuery);

    this.#aiMode = true;
    this.#aiText = "";
    this.#setLoading(true, "Thinking…");
    this.#updateAiPlaceholder();
    this.#showModelInStatus();

    // Replace the search results with the conversation
    if (this.#listBox && !followUp) {
      let child = this.#listBox.getFirstChild();
      while (child) {
        const next = this.#listBox.getNextSibling(child);
        this.#listBox.remove(child);
        child = next;
      }
    }

    // Show initial user question
    this.#aiMessages.push({ role: "user", content: query });
    this.#updateAiDisplay("user", query);

    // Start streaming
    const callbacks = {
      onText: (text: string) => {
        if (signal.aborted) return;
        this.#setLoading(true, "Writing reply…");
        this.#aiText += text;
        this.#updateAiDisplay("assistant");
      },
      onActivity: (message: string) => {
        if (!signal.aborted) this.#setLoading(true, message);
      },
      onDone: () => {
        if (signal.aborted) return;
        console.log("[Main] onDone");
        if (this.#aiText) {
          this.#aiMessages.push({ role: "assistant", content: this.#aiText });
          this.#aiText = "";
        }
        if (this.#spinner) this.#spinner.setVisible(false);
        if (this.#statusLabel) this.#statusLabel.setText("");
        this.#showModelInStatus();
        this.#restoreAiEntry();
        this.#updateAiPlaceholder();
      },
      onError: (error: string) => {
        if (signal.aborted) return;
        console.log("[Main] onError:", error);
        this.#setLoading(false, `Error: ${error}`);
      },
    };

    console.log("[Main] Calling streamResponse...");
    try {
      for await (
        const _ of source.streamResponse(resolvedQuery, {
          callbacks,
          signal,
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
    role: "user" | "assistant" = "assistant",
    text?: string,
  ) {
    const list = this.#listBox;
    const content = text || this.#aiText;
    if (!list || !content) return;

    let label: Label | undefined;
    if (role === "assistant") {
      const lastRow = list.getLastChild() as ListBoxRow | null;
      const lastBox = lastRow?.getChild() as Box | undefined;
      const previous = lastBox?.getFirstChild() as Label | undefined;
      if (previous?.getText().startsWith("AI: ")) label = previous;
    }

    if (!label) {
      const row = new ListBoxRow();
      row.setProperty("activatable", false);
      row.setProperty("selectable", false);
      row.addCssClass("dg-ai-turn");
      if (role === "user") row.addCssClass("dg-ai-question");

      const box = new Box(Orientation.VERTICAL, 4);
      box.setMarginTop(8);
      box.setMarginBottom(8);
      box.setMarginStart(12);
      box.setMarginEnd(12);
      label = new Label("");
      label.setXalign(0);
      label.setWrap(true);
      label.setProperty("wrap-mode", 2); // WORD
      label.setProperty("width-chars", 50);
      box.append(label);
      row.setChild(box);
      list.append(row);
    }

    const speaker = role === "user" ? "You" : "AI";
    label.setMarkup(`<b>${speaker}:</b> ${this.#convertToPango(content)}`);
    this.#queueLauncherLayout();

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
      this.#aiAbortController = undefined;
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

  #aiPrefix(): string {
    return `${this.#aiSource?.trigger ?? "ai"} `;
  }

  #resetAiEntry() {
    const prefix = this.#aiPrefix();
    this.#searchEntry?.setText(prefix);
    this.#searchEntry?.selectRegion(-1, -1);
  }

  /** Puts the AI prefix back, keeping any follow-up typed in the meantime. */
  #restoreAiEntry() {
    const text = this.#searchEntry?.getText() ?? "";
    if (text.trim() && text.trim() !== this.#aiPrefix().trim()) {
      this.#searchEntry?.selectRegion(-1, -1);
      return;
    }
    this.#resetAiEntry();
  }

  #resetPlaceholder() {
    if (this.#searchEntry) {
      this.#searchEntry.setProperty(
        "placeholder-text",
        this.#aiSource
          ? `Search or type '${this.#aiPrefix()}<question>'…`
          : "Search…",
      );
    }
  }

  #triggeredPlugin(query: string): Source | undefined {
    const separator = query.indexOf(" ");
    if (separator < 0) return;
    const trigger = query.slice(0, separator);
    return this.#plugins.find((plugin) => plugin.trigger === trigger);
  }

  #terminalCommand(query: string): string | undefined {
    const trigger = this.#loader.terminalTrigger;
    if (trigger) return terminalCommand(query, trigger);
  }

  #cancelTriggeredSearch() {
    this.#pendingTriggeredSearch?.controller.abort();
    this.#pendingTriggeredSearch = undefined;
  }

  #updateSearch(query: string) {
    this.#cancelTriggeredSearch();
    const searchId = ++this.#latestSearchId;
    this.#setLoading(false);
    this.#searchMessage?.setVisible(false);

    if (!query.trim()) {
      this.#currentResults = [];
      this.#currentResultsQuery = query;
      this.#renderList([]);
      return;
    }

    const pathQuery = isPathQuery(query);
    const command = this.#terminalCommand(query);
    const t0 = DEBUG ? performance.now() : 0;
    let results: SearchResult[] = [];

    const parts = query.split(" ");
    const trigger = parts[0];
    const args = parts.slice(1).join(" ");

    // Check for AI trigger - only activate on Enter, just show placeholder here
    if (this.#aiSource && trigger === this.#aiSource.trigger) {
      const model = this.#aiSource.getModel();
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
      this.#currentResultsQuery = query;
      this.#renderList(results);
      return;
    }

    // Check if a plugin matches the specific trigger
    // Only trigger if there is at least one space after the trigger
    const triggeredPlugin = this.#triggeredPlugin(query);

    const handleResults = (newResults: SearchResult[]) => {
      if (searchId !== this.#latestSearchId) return;
      results = results.concat(newResults);
      const sorted = pathQuery
        ? results
        : [...results].sort((a, b) => b.score - a.score).slice(0, 20);
      this.#currentResults = sorted;
      this.#currentResultsQuery = query;
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
    const showMessage = (message?: string) => {
      if (searchId === this.#latestSearchId && message) {
        this.#searchMessage?.setText(message);
        this.#searchMessage?.setVisible(true);
        this.#queueLauncherLayout();
      }
    };

    handleResults([]);
    if (command !== undefined) {
      const source = this.#loader.terminalSource;
      if (!source || !this.#plugins.includes(source)) {
        showMessage("Enable Terminal in Preferences to run shell commands.");
        return;
      }
      if (!command.trim()) {
        showMessage("Type a shell command.");
        return;
      }
      return source.search(command).then(handleResults);
    } else if (pathQuery) {
      const source = this.#loader.pathSource;
      if (!this.#plugins.includes(source)) return;
      return source.lookup(query).then(({ results, message }) => {
        handleResults(results);
        showMessage(message);
      }).catch((error) => {
        console.error("Path search failed:", error);
        showMessage("Could not read this path.");
      });
    } else if (triggeredPlugin) {
      // Specific plugin search - fire async
      this.#setLoading(true, `Searching ${triggeredPlugin.id}...`);
      const controller = new AbortController();
      const done = Promise.resolve().then(() =>
        triggeredPlugin.search(args, controller.signal)
      ).then(
        (results) => {
          if (controller.signal.aborted) return;
          handleResults(results);
          if (!results.length) {
            showMessage(
              args.trim()
                ? `No results from ${triggeredPlugin.name}.`
                : `Type a query after ${trigger}.`,
            );
          }
        },
      ).catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof FileSearchError) {
          showMessage(error.message);
          return;
        }
        console.error(`Search failed for ${triggeredPlugin.id}:`, error);
        showMessage(`Could not search ${triggeredPlugin.name}.`);
      }).finally(() => {
        if (this.#pendingTriggeredSearch?.controller === controller) {
          this.#pendingTriggeredSearch = undefined;
          handleDone();
        }
      });
      this.#pendingTriggeredSearch = { query, controller, done };
      return done;
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

    let firstRow: ListBoxRow | undefined;
    let selectedRow: ListBoxRow | undefined;
    for (const result of results) {
      const row = new ListBoxRow();
      row.addCssClass("dg-result");
      firstRow ??= row;
      if (result === this.#selectedResult) selectedRow = row;

      const mainBox = new Box(Orientation.HORIZONTAL, 11);
      mainBox.setMarginTop(6);
      mainBox.setMarginBottom(6);
      mainBox.setMarginStart(12);
      mainBox.setMarginEnd(10);

      const icon = createIcon(
        result.icon || "application-x-executable-symbolic",
      );
      icon.setPixelSize(26);
      mainBox.append(icon);

      const textBox = new Box(Orientation.VERTICAL, 2);
      textBox.setHexpand(true);
      textBox.setValign(Align.CENTER);

      const titleLabel = new Label(result.title);
      titleLabel.setXalign(0);
      titleLabel.setEllipsize(3);
      titleLabel.addCssClass("dg-result-title");
      textBox.append(titleLabel);

      if (result.subtitle) {
        const subtitleLabel = new Label(result.subtitle);
        subtitleLabel.setXalign(0);
        subtitleLabel.setEllipsize(3);
        subtitleLabel.addCssClass("dg-result-subtitle");
        textBox.append(subtitleLabel);
      }

      mainBox.append(textBox);
      row.setChild(mainBox);
      this.#listBox.append(row);
    }
    // Later plugin results re-render the list; keep the user's pick if it is
    // still there.
    if (!selectedRow) this.#selectedResult = undefined;
    const highlighted = selectedRow ?? firstRow;
    if (highlighted) this.#listBox.selectRow(highlighted);
    this.#queueLauncherLayout();
    if (selectedRow) this.#scrollToRow(selectedRow);
    if (DEBUG) {
      debug(
        `[Render] ${results.length} rows: ${
          (performance.now() - t0).toFixed(1)
        }ms`,
      );
    }
  }

  async #activateSearch(query: string) {
    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    if (this.#aiMode) this.#exitAiMode();
    const pending = this.#pendingTriggeredSearch;
    let done: Promise<void> | undefined;
    if (pending?.query === query) {
      done = pending.done;
    } else if (
      query !== this.#currentResultsQuery || !this.#currentResults.length
    ) {
      done = this.#updateSearch(query);
    }
    const searchId = this.#latestSearchId;
    if (done) await done;
    if (
      searchId === this.#latestSearchId && !this.#modelMode &&
      this.#searchEntry?.getText() === query
    ) {
      await this.#activateResult(this.#selectedIndex());
    }
  }

  /** Index of the highlighted result, or the first result. */
  #selectedIndex(): number {
    const index = this.#selectedResult
      ? this.#currentResults.indexOf(this.#selectedResult)
      : -1;
    return Math.max(index, 0);
  }

  /** Moves the highlight by `step` rows. Returns whether the key was used. */
  #moveSelection(step: number): boolean {
    if (this.#aiMode) return this.#scrollAiChat(step);
    if (!this.#listBox) return false;
    const count = this.#currentResults.length;
    if (!count) return false;
    const index = Math.min(
      Math.max(this.#selectedIndex() + step, 0),
      count - 1,
    );
    const row = this.#listBox.getRowAtIndex(index);
    if (!row) return true;
    this.#selectedResult = this.#currentResults[index];
    this.#listBox.selectRow(row);
    this.#scrollToRow(row);
    return true;
  }

  /** Scrolls the AI conversation, keeping focus in the entry for follow-ups. */
  #scrollAiChat(step: number): boolean {
    const adjustment = this.#scrolledWindow?.getVadjustment();
    if (!adjustment) return true;
    const page = adjustment.getPageSize();
    const bottom = Math.max(adjustment.getUpper() - page, 0);
    // About three lines of text per press.
    const value = adjustment.getValue() + step * 60;
    adjustment.setValue(Math.min(Math.max(value, 0), bottom));
    return true;
  }

  #scrollToRow(row: ListBoxRow) {
    const list = this.#listBox;
    const adjustment = this.#scrolledWindow?.getVadjustment();
    if (!list || !adjustment) return;
    // Wait for layout so new rows have their final positions.
    setTimeout(() => {
      const bounds = row.computeBounds(list);
      if (!bounds) return;
      const top = bounds.y;
      const bottom = bounds.y + bounds.height;
      const page = adjustment.getPageSize();
      const value = adjustment.getValue();
      if (top < value) adjustment.setValue(top);
      else if (bottom > value + page) adjustment.setValue(bottom - page);
    }, 0);
  }

  async #activateResult(index: number) {
    if (
      !this.#modelMode &&
      this.#currentResultsQuery !== this.#searchEntry?.getText()
    ) return;
    if (index >= 0 && index < this.#currentResults.length) {
      const result = this.#currentResults[index];
      const query = this.#searchEntry?.getText() ?? "";
      const terminal = !this.#modelMode &&
        this.#terminalCommand(query) !== undefined;
      if (terminal && this.#runningTerminalCommand) return;
      if (terminal) this.#runningTerminalCommand = true;
      try {
        await result.onActivate();
        if (terminal && this.#searchEntry?.getText() === query) {
          this.#searchEntry.setText("");
        }
        this.#win?.setVisible(false);
      } catch (e) {
        console.error("Activation failed:", e);
        this.#setLoading(
          true,
          `Error: ${e instanceof Error ? e.message : String(e)}`,
        );
        setTimeout(() => this.#setLoading(false), 3000);
      } finally {
        if (terminal) this.#runningTerminalCommand = false;
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

    try {
      this.#appearance = await this.#loader.configManager.getAppearance();
    } catch (error) {
      console.warn("Could not load DG appearance settings:", error);
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
