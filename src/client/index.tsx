import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ComponentType } from "react";

export const inject = ["slots"];

type KbProps = { wide?: boolean };

type SlotContext = {
  slots: {
    inject(name: string, callback: () => void): void;
    register(
      declaration: { name: string; id: string; order?: number },
      component: ComponentType<KbProps>
    ): void;
  };
};

const CSS_ID = "dsh-knowledge-wiki/sidebar-entry.css";
const CSS = `
.dsh-kb-entry {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 36px;
  margin: 0 2px;
  padding: 7px 8px;
  border: 0;
  border-radius: var(--dsw-radius-md, 8px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}
.dsh-kb-entry:hover,
.dsh-kb-entry-active {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-kb-entry:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid
    var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe));
  outline-offset: -2px;
}
.dsh-kb-entry svg { flex: none; }
.dsh-kb-entry-collapsed {
  width: 36px;
  height: 36px;
  min-height: 36px;
  justify-content: center;
  margin: 0;
  padding: 0;
}
.dsh-kb-entry-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dsh-kb-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.55);
}
.dsh-kb-modal {
  display: flex;
  flex-direction: column;
  width: min(1180px, 100%);
  height: min(860px, 100%);
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28));
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #fff));
  color: var(--dsw-alias-label-primary, #111);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.4);
}
.dsh-kb-modal-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 44px;
  padding: 0 10px 0 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28));
  font-size: 14px;
  font-weight: 600;
}
.dsh-kb-modal-close {
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #666);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}
.dsh-kb-modal-close:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary, #111);
}
.dsh-kb-modal-frame {
  flex: 1;
  width: 100%;
  border: 0;
  background: #fff;
}
`;

function ensureCss() {
  if (typeof document === "undefined") return;
  const selector = `style[data-plugin-css="${CSS_ID}"]`;
  if (document.querySelector(selector) !== null) return;
  const style = document.createElement("style");
  style.dataset.pluginCss = CSS_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function DatabaseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </svg>
  );
}

/**
 * 侧栏入口 + 工作台弹窗。
 * 弹窗用 portal 挂到 body，iframe 承载 /kb/，关闭后 DSH 页面与状态原样保留。
 */
export function KbWorkbenchAction({ wide = false }: KbProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={`dsh-kb-entry${wide ? "" : " dsh-kb-entry-collapsed"}${open ? " dsh-kb-entry-active" : ""}`}
        title="知识库工作台"
        aria-label="知识库工作台"
        aria-pressed={open}
        onClick={() => setOpen(true)}
      >
        <DatabaseIcon />
        {wide ? <span className="dsh-kb-entry-label">知识库</span> : null}
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="dsh-kb-modal-backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setOpen(false);
              }}
            >
              <div className="dsh-kb-modal" role="dialog" aria-modal="true" aria-label="知识库工作台">
                <div className="dsh-kb-modal-head">
                  <span>知识库工作台</span>
                  <button
                    type="button"
                    className="dsh-kb-modal-close"
                    aria-label="关闭"
                    onClick={() => setOpen(false)}
                  >
                    ×
                  </button>
                </div>
                <iframe className="dsh-kb-modal-frame" src="/kb/?embed=1" title="知识库工作台" />
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

export function apply(ctx: SlotContext) {
  ensureCss();
  ctx.slots.inject("sidebar.footer.action", () => {
    ctx.slots.register(
      { name: "sidebar.footer.action", id: "kb-workbench", order: 10 },
      KbWorkbenchAction
    );
  });
}
