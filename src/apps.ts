export interface AppInfo {
  name: string;
  exec: string;
  icon?: string;
  path: string;
}

export async function getApps(): Promise<AppInfo[]> {
  const apps: AppInfo[] = [];
  const searchPaths = [
    "/usr/share/applications",
    `${Deno.env.get("HOME")}/.local/share/applications`,
  ];

  for (const path of searchPaths) {
    try {
      for await (const entry of Deno.readDir(path)) {
        if (entry.isFile && entry.name.endsWith(".desktop")) {
          const content = await Deno.readTextFile(`${path}/${entry.name}`);
          const app = parseDesktopFile(content, `${path}/${entry.name}`);
          if (app) {
            apps.push(app);
          }
        }
      }
    } catch {
      // Ignore errors (e.g., directory doesn't exist)
    }
  }

  // Deduplicate by name, preferring user local paths if duplicates exist?
  // For simplicity, we just return all unique valid ones.
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

function parseDesktopFile(content: string, path: string): AppInfo | null {
  const lines = content.split("\n");
  let isDesktopEntry = false;
  let name = "";
  let exec = "";
  let icon = "";
  let noDisplay = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "[Desktop Entry]") {
      isDesktopEntry = true;
      continue;
    }

    if (!isDesktopEntry) continue;
    // Stop if we hit another section
    if (trimmed.startsWith("[") && trimmed !== "[Desktop Entry]") break;

    if (trimmed.startsWith("Name=")) {
      name = trimmed.substring(5);
    } else if (trimmed.startsWith("Exec=")) {
      exec = trimmed.substring(5);
    } else if (trimmed.startsWith("Icon=")) {
      icon = trimmed.substring(5);
    } else if (trimmed.startsWith("NoDisplay=true")) {
      noDisplay = true;
    }
  }

  if (name && exec && !noDisplay) {
    // Sanitize Exec command (remove % field codes)
    // Common codes: %f, %F, %u, %U, %d, %D, %n, %N, %i, %c, %k, %v, %m
    const cleanExec = exec.replace(/%[fFuUdDnNiCkfvVm]/g, "").trim();

    return {
      name,
      exec: cleanExec,
      icon,
      path,
    };
  }

  return null;
}
