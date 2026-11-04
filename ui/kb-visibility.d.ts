export type KbDocs = number | {
  total?: number;
  ready?: number;
  importing?: number;
  failed?: number;
  deleted?: number;
  notes?: number;
};

export interface KbVisibilityInput {
  name?: string;
  dir?: string;
  mergedInto?: string | null;
  docs?: KbDocs;
}

export function kbLiveDocs(kb: KbVisibilityInput | null | undefined): number;
export function isListedKb(kb: KbVisibilityInput | null | undefined): boolean;
export function visibleKbs<T extends KbVisibilityInput>(list: readonly T[] | null | undefined): T[];
export function normalizeScope<T extends { mode: string; kbs?: string[] }>(
  scope: T,
  list: readonly KbVisibilityInput[] | null | undefined,
): T;
