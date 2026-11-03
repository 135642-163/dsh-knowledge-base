export interface KbSource {
  kb?: string;
  docId: string;
  title?: string;
  page?: number;
  clause?: string;
  pageEnd?: number;
  pages?: number[];
  clauses?: string[];
  keywords?: string[];
  snippet?: string;
  deepLink?: string;
}
export function sourceHref(source: KbSource): string;
export function sourceLabel(source: KbSource): string;
export function dedupeSources(sources: KbSource[], max?: number): KbSource[];
export function mergeSourcesByDoc(sources: KbSource[], max?: number): KbSource[];
