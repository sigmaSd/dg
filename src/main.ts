import {
  AdwApplicationWindow,
  Application,
  Box,
  Entry,
  GTK_ORIENTATION_VERTICAL,
  HeaderBar,
  Label,
  ListBox,
  ListBoxRow,
  ScrolledWindow,
  SimpleAction,
  ToolbarView,
  Widget,
} from "@sigmasd/gtk";
import { EventLoop } from "@sigmasd/gtk/eventloop";
import { SearchResult, Source } from "./sources/interface.ts";
import { AppSource } from "./sources/apps.ts";
import { FirefoxSource } from "./sources/firefox.ts";

const APP_ID = "com.mrcool.Launcher";
const APP_FLAGS = 0;

class LauncherApp {
  #app: Application;
  #win?: AdwApplicationWindow;
  #eventLoop: EventLoop;
  #listBox?: ListBox;
  #searchEntry?: Entry;
  
  #sources: Map<string, Source> = new Map();
  #currentResults: SearchResult[] = [];

  constructor() {
    this.#app = new Application(APP_ID, APP_FLAGS);
    this.#eventLoop = new EventLoop({ pollInterval: 16 });

    // Initialize sources
    this.#sources.set("apps", new AppSource());
    this.#sources.set("firefox", new FirefoxSource());

    this.#app.onActivate(() => {
      this.#buildUI();
      this.#initSources();
    });
  }

  async #initSources() {
    console.log("Initializing sources...");
    for (const source of this.#sources.values()) {
      await source.init();
    }
    // Initial load (default to apps)
    this.#updateSearch("");
  }

  #buildUI() {
    if (this.#win) return;

    this.#win = new AdwApplicationWindow(this.#app);
    this.#win.setTitle("Launcher");
    this.#win.setDefaultSize(600, 500);

    const toolbarView = new ToolbarView();
    const headerBar = new HeaderBar();
    toolbarView.addTopBar(headerBar);

    const contentBox = new Box(GTK_ORIENTATION_VERTICAL, 0);
    
    // Search Entry
    const searchBox = new Box(GTK_ORIENTATION_VERTICAL, 0);
    searchBox.setMarginTop(12);
    searchBox.setMarginBottom(12);
    searchBox.setMarginStart(12);
    searchBox.setMarginEnd(12);

    this.#searchEntry = new Entry();
    this.#searchEntry.setProperty("placeholder-text", "Search apps (or 'b ' for browser history)...");
    this.#searchEntry.onChanged(() => this.#onSearchChanged());
    this.#searchEntry.onActivate(() => this.#activateResult(0));
    
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
      this.#activateResult(index);
    });

    scrolled.setChild(this.#listBox);
    contentBox.append(scrolled);

    toolbarView.setContent(contentBox);
    this.#win.setContent(toolbarView);

    this.#win.onCloseRequest(() => {
      this.#eventLoop.stop();
      // Cleanup sources (e.g. close DB connections)
      for (const source of this.#sources.values()) {
        if ("cleanup" in source) {
          (source as any).cleanup();
        }
      }
      return false;
    });

    this.#win.present();
  }

  async #onSearchChanged() {
    if (!this.#searchEntry) return;
    const query = this.#searchEntry.getText();
    await this.#updateSearch(query);
  }

  async #updateSearch(query: string) {
    let results: SearchResult[] = [];

    // Parse Mode
    if (query.startsWith("b ")) {
      // Browser Mode
      const term = query.substring(2);
      const source = this.#sources.get("firefox");
      if (source) {
        results = await source.search(term);
      }
    } else {
      // App Mode (Default)
      const source = this.#sources.get("apps");
      if (source) {
        results = await source.search(query);
      }
    }

    // Sort by score
    results.sort((a, b) => b.score - a.score);
    this.#currentResults = results;
    this.#renderList(results);
  }

  #renderList(results: SearchResult[]) {
    if (!this.#listBox) return;

    // Clear existing children
    let child = this.#listBox.getFirstChild();
    while (child) {
      const next = this.#listBox.getNextSibling(child);
      const w = new Widget(child);
      this.#listBox.remove(w);
      w.unref();
      child = next;
    }

    for (const result of results) {
      const row = new ListBoxRow();
      
      const box = new Box(GTK_ORIENTATION_VERTICAL, 4);
      box.setMarginTop(8);
      box.setMarginBottom(8);
      box.setMarginStart(10);
      box.setMarginEnd(10);

      const titleLabel = new Label(result.title);
      titleLabel.setProperty("xalign", 0);
      titleLabel.setProperty("ellipsize", 3); // ELLIPSIZE_END
      titleLabel.setMarkup(`<b>${this.#escapeMarkup(result.title)}</b>`);
      
      const subtitleLabel = new Label(result.subtitle);
      subtitleLabel.setProperty("xalign", 0);
      subtitleLabel.setProperty("ellipsize", 3); // ELLIPSIZE_END
      subtitleLabel.setMarkup(`<span size="small" alpha="50%">${this.#escapeMarkup(result.subtitle)}</span>`);

      box.append(titleLabel);
      box.append(subtitleLabel);
      
      row.setChild(box);
      this.#listBox.append(row);
    }
  }

  #activateResult(index: number) {
    if (index >= 0 && index < this.#currentResults.length) {
      const result = this.#currentResults[index];
      result.onActivate();
      this.#eventLoop.stop();
    }
  }

  #escapeMarkup(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  async run() {
    await this.#eventLoop.start(this.#app);
  }
}

if (import.meta.main) {
  const app = new LauncherApp();
  await app.run();
}