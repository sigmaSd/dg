import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { findExecutable } from "../../utils/find-executable.ts";
import type { SearchResult, Source } from "../interface.ts";
import { expandHomePath } from "./paths.ts";

const maxResults = 20;

export class FileSearchError extends Error {}

export async function findFd(): Promise<string | undefined> {
  // Debian and Ubuntu install the same program under the name fdfind.
  return await findExecutable("fd") ?? await findExecutable("fdfind");
}

interface Match {
  path: string;
  name: string;
  score: number;
}

function compareMatches(a: Match, b: Match): number {
  return b.score - a.score || a.path.length - b.path.length ||
    a.path.localeCompare(b.path);
}

export class FileSearchSource implements Source {
  id = "file-search";
  name = "File Search";
  description = "Find files and folders by name";
  trigger = "p";
  #command: string | undefined;
  #openPath: (path: string, isDirectory: boolean) => Promise<void>;
  #home: string;

  constructor(
    command: string | undefined,
    openPath: (path: string, isDirectory: boolean) => Promise<void>,
    home = homedir(),
  ) {
    this.#command = command;
    this.#openPath = openPath;
    this.#home = home;
  }

  init(): Promise<void> {
    return Promise.resolve();
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const text = query.trim();
    if (!text || !this.#command || signal?.aborted) return [];

    const scope = /^(?:"((?:~\/|\/)[^"]*)"|((?:~\/|\/)\S*))(?:\s+|$)/.exec(
      text,
    );
    const root = scope
      ? expandHomePath(scope[1] ?? scope[2], this.#home)
      : this.#home;
    const phrase = text.slice(scope?.[0].length ?? 0).trim();
    if (!phrase) throw new FileSearchError("Type a filename to search for.");
    const info = await Deno.stat(root).catch(() => undefined);
    if (!info?.isDirectory) {
      throw new FileSearchError("Could not read this search folder.");
    }
    if (signal?.aborted) return [];

    const words = phrase.toLowerCase().split(/\s+/);
    const normalizedPhrase = words.join(" ");
    // Filter by the longest word in fd, then check the other words on matches.
    const pattern = words.reduce((a, b) => b.length > a.length ? b : a);
    const child = new Deno.Command(this.#command, {
      args: [
        "--absolute-path",
        "--print0",
        "--color=never",
        "--no-ignore",
        "--ignore-case",
        "--fixed-strings",
        "--type=file",
        "--type=directory",
        "--type=symlink",
        "--",
        pattern,
        root,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      signal,
    }).spawn();

    const matches: Match[] = [];
    let remainder = "";
    let status: Deno.CommandStatus;
    try {
      for await (
        const chunk of child.stdout.pipeThrough(new TextDecoderStream())
      ) {
        if (signal?.aborted) return [];
        const paths = (remainder + chunk).split("\0");
        remainder = paths.pop() ?? "";
        for (const rawPath of paths) {
          const path = rawPath.replace(/\/$/, "");
          const name = basename(path);
          const lowerName = name.toLowerCase();
          if (!words.every((word) => lowerName.includes(word))) continue;
          const score = lowerName === normalizedPhrase
            ? 2
            : lowerName.startsWith(normalizedPhrase)
            ? 1
            : 0;
          const match = { path, name, score };
          if (
            matches.length < maxResults ||
            compareMatches(match, matches[matches.length - 1]) < 0
          ) {
            matches.push(match);
            matches.sort(compareMatches);
            if (matches.length > maxResults) matches.pop();
          }
        }
      }
    } finally {
      status = await child.status;
    }
    if (signal?.aborted) return [];
    if (!status.success) {
      throw new FileSearchError("Could not search this folder with fd.");
    }

    const results = await Promise.all(
      matches.map(async ({ path, name, score }) => {
        const info = await Deno.stat(path).catch(() => undefined);
        if (!info?.isFile && !info?.isDirectory) return;
        const isDirectory = info.isDirectory;
        return {
          title: name,
          subtitle: dirname(path),
          icon: isDirectory ? "folder-symbolic" : "text-x-generic-symbolic",
          score,
          onActivate: () => this.#openPath(path, isDirectory),
        };
      }),
    );
    return signal?.aborted
      ? []
      : results.filter((result) => result !== undefined);
  }
}
