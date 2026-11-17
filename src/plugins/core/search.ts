import type { SearchResult, Source } from "../interface.ts";
import { openUrl } from "../../utils/open-url.ts";

export class SearchSource implements Source {
  id = "search";
  name = "Web Search";
  description = "Search Google, DuckDuckGo, or Bing";
  trigger = "q";
  #openUrl: typeof openUrl;

  constructor(opener = openUrl) {
    this.#openUrl = opener;
  }

  #engines = [
    { name: "Google", url: "https://www.google.com/search?q=" },
    { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
    { name: "Bing", url: "https://www.bing.com/search?q=" },
  ];

  async init(): Promise<void> {}

  search(query: string): Promise<SearchResult[]> {
    query = query.trim();
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
        return this.#openUrl(engine.url + encoded);
      },
    }));
  }
}
