import { PluginMetadata, PluginPermissions, SearchResult, Source, WorkerMessage, MainMessage } from "../interface.ts";

export class WorkerSource implements Source {
  id: string;
  name: string;
  description?: string;
  trigger?: string;

  #worker?: Worker;
  #path: string;
  #permissions: PluginPermissions;
  #pendingSearches = new Map<number, (results: SearchResult[]) => void>();
  #searchIdCounter = 0;

  constructor(path: string, metadata: PluginMetadata) {
    this.#path = path;
    this.id = metadata.id;
    this.name = metadata.name;
    this.description = metadata.description;
    this.trigger = metadata.trigger;
    
    // Explicitly deny permissions not requested
    const requested = metadata.permissions || {};
    const allPerms: Deno.PermissionName[] = ["run", "read", "write", "net", "env", "sys", "ffi", "hrtime"];
    this.#permissions = {};
    for (const p of allPerms) {
      this.#permissions[p] = (requested as any)[p] || false;
    }
  }

  /**
   * Spawns a restricted worker to read the plugin's metadata.
   * This runs with effectively NO permissions (except reading the file itself).
   */
  static async loadMetadata(filePath: string): Promise<PluginMetadata> {
    const code = `
      import { meta } from "${filePath}";
      self.postMessage(meta);
    `;
    
    // Create a blob URL for the bootstrapping code
    const blob = new Blob([code], { type: "application/typescript" });
    const url = URL.createObjectURL(blob);

    const isRemote = filePath.startsWith("http") || filePath.startsWith("https") || filePath.startsWith("jsr:") || filePath.startsWith("npm:");

    const worker = new Worker(url, { 
      type: "module",
      deno: {
        permissions: {
          read: isRemote ? false : [filePath], 
          net: isRemote ? true : false, // Allow net for remote modules (fetching)
          write: false,
          run: false,
          env: false
        }
      } as any // 'deno' option is Deno-specific
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

  async init(_window?: any): Promise<void> {
    // Construct the bootstrapping code for the real worker
    // We assume the plugin exports a default class that extends WorkerPlugin
    // and a 'meta' object.
    const code = `
      import { setupWorker } from "${new URL("./client.ts", import.meta.url).href}";
      import Plugin, { meta } from "${this.#path}";
      
      const instance = new Plugin();
      setupWorker(instance, meta);
    `;

    const blob = new Blob([code], { type: "application/typescript" });
    const url = URL.createObjectURL(blob);

    this.#worker = new Worker(url, {
      type: "module",
      deno: {
        permissions: this.#permissions
      } as any
    });

    this.#worker.onmessage = (e: MessageEvent<MainMessage>) => {
      const msg = e.data;
      if (msg.type === "results") {
        const resolve = this.#pendingSearches.get(msg.id);
        if (resolve) {
          // Hydrate the results with the activation logic
          const hydratedResults: SearchResult[] = msg.results.map(r => ({
            title: r.title,
            subtitle: r.subtitle,
            score: r.score,
            onActivate: () => {
              this.#worker?.postMessage({
                type: "activate",
                id: r.resultId
              } as WorkerMessage);
            }
          }));
          resolve(hydratedResults);
          this.#pendingSearches.delete(msg.id);
        }
      } else if (msg.type === "log") {
        console.log(`[Plugin ${this.id}]`, msg.message);
      }
    };
  }

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
