import { assertEquals } from "@std/assert";
import {
  availableModels,
  opencodePermissions,
} from "../src/plugins/core/opencode.ts";

Deno.test("OpenCode catalog preserves IDs and filters unavailable models", () => {
  assertEquals(
    availableModels([
      {
        id: "vendor/model",
        providerID: "router",
        name: "Free chat",
        type: "chat",
        cost: [{ input: 0, output: 0 }],
      },
      {
        id: "cache-charged",
        providerID: "provider",
        cost: [{ input: 0, output: 0, cache: { read: 0.1 } }],
      },
      { id: "unknown-cost", providerID: "provider" },
      { id: "old", providerID: "provider", status: "deprecated" },
      { id: "disabled", providerID: "router", enabled: false },
      { id: "image", providerID: "router", type: "image" },
    ]),
    [
      {
        id: "cache-charged",
        provider: "provider",
        name: "cache-charged",
        isFree: false,
      },
      {
        id: "unknown-cost",
        provider: "provider",
        name: "unknown-cost",
        isFree: false,
      },
      {
        id: "vendor/model",
        provider: "router",
        name: "Free chat",
        isFree: true,
      },
    ],
  );
});

Deno.test("OpenCode 2 tool rules preserve the legacy switches", () => {
  const permissions = opencodePermissions({ edit: true, bash: true });
  assertEquals(permissions[0], {
    action: "*",
    resource: "*",
    effect: "deny",
  });
  assertEquals(
    permissions.find((rule) => rule.action === "read")?.effect,
    "allow",
  );
  assertEquals(
    permissions.find((rule) => rule.action === "shell")?.effect,
    "allow",
  );
  assertEquals(
    permissions.find((rule) => rule.action === "edit")?.effect,
    "deny",
  );
  assertEquals(
    permissions.find((rule) => rule.action === "subagent")?.effect,
    "deny",
  );
  assertEquals(
    opencodePermissions({ edit: true, write: true })
      .find((rule) => rule.action === "edit")?.effect,
    "allow",
  );
});

Deno.test("OpenCode web tools are independent opt-ins", () => {
  const effects = (settings?: Parameters<typeof opencodePermissions>[0]) =>
    opencodePermissions(settings)
      .filter(({ action }) => action === "websearch" || action === "webfetch")
      .map(({ effect }) => effect);

  assertEquals(effects(), ["deny", "deny"]);
  assertEquals(effects({ websearch: true }), ["allow", "deny"]);
  assertEquals(effects({ webfetch: true }), ["deny", "allow"]);
});
