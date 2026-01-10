export interface SearchResult {
  title: string;
  subtitle: string;
  score: number;
  icon?: string;
  onActivate: () => Promise<void> | void;
}

export interface Source {
  id: string;
  name: string;
  description?: string;
  /**
   * The prefix to trigger this source (e.g., "b", "calc").
   * If undefined, this source is searched when no specific trigger is used (Global).
   */
  trigger?: string; 
  init(): Promise<void>;
  search(query: string): Promise<SearchResult[]>;
}