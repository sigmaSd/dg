import { Source } from "./plugins/interface.ts";
import { ConfigManager } from "./config.ts";

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
    this.#plugins.push(new StoreSource()); // We'll create this next

    // 2. Load User Plugins from config
    const config = await this.#configManager.read();
    
    for (const url of config.plugins) {
      try {
        console.log(`Loading plugin: ${url}`);
        // Dynamic import supports http/https/jsr (via import map or directly if supported)
        // For JSR, we might need to handle it carefully if not using import maps, 
        // but Deno handles `jsr:` specifiers in dynamic imports if the environment is set up.
        // `deno run` supports it.
        const module = await import(url);
        
        // Expect default export to be the class
        if (module.default && typeof module.default === "function") {
          // Instantiate
          const plugin = new module.default();
          if (this.#isValidSource(plugin)) {
            this.#plugins.push(plugin);
          } else {
            console.warn(`Plugin ${url} does not implement Source interface correctly.`);
          }
        } else {
           console.warn(`Plugin ${url} does not export a default class.`);
        }
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

  #isValidSource(obj: any): obj is Source {
    return typeof obj.search === "function" && typeof obj.init === "function";
  }
}