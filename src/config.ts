import { join } from "@std/path";
import type { PluginPermissions } from "./plugins/interface.ts";

export interface PluginEntry {
  url: string;
  name?: string;
  trigger?: string;
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
  external_directory?: boolean;
}

export interface OpencodeConfig {
  enabled?: boolean;
  model?: string;
  tools?: OpencodeToolsConfig;
}

export const defaultOpencodeTools: Readonly<Required<OpencodeToolsConfig>> = {
  read: true,
  grep: true,
  glob: true,
  edit: false,
  write: false,
  bash: false,
  task: false,
  external_directory: false,
};

export interface Config {
  plugins: PluginEntry[];
  opencode?: OpencodeConfig;
}

export class ConfigManager {
  #configPath: string;
  #settingsDir: string;

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
    this.#settingsDir = join(dgDir, "settings");
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

  async getPluginSettings(id: string): Promise<unknown> {
    const file = join(this.#settingsDir, `${encodeURIComponent(id)}.json`);
    try {
      return JSON.parse(await Deno.readTextFile(file));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  async setPluginSettings(id: string, value: unknown): Promise<void> {
    const json = JSON.stringify(value, null, 2);
    if (json === undefined) throw new TypeError("Plugin settings must be JSON");
    const file = join(this.#settingsDir, `${encodeURIComponent(id)}.json`);
    await Deno.mkdir(this.#settingsDir, { recursive: true });
    const temp = await Deno.makeTempFile({ dir: this.#settingsDir });
    try {
      await Deno.writeTextFile(temp, `${json}\n`);
      await Deno.rename(temp, file);
    } catch (error) {
      await Deno.remove(temp).catch(() => {});
      throw error;
    }
  }

  async read(): Promise<Config> {
    try {
      const text = await Deno.readTextFile(this.#configPath);
      const json = JSON.parse(text);

      // Migration: Convert string[] to PluginEntry[]
      json.plugins = Array.isArray(json.plugins)
        ? json.plugins.flatMap((entry: PluginEntry | string | null) => {
          if (typeof entry === "string") return [{ url: entry }];
          return entry && typeof entry.url === "string" ? [entry] : [];
        })
        : [];

      return json;
    } catch {
      return { plugins: [] };
    }
  }

  async addPlugin(
    url: string,
    permissions?: PluginPermissions,
    name?: string,
    trigger?: string,
  ) {
    await this.ensureConfigDir();
    const config = await this.read();
    if (!config.plugins.find((p) => p.url === url)) {
      config.plugins.push({ url, permissions, name, trigger });
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
}
