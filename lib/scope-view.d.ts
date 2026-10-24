export function chipLabel(
  scope: { mode: string; kbs: string[] } | null,
  options?: { loading?: boolean; failed?: boolean }
): string;
export function scopePromptText(scope: { mode: string; kbs: string[] } | null): string;
export function selectionPayload(mode: string, kbs: string[], order?: string[]): { mode: string; kbs: string[] };
export function isAllSelection(kbs: string[], allNames: string[]): boolean;
