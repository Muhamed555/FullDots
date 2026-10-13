import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SearchResult } from '../../shared/search';
import { api } from '../api';
import {
  PALETTE_SEARCH_LIMIT,
  createSearchRunner,
  idleSearch,
  type SearchState,
} from './debounced-search';
import { isPaletteShortcut } from './palette-model';

export interface CommandPaletteControl {
  open: boolean;
  /** Text to start the search with, set when the sidebar box hands over what was typed. */
  initialQuery: string;
  show: (query?: string) => void;
  hide: () => void;
}

/** Open state for the palette, plus the Ctrl+K / Cmd+K shortcut. */
export function useCommandPalette(): CommandPaletteControl {
  const [state, setState] = useState({ open: false, initialQuery: '' });
  const show = useCallback(
    (query = '') => setState({ open: true, initialQuery: query }),
    [],
  );
  const hide = useCallback(
    () => setState((current) => ({ ...current, open: false })),
    [],
  );
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      // The remote computer screen forwards every key to the page it controls.
      if (
        event.target instanceof Element &&
        event.target.closest('.computer-keys')
      )
        return;
      event.preventDefault();
      setState((current) =>
        current.open
          ? { ...current, open: false }
          : { open: true, initialQuery: '' },
      );
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  return useMemo(() => ({ ...state, show, hide }), [state, show, hide]);
}

/** Debounced server search for the text typed in the palette. */
export function usePaletteSearch(
  query: string,
  initial: SearchState = idleSearch,
): SearchState {
  const [state, setState] = useState<SearchState>(initial);
  const runner = useMemo(
    () =>
      createSearchRunner({
        onState: setState,
        fetcher: async (text, signal) =>
          (
            await api<{ results: SearchResult[] }>(
              `/search?q=${encodeURIComponent(text)}&limit=${PALETTE_SEARCH_LIMIT}`,
              'GET',
              undefined,
              signal,
            )
          ).results,
      }),
    [],
  );
  useEffect(() => {
    runner.search(query);
  }, [runner, query]);
  useEffect(() => runner.cancel, [runner]);
  return state;
}
