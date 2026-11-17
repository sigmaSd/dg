import { assertEquals } from "@std/assert";
import {
  terminalCommand,
  terminalShortcut,
} from "../src/plugins/core/terminal.ts";

Deno.test("Terminal shortcut preserves the entire shell command", () => {
  const command = `printf '%s\\n' "a b" | head -n 1 > 'out file'`;
  assertEquals(terminalCommand(`!${command}`, terminalShortcut), command);
  assertEquals(terminalCommand("! ls -la", terminalShortcut), " ls -la");
  assertEquals(terminalCommand("!", terminalShortcut), "");
  assertEquals(terminalCommand("ls", terminalShortcut), undefined);
});

Deno.test("Custom terminal keyword requires a separator", () => {
  assertEquals(terminalCommand("run printf 'a b'", "run"), "printf 'a b'");
  assertEquals(terminalCommand("runner ls", "run"), undefined);
  assertEquals(terminalCommand("run", "run"), undefined);
  assertEquals(terminalCommand("!ls", "run"), undefined);
});
