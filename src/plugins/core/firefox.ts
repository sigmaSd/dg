import { DatabaseSync } from "node:sqlite";
import type { SearchResult, Source } from "../interface.ts";

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

    // Find all potential Firefox profiles with places.sqlite
    const candidates: Array<{ path: string; mtime: number; name: string }> = [];

    try {
      for await (const entry of Deno.readDir(firefoxDir)) {
        if (entry.isDirectory) {
          const placesPath = `${firefoxDir}/${entry.name}/places.sqlite`;
          try {
            const stat = await Deno.stat(placesPath);
            candidates.push({
              path: placesPath,
              mtime: stat.mtime?.getTime() || 0,
              name: entry.name,
            });
          } catch {
            continue;
          }
        }
      }
    } catch {
      console.warn("Could not find Firefox profile");
      return;
    }

    if (candidates.length === 0) {
      console.warn("No Firefox profiles with places.sqlite found");
      return;
    }

    // Sort by priority:
    // 1. Prefer profiles with "default-release" in name
    // 2. Then by modification time (most recent first)
    candidates.sort((a, b) => {
      const aIsRelease = a.name.includes("default-release") ? 1 : 0;
      const bIsRelease = b.name.includes("default-release") ? 1 : 0;
      if (aIsRelease !== bIsRelease) return bIsRelease - aIsRelease;
      return b.mtime - a.mtime;
    });

    this.#dbPath = candidates[0].path;
    console.log(`Using Firefox profile: ${candidates[0].name}`);

    if (this.#dbPath) {
      // Copy to temp to avoid lock
      this.#tmpPath = await Deno.makeTempFile({ suffix: ".sqlite" });
      await Deno.copyFile(this.#dbPath, this.#tmpPath);
      this.#db = new DatabaseSync(this.#tmpPath);
    }
  }

  search(query: string): Promise<SearchResult[]> {
    if (!this.#db || !query) return Promise.resolve([]);

    const q = `%${query}%`;
    const stmt = this.#db.prepare(`
      SELECT title, url, visit_count, frecency, last_visit_date, typed
      FROM moz_places
      WHERE (title LIKE ? OR url LIKE ?)
      AND hidden = 0
      ORDER BY frecency DESC, last_visit_date DESC
      LIMIT 20
    `);

    const rows = stmt.all(q, q) as {
      title: string | null;
      url: string;
      visit_count: number;
      frecency: number;
      last_visit_date: number | null;
      typed: number;
    }[];

    // Current time in microseconds (Firefox uses microseconds since epoch)
    const now = Date.now() * 1000;

    return Promise.resolve(rows.map((row) => {
      // Base score from Firefox's frecency algorithm
      let score = Math.max(0, row.frecency / 100);

      // Boost for recency (sites visited in last 24h get significant boost)
      if (row.last_visit_date) {
        const hoursSinceVisit = (now - row.last_visit_date) /
          (1000 * 1000 * 3600);
        if (hoursSinceVisit < 1) score += 50; // Last hour
        else if (hoursSinceVisit < 24) score += 30; // Last day
        else if (hoursSinceVisit < 168) score += 10; // Last week
      }

      // Boost for typed URLs (implies importance)
      if (row.typed > 0) score += 15;

      return {
        title: row.title || row.url,
        subtitle: row.url,
        icon: "firefox",
        score,
        onActivate: () => {
          console.log(`Opening: ${row.url}`);
          let commandName = "xdg-open";
          let args = [row.url];

          if (Deno.build.os === "windows") {
            commandName = "cmd";
            args = ["/c", "start", row.url];
          } else if (Deno.build.os === "darwin") {
            commandName = "open";
          }

          const command = new Deno.Command(commandName, {
            args,
            stdin: "null",
            stdout: "null",
            stderr: "null",
            detached: true,
          });
          command.spawn();
        },
      };
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
