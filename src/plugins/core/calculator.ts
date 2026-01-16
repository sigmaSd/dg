import type { SearchResult, Source } from "../interface.ts";
import type { AdwApplicationWindow } from "@sigmasd/gtk";

export class CalculatorSource implements Source {
  id = "calculator";
  name = "Calculator";
  description = "Perform simple calculations";
  trigger = undefined; // Make it global
  #window?: AdwApplicationWindow;

  constructor(window?: AdwApplicationWindow) {
    this.#window = window;
  }

  async init(): Promise<void> {}

  search(query: string): Promise<SearchResult[]> {
    if (!query || query.length < 3) return Promise.resolve([]);

    try {
      let q = query.trim();
      if (q.startsWith("=")) {
        q = q.substring(1).trim();
      }

      // Remove spaces for easier check
      const clean = q.replace(/\s+/g, "");

      // Basic validation: only numbers, operators, parens, and dot
      // Must contain at least one operator to be considered a calculation in global search
      if (!/^[0-9+\-*/().]+$/.test(clean) || !/[+\-*/]/.test(clean)) {
        return Promise.resolve([]);
      }

      // Use Function constructor as a safer eval
      const result = new Function(`return ${clean}`)();

      if (typeof result !== "number" || isNaN(result) || !isFinite(result)) {
        return Promise.resolve([]);
      }

      return Promise.resolve([{
        title: result.toString(),
        subtitle: `Result of ${query} (Press Enter to Copy)`,
        icon: "accessories-calculator",
        score: 110, // High score so it appears on top
        onActivate: () => {
          console.log(`Copying result to clipboard: ${result}`);
          const text = result.toString();
          if (this.#window) {
            this.#window.getDisplay().getClipboard().set(text);
          } else {
            console.warn("Cannot copy to clipboard: window not available");
          }
        },
      }]);
    } catch {
      return Promise.resolve([]);
    }
  }
}
