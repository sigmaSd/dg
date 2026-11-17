import type { Source } from "./plugins/interface.ts";
import { ConfigManager, type PluginEntry } from "./config.ts";
import { WorkerSource } from "./plugins/worker/host.ts";
import * as path from "@std/path";
import type { AdwApplicationWindow } from "@sigmasd/gtk/adw";
import type { Window } from "@sigmasd/gtk/gtk4";
import {
  normalizePermissions,
  promptPermissions,
} from "./utils/permissions.ts";
import { AppSource } from "./plugins/core/apps.ts";
import { FirefoxSource } from "./plugins/core/firefox.ts";
import { StoreSource } from "./plugins/core/store.ts";
import { CalculatorSource } from "./plugins/core/calculator.ts";
import { AiSource } from "./plugins/core/ai.ts";
import { SearchSource } from "./plugins/core/search.ts";
import { type FileManagerStartupId, PathSource } from "./plugins/core/paths.ts";
import type { openUrl } from "./utils/open-url.ts";

const settingsId = "plugin-states";
const triggersId = "plugin-triggers";
const triggerPattern = /^(?!\/|~(?:\/|$))[^\s]+$/;

export interface PluginControl {
  key: string;
  title: string;
  description?: string;
  trigger?: string;
  enabled: boolean;
  error?: string;
}

interface Registration {
  control: PluginControl;
  defaultEnabled: boolean;
  entry?: PluginEntry;
  source?: Source;
  create: (permissionWindow?: Window) => Source | Promise<Source>;
}

function extensionKey(url: string): string {
  const packageName = /^jsr:(@[^/]+\/[^@]+)(?:@.+)?$/.exec(url)?.[1];
  return `extension:${packageName ? `jsr:${packageName}` : url}`;
}

export class PluginLoader {
  #configManager = new ConfigManager();
  #appSource: AppSource;
  #pathSource: PathSource;
  #registrations = new Map<string, Registration>();
  #overrides = new Map<string, boolean>();
  #triggers = new Map<string, string>();
  #changes = Promise.resolve();
  #onChanged: () => void;
  #openUrl?: typeof openUrl;

