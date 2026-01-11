import { assertEquals } from "@std/assert";
import { CalculatorSource } from "../src/plugins/core/calculator.ts";

Deno.test("Calculator plugin", async (t) => {
  const calc = new CalculatorSource();

  await t.step("basic addition", async () => {
    const results = await calc.search("2 + 2");
    assertEquals(results.length, 1);
    assertEquals(results[0].title, "4");
  });

  await t.step("with trigger prefix", async () => {
    const results = await calc.search("= 10 / 2");
    assertEquals(results.length, 1);
    assertEquals(results[0].title, "5");
  });

  await t.step("ignore plain numbers", async () => {
    const results = await calc.search("123");
    assertEquals(results.length, 0);
  });

  await t.step("complex expression", async () => {
    const results = await calc.search("(10 + 5) * 2");
    assertEquals(results.length, 1);
    assertEquals(results[0].title, "30");
  });

  await t.step("invalid expression", async () => {
    const results = await calc.search("2 + abc");
    assertEquals(results.length, 0);
  });
});
