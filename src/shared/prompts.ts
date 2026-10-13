/** Where a saved prompt is offered: everywhere, with one Dot, or with a team (teams arrive later). */
export type PromptScope = 'global' | 'dot' | 'team';
export const PROMPT_SCOPES: readonly PromptScope[] = ['global', 'dot', 'team'];

export const PROMPT_TITLE_MAX = 80;
export const PROMPT_BODY_MAX = 4000;

/** A reusable message the owner saved. Archiving hides it; nothing is deleted. */
export interface Prompt {
  id: string;
  title: string;
  body: string;
  scope: PromptScope;
  dotId: string | null;
  teamId: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}
