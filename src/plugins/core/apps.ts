import { type AppInfo, getApps } from "../../apps.ts";
import type { SearchResult, Source } from "../interface.ts";

function splitExec(exec: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";

  for (let i = 0; i < exec.length; i++) {
    const char = exec[i];

    if (!inQuote && (char === '"' || char === "'")) {
      inQuote = true;
      quoteChar = char;
    } else if (inQuote && char === quoteChar) {
      inQuote = false;
      quoteChar = "";
    } else if (!inQuote && char === " ") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current) args.push(current);
  return args;
}

export class AppSource implements Source {
  id = "apps";
  name = "Applications";
  description = "Search and launch installed applications";
  trigger = undefined; // Global source

  #apps: AppInfo[] = [];

  async init(): Promise<void> {
    this.#apps = await getApps();
  }

  search(query: string): Promise<SearchResult[]> {
    const q = query.toLowerCase();

    // Simple fuzzy-ish matching
    const matches = this.#apps.filter((app) =>
      app.name.toLowerCase().includes(q) ||
      app.exec.toLowerCase().includes(q)
    );

    return Promise.resolve(matches.map((app) => ({
      title: app.name,
      subtitle: app.exec,
      icon: app.icon,
      score: app.name.toLowerCase().startsWith(q) ? 100 : 50,
      onActivate: () => {
        console.log(`Launching: ${app.name}`);
        const args = splitExec(app.exec);
        const cmd = args[0];
        const rest = args.slice(1);
        const command = new Deno.Command(cmd, {
          args: rest,
          stdin: "null",
          stdout: "null",
          stderr: "null",
          detached: true,
        });
        command.spawn();
      },
    })));
  }
}
