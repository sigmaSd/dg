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
  #searchIdCounter = 0;

  /**
   * Creates a new WorkerSource.
   * @param path Path to the plugin module
   * @param metadata Metadata describing the plugin
   */
  constructor(path: string, metadata: PluginMetadata) {
    this.#path = path;
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
        reject(new Error("Plugin metadata load timed out"));
      }, 5000);

      worker.onmessage = (e) => {
        clearTimeout(timeout);
        worker.terminate();
        URL.revokeObjectURL(url);
        resolve(e.data as PluginMetadata);
      };

      worker.onerror = (e) => {
        clearTimeout(timeout);
        worker.terminate();
        URL.revokeObjectURL(url);
        reject(e);
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
    const url = URL.createObjectURL(blob);

    this.#worker = new Worker(url, {
      type: "module",
      deno: {
        permissions: this.#permissions as Deno.PermissionOptions,
      } as { permissions: Deno.PermissionOptions },
    });

    this.#worker.onmessage = (e: MessageEvent<MainMessage>) => {
      const msg = e.data;
      if (msg.type === "results") {
        const resolve = this.#pendingSearches.get(msg.id);
        if (resolve) {
          // Hydrate the results with the activation logic
          const hydratedResults: SearchResult[] = msg.results.map((r) => ({
            title: r.title,
            subtitle: r.subtitle,
            score: r.score,
            onActivate: () => {
              this.#worker?.postMessage({
                type: "activate",
                id: r.resultId,
              } as WorkerMessage);
            },
          }));
          resolve(hydratedResults);
          this.#pendingSearches.delete(msg.id);
        }
      } else if (msg.type === "log") {
        console.log(`[Plugin ${this.id}]`, msg.message);
      }
    };

    return Promise.resolve();
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
      this.#pendingSearches.set(id, resolve);
      this.#worker!.postMessage(msg);

      // Cleanup timeout
      setTimeout(() => {
        if (this.#pendingSearches.has(id)) {
          this.#pendingSearches.delete(id);
          resolve([]);
        }
      }, 5000);
    });
  }
}
