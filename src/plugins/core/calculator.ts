import type { SearchResult, Source } from "../interface.ts";

export class CalculatorSource implements Source {
  id = "calculator";
  name = "Calculator";
  description = "Perform simple calculations";
  trigger = undefined; // Make it global

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
        subtitle: `Result of ${query}`,
        icon: "accessories-calculator",
        score: 110, // High score so it appears on top
        onActivate: async () => {
          console.log(`Copying result to clipboard: ${result}`);
          const text = result.toString();

          let commandName = "";
          let args: string[] = [];

          if (Deno.build.os === "linux") {
            // Try wl-copy then xclip
            commandName = "sh";
            args = [
              "-c",
              `echo -n "${text}" | wl-copy || echo -n "${text}" | xclip -selection clipboard`,
            ];
          } else if (Deno.build.os === "darwin") {
            commandName = "pbcopy";
          } else if (Deno.build.os === "windows") {
            commandName = "clip";
          }

          if (commandName) {
            const command = new Deno.Command(commandName, {
              args,
              stdin: "piped",
            });
            const child = command.spawn();
            const writer = child.stdin.getWriter();
            await writer.write(new TextEncoder().encode(text));
            await writer.close();
            await child.status;
          }
        },
      }]);
    } catch {
      return Promise.resolve([]);
    }
  }
}
