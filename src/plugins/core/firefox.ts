import { DatabaseSync } from "node:sqlite";
import { SearchResult, Source } from "../interface.ts";

export class FirefoxSource implements Source {
  id = "firefox";
  name = "Firefox History";
  description = "Search browser history and bookmarks";
  trigger = "b";

  #dbPath?: string;
  #db?: DatabaseSync;
  #tmpPath?: string;

  async init(): Promise<void> {
    const home = Deno.env.get("HOME");
    if (!home) return;

    const firefoxDir = `${home}/.mozilla/firefox`;
    try {
      for await (const entry of Deno.readDir(firefoxDir)) {
        if (entry.isDirectory && (entry.name.endsWith(".default-release") || entry.name.endsWith(".default"))) {
          const placesPath = `${firefoxDir}/${entry.name}/places.sqlite`;
          try {
            await Deno.stat(placesPath);
            this.#dbPath = placesPath;
            break;
          } catch {
            continue;
          }
        }
      }
    } catch {
      // Firefox not found or no permission
      console.warn("Could not find Firefox profile");
      return;
    }

    if (this.#dbPath) {
      // Copy to temp to avoid lock
      this.#tmpPath = await Deno.makeTempFile({ suffix: ".sqlite" });
      await Deno.copyFile(this.#dbPath, this.#tmpPath);
      this.#db = new DatabaseSync(this.#tmpPath);
    }
  }

  async search(query: string): Promise<SearchResult[]> {
    if (!this.#db || !query) return [];

    const q = `%${query}%`;
    const stmt = this.#db.prepare(`
      SELECT title, url, visit_count 
      FROM moz_places 
      WHERE (title LIKE ? OR url LIKE ?) 
      AND hidden = 0
      ORDER BY visit_count DESC 
      LIMIT 20
    `);

    const rows = stmt.all(q, q) as { title: string | null; url: string; visit_count: number }[];

    return rows.map(row => ({
      title: row.title || row.url,
      subtitle: row.url,
      score: 10 + Math.min(row.visit_count, 20),
      onActivate: () => {
        console.log(`Opening: ${row.url}`);
        const command = new Deno.Command("xdg-open", {
          args: [row.url],
          stdin: "null",
          stdout: "null",
          stderr: "null",
        });
        command.spawn();
      }
    }));
  }

  cleanup() {
    if (this.#tmpPath) {
      try {
        Deno.removeSync(this.#tmpPath);
      } catch {
        // Ignore
      }
    }
  }
}
