export interface AppInfo {
  name: string;
  exec: string;
  icon?: string;
  path: string;
}

export async function getApps(): Promise<AppInfo[]> {
  if (Deno.build.os === "linux") {
    return getLinuxApps();
  }
  if (Deno.build.os === "darwin") {
    return getMacApps();
  }
  if (Deno.build.os === "windows") {
    return getWindowsApps();
  }
  return [];
}

async function getLinuxApps(): Promise<AppInfo[]> {
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

  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

async function getMacApps(): Promise<AppInfo[]> {
  const apps: AppInfo[] = [];
  const searchPaths = [
    "/Applications",
    "/System/Applications",
    `${Deno.env.get("HOME")}/Applications`,
  ];

  for (const p of searchPaths) {
    try {
      for await (const entry of Deno.readDir(p)) {
        if (entry.name.endsWith(".app")) {
          apps.push({
            name: entry.name.slice(0, -4),
            exec: `open -a "${p}/${entry.name}"`,
            path: `${p}/${entry.name}`,
            icon: "application-x-executable",
          });
        }
      }
    } catch { /* ignore */ }
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

async function getWindowsApps(): Promise<AppInfo[]> {
  try {
    const command = new Deno.Command("powershell", {
      args: ["-Command", "Get-StartApps | ConvertTo-Json"],
      stdout: "piped",
    });
    const { stdout } = await command.output();
    const output = new TextDecoder().decode(stdout);
    if (!output) return [];

    const data = JSON.parse(output);
    const appList = Array.isArray(data) ? data : [data];

    return appList.map((app: { Name: string; AppID: string }) => ({
      name: app.Name,
      exec: `explorer.exe shell:AppsFolder\\${app.AppID}`,
      path: app.AppID,
      icon: "application-x-executable",
    })).sort((a: AppInfo, b: AppInfo) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
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
