import { assertEquals } from "@std/assert";
import type { SearchResult, Source } from "../src/plugins/interface.ts";

// Mock source for testing triggers
class MockSource implements Source {
  id = "mock";
  name = "Mock";
  trigger?: string;
  lastQuery?: string;

  constructor(trigger?: string) {
    this.trigger = trigger;
  }

  async init(): Promise<void> {}

  // deno-lint-ignore require-await
  async search(query: string): Promise<SearchResult[]> {
    this.lastQuery = query;
    return [{
      title: "Result",
      subtitle: `Query: ${query}`,
      score: 100,
      onActivate: () => {},
    }];
  }
}

// Emulate the logic in src/main.ts updateSearch
async function simulateSearch(query: string, plugins: Source[]) {
  const parts = query.split(" ");
  const trigger = parts[0];
  const args = parts.slice(1).join(" ");

  // Check if a plugin matches the specific trigger
  // Only trigger if there is at least one space after the trigger
  const triggeredPlugin = parts.length > 1
    ? plugins.find((p) => p.trigger === trigger)
    : undefined;

  let results: SearchResult[] = [];
  if (triggeredPlugin) {
    results = await triggeredPlugin.search(args);
  } else {
    const globalPlugins = plugins.filter((p) => !p.trigger);
    for (const plugin of globalPlugins) {
      const pluginResults = await plugin.search(query);
      results = results.concat(pluginResults);
    }
  }
  return results;
}

Deno.test("Trigger logic - only trigger with space", async () => {
  const triggerPlugin = new MockSource("s");
  const globalPlugin = new MockSource(undefined);
  const plugins = [triggerPlugin, globalPlugin];

  // 1. Typing "s" should NOT trigger the plugin, but go to global plugins
  const res1 = await simulateSearch("s", plugins);
  assertEquals(
    triggerPlugin.lastQuery,
    undefined,
    "Trigger plugin should not have been called",
  );
  assertEquals(
    globalPlugin.lastQuery,
    "s",
    "Global plugin should have been called with 's'",
  );
  assertEquals(res1.length, 1);

  // Reset
  triggerPlugin.lastQuery = undefined;
  globalPlugin.lastQuery = undefined;

  // 2. Typing "s " SHOULD trigger the plugin
  const res2 = await simulateSearch("s ", plugins);
  assertEquals(
    triggerPlugin.lastQuery,
    "",
    "Trigger plugin should have been called with empty args",
  );
  assertEquals(
    globalPlugin.lastQuery,
    undefined,
    "Global plugin should NOT have been called",
  );
  assertEquals(res2.length, 1);

  // Reset
  triggerPlugin.lastQuery = undefined;
  globalPlugin.lastQuery = undefined;

  // 3. Typing "s query" SHOULD trigger the plugin with "query"
  const res3 = await simulateSearch("s query", plugins);
  assertEquals(
    triggerPlugin.lastQuery,
    "query",
    "Trigger plugin should have been called with 'query'",
  );
  assertEquals(
    globalPlugin.lastQuery,
    undefined,
    "Global plugin should NOT have been called",
  );
  assertEquals(res3.length, 1);
});
