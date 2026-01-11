import { join } from "@std/path";
import { PluginPermissions } from "./plugins/interface.ts";

export interface PluginEntry {
  url: string;
  permissions?: PluginPermissions;
}

export interface Config {
  plugins: PluginEntry[];
}

export class ConfigManager {
  #configPath: string;

  constructor() {
    const home = Deno.env.get("HOME") || ".";
    this.#configPath = join(home, ".config", "launcher", "plugins.json");
  }

  async ensureConfigDir() {
    const dir = join(this.#configPath, "..");
    try {
      await Deno.mkdir(dir, { recursive: true });
    } catch (e) {
      if (!(e instanceof Deno.errors.AlreadyExists)) {
        throw e;
      }
    }
  }

  async read(): Promise<Config> {
    try {
      const text = await Deno.readTextFile(this.#configPath);
      const json = JSON.parse(text);
      
      // Migration: Convert string[] to PluginEntry[]
      if (Array.isArray(json.plugins) && json.plugins.length > 0 && typeof json.plugins[0] === "string") {
        json.plugins = (json.plugins as string[]).map(url => ({ url }));
      }
      
      return json;
    } catch {
      return { plugins: [] };
    }
  }

  async addPlugin(url: string, permissions?: PluginPermissions) {
    await this.ensureConfigDir();
    const config = await this.read();
    if (!config.plugins.find(p => p.url === url)) {
      config.plugins.push({ url, permissions });
      await Deno.writeTextFile(this.#configPath, JSON.stringify(config, null, 2));
    }
  }

  async updatePlugin(url: string, permissions: PluginPermissions) {
    await this.ensureConfigDir();
    const config = await this.read();
    const entry = config.plugins.find(p => p.url === url);
    if (entry) {
      entry.permissions = permissions;
      await Deno.writeTextFile(this.#configPath, JSON.stringify(config, null, 2));
    }
  }

  async removePlugin(url: string) {
    await this.ensureConfigDir();
    const config = await this.read();
    const index = config.plugins.findIndex(p => p.url === url);
    if (index !== -1) {
      config.plugins.splice(index, 1);
      await Deno.writeTextFile(this.#configPath, JSON.stringify(config, null, 2));
    }
  }
}
