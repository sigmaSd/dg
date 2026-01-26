export interface AppInfo {
  name: string;
  exec: string;
  icon?: string;
  path: string;
}

export function getApps(): Promise<AppInfo[]> {
  if (Deno.build.os === "linux") {
    return getLinuxApps();
  }
  if (Deno.build.os === "darwin") {
    return getMacApps();
  }
  if (Deno.build.os === "windows") {
    return getWindowsApps();
  }
  return Promise.resolve([]);
}

async function getLinuxApps(): Promise<AppInfo[]> {
  const apps: AppInfo[] = [];
  const xdgDataDirs = Deno.env.get("XDG_DATA_DIRS") ||
    "/usr/local/share:/usr/share";
  const searchPaths = xdgDataDirs.split(":").map((p) => `${p}/applications`);

  const xdgDataHome = Deno.env.get("XDG_DATA_HOME") ||
    `${Deno.env.get("HOME")}/.local/share`;
  const userAppDir = `${xdgDataHome}/applications`;

  if (!searchPaths.includes(userAppDir)) {
    searchPaths.unshift(userAppDir);
  }

  const seenFiles = new Set<string>();

  for (const path of searchPaths) {
    try {
      for await (const entry of Deno.readDir(path)) {
        if (
          (entry.isFile || entry.isSymlink) &&
          entry.name.endsWith(".desktop") && !seenFiles.has(entry.name)
        ) {
          seenFiles.add(entry.name);
          const fullPath = `${path}/${entry.name}`;
          const content = await Deno.readTextFile(fullPath);
          const app = parseDesktopFile(content, fullPath);
          if (app) {
            apps.push(app);
          }
        }
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        console.error(`Error reading directory ${path}:`, e);
      }
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
      args: [
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Get-StartApps | ConvertTo-Json",
      ],
      stdout: "piped",
    });
    const { stdout } = await command.output();
    const output = new TextDecoder().decode(stdout).trim();
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

export function parseDesktopFile(
  content: string,
  path: string,
): AppInfo | null {
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
      name = trimmed.substring(5).split("#")[0].trim();
    } else if (trimmed.startsWith("Exec=")) {
      exec = trimmed.substring(5).split("#")[0].trim();
    } else if (trimmed.startsWith("Icon=")) {
      icon = trimmed.substring(5).split("#")[0].trim();
    } else if (trimmed.startsWith("NoDisplay=")) {
      if (trimmed.substring(10).toLowerCase().startsWith("true")) {
        noDisplay = true;
      }
    }
  }

  if (name && exec && !noDisplay) {
    // Sanitize Exec command (remove % field codes)
    // Common codes: %f, %F, %u, %U, %d, %D, %n, %N, %i, %c, %k, %v, %m
    // Also remove Flatpak markers: @@u %u @@ etc.
    const cleanExec = exec
      .replace(/%[fFuUdDnNiCkfvVm]/g, "")
      .replace(/@@[uUnN]?\s*(%[fFuU])?\s*@@/g, "")
      .trim();

    return {
      name,
      exec: cleanExec,
      icon,
      path,
    };
  }

  if (noDisplay) {
    // console.log(`Skipping ${path}: NoDisplay=true`);
  } else if (!name || !exec) {
    console.log(`Skipping ${path}: Name="${name}", Exec="${exec}"`);
  }

  return null;
}
