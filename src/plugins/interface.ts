/**
 * Shared interfaces and types for the DG Launcher plugin system.
 * This module defines the contract between the main application and its plugins.
 * @module
 */

/**
 * Represents a single search result to be displayed in the launcher.
 */
export interface SearchResult {
  /** The main title of the result */
  title: string;
  /** A subtitle or description providing more context */
  subtitle: string;
  /** A relevance score, higher is better */
  score: number;
  /** Name of the icon to display (e.g. from the system theme) */
  icon?: string;
  /**
   * For worker plugins, this ID is sent back to trigger the action.
   * For in-process plugins, this function is called directly.
   */
  id?: string;
  /** Action to perform when the result is selected/activated */
  onActivate: () => Promise<void> | void;
}

/**
 * Permissions requested by a plugin, mapping Deno permission names to their allowed values.
 */
export type PluginPermissions = {
  [K in Deno.PermissionName]?: string[] | boolean;
};

/**
 * Metadata describing a plugin.
 */
export interface PluginMetadata {
  /** Unique identifier for the plugin */
  id: string;
  /** Display name of the plugin */
  name: string;
  /** Brief description of what the plugin does */
  description?: string;
  /**
   * Keyword to trigger this plugin specifically.
   * If undefined, the plugin is treated as a global source.
   */
  trigger?: string;
  /** Permissions required by the plugin */
  permissions?: PluginPermissions;
}

/**
 * Interface that all plugin sources must implement.
 */
export interface Source {
  /** Unique identifier for the source */
  id: string;
  /** Display name of the source */
  name: string;
  /** Brief description of the source */
  description?: string;
  /**
   * Keyword to trigger this source specifically.
   * If undefined, the source is active for all queries.
   */
  trigger?: string;
  /**
   * Initializes the source.
   */
  init(): Promise<void>;
  /**
   * Searches the source for the given query.
   * @param query The search string entered by the user
   */
  search(query: string): Promise<SearchResult[]>;
}

// --- RPC Protocol Types ---

/**
 * Messages sent from the main process to the worker.
 */
export type WorkerMessage =
  | { type: "search"; id: number; query: string }
  | { type: "activate"; id: string };

/**
 * Messages sent from the worker to the main process.
 */
export type MainMessage =
  | { type: "ready"; metadata: PluginMetadata }
  | {
    type: "results";
    id: number;
    results: {
      title: string;
      subtitle: string;
      score: number;
      resultId: string;
    }[];
  }
  | { type: "log"; level: "info" | "error"; message: string };
