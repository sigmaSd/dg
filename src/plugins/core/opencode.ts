import { homedir } from "node:os";
import { join } from "@std/path";
import {
  defaultOpencodeTools,
  type OpencodeToolsConfig,
} from "../../config.ts";
import { findExecutable } from "../../utils/find-executable.ts";

const decoder = new TextDecoder();
const agent = "dg";

async function findOpencode(): Promise<string> {
  const name = Deno.build.os === "windows" ? "opencode.exe" : "opencode";
  const paths = new Set([
    await findExecutable(name),
    await findExecutable(join(homedir(), ".opencode", "bin", name)),
  ]);
  for (const path of paths) {
    if (!path) continue;
    const result = await new Deno.Command(path, {
      args: ["--version"],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(5000),
    }).output().catch(() => undefined);
    const major = result?.success &&
      decoder.decode(result.stdout).match(/(?:^|\s)v?(\d+)\.\d+\.\d+\b/)?.[1];
    if (major && Number(major) >= 2) return path;
  }
  throw new Error("Install OpenCode 2 or later to use AI Assistant.");
}

export function opencodePermissions(settings?: OpencodeToolsConfig) {
  const tools = { ...defaultOpencodeTools, ...settings };
  const allowed = {
    read: tools.read,
    grep: tools.grep,
    glob: tools.glob,
    // OpenCode 2 uses one action for edits, writes, and patches.
    edit: tools.edit && tools.write,
    shell: tools.bash,
    subagent: tools.task,
    external_directory: tools.external_directory,
    websearch: tools.websearch === true,
    webfetch: tools.webfetch === true,
  };
  return [
    { action: "*", resource: "*", effect: "deny" },
    ...Object.entries(allowed).map(([action, enabled]) => ({
      action,
      resource: "*",
      effect: enabled ? "allow" : "deny",
    })),
  ];
}

export interface OpencodeModel {
  id: string;
  provider: string;
  name: string;
  isFree: boolean;
}

interface ModelData {
  id?: string;
  providerID?: string;
  name?: string;
  type?: string;
  enabled?: boolean;
  status?: string;
  cost?: {
    input?: number;
    output?: number;
    cache?: { read?: number; write?: number };
  }[];
}

export function availableModels(data: ModelData[]): OpencodeModel[] {
  const models = new Map<string, OpencodeModel>();
  for (const model of data) {
    if (
      !model.id || !model.providerID || model.enabled === false ||
      model.status === "deprecated" || (model.type && model.type !== "chat")
    ) continue;
    const cost = model.cost;
    models.set(`${model.providerID}/${model.id}`, {
      id: model.id,
      provider: model.providerID,
      name: model.name || model.id,
      isFree: Boolean(
        cost?.length &&
          cost.every((tier) =>
            tier.input === 0 && tier.output === 0 &&
            (tier.cache?.read ?? 0) === 0 && (tier.cache?.write ?? 0) === 0
          ),
      ),
    });
  }
  return [...models.values()].sort((a, b) =>
    `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`)
  );
}

export interface RunEvent {
  type: string;
  sessionID?: string;
  error?: { message?: string; data?: { message?: string } } | string;
  part?: {
    text?: string;
    tool?: string;
    state?: {
      status?: string;
    };
  };
}

function stderrMessage(stderr: string): string | undefined {
  return stderr.trim().split("\n")
    .filter((line) => line && !/^\s*at /.test(line))
    .find((line) => !/level=(INFO|WARN|DEBUG)/.test(line));
}

export class Opencode {
  #lifetime = new AbortController();
  #children = new Set<Promise<Deno.CommandStatus>>();

  private constructor(readonly path: string, readonly workspace: string) {}

