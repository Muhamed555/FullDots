import type { SearchResult } from '../../shared/search';

/** Wait this long after the last keystroke before asking the server. */
export const SEARCH_DEBOUNCE_MS = 150;
export const PALETTE_SEARCH_LIMIT = 20;

export interface SearchState {
  loading: boolean;
  /** The query `results` answer; highlights follow it, not what is typed now. */
  resultsFor: string;
  results: SearchResult[];
  error: string;
}

export const idleSearch: SearchState = {
  loading: false,
  resultsFor: '',
  results: [],
  error: '',
};

export interface SearchRunner {
  /** Searches for the typed text once typing pauses; an empty query clears everything. */
  search: (query: string) => void;
  cancel: () => void;
}

/**
 * Debounces and sequences server searches: a newer query cancels the older one, and an answer to
 * an old query is never shown. Framework free so the timing is tested with fake timers.
 */
export function createSearchRunner(options: {
  delay?: number;
  fetcher: (query: string, signal: AbortSignal) => Promise<SearchResult[]>;
  onState: (update: (state: SearchState) => SearchState) => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): SearchRunner {
  const {
    delay = SEARCH_DEBOUNCE_MS,
    fetcher,
    onState,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
  };
  return {
    cancel,
    search(raw) {
      cancel();
      const query = raw.trim();
      if (!query) {
        onState(() => idleSearch);
        return;
      }
      // Keep the old rows on screen while the next ones load, so the list does not flicker.
      onState((state) => ({ ...state, loading: true, error: '' }));
      timer = setTimer(() => {
        timer = undefined;
        const mine = new AbortController();
        controller = mine;
        fetcher(query, mine.signal).then(
          (results) => {
            if (mine.signal.aborted) return;
            onState(() => ({
              loading: false,
              resultsFor: query,
              results,
              error: '',
            }));
          },
          (error: unknown) => {
            if (mine.signal.aborted) return;
            onState((state) => ({
              ...state,
              loading: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Search is not available.',
            }));
          },
        );
      }, delay);
    },
  };
}
