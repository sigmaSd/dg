export interface SearchResult {
  title: string;
  subtitle: string;
  score: number;
  icon?: string;
  /**
   * For worker plugins, this ID is sent back to trigger the action.
   * For in-process plugins, this function is called directly.
   */
  id?: string;
  onActivate: () => Promise<void> | void;
}

export type PluginPermissions = {
  [K in Deno.PermissionName]?: string[] | boolean;
};

export interface PluginMetadata {
  id: string;
  name: string;
  description?: string;
  trigger?: string;
  permissions?: PluginPermissions;
}

export interface Source {
  id: string;
  name: string;
  description?: string;
  trigger?: string;
  init(window?: unknown): Promise<void>;
  search(query: string): Promise<SearchResult[]>;
}

// --- RPC Protocol Types ---

export type WorkerMessage =
  | { type: "search"; id: number; query: string }
  | { type: "activate"; id: string };

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
