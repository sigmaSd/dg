import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute } from "node:path";
import { platform } from "node:process";
import { pathToFileURL } from "node:url";
import type { AppInfo } from "../../apps.ts";
import type { ConfigManager } from "../../config.ts";
import type { SearchResult, Source } from "../interface.ts";
import type { AppSource } from "./apps.ts";

export const pathTargets = ["both", "files", "folders"] as const;
type PathTarget = typeof pathTargets[number];
type SystemAction = "default" | "reveal";

export type PathAction =
  | { kind: SystemAction; target: PathTarget }
  | { kind: "app"; target: PathTarget; desktopId: string };

export const NAUTILUS_DESKTOP_ID = "org.gnome.Nautilus.desktop";

export type FileManagerStartupId = (
  path: string,
  options?: { desktopFile?: string; nautilusOnly?: boolean },
) => string | undefined;

export const systemPathActions = {
  default: { title: "Open with Default App", icon: "document-open-symbolic" },
  reveal: { title: "Reveal in File Manager", icon: "folder-open-symbolic" },
} satisfies Record<SystemAction, { title: string; icon: string }>;

const defaultActions: readonly PathAction[] = [
  { kind: "default", target: "both" },
  { kind: "reveal", target: "files" },
];

function isPathAction(value: unknown): value is PathAction {
  if (
    !value || typeof value !== "object" || !("target" in value) ||
    !pathTargets.some((target) => target === value.target) || !("kind" in value)
  ) {
    return false;
  }
  return value.kind === "default" || value.kind === "reveal" ||
    (value.kind === "app" && "desktopId" in value &&
      typeof value.desktopId === "string" &&
      value.desktopId.endsWith(".desktop"));
}

export function isPathQuery(query: string): boolean {
  return platform === "linux" &&
    (isAbsolute(query) || query === "~" || query.startsWith("~/"));
}

export function expandHomePath(path: string, home = homedir()): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} could not open this path`));
    });
  });
}

function showInFileManager(
  method: "ShowFolders" | "ShowItems",
  path: string,
  startupId = "",
  busName = "org.freedesktop.FileManager1",
): Promise<void> {
  return runCommand("gdbus", [
    "call",
    "--session",
    "--timeout",
    "3",
    "--dest",
    busName,
    "--object-path",
    "/org/freedesktop/FileManager1",
    "--method",
    `org.freedesktop.FileManager1.${method}`,
    JSON.stringify([pathToFileURL(path).href]),
    JSON.stringify(startupId),
  ]);
}

export class PathSource implements Source {
  id = "paths";
  name = "Paths";
  description = "Paste an absolute path, ~, or a path starting with ~/";
  #apps: AppSource;
  #config: ConfigManager;
  #fileManagerStartupId?: FileManagerStartupId;
  #desktopApps = new Map<string, AppInfo>();
  #actions: readonly PathAction[] = defaultActions;

  constructor(
    apps: AppSource,
    config: ConfigManager,
    fileManagerStartupId?: FileManagerStartupId,
  ) {
    this.#apps = apps;
    this.#config = config;
    this.#fileManagerStartupId = fileManagerStartupId;
  }

  get desktopApps(): ReadonlyMap<string, AppInfo> {
    return this.#desktopApps;
  }

  get actions(): readonly PathAction[] {
    return this.#actions;
  }

  async init(): Promise<void> {
    if (platform !== "linux") return;
    this.#desktopApps = new Map(
      (await this.#apps.loadCatalog()).map((app) => [basename(app.path), app]),
    );
    const saved = await this.#config.getPluginSettings(this.id);
    this.#actions = Array.isArray(saved)
      ? saved.filter(isPathAction)
      : defaultActions;
  }

  async saveActions(actions: readonly PathAction[]): Promise<void> {
    const saved = [...actions];
    await this.#config.setPluginSettings(this.id, saved);
    this.#actions = saved;
  }

  async search(query: string): Promise<SearchResult[]> {
    return (await this.lookup(query)).results;
  }

  async lookup(
    query: string,
  ): Promise<{ results: SearchResult[]; message?: string }> {
    if (!isPathQuery(query)) return { results: [] };
    const path = expandHomePath(query);
    const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw error;
    });
    if (!info) {
      return { results: [], message: "No file or folder exists at this path." };
    }
    if (!info.isDirectory() && !info.isFile()) {
      return {
        results: [],
        message: "This path is not a regular file or folder.",
      };
    }

    const target = info.isDirectory() ? "folders" : "files";
    const results: SearchResult[] = [];
    for (const action of this.#actions) {
      if (action.target !== "both" && action.target !== target) continue;
      const score = -results.length;
      if (action.kind === "app") {
        const app = this.#desktopApps.get(action.desktopId);
        if (!app) continue;
        results.push({
          title: `Open in ${app.name}`,
          subtitle: path,
          icon: app.icon || "application-x-executable",
          score,
          onActivate:
            target === "folders" && action.desktopId === NAUTILUS_DESKTOP_ID
              ? () => this.#openFolder(path, app.path)
              : () => runCommand("gio", ["launch", app.path, path]),
        });
      } else {
        const { title, icon } = systemPathActions[action.kind];
        results.push({
          title: action.kind === "default" && target === "folders"
            ? "Open in Default File Manager"
            : title,
          subtitle: path,
          icon,
          score,
          onActivate: action.kind === "reveal"
            ? () => this.#revealPath(path)
            : () => this.openPath(path, target === "folders"),
        });
      }
    }
    return {
      results,
      message: results.length === 0
        ? "No configured actions apply to this path."
        : undefined,
    };
  }

  openPath(path: string, isDirectory: boolean): Promise<void> {
    return isDirectory
      ? this.#openFolder(path)
      : runCommand("gio", ["open", path]);
  }

  async #openFolder(path: string, desktopFile?: string): Promise<void> {
    const startupId = this.#fileManagerStartupId?.(path, {
      desktopFile,
      nautilusOnly: true,
    });
    if (startupId) {
      try {
        await showInFileManager(
          "ShowFolders",
          path,
          startupId,
          "org.gnome.Nautilus",
        );
        return;
      } catch {
        // Fall back to normal desktop launching if Nautilus cannot handle the request.
      }
    }
    await runCommand(
      "gio",
      desktopFile ? ["launch", desktopFile, path] : ["open", path],
    );
  }

  async #revealPath(path: string): Promise<void> {
    const startupId = this.#fileManagerStartupId?.(path);
    try {
      await showInFileManager("ShowItems", path, startupId);
    } catch {
      await this.#openFolder(dirname(path));
    }
  }
}
