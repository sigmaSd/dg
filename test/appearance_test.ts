import { assertEquals } from "@std/assert";
import { defaultAppearance, normalizeAppearance } from "../src/config.ts";

Deno.test("Appearance settings default and clamp invalid transparency", () => {
  assertEquals(normalizeAppearance(undefined), defaultAppearance);
  assertEquals(
    normalizeAppearance({ theme: "unknown", transparency: NaN }),
    defaultAppearance,
  );
  assertEquals(normalizeAppearance({ theme: "glass", transparency: 70 }), {
    theme: "glass",
    color: "ocean",
    transparency: 45,
  });
  assertEquals(normalizeAppearance({ theme: "system", transparency: -8 }), {
    theme: "system",
    color: "ocean",
    transparency: 0,
  });
  assertEquals(
    normalizeAppearance({ theme: "system", color: "iris", transparency: 32.6 }),
    {
      theme: "system",
      color: "iris",
      transparency: 33,
    },
  );
});
