import { AppInfo, getApps } from "../apps.ts";
import { SearchResult, Source } from "./interface.ts";

export class AppSource implements Source {
  id = "apps";
  name = "Applications";
  #apps: AppInfo[] = [];

  async init(): Promise<void> {
    this.#apps = await getApps();
  }

  async search(query: string): Promise<SearchResult[]> {
    const q = query.toLowerCase();
    
    // Simple fuzzy-ish matching
    const matches = this.#apps.filter(app => 
      app.name.toLowerCase().includes(q) || 
      app.exec.toLowerCase().includes(q)
    );

    return matches.map(app => ({
      title: app.name,
      subtitle: app.exec,
      score: app.name.toLowerCase().startsWith(q) ? 100 : 50, // Higher score for prefix match
      onActivate: () => {
        console.log(`Launching: ${app.name}`);
        const command = new Deno.Command("sh", {
          args: ["-c", `${app.exec} &`],
          stdin: "null",
          stdout: "null",
          stderr: "null",
        });
        command.spawn();
      }
    }));
  }
}
