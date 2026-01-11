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

      return this.#installedPlugins.map(url => {
        // Parse version from URL like jsr:@scope/pkg@version
        const match = url.match(/jsr:@([^/]+)\/([^@]+)@(.+)/);
        const displayTitle = match ? `@${match[1]}/${match[2]}` : url;
        const displayVersion = match ? `v${match[3]}` : "unknown version";

        return {
          title: displayTitle,
          subtitle: `${displayVersion} - Press Enter to Remove`,
          score: 100,
          onActivate: async () => {
            console.log(`Removing plugin: ${url}`);
            await this.#configManager.removePlugin(url);
          }
        };
      });
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

      const results: SearchResult[] = [];
      for (const item of filtered) {
        if (signal.aborted) break;

        // Fetch latest version from meta.json
        let latest = "latest";
        try {
          const metaResp = await fetch(`https://jsr.io/@${item.scope}/${item.name}/meta.json`, { signal });
          if (metaResp.ok) {
            const meta = await metaResp.json();
            latest = meta.latest;
          }
        } catch { /* fallback to @latest */ }

        const fullUrl = `jsr:@${item.scope}/${item.name}`;
        const pinnedUrl = `${fullUrl}@${latest}`;
        
        // Check if ANY version of this plugin is installed
        const installedVersion = this.#installedPlugins.find(p => p.startsWith(fullUrl));
        const isInstalled = !!installedVersion;
        const isLatest = installedVersion === pinnedUrl;

        let subtitle = item.description || "No description";
        if (isInstalled) {
          subtitle = isLatest ? `[INSTALLED v${latest}] ${subtitle}` : `[UPDATE AVAILABLE to v${latest}] ${subtitle}`;
        } else {
          subtitle = `[v${latest}] ${subtitle}`;
        }

        results.push({
          title: `@${item.scope}/${item.name}`,
          subtitle,
          score: 10,
          onActivate: async () => {
            if (isInstalled && isLatest) return;
            
            if (installedVersion) {
              console.log(`Updating ${fullUrl} to ${latest}...`);
              await this.#configManager.removePlugin(installedVersion);
            } else {
              console.log(`Installing ${pinnedUrl}...`);
            }
            await this.#configManager.addPlugin(pinnedUrl);
          }
        });
      }
      return results;
    } catch (e) {
      if (e.name === 'AbortError') return this.#lastResults;
      console.error("JSR Search failed", e);
      return [];
    }
  }
}
