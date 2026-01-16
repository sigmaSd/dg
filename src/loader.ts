import type { Source } from "./plugins/interface.ts";
import { ConfigManager } from "./config.ts";
import { WorkerSource } from "./plugins/worker/host.ts";
import * as path from "@std/path";
import type { AdwApplicationWindow } from "@sigmasd/gtk";
import {
  normalizePermissions,
  promptPermissions,
} from "./utils/permissions.ts";

// Import core plugins statically
import { AppSource } from "./plugins/core/apps.ts";
import { FirefoxSource } from "./plugins/core/firefox.ts";
import { StoreSource } from "./plugins/core/store.ts";
import { CalculatorSource } from "./plugins/core/calculator.ts";

export class PluginLoader {
  #plugins: Source[] = [];
  #configManager = new ConfigManager();

  async loadPlugins(window?: AdwApplicationWindow): Promise<Source[]> {
    this.#plugins = [];

    // 1. Load Core Plugins
    this.#plugins.push(new AppSource());
    this.#plugins.push(new FirefoxSource());
    this.#plugins.push(new StoreSource(window));
    this.#plugins.push(new CalculatorSource(window));

    // 2. Load User Plugins from config
    const config = await this.#configManager.read();

    for (const entry of config.plugins) {
      const url = entry.url;
      try {
        // Resolve absolute path if it's a local file
        let pluginPath = url;
        const isRemote = url.startsWith("http") || url.startsWith("https") ||
          url.startsWith("jsr:") || url.startsWith("npm:");

        if (!isRemote && !url.startsWith("file://")) {
          pluginPath = path.resolve(url);
          pluginPath = `file://${pluginPath}`;
        }

        // 1. Load Metadata (Safe Sandbox)
        const meta = await WorkerSource.loadMetadata(pluginPath);

        // Verify Permissions
        const granted = entry.permissions || {};
        const requested = meta.permissions || {};

        const grantedStr = JSON.stringify(normalizePermissions(granted));
        const requestedStr = JSON.stringify(normalizePermissions(requested));

        if (grantedStr !== requestedStr) {
          console.log(
            `Plugin '${meta.name}' (${url}) permissions have changed.`,
          );
          if (window) {
            const accepted = await promptPermissions(
              window,
              meta.name,
              requested,
            );
            if (accepted) {
              await this.#configManager.updatePlugin(entry.url, requested);
            } else {
              console.warn(
                `User denied updated permissions for ${meta.name}. Skipping.`,
              );
              continue;
            }
          } else {
            console.warn(
              `Cannot prompt for permissions (no window). Skipping ${meta.name}`,
            );
            continue;
          }
        }

        // 2. Initialize Worker
        const plugin = new WorkerSource(pluginPath, meta, window);
        this.#plugins.push(plugin);
      } catch (e) {
        console.error(`Failed to load plugin ${url}:`, e);
      }
    }

    // Initialize all plugins
    console.log(`Initializing ${this.#plugins.length} plugins...`);
    for (const plugin of this.#plugins) {
      try {
        await plugin.init();
      } catch (e) {
        console.error(`Failed to init plugin ${plugin.name}:`, e);
      }
    }

    return this.#plugins;
  }
}
