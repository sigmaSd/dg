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
  init(): Promise<void>;
  search(query: string): Promise<SearchResult[]>;
}
