/** ui/resizable.js 的类型声明：客户端 bundle（TSX）与零构建工作台共用同一份实现。 */

export type ResizeSize = { width: number; height: number };

export type ResizeHandle = { destroy: () => void };

export type MountResizeOptions = {
  /** localStorage 键（内部统一加 dsh-kb:size: 前缀）；省略则不记忆尺寸。 */
  storageKey?: string;
  minWidth?: number;
  minHeight?: number;
  margin?: number;
};

export declare function mountResize(
  target: Element | null,
  overlay: Element | null,
  options?: MountResizeOptions,
): ResizeHandle;

export declare function readStoredSize(
  key: string,
  storage?: Pick<Storage, "getItem"> | null,
): ResizeSize | null;

export declare function writeStoredSize(
  key: string,
  size: ResizeSize,
  storage?: Pick<Storage, "setItem"> | null,
): boolean;

export declare function safeStorage(win?: Window | null): Storage | null;

export declare const RESIZE_CURSOR: Record<string, string>;
