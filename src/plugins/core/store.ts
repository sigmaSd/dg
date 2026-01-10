import { SearchResult, Source } from "../interface.ts";
import { ConfigManager } from "../../config.ts";

export class StoreSource implements Source {
  id = "store";
  name = "DG Plugin Store";
  description = "Search and install dg-plugins from JSR";
  trigger = "store";
  
  #configManager = new ConfigManager();
  #installedPlugins: string[] = [];
  #debounceTimer: number | null = null;
  #abortController: AbortController | null = null;
  #lastResults: SearchResult[] = [];
  #isSearching = false;

  async init(): Promise<void> {
    const config = await this.#configManager.read();
    this.#installedPlugins = config.plugins;
  }

  async search(query: string): Promise<SearchResult[]> {
    if (!query) {
      if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
      if (this.#abortController) this.#abortController.abort();
      this.#isSearching = false;
      
      const config = await this.#configManager.read();
      this.#installedPlugins = config.plugins;

      if (this.#installedPlugins.length === 0) {
        return [{
          title: "No plugins installed",
          subtitle: "Type 'store <query>' to find plugins on JSR",
          score: 0,
          onActivate: () => {}
        }];
      }

      return this.#installedPlugins.map(url => ({
        title: url,
        subtitle: "Installed - Press Enter to Remove",
        score: 100,
        onActivate: async () => {
          console.log(`Removing plugin: ${url}`);
          await this.#configManager.removePlugin(url);
        }
      }));
    }

    // Debounce logic within the async search
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    if (this.#abortController) this.#abortController.abort();

    this.#isSearching = true;

    return new Promise((resolve) => {
      this.#debounceTimer = setTimeout(async () => {
        this.#abortController = new AbortController();
        const results = await this.#performSearch(query, this.#abortController.signal);
        this.#lastResults = results;
        this.#isSearching = false;
        resolve(results);
      }, 500);
    });
  }

  async #performSearch(query: string, signal: AbortSignal): Promise<SearchResult[]> {
    try {
      const resp = await fetch(
        `https://jsr.io/api/packages?query=dg-plugin-${encodeURIComponent(query)}`,
        { signal }
      );
      if (!resp.ok) return [];
      
      const data = await resp.json();
      const items = (data.items || []) as any[];

      const filtered = items.filter(item => item.name.startsWith("dg-plugin-"));

      if (filtered.length === 0) {
        return [{
          title: "No results found",
          subtitle: "Only packages starting with 'dg-plugin-' are shown",
          score: 0,
          onActivate: () => {}
        }];
      }

      return filtered.map(item => {
        const fullUrl = `jsr:@${item.scope}/${item.name}`;
        const isInstalled = this.#installedPlugins.includes(fullUrl);

        return {
          title: `@${item.scope}/${item.name}`,
          subtitle: (isInstalled ? "[INSTALLED] " : "") + (item.description || "No description"),
          score: 10,
          onActivate: async () => {
            if (isInstalled) return;
            console.log(`Installing ${fullUrl}...`);
            await this.#configManager.addPlugin(fullUrl);
          }
        };
      });
    } catch (e) {
      if (e.name === 'AbortError') return this.#lastResults;
      console.error("JSR Search failed", e);
      return [];
    }
  }
}
