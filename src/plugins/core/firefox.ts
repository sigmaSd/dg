import { DatabaseSync } from "node:sqlite";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { SearchResult, Source } from "../interface.ts";
import { openUrl } from "../../utils/open-url.ts";

async function fileVersion(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path, { bigint: true });
    return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function copyPlacesSnapshot(source: string, target: string) {
  const sourceWal = `${source}-wal`;
  const targetWal = `${target}-wal`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const [places, wal] = await Promise.all([
        fileVersion(source),
        fileVersion(sourceWal),
      ]);
      if (!places) break;
      await Deno.copyFile(source, target);
      if (wal) {
        await Deno.copyFile(sourceWal, targetWal);
      } else {
        await Deno.remove(targetWal).catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        });
      }
      const [copiedPlaces, copiedWal] = await Promise.all([
        fileVersion(source),
        fileVersion(sourceWal),
      ]);
      // Firefox may write or checkpoint its WAL during the copy. Retry a changed pair.
      if (places === copiedPlaces && wal === copiedWal) return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  throw new Error("Could not take a stable snapshot of Firefox history.");
}

export class FirefoxSource implements Source {
  id = "firefox";
  name = "Firefox History";
  description = "Search browser history and bookmarks";
  trigger = "b";

  #db?: DatabaseSync;
  #snapshotDir?: string;
  #openUrl: typeof openUrl;

  constructor(opener = openUrl) {
    this.#openUrl = opener;
  }

  async init(): Promise<void> {
    // Clean up any previous init before re-initializing
    await this.destroy();

    const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
    if (!home) return;

    const configHome = Deno.env.get("XDG_CONFIG_HOME") || join(home, ".config");
    const roots = [
      join(configHome, "mozilla", "firefox"),
      join(home, ".mozilla", "firefox"),
    ];
    if (Deno.build.os === "linux") {
      const flatpak = join(home, ".var", "app", "org.mozilla.firefox");
      roots.push(
        join(flatpak, "config", "mozilla", "firefox"),
        join(flatpak, ".mozilla", "firefox"),
      );
      roots.push(
        join(home, "snap", "firefox", "common", ".mozilla", "firefox"),
      );
    } else if (Deno.build.os === "darwin") {
      roots.unshift(
        join(home, "Library", "Application Support", "Firefox", "Profiles"),
      );
    } else if (Deno.build.os === "windows") {
      const roaming = Deno.env.get("APPDATA") ||
        join(home, "AppData", "Roaming");
      roots.unshift(join(roaming, "Mozilla", "Firefox", "Profiles"));
    }
    const candidates: Array<{ path: string; mtime: number; name: string }> = [];
    for (const root of roots) {
      try {
        for await (const entry of Deno.readDir(root)) {
          if (!entry.isDirectory && !entry.isSymlink) continue;
          const places = join(root, entry.name, "places.sqlite");
          const info = await Deno.stat(places).catch(() => undefined);
          if (!info?.isFile) continue;
          const wal = await Deno.stat(`${places}-wal`).catch(() => undefined);
          candidates.push({
            path: places,
            mtime: Math.max(
              info.mtime?.getTime() ?? 0,
              wal?.mtime?.getTime() ?? 0,
            ),
            name: entry.name,
          });
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          console.warn(`Could not read Firefox profiles in ${root}:`, error);
        }
      }
    }

    if (candidates.length === 0) {
      this.description = "No Firefox history profile found";
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

    const cache = Deno.env.get("XDG_CACHE_HOME") || join(home, ".cache");
    const snapshotRoot = Deno.env.get("TMPDIR") || join(cache, "dg");
    await Deno.mkdir(snapshotRoot, { recursive: true });
    this.#snapshotDir = await Deno.makeTempDir({
      dir: snapshotRoot,
      prefix: "dg-firefox-",
    });
    const snapshot = join(this.#snapshotDir, "places.sqlite");
    try {
      await copyPlacesSnapshot(candidates[0].path, snapshot);
      this.#db = new DatabaseSync(snapshot, { readOnly: true });
      this.#db.prepare("SELECT 1 FROM moz_places LIMIT 0");
      this.description = "Search browser history and bookmarks";
    } catch (error) {
      await this.destroy();
      throw error;
    }
  }

  search(query: string): Promise<SearchResult[]> {
    query = query.trim();
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
        onActivate: () => this.#openUrl(row.url),
      };
    }));
  }

  async destroy(): Promise<void> {
    // Close database first (releases file handle)
    if (this.#db) {
      try {
        this.#db.close();
      } catch {
        // Ignore
      }
      this.#db = undefined;
    }

    // Then remove temp file
    if (this.#snapshotDir) {
      try {
        await Deno.remove(this.#snapshotDir, { recursive: true });
      } catch {
        // Ignore
      }
      this.#snapshotDir = undefined;
    }
  }
}
