import { Source } from "./plugins/interface.ts";
import { ConfigManager } from "./config.ts";
import { WorkerSource } from "./plugins/worker/host.ts";
import * as path from "@std/path";

// Import core plugins statically
import { AppSource } from "./plugins/core/apps.ts";
import { FirefoxSource } from "./plugins/core/firefox.ts";
import { StoreSource } from "./plugins/core/store.ts";

export class PluginLoader {
  #plugins: Source[] = [];
  #configManager = new ConfigManager();

  async loadPlugins(): Promise<Source[]> {
    this.#plugins = [];

    // 1. Load Core Plugins
    this.#plugins.push(new AppSource());
    this.#plugins.push(new FirefoxSource());
    this.#plugins.push(new StoreSource()); 

    // 2. Load User Plugins from config
    const config = await this.#configManager.read();
    
    for (const url of config.plugins) {
      try {
        console.log(`Loading plugin metadata: ${url}`);
        
        // Resolve absolute path if it's a local file
        let pluginPath = url;
        const isRemote = url.startsWith("http") || url.startsWith("https") || url.startsWith("jsr:") || url.startsWith("npm:");
        
        if (!isRemote && !url.startsWith("file://")) {
             // If it's a relative path, resolve it relative to CWD or config?
             // For now, assume absolute or CWD relative
             pluginPath = path.resolve(url);
             pluginPath = `file://${pluginPath}`;
        }

        // 1. Load Metadata (Safe Sandbox)
        const meta = await WorkerSource.loadMetadata(pluginPath);
        console.log(`Plugin '${meta.name}' requests permissions:`, meta.permissions);

        // TODO: Show UI Dialog here to ask user for permission
        // For now, we auto-approve
        
        // 2. Initialize Worker
        const plugin = new WorkerSource(pluginPath, meta);
        this.#plugins.push(plugin);

      } catch (e) {
        console.error(`Failed to load plugin ${url}:`, e);
      }
    }

    // Initialize all plugins
    console.log(`Loaded ${this.#plugins.length} plugins.`);
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