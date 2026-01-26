/// <reference lib="webworker" />

/**
 * Client-side utilities for DG Launcher plugins running in a worker.
 * This module provides the base class and setup functions for worker-based plugins.
 * @module
 */

import type {
  MainMessage,
  PluginMetadata,
  SearchResult,
  WorkerMessage,
} from "../interface.ts";

/**
 * Base class for Worker Plugins.
 * Usage:
 *
 * ```ts
 * export const meta: PluginMetadata = { ... };
 *
 * export class MyPlugin extends WorkerPlugin {
 *   async search(query: string) {
 *     // ...
 *   }
 * }
 * ```
 */
export abstract class WorkerPlugin {
  /**
   * Search for results matching the query.
   * @param query The search string
   */
  abstract search(query: string): Promise<SearchResult[]>;

  /**
   * Optional: Handle activation if complex logic is needed inside the worker.
   * Default behavior is handled by the main thread via the resultId.
   * @param _resultId The ID of the activated result
   */
  async onActivate(_resultId: string): Promise<void> {}

  /**
   * Helper to copy text to the system clipboard.
   * @param text The text to copy
   */
  copyToClipboard(text: string) {
    const msg: MainMessage = { type: "copy", text };
    self.postMessage(msg);
  }
}

/**
 * Internal: Bootstraps the worker.
 * This is imported by the dynamic worker wrapper.
 */
export function setupWorker(plugin: WorkerPlugin, metadata: PluginMetadata) {
  // Notify main thread we are ready
  const readyMsg: MainMessage = { type: "ready", metadata };
  self.postMessage(readyMsg);

  // Store results map to handle activations: resultId -> callback
  const resultMap = new Map<string, () => Promise<void> | void>();

  self.onmessage = async (
    e: MessageEvent<WorkerMessage>,
  ) => {
    const msg = e.data;

    try {
      if (msg.type === "search") {
        const results = await plugin.search(msg.query);

        // Transform results for transport (strip functions)
        const transportResults = results.map((r, idx) => {
          const resultId = `${msg.id}_${idx}`;
          if (r.onActivate) {
            resultMap.set(resultId, r.onActivate);
          }
          return {
            title: r.title,
            subtitle: r.subtitle,
            score: r.score,
            resultId,
          };
        });

        const response: MainMessage = {
          type: "results",
          id: msg.id,
          results: transportResults,
        };
        self.postMessage(response);
      } else if (msg.type === "activate") {
        const action = resultMap.get(msg.id);
        if (action) {
          await action();
        }
        await plugin.onActivate(msg.id);
        const response: MainMessage = { type: "activated", id: msg.id };
        self.postMessage(response);
      }
    } catch (err) {
      const errorMsg: MainMessage = {
        type: "log",
        level: "error",
        message: String(err),
      };
      self.postMessage(errorMsg);
    }
  };
}
