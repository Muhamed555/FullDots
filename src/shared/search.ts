/**
 * What the search endpoint can find. A `team` type joins this list once teams exist: add it here,
 * then add a source for it in `src/server/search.ts`.
 */
export type SearchResultType = 'chat' | 'message' | 'page' | 'dot' | 'prompt';
export const SEARCH_TYPES: readonly SearchResultType[] = [
  'chat',
  'message',
  'page',
  'dot',
  'prompt',
];

export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;
/** Longest query the server looks at. */
export const SEARCH_QUERY_MAX = 200;

export interface SearchResult {
  type: SearchResultType;
  /** The chat, message, page, Dot or prompt id. */
  id: string;
  title: string;
  /** About 120 characters around the first match; empty when there is nothing to show. */
  snippet: string;
  threadId?: string;
  spaceId?: string;
  dotId?: string;
  /** Last change in ms; a Dot has only a creation time. */
  updatedAt: number;
}
