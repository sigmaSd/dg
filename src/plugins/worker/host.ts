/**
 * Host-side implementation for DG Launcher plugins.
 * This module handles the creation and communication with plugin workers.
 * @module
 */

import {
  type MainMessage,
  PERMISSION_NAMES,
  type PluginMetadata,
  type PluginPermissions,
  type SearchResult,
  type Source,
  type WorkerMessage,
} from "../interface.ts";
import type { AdwApplicationWindow } from "@sigmasd/gtk/adw";

/**
 * Host implementation for running plugins in a Worker.
 */
export class WorkerSource implements Source {
  /** Unique identifier for the source */
  id: string;
  /** Display name of the source */
  name: string;
  /** Brief description of the source */
  description?: string;
  /** Trigger keyword */
  trigger?: string;

  #worker?: Worker;
  #path: string;
  #permissions: PluginPermissions;
  #pendingSearches = new Map<number, (results: SearchResult[]) => void>();
  #pendingActivations = new Map<string, () => void>();
  #searchIdCounter = 0;
  #window?: AdwApplicationWindow;
  #blobUrl?: string;

  /**
   * Creates a new WorkerSource.
   * @param path Path to the plugin module
   * @param metadata Metadata describing the plugin
   * @param window Optional main window instance (required for clipboard access)
   */
  constructor(
    path: string,
    metadata: PluginMetadata,
    window?: AdwApplicationWindow,
  ) {
    this.#path = path;
    this.#window = window;
    this.id = metadata.id;
    this.name = metadata.name;
    this.description = metadata.description;
    this.trigger = metadata.trigger;

    // Explicitly deny permissions not requested
    const requested = metadata.permissions || {};
    this.#permissions = {};
    for (const p of PERMISSION_NAMES) {
      (this.#permissions as Record<string, unknown>)[p] =
        (requested as Record<string, unknown>)[p] || false;
    }
  }

  /**
   * Spawns a restricted worker to read the plugin's metadata.
   * This runs with effectively NO permissions (except reading the file itself).
   */
  static loadMetadata(filePath: string): Promise<PluginMetadata> {
    const code = `
          import { meta } from "${filePath}";
          self.postMessage(meta);
        `;

    // Create a blob URL for the bootstrapping code
    const blob = new Blob([code], { type: "application/typescript" });
    const url = URL.createObjectURL(blob);

    const isRemote = filePath.startsWith("http") ||
      filePath.startsWith("https") || filePath.startsWith("jsr:") ||
      filePath.startsWith("npm:");

    const worker = new Worker(url, {
      type: "module",
      deno: {
        permissions: {
          read: isRemote ? false : [filePath],
          net: isRemote ? true : false, // Allow net for remote modules (fetching)
          write: false,
          run: false,
          env: false,
        },
      } as unknown as { permissions: Deno.PermissionOptions }, // Use unknown cast to avoid any if possible
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.terminate();
        URL.revokeObjectURL(url);
        reject(new Error("Plugin metadata load timed out"));
      }, 5000);

      worker.onmessage = (e) => {
        clearTimeout(timeout);
        worker.terminate();
        URL.revokeObjectURL(url);
        resolve(e.data as PluginMetadata);
      };

      worker.onerror = (e) => {
        e.preventDefault();
        clearTimeout(timeout);
        worker.terminate();
        URL.revokeObjectURL(url);
        reject(new Error(`Worker error: ${e.message}`));
      };
    });
  }

  /**
   * Initializes the worker and sets up message listeners.
   */
  init(): Promise<void> {
    // Construct the bootstrapping code for the real worker
    // We assume the plugin exports a default class that extends WorkerPlugin
    // and a 'meta' object.
    const code = `
      import { setupWorker } from "${
      new URL("./client.ts", import.meta.url).href
    }";
      import Plugin, { meta } from "${this.#path}";

      const instance = new Plugin();
      setupWorker(instance, meta);
    `;

    const blob = new Blob([code], { type: "application/typescript" });
    this.#blobUrl = URL.createObjectURL(blob);

    this.#worker = new Worker(this.#blobUrl, {
      type: "module",
      deno: {
        permissions: this.#permissions as Deno.PermissionOptions,
      } as { permissions: Deno.PermissionOptions },
    });

    const ready = Promise.withResolvers<void>();
    const timeout = setTimeout(
      () => ready.reject(new Error("Plugin startup timed out")),
      5000,
    );
    this.#worker.onerror = (event) => {
      event.preventDefault();
      ready.reject(new Error(event.message));
      console.error(`[Plugin ${this.id}]`, event.message);
    };
    this.#worker.onmessage = (e: MessageEvent<MainMessage>) => {
      const msg = e.data;
      if (msg.type === "ready") {
        ready.resolve();
      } else if (msg.type === "results") {
        const resolve = this.#pendingSearches.get(msg.id);
        if (resolve) {
          // Hydrate the results with the activation logic
          const hydratedResults: SearchResult[] = msg.results.map((r) => ({
            title: r.title,
            subtitle: r.subtitle,
            score: r.score,
            onActivate: () => {
              return new Promise<void>((resolve) => {
                if (!r.resultId) {
                  resolve();
                  return;
                }
                const timeout = setTimeout(() => {
                  if (this.#pendingActivations.delete(r.resultId)) resolve();
                }, 5000);
                this.#pendingActivations.set(r.resultId, () => {
                  clearTimeout(timeout);
                  resolve();
                });
                this.#worker?.postMessage({
                  type: "activate",
                  id: r.resultId,
                } as WorkerMessage);
              });
            },
          }));
          resolve(hydratedResults);
          this.#pendingSearches.delete(msg.id);
        }
      } else if (msg.type === "activated") {
        const resolve = this.#pendingActivations.get(msg.id);
        if (resolve) {
          resolve();
          this.#pendingActivations.delete(msg.id);
        }
      } else if (msg.type === "log") {
        console.log(`[Plugin ${this.id}]`, msg.message);
      } else if (msg.type === "copy") {
        console.log(
          `[Plugin ${this.id}] Host received copy request for: ${
            msg.text.substring(0, 20)
          }...`,
        );
        if (this.#window) {
          this.#window.getDisplay().getClipboard().set(msg.text);
        } else {
          console.warn(
            `[Plugin ${this.id}] Tried to copy to clipboard but no window is available.`,
          );
        }
      }
    };

    return ready.promise.finally(() => clearTimeout(timeout));
  }

  /**
   * Sends a search query to the worker.
   * @param query The search query
   */
  search(query: string): Promise<SearchResult[]> {
    if (!this.#worker) return Promise.resolve([]);

    const id = ++this.#searchIdCounter;
    const msg: WorkerMessage = { type: "search", id, query };

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.#pendingSearches.delete(id)) resolve([]);
      }, 5000);
      this.#pendingSearches.set(id, (results) => {
        clearTimeout(timeout);
        resolve(results);
      });
      this.#worker!.postMessage(msg);
    });
  }

  // deno-lint-ignore require-await
  async destroy(): Promise<void> {
    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = undefined;
    }
    for (const resolve of this.#pendingSearches.values()) resolve([]);
    this.#pendingSearches.clear();
    for (const resolve of this.#pendingActivations.values()) resolve();
    this.#pendingActivations.clear();
    if (this.#blobUrl) {
      URL.revokeObjectURL(this.#blobUrl);
      this.#blobUrl = undefined;
    }
  }
}
