import { type AdwApplicationWindow, MessageDialog } from "@sigmasd/gtk";
import {
  PERMISSION_NAMES,
  type PluginPermissions,
} from "../plugins/interface.ts";

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
  const lines: string[] = [];

  const labels: Record<string, string> = {
    net: "Network Access",
    read: "Read Files",
    write: "Write Files",
    run: "Run Subprocesses",
    env: "Environment Variables",
    sys: "System Information",
    ffi: "FFI (Foreign Function Interface)",
    hrtime: "High Resolution Time",
  };

  for (const key of PERMISSION_NAMES) {
    const val = p[key];
    if (!val) continue;

    const label = labels[key as string] || key;
    if (val === true) {
      lines.push(`• Full ${label}`);
    } else if (Array.isArray(val) && val.length > 0) {
      lines.push(`• ${label}:`);
      val.forEach((item) => lines.push(`  - ${item}`));
    }
  }

  return lines.join("\n").trim() || "No special permissions requested.";
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
