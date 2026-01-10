import { join } from "@std/path";

export interface Config {
  plugins: string[];
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
      return JSON.parse(text);
    } catch {
      return { plugins: [] };
    }
  }

  async addPlugin(url: string) {
    await this.ensureConfigDir();
    const config = await this.read();
    if (!config.plugins.includes(url)) {
      config.plugins.push(url);
      await Deno.writeTextFile(this.#configPath, JSON.stringify(config, null, 2));
    }
  }

  async removePlugin(url: string) {
    await this.ensureConfigDir();
    const config = await this.read();
    const index = config.plugins.indexOf(url);
    if (index !== -1) {
      config.plugins.splice(index, 1);
      await Deno.writeTextFile(this.#configPath, JSON.stringify(config, null, 2));
    }
  }
}