  static async open(tools?: OpencodeToolsConfig): Promise<Opencode> {
    const path = await findOpencode();
    const directory = Deno.env.get("XDG_RUNTIME_DIR") ||
      Deno.env.get("TMPDIR") || join(homedir(), ".cache", "dg");
    await Deno.mkdir(directory, { recursive: true });
    const workspace = await Deno.makeTempDir({
      dir: directory,
      prefix: "dg-opencode-",
    });
    try {
      const config = join(workspace, ".opencode");
      await Deno.mkdir(config);
      await Deno.writeTextFile(
        join(config, "opencode.json"),
        JSON.stringify({
          websearch: tools?.websearch === true
            ? { provider: "tinyfish" }
            : false,
          agents: {
            [agent]: {
              description: "DG Launcher assistant",
              mode: "primary",
              permissions: opencodePermissions(tools),
            },
          },
        }),
      );
      return new Opencode(path, workspace);
    } catch (error) {
      await Deno.remove(workspace, { recursive: true });
      throw error;
    }
  }

  #spawn(args: string[], stdin: "null" | "piped", signal: AbortSignal) {
    const child = new Deno.Command(this.path, {
      args,
      cwd: this.workspace,
      env: { PWD: this.workspace },
      stdin,
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.any([this.#lifetime.signal, signal]),
    }).spawn();
    const status = child.status;
    this.#children.add(status);
    void status.then(
      () => this.#children.delete(status),
      () => this.#children.delete(status),
    );
    return child;
  }

  async #modelApi<T>(route: string, signal: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(15_000);
    const output = await this.#spawn(
      ["api", "--standalone", "GET", route],
      "null",
      AbortSignal.any([signal, timeout]),
    ).output();
    signal.throwIfAborted();
    this.#lifetime.signal.throwIfAborted();
    if (timeout.aborted) {
      throw new Error("OpenCode model lookup timed out.");
    }
    if (!output.success) {
      throw new Error(
        stderrMessage(decoder.decode(output.stderr)) ||
          "OpenCode model lookup failed.",
      );
    }
    return (JSON.parse(decoder.decode(output.stdout)) as { data: T }).data;
  }

  async models(signal: AbortSignal): Promise<{
    models: OpencodeModel[];
    defaultModel?: string;
  }> {
    const data = await this.#modelApi<ModelData[]>("/api/model", signal);
    if (!Array.isArray(data)) {
      throw new Error("OpenCode returned an invalid model list.");
    }
    const model = await this.#modelApi<ModelData | null>(
      "/api/model/default",
      signal,
    ).catch(() => null);
    signal.throwIfAborted();
    this.#lifetime.signal.throwIfAborted();
    return {
      models: availableModels(data),
      defaultModel: model?.providerID && model.id
        ? `${model.providerID}/${model.id}`
        : undefined,
    };
  }

  async *run(
    prompt: string,
    options: { model?: string; sessionId?: string; signal: AbortSignal },
  ): AsyncGenerator<RunEvent> {
    const args = [
      "run",
      "--standalone",
      "--format",
      "json",
      "--agent",
      agent,
      "--title",
      "DG",
    ];
    if (options.model) args.push("--model", options.model);
    if (options.sessionId) args.push("--session", options.sessionId);
    const stop = new AbortController();
    const child = this.#spawn(
      args,
      "piped",
      AbortSignal.any([options.signal, stop.signal]),
    );
    const stderr = new Response(child.stderr).text();

    try {
      const writer = child.stdin.getWriter();
      const sent = writer.write(new TextEncoder().encode(prompt))
        .then(() => writer.close()).catch((error) => error);
      let buffer = "";
      for await (
        const chunk of child.stdout.pipeThrough(new TextDecoderStream())
      ) {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseEvent(line);
          if (event) yield event;
        }
      }
      const last = parseEvent(buffer);
      if (last) yield last;
      const status = await child.status;
      options.signal.throwIfAborted();
      this.#lifetime.signal.throwIfAborted();
      if (!status.success) {
        throw new Error(
          stderrMessage(await stderr) ||
            `OpenCode exited with status ${status.code}.`,
        );
      }
      const writeError = await sent;
      if (writeError) throw writeError;
    } finally {
      stop.abort();
      await child.status;
      await stderr;
    }
  }

  async close(): Promise<void> {
    this.#lifetime.abort();
    await Promise.allSettled(this.#children);
    await Deno.remove(this.workspace, { recursive: true });
  }
}

function parseEvent(line: string): RunEvent | undefined {
  try {
    const event = JSON.parse(line);
    return typeof event?.type === "string" ? event : undefined;
  } catch {
    return undefined;
  }
}
