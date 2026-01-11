#!/usr/bin/env -S deno run --allow-ffi

import {
  AdwApplicationWindow,
  Application,
  Box,
  Button,
  GTK_ORIENTATION_VERTICAL,
  HeaderBar,
  Label,
  ToolbarView,
} from "../src/gtk-ffi.ts";

const APP_ID = "com.example.CSDDemo";
const APP_FLAGS = 0;

class CSDDemoApp {
  #app: Application;
  #win?: AdwApplicationWindow;

  constructor() {
    this.#app = new Application(APP_ID, APP_FLAGS);

    this.#app.onActivate(() => {
      if (!this.#win) {
        this.#win = new AdwApplicationWindow(this.#app);
        this.#win.setTitle("CSD Demo");
        this.#win.setDefaultSize(400, 300);

        // Create a ToolbarView
        const toolbarView = new ToolbarView();

        // Create a header bar and add it to top bars
        const headerBar = new HeaderBar();
        toolbarView.addTopBar(headerBar);

        // Main container
        const box = new Box(GTK_ORIENTATION_VERTICAL, 12);
        box.setMarginTop(24);
        box.setMarginBottom(24);
        box.setMarginStart(24);
        box.setMarginEnd(24);

        const label = new Label(
          "This window uses Client-Side Decorations (CSD)",
        );
        box.append(label);

        const decoratedBtn = new Button("Toggle System Decorations");
        let isDecorated = true;
        decoratedBtn.onClick(() => {
          isDecorated = !isDecorated;
          this.#win?.setDecorated(isDecorated);
          label.setText(`Decorated: ${isDecorated}`);
          console.log(`Window decorated set to: ${isDecorated}`);
        });
        box.append(decoratedBtn);

        // Set content of toolbar view
        toolbarView.setContent(box);

        // Set content of window
        this.#win.setContent(toolbarView);
        this.#win.present();
      }
    });
  }

  run(): number {
    return this.#app.run([]);
  }
}

if (import.meta.main) {
  const app = new CSDDemoApp();
  const exitCode = app.run();
  Deno.exit(exitCode);
}
