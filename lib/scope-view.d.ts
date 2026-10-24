export const DISABLED_PROMPT_TEXT: string;

export function chipLabel(
  scope: { mode: string; kbs: string[] } | null,
  options?: { loading?: boolean; failed?: boolean }
): string;
export function scopePromptText(scope: { mode: string; kbs: string[] } | null): string;
export function selectionPayload(
  kbs: string[],
  allNames?: string[],
  order?: string[]
): { mode: "all" | "none" | "selected"; kbs: string[] };
export function isAllSelection(kbs: string[], allNames: string[]): boolean;
