import { type AdwApplicationWindow, MessageDialog } from "@sigmasd/gtk";
import type { PluginPermissions } from "../plugins/interface.ts";

export function normalizePermissions(
  p: PluginPermissions,
): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(p).sort() as (keyof PluginPermissions)[];
  for (const k of keys) {
    const val = p[k];
    if (Array.isArray(val)) {
      sorted[k] = [...val].sort();
    } else {
      sorted[k] = val;
    }
  }
  return sorted;
}

export function formatPermissions(p: PluginPermissions): string {
  let text = "";

  if (Array.isArray(p.net) && p.net.length > 0) {
    text += "• Network Access:\n" + p.net.map((d) => `  - ${d}`).join("\n") +
      "\n\n";
  }
  if (Array.isArray(p.read) && p.read.length > 0) {
    text += "• Read Files:\n" + p.read.map((f) => `  - ${f}`).join("\n") +
      "\n\n";
  }
  if (Array.isArray(p.write) && p.write.length > 0) {
    text += "• Write Files:\n" + p.write.map((f) => `  - ${f}`).join("\n") +
      "\n\n";
  }
  if (Array.isArray(p.run) && p.run.length > 0) {
    text += "• Run Subprocesses:\n" + p.run.map((c) => `  - ${c}`).join("\n") +
      "\n\n";
  }
  if (Array.isArray(p.env) && p.env.length > 0) {
    text += "• Environment Variables:\n" + p.env.map((e) =>
      `  - ${e}`
    ).join("\n") + "\n\n";
  }

  // Booleans
  if (p.net === true) text += "• Full Network Access\n\n";
  if (p.read === true) text += "• Read All Files\n\n";
  if (p.write === true) text += "• Write All Files\n\n";
  if (p.run === true) text += "• Run All Commands\n\n";
  if (p.env === true) text += "• Access All Env Vars\n\n";
  if ((p as Record<string, unknown>).ffi === true) {
    text += "• FFI (Foreign Function Interface)\n\n";
  }
  if ((p as Record<string, unknown>).hrtime === true) {
    text += "• High Resolution Time\n\n";
  }

  return text.trim() || "No special permissions requested.";
}

export function promptPermissions(
  window: AdwApplicationWindow,
  name: string,
  perms: PluginPermissions,
): Promise<boolean> {
  return new Promise((resolve) => {
    const formatted = formatPermissions(perms);
    const dialog = new MessageDialog(
      window,
      "Permission Request",
      `The plugin '${name}' requests the following permissions:\n\n${formatted}`,
    );

    dialog.addResponse("deny", "Deny");
    dialog.addResponse("allow", "Allow");
    dialog.setResponseAppearance("allow", 1); // ADW_RESPONSE_SUGGESTED
    dialog.setDefaultResponse("allow");
    dialog.setCloseResponse("deny");

    dialog.onResponse((response) => {
      dialog.close();
      resolve(response === "allow");
    });

    dialog.present();
  });
}
