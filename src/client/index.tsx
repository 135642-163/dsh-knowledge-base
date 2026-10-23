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
  display: inline-flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: 30px;
  padding: 5px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}
.dsh-kb-entry:hover {
  background: var(--dsw-alias-fill-l2);
  color: var(--dsw-alias-label-primary);
}
.dsh-kb-entry:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 1px;
}
.dsh-kb-entry svg { flex: none; }
.dsh-kb-entry-collapsed { justify-content: center; padding: 5px; }
.dsh-kb-entry-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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

function isElectron() {
  return typeof navigator !== "undefined" && /Electron/i.test(navigator.userAgent);
}

export function KbWorkbenchAction({ wide = false }: KbProps) {
  // Electron 主窗口拒绝应用内新窗口（setWindowOpenHandler deny），所以桌面端
  // 走当前窗口导航；普通浏览器仍用新标签。这样点击一定有可见响应。
  const desktop = isElectron();
  return (
    <a
      className={wide ? "dsh-kb-entry" : "dsh-kb-entry dsh-kb-entry-collapsed"}
      href="/kb/"
      target={desktop ? "_self" : "_blank"}
      rel={desktop ? undefined : "noopener noreferrer"}
      title="知识库工作台"
      aria-label="知识库工作台"
    >
      <DatabaseIcon />
      {wide ? <span className="dsh-kb-entry-label">知识库</span> : null}
    </a>
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
