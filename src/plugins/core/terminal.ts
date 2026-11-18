import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { ConfigManager } from "../../config.ts";
import { findExecutable } from "../../utils/find-executable.ts";
import type { SearchResult, Source } from "../interface.ts";

const terminals = [
  {
    id: "xdg-terminal-exec",
    title: "XDG Default Terminal",
    args: (directory: string) => [`--dir=${directory}`, "--"],
  },
  {
    id: "ptyxis",
    title: "Ptyxis",
    args: (
      directory: string,
    ) => ["--new-window", `--working-directory=${directory}`, "--"],
  },
  {
    id: "gnome-terminal",
    title: "GNOME Terminal",
    args: (directory: string) => [`--working-directory=${directory}`, "--"],
  },
  {
    id: "konsole",
    title: "Konsole",
    args: (directory: string) => ["--workdir", directory, "-e"],
  },
  {
    id: "xfce4-terminal",
    title: "Xfce Terminal",
    args: (directory: string) => [`--working-directory=${directory}`, "-x"],
  },
  { id: "xterm", title: "XTerm", args: () => ["-e"] },
] as const;

type TerminalId = typeof terminals[number]["id"];

export interface TerminalSettings {
  terminal: TerminalId | "auto";
  shell: string;
}

export const terminalShortcut = "!";

// Keep the terminal's child alive until the user dismisses the command output.
const commandWithPause = `
trap ':' INT
if "$1" -i -c "$2"; then
  status=0
else
  status=$?
fi
trap - INT
printf '\\nCommand exited with status %s. Press Enter to close.\\n' "$status"
IFS= read -r ignored_input || :
exit "$status"
`;

export function terminalCommand(
  query: string,
  trigger: string,
): string | undefined {
  const prefix = trigger === terminalShortcut ? trigger : `${trigger} `;
  if (query.startsWith(prefix)) return query.slice(prefix.length);
}

export class TerminalSource implements Source {
  id = "terminal";
  name = "Terminal";
  description = "Run a shell command in a new terminal window";
  trigger = terminalShortcut;
  #config: ConfigManager;
  #settings: TerminalSettings = { terminal: "auto", shell: "" };

  constructor(config: ConfigManager) {
    this.#config = config;
  }

  get defaultShell(): string {
    return Deno.env.get("SHELL") || "/bin/sh";
  }

  async #readSettings(): Promise<TerminalSettings> {
    const saved = await this.#config.getPluginSettings(this.id) as
      | Partial<TerminalSettings>
      | undefined;
    return {
      terminal: terminals.find(({ id }) => id === saved?.terminal)?.id ??
        "auto",
      shell: typeof saved?.shell === "string" ? saved.shell : "",
    };
  }

  async init(): Promise<void> {
    this.#settings = await this.#readSettings();
  }

  async preferences() {
    const settings = await this.#readSettings().catch((error) => {
      console.warn("Could not read Terminal settings:", error);
      return this.#settings;
    });
    const choices = [{ id: "auto" as const, title: "System Default" }];
    const candidates = await Promise.all(
      terminals.map(async ({ id, title }) => ({
        id,
        title,
        available: Boolean(await findExecutable(id)),
      })),
    );
    return {
      settings,
      choices: [
        ...choices,
        ...candidates.filter(({ id, available }) =>
          available || id === settings.terminal
        )
          .map(({ id, title, available }) => ({
            id,
            title: available ? title : `${title} (Unavailable)`,
          })),
      ],
      defaultShell: this.defaultShell,
    };
  }

  async saveSettings(settings: TerminalSettings): Promise<void> {
    if (
      settings.shell &&
      ((!isAbsolute(settings.shell) && settings.shell.includes("/")) ||
        !await findExecutable(settings.shell))
    ) {
      throw new Error("Enter an executable shell name or its absolute path.");
    }
    if (
      settings.terminal !== "auto" && !await findExecutable(settings.terminal)
    ) {
      throw new Error("Choose a terminal that is installed.");
    }
    const saved = { ...settings };
    await this.#config.setPluginSettings(this.id, saved);
    this.#settings = saved;
  }

  search(command: string): Promise<SearchResult[]> {
    if (!command.trim()) return Promise.resolve([]);
    return Promise.resolve([{
      title: "Run in Terminal",
      subtitle: command,
      icon: "utilities-terminal-symbolic",
      score: 100,
      onActivate: () => this.#run(command),
    }]);
  }

  async #run(command: string): Promise<void> {
    const { terminal, shell } = this.#settings;
    const shellPath = await findExecutable(shell || this.defaultShell);
    if (!shellPath) throw new Error("DG could not find the configured shell.");
    const home = homedir();
    for (const adapter of terminals) {
      if (terminal !== "auto" && terminal !== adapter.id) continue;
      const executable = await findExecutable(adapter.id);
      if (!executable) continue;

      const child = new Deno.Command(executable, {
        args: [
          ...adapter.args(home),
          "/bin/sh",
          "-c",
          commandWithPause,
          "dg-terminal",
          shellPath,
          command,
        ],
        cwd: home,
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      child.unref();
      return;
    }
    throw new Error(
      terminal === "auto"
        ? "Install a supported terminal app or xdg-terminal-exec."
        : "The selected terminal is no longer installed.",
    );
  }
}
