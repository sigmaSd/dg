import { join } from "@std/path";
import type { PluginPermissions } from "./plugins/interface.ts";

export interface PluginEntry {
  url: string;
  permissions?: PluginPermissions;
}

export interface Config {
  plugins: PluginEntry[];
  openrouterApiKey?: string;
  opencodeServerUrl?: string;
  opencodeEnabled?: boolean;
}

export class ConfigManager {
  #configPath: string;

  constructor() {
    let baseDir: string;

    if (Deno.build.os === "windows") {
      baseDir = Deno.env.get("APPDATA") || Deno.env.get("HOME") || ".";
    } else {
      baseDir = Deno.env.get("XDG_CONFIG_HOME") ||
        join(Deno.env.get("HOME") || ".", ".config");
    }

    this.#configPath = join(baseDir, "dg", "plugins.json");
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
      if (
        Array.isArray(json.plugins) && json.plugins.length > 0 &&
        typeof json.plugins[0] === "string"
      ) {
        json.plugins = (json.plugins as string[]).map((url) => ({ url }));
      }

      return json;
    } catch {
      return { plugins: [] };
    }
  }

  async addPlugin(url: string, permissions?: PluginPermissions) {
    await this.ensureConfigDir();
    const config = await this.read();
    if (!config.plugins.find((p) => p.url === url)) {
      config.plugins.push({ url, permissions });
      await Deno.writeTextFile(
        this.#configPath,
        JSON.stringify(config, null, 2),
      );
    }
  }

  async updatePlugin(url: string, permissions: PluginPermissions) {
    await this.ensureConfigDir();
    const config = await this.read();
    const entry = config.plugins.find((p) => p.url === url);
    if (entry) {
      entry.permissions = permissions;
      await Deno.writeTextFile(
        this.#configPath,
        JSON.stringify(config, null, 2),
      );
    }
  }

  async removePlugin(url: string) {
    await this.ensureConfigDir();
    const config = await this.read();
    const index = config.plugins.findIndex((p) => p.url === url);
    if (index !== -1) {
      config.plugins.splice(index, 1);
      await Deno.writeTextFile(
        this.#configPath,
        JSON.stringify(config, null, 2),
      );
    }
  }

  async getApiKey(): Promise<string | undefined> {
    const config = await this.read();
    return config.openrouterApiKey;
  }

  async setApiKey(key: string) {
    await this.ensureConfigDir();
    const config = await this.read();
    config.openrouterApiKey = key;
    await Deno.writeTextFile(
      this.#configPath,
      JSON.stringify(config, null, 2),
    );
  }

  async getOpencodeServerUrl(): Promise<string | undefined> {
    const config = await this.read();
    return config.opencodeServerUrl;
  }

  async setOpencodeServerUrl(url: string) {
    await this.ensureConfigDir();
    const config = await this.read();
    config.opencodeServerUrl = url;
    await Deno.writeTextFile(
      this.#configPath,
      JSON.stringify(config, null, 2),
    );
  }

  async isOpencodeEnabled(): Promise<boolean> {
    const config = await this.read();
    return config.opencodeEnabled ?? false;
  }

  async setOpencodeEnabled(enabled: boolean) {
    await this.ensureConfigDir();
    const config = await this.read();
    config.opencodeEnabled = enabled;
    await Deno.writeTextFile(
      this.#configPath,
      JSON.stringify(config, null, 2),
    );
  }
}
