// Edit and resend opens a branch with the edited text already in its composer. The text waits here,
// by conversation id, until that conversation's chat mounts and takes it.
const drafts = new Map<string, string>();

export function setBranchDraft(threadId: string, text: string) {
  drafts.set(threadId, text);
}

/** The waiting draft, if any. Reading does not clear it (React may run an initializer twice). */
export function branchDraft(threadId: string): string | undefined {
  return drafts.get(threadId);
}

export function clearBranchDraft(threadId: string) {
  drafts.delete(threadId);
}
