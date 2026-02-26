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
  Widget,
} from "@sigmasd/gtk/gtk4";
import { AdwApplicationWindow, ToolbarView } from "@sigmasd/gtk/adw";
import { EventLoop } from "@sigmasd/gtk/eventloop";
import type { SearchResult, Source } from "./plugins/interface.ts";
import { PluginLoader } from "./loader.ts";
import { SimpleAction } from "@sigmasd/gtk/gio";

const APP_ID = "io.github.sigmasd.dg";
const APP_FLAGS = 0;

class DGApp {
  #app: Application;
  #win?: AdwApplicationWindow;
  #eventLoop: EventLoop;
  #listBox?: ListBox;
  #searchEntry?: Entry;
  #statusLabel?: Label;
  #spinner?: Spinner;
  #bottomBox?: Box;

  #loader: PluginLoader;
  #plugins: Source[] = [];
  #currentResults: SearchResult[] = [];
  #latestSearchId = 0;

  constructor() {
    this.#app = new Application(APP_ID, APP_FLAGS);
    this.#eventLoop = new EventLoop({ pollInterval: 16 });
    this.#loader = new PluginLoader();

    this.#app.onActivate(() => {
      if (!this.#win) {
        this.#buildUI();
        this.#initPlugins();
        this.#setupActions();
      }
      this.#win?.present();
      // Clear search and focus when re-opening
      this.#searchEntry?.setText("");
      this.#searchEntry?.grabFocus();
    });
  }

  async #initPlugins() {
    console.log("Loading plugins...");
    this.#setLoading(true, "Loading plugins...");
    this.#plugins = await this.#loader.loadPlugins(this.#win);
    this.#setLoading(false);
    // Use the current text in the entry if the user already started typing
    const currentQuery = this.#searchEntry?.getText() || "";
    this.#updateSearch(currentQuery);
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
    quitAction.connect("activate", () => {
      console.log("Quit action activated");
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
      this.#win?.setVisible(false);
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
      "Type to search apps, or 'b' for browser...",
    );
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
      this.#win?.setVisible(false);
      return true;
    });

    this.#win.present();
  }

  async #onSearchChanged() {
    if (!this.#searchEntry) return;
    const query = this.#searchEntry.getText();
    await this.#updateSearch(query);
  }

  async #updateSearch(query: string) {
    const searchId = ++this.#latestSearchId;
    this.#setLoading(true, "Searching...");

    let results: SearchResult[] = [];

    const parts = query.split(" ");
    const trigger = parts[0];
    const args = parts.slice(1).join(" ");

    // Check if a plugin matches the specific trigger
    // Only trigger if there is at least one space after the trigger
    const triggeredPlugin = parts.length > 1
      ? this.#plugins.find((p) => p.trigger === trigger)
      : undefined;

    if (triggeredPlugin) {
      // Specific plugin search
      results = await triggeredPlugin.search(args);
    } else {
      // Global search (plugins with no trigger)
      const globalPlugins = this.#plugins.filter((p) => !p.trigger);
      for (const plugin of globalPlugins) {
        const pluginResults = await plugin.search(query);
        results = results.concat(pluginResults);
      }
    }

    // Only update if this is the latest search
    if (searchId === this.#latestSearchId) {
      this.#setLoading(false);
      results.sort((a, b) => b.score - a.score);
      this.#currentResults = results;
      this.#renderList(results);
    }
  }

  #renderList(results: SearchResult[]) {
    if (!this.#listBox) return;

    let child = this.#listBox.getFirstChild();
    while (child) {
      const next = this.#listBox.getNextSibling(child);
      const w = new Widget(child);
      this.#listBox.remove(w);
      // Note: GTK automatically unrefs when removing from container
      // Manual unref() here causes double-free and segfaults
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
  }

  async #activateResult(index: number) {
    if (index >= 0 && index < this.#currentResults.length) {
      const result = this.#currentResults[index];
      await result.onActivate();
      this.#win?.setVisible(false);
    }
  }

  #escapeMarkup(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
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
}

if (import.meta.main) {
  const app = new DGApp();
  await app.run();
}
