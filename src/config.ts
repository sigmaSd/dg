import { join } from "@std/path";
import type { PluginPermissions } from "./plugins/interface.ts";

export interface PluginEntry {
  url: string;
  permissions?: PluginPermissions;
}

export interface OpencodeToolsConfig {
  bash?: boolean;
  read?: boolean;
  edit?: boolean;
  write?: boolean;
  grep?: boolean;
  glob?: boolean;
  task?: boolean;
  external_directory?: "allow" | "deny" | "ask";
}

export interface OpencodeConfig {
  enabled?: boolean;
  model?: string;
  tools?: OpencodeToolsConfig;
}

export interface Config {
  plugins: PluginEntry[];
  opencode?: OpencodeConfig;
}

export interface CachedModel {
  id: string;
  name: string;
  provider: string;
  isFree: boolean;
}

export class ConfigManager {
  #configPath: string;
  #kvPromise: Promise<Deno.Kv>;

  constructor() {
    let baseDir: string;

    if (Deno.build.os === "windows") {
      baseDir = Deno.env.get("APPDATA") || Deno.env.get("HOME") || ".";
    } else {
      baseDir = Deno.env.get("XDG_CONFIG_HOME") ||
        join(Deno.env.get("HOME") || ".", ".config");
    }

    const dgDir = join(baseDir, "dg");
    this.#configPath = join(dgDir, "plugins.json");

    // Initialize KV in the config directory
    this.#kvPromise = (async () => {
      await Deno.mkdir(dgDir, { recursive: true });
      return await Deno.openKv(join(dgDir, "cache.db"));
    })();
  }

  async setCachedModels(models: CachedModel[]) {
    const kv = await this.#kvPromise;

    // Clear existing models
    const iter = kv.list({ prefix: ["models"] });
    for await (const entry of iter) {
      await kv.delete(entry.key);
    }
    // Also clear the old models_cache key if it exists
    await kv.delete(["models_cache"]);

    // Set new models
    for (let i = 0; i < models.length; i++) {
      await kv.set(["models", i], models[i]);
    }

    // Set metadata
    await kv.set(["models_meta"], {
      timestamp: Date.now(),
      count: models.length,
    });
  }

  async getCachedModels(): Promise<CachedModel[] | null> {
    const kv = await this.#kvPromise;
    const meta = await kv.get<{ timestamp: number; count: number }>([
      "models_meta",
    ]);

    if (meta.value) {
      // Refresh cache if older than 24 hours
      const oneDay = 24 * 60 * 60 * 1000;
      if (Date.now() - meta.value.timestamp > oneDay) {
        return null;
      }

      const models: CachedModel[] = [];
      const iter = kv.list<CachedModel>({ prefix: ["models"] });
      for await (const entry of iter) {
        models.push(entry.value);
      }
      return models.length > 0 ? models : null;
    }
    return null;
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

  async getOpencodeConfig(): Promise<OpencodeConfig | undefined> {
    const config = await this.read();
    return config.opencode;
  }

  async setOpencodeConfig(opencodeConfig: Partial<OpencodeConfig>) {
    await this.ensureConfigDir();
    const config = await this.read();
    config.opencode = { ...config.opencode, ...opencodeConfig };
    await Deno.writeTextFile(
      this.#configPath,
      JSON.stringify(config, null, 2),
    );
  }

  async getModel(): Promise<string> {
    const config = await this.read();
    return config.opencode?.model || "opencode/minimax-m2.5-free";
  }

  async setModel(model: string) {
    await this.ensureConfigDir();
    const config = await this.read();
    if (!config.opencode) config.opencode = {};
    config.opencode.model = model;
    await Deno.writeTextFile(
      this.#configPath,
      JSON.stringify(config, null, 2),
    );
  }
}
