import {
  AdwApplicationWindow,
  Application,
  Box,
  Button,
  Entry,
  GTK_ORIENTATION_VERTICAL,
  HeaderBar,
  Label,
  ListBox,
  ListBoxRow,
  ScrolledWindow,
  ToolbarView,
  Widget,
} from "@sigmasd/gtk";
import { EventLoop } from "@sigmasd/gtk/eventloop";
import { AppInfo, getApps } from "./apps.ts";

const APP_ID = "com.mrcool.Launcher";
// App flags 0 = G_APPLICATION_FLAGS_NONE
const APP_FLAGS = 0;

class LauncherApp {
  #app: Application;
  #win?: AdwApplicationWindow;
  #eventLoop: EventLoop;
  #listBox?: ListBox;
  #allApps: AppInfo[] = [];
  #searchEntry?: Entry;

  constructor() {
    this.#app = new Application(APP_ID, APP_FLAGS);
    this.#eventLoop = new EventLoop({ pollInterval: 16 });

    this.#app.onActivate(() => {
      this.#buildUI();
      this.#loadApps();
    });
  }

  #buildUI() {
    if (this.#win) return;

    this.#win = new AdwApplicationWindow(this.#app);
    this.#win.setTitle("App Launcher");
    this.#win.setDefaultSize(600, 500);

    // Main layout with ToolbarView (standard for Adwaita apps)
    const toolbarView = new ToolbarView();
    
    // Header Bar
    const headerBar = new HeaderBar();
    toolbarView.addTopBar(headerBar);

    // Content container
    const contentBox = new Box(GTK_ORIENTATION_VERTICAL, 0);
    
    // Search Entry area
    const searchBox = new Box(GTK_ORIENTATION_VERTICAL, 0);
    searchBox.setMarginTop(12);
    searchBox.setMarginBottom(12);
    searchBox.setMarginStart(12);
    searchBox.setMarginEnd(12);

    this.#searchEntry = new Entry();
    this.#searchEntry.setProperty("placeholder-text", "Search applications...");
    this.#searchEntry.onChanged(() => this.#filterApps());
    // On Enter key, launch the first result
    this.#searchEntry.onActivate(() => this.#launchFirstResult());
    
    searchBox.append(this.#searchEntry);
    contentBox.append(searchBox);

    // List of apps
    const scrolled = new ScrolledWindow();
    scrolled.setProperty("vexpand", true); // Expand to fill space
    
    this.#listBox = new ListBox();
    this.#listBox.setProperty("selection-mode", 1); // Single selection
    this.#listBox.setMarginTop(0);
    this.#listBox.setMarginBottom(12);
    this.#listBox.setMarginStart(12);
    this.#listBox.setMarginEnd(12);
    // Add CSS class "content" logic if we had CSS provider, but we don't yet.

    this.#listBox.onRowActivated((_row, index) => {
      this.#launchAppAtIndex(index);
    });

    scrolled.setChild(this.#listBox);
    contentBox.append(scrolled);

    toolbarView.setContent(contentBox);
    this.#win.setContent(toolbarView);

    // Handle window close to stop event loop
    this.#win.onCloseRequest(() => {
      this.#eventLoop.stop();
      return false; // Allow close
    });

    this.#win.present();
  }

  async #loadApps() {
    console.log("Loading apps...");
    this.#allApps = await getApps();
    console.log(`Found ${this.#allApps.length} apps.`);
    this.#renderList(this.#allApps);
  }

  #renderList(apps: AppInfo[]) {
    if (!this.#listBox) return;

    // Clear existing children
    // Note: Since we don't have a clear() method exposed yet on ListBox in this version,
    // we iterate children. gtk_widget_get_first_child / next_sibling logic needed.
    // However, the easier way in this binding if `remove` works is:
    let child = this.#listBox.getFirstChild();
    while (child) {
      const next = this.#listBox.getNextSibling(child);
      // We need to wrap the raw pointer in a Widget to pass to remove
      // But wait, remove takes a Widget wrapper. 
      // The bindings for ListBox.remove take a Widget.
      // We can create a temporary wrapper.
      const w = new Widget(child);
      this.#listBox.remove(w);
      w.unref(); // Release the reference added by new Widget(child)
      child = next;
    }

    for (const app of apps) {
      const row = new ListBoxRow();
      
      const box = new Box(GTK_ORIENTATION_VERTICAL, 4);
      box.setMarginTop(10);
      box.setMarginBottom(10);
      box.setMarginStart(10);
      box.setMarginEnd(10);

      const nameLabel = new Label(app.name);
      nameLabel.setProperty("xalign", 0); // Left align
      // Make it bold using markup
      nameLabel.setMarkup(`<b>${this.#escapeMarkup(app.name)}</b>`);
      
      const execLabel = new Label(app.exec);
      execLabel.setProperty("xalign", 0);
      // Smaller text? We don't have CSS classes easily, but can use markup
      execLabel.setMarkup(`<span size="small" alpha="50%">${this.#escapeMarkup(app.exec)}</span>`);

      box.append(nameLabel);
      box.append(execLabel);
      
      row.setChild(box);
      this.#listBox.append(row);
    }
  }

  #filterApps() {
    if (!this.#searchEntry) return;
    const query = this.#searchEntry.getText().toLowerCase();
    
    const filtered = this.#allApps.filter(app => 
      app.name.toLowerCase().includes(query) || 
      app.exec.toLowerCase().includes(query)
    );

    this.#renderList(filtered);
  }

  #launchFirstResult() {
    // If we have filtered results, launch the first one
    if (!this.#searchEntry) return;
    const query = this.#searchEntry.getText().toLowerCase();
    const filtered = this.#allApps.filter(app => 
      app.name.toLowerCase().includes(query) || 
      app.exec.toLowerCase().includes(query)
    );

    if (filtered.length > 0) {
      this.#launchApp(filtered[0]);
    }
  }

  #launchAppAtIndex(index: number) {
     // Need to find which app corresponds to this index in the CURRENT filtered list
     if (!this.#searchEntry) return;
     const query = this.#searchEntry.getText().toLowerCase();
     const filtered = this.#allApps.filter(app => 
       app.name.toLowerCase().includes(query) || 
       app.exec.toLowerCase().includes(query)
     );

     if (index >= 0 && index < filtered.length) {
       this.#launchApp(filtered[index]);
     }
  }

  #launchApp(app: AppInfo) {
    console.log(`Launching: ${app.name} (${app.exec})`);
    try {
      // Use sh -c to handle arguments in exec string
      const command = new Deno.Command("sh", {
        args: ["-c", `${app.exec} &`], // Run in background
        stdin: "null",
        stdout: "null",
        stderr: "null",
      });
      command.spawn();
      
      // Close launcher after launch
      this.#eventLoop.stop();
    } catch (e) {
      console.error(`Failed to launch ${app.name}:`, e);
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