  constructor(
    launch: {
      fileManagerStartupId?: FileManagerStartupId;
      openUrl?: typeof openUrl;
      launchApp?: (desktopFile: string) => boolean;
    } = {},
    onChanged = () => {},
  ) {
    this.#appSource = new AppSource(launch.launchApp);
    this.#pathSource = new PathSource(
      this.#appSource,
      this.#configManager,
      launch.fileManagerStartupId,
    );
    this.#onChanged = onChanged;
    this.#openUrl = launch.openUrl;
  }

  get configManager() {
    return this.#configManager;
  }

  get pathSource() {
    return this.#pathSource;
  }

  get controls(): PluginControl[] {
    return Array.from(
      this.#registrations.values(),
      ({ control }) => ({ ...control }),
    );
  }

  get activeSources(): Source[] {
    return Array.from(this.#registrations.values()).flatMap(({ source }) =>
      source ? [source] : []
    );
  }

  async loadPlugins(window?: AdwApplicationWindow): Promise<Source[]> {
    const saved = await this.#configManager.getPluginSettings(settingsId).catch(
      (error) => {
        console.error("Could not read plugin switches:", error);
        return undefined;
      },
    );
    if (saved && typeof saved === "object") {
      for (const [key, value] of Object.entries(saved)) {
        if (typeof value === "boolean") this.#overrides.set(key, value);
      }
    }
    const triggers = await this.#configManager.getPluginSettings(triggersId)
      .catch((error) => {
        console.error("Could not read plugin triggers:", error);
      });
    if (triggers && typeof triggers === "object") {
      for (const [key, value] of Object.entries(triggers)) {
        if (
          typeof value === "string" && triggerPattern.test(value)
        ) {
          this.#triggers.set(key, value);
        }
      }
    }
    const config = await this.#configManager.read();
    const register = (source: Source, defaultEnabled = true) => {
      const key = `core:${source.id}`;
      this.#registrations.set(key, {
        control: {
          key,
          title: source.name,
          description: source.description,
          trigger: source.trigger
            ? this.#triggers.get(key) ?? source.trigger
            : undefined,
          enabled: false,
        },
        defaultEnabled,
        create: () => source,
      });
    };
    register(this.#appSource);
    if (Deno.build.os === "linux") register(this.#pathSource);
    register(new FirefoxSource(this.#openUrl));
    register(
      new StoreSource(
        window,
        this.#configManager,
        () =>
          this.#queueChange(async () => {
            await this.#syncExtensions(
              (await this.#configManager.read()).plugins,
              window,
            );
            this.#onChanged();
          }),
      ),
    );
    register(new CalculatorSource(window));
    register(new SearchSource(this.#openUrl));
    register(
      new AiSource(this.#configManager),
      config.opencode?.enabled === true,
    );

    for (const registration of this.#registrations.values()) {
      await this.#startIfEnabled(registration, window);
    }
    await this.#syncExtensions(config.plugins, window);
    return this.activeSources;
  }

  setEnabled(key: string, enabled: boolean, window?: Window): Promise<void> {
    return this.#queueChange(async () => {
      const registration = this.#registrations.get(key);
      if (!registration) throw new Error("This plugin is no longer installed.");
      if (registration.control.enabled === enabled) return;

      const source = enabled
        ? await this.#start(registration, window)
        : undefined;
      const overrides = new Map(this.#overrides).set(key, enabled);
      try {
        await this.#configManager.setPluginSettings(
          settingsId,
          Object.fromEntries(overrides),
        );
      } catch (error) {
        await this.#stop(source);
        throw error;
      }
      this.#overrides = overrides;
      const previous = registration.source;
      this.#setSource(registration, source);
      await this.#stop(previous);
      this.#onChanged();
    });
  }

  setTrigger(key: string, trigger: string): Promise<void> {
    return this.#queueChange(async () => {
      const registration = this.#registrations.get(key);
      if (!registration?.control.trigger) {
        throw new Error("This plugin has no trigger to edit.");
      }
      if (!triggerPattern.test(trigger)) {
        throw new Error(
          "Use a single shortcut without spaces or a path prefix.",
        );
      }
      const duplicate = this.controls.find((plugin) =>
        plugin.key !== key && plugin.trigger === trigger
      );
      if (duplicate) {
        throw new Error(`“${trigger}” is already used by ${duplicate.title}.`);
      }
      const overrides = new Map(this.#triggers).set(key, trigger);
      await this.#configManager.setPluginSettings(
        triggersId,
        Object.fromEntries(overrides),
      );
      this.#triggers = overrides;
      registration.control.trigger = trigger;
      if (registration.source) registration.source.trigger = trigger;
      this.#onChanged();
    });
  }

  #queueChange(change: () => Promise<void>): Promise<void> {
    const pending = this.#changes.then(change);
    this.#changes = pending.catch(() => {});
    return pending;
  }

  #setSource(registration: Registration, source?: Source) {
    registration.source = source;
    registration.control.enabled = Boolean(source);
    registration.control.error = undefined;
    if (source) {
      registration.control.title = source.name;
      registration.control.description = source.description;
      if (source.trigger) {
        source.trigger = this.#triggers.get(registration.control.key) ??
          source.trigger;
      }
      registration.control.trigger = source.trigger;
    }
  }

  async #startIfEnabled(registration: Registration, window?: Window) {
    const enabled = this.#overrides.get(registration.control.key) ??
      registration.defaultEnabled;
    if (!enabled) return;
    try {
      this.#setSource(registration, await this.#start(registration, window));
    } catch (error) {
      registration.control.enabled = true;
      registration.control.error = error instanceof Error
        ? error.message
        : String(error);
      console.error(`Could not start ${registration.control.title}:`, error);
    }
  }

  async #start(registration: Registration, window?: Window): Promise<Source> {
    const source = await registration.create(window);
    try {
      await source.init();
      return source;
    } catch (error) {
      await this.#stop(source);
      throw error;
    }
  }

  async #stop(source?: Source): Promise<void> {
    try {
      await source?.destroy?.();
    } catch (error) {
      console.error(`Could not stop ${source?.name}:`, error);
    }
  }

  async #syncExtensions(entries: PluginEntry[], window?: AdwApplicationWindow) {
    const installed = new Map(
      entries.map((entry) => [extensionKey(entry.url), entry]),
    );
    for (const [key, registration] of this.#registrations) {
      if (
        !registration.entry ||
        registration.entry.url === installed.get(key)?.url
      ) continue;
      this.#registrations.delete(key);
      await this.#stop(registration.source);
    }
    for (const [key, entry] of installed) {
      if (this.#registrations.has(key)) continue;
      const registration: Registration = {
        control: {
          key,
          title: entry.name ?? entry.url,
          trigger: this.#triggers.get(key) ?? entry.trigger,
          enabled: false,
        },
        defaultEnabled: true,
        entry,
        create: (parent) => this.#createWorker(entry, window, parent),
      };
      this.#registrations.set(key, registration);
      await this.#startIfEnabled(registration, window);
    }
  }

  async #createWorker(
    entry: PluginEntry,
    window?: AdwApplicationWindow,
    parent?: Window,
  ): Promise<WorkerSource> {
    const { url } = entry;
    const pluginPath = /^(https?:|jsr:|npm:|file:)/.test(url)
      ? url
      : path.toFileUrl(path.resolve(url)).href;
    const meta = await WorkerSource.loadMetadata(pluginPath);
    const requested = meta.permissions ?? {};
    const granted = entry.permissions ?? {};
    if (
      JSON.stringify(normalizePermissions(granted)) !==
        JSON.stringify(normalizePermissions(requested))
    ) {
      if (!parent || !await promptPermissions(parent, meta.name, requested)) {
        throw new Error("Plugin permissions were not approved.");
      }
      await this.#configManager.updatePlugin(url, requested);
      entry.permissions = requested;
    }
    return new WorkerSource(pluginPath, meta, window);
  }
}
