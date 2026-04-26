import type { SearchResult, Source } from "../interface.ts";

export class SearchSource implements Source {
  id = "search";
  name = "Web Search";
  description = "Search the web via Google or DuckDuckGo";
  trigger = "q";

  #engines = [
    { name: "Google", url: "https://www.google.com/search?q=" },
    { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
    { name: "Bing", url: "https://www.bing.com/search?q=" },
  ];

  async init(): Promise<void> {}

  search(query: string): Promise<SearchResult[]> {
    if (!query) {
      return Promise.resolve(this.#engineResults("Type to search", ""));
    }

    const encoded = encodeURIComponent(query);

    return Promise.resolve(
      this.#engineResults(`Search "${query}"`, query, encoded),
    );
  }

  #engineResults(
    title: string,
    query: string,
    encoded?: string,
  ): SearchResult[] {
    return this.#engines.map((engine) => ({
      title: `${title} via ${engine.name}`,
      subtitle: query
        ? `Open ${engine.name} search results`
        : "Select a search engine",
      icon: "system-search",
      score: query ? 100 : 50,
      onActivate: () => {
        if (!encoded) return;
        const url = engine.url + encoded;
        this.#openUrl(url);
      },
    }));
  }

  #openUrl(url: string) {
    console.log(`Opening: ${url}`);
    let commandName = "xdg-open";
    let args = [url];

    if (Deno.build.os === "windows") {
      commandName = "cmd";
      args = ["/c", "start", "", url];
    } else if (Deno.build.os === "darwin") {
      commandName = "open";
    }

    const command = new Deno.Command(commandName, {
      args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    });
    command.spawn();
  }
}
