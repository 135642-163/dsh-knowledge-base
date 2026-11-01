# Windows / macOS E2E（2026-11-01）

## macOS（本轮实跑）

- 宿主：macOS + WebKit 27.2（Playwright 1.64.1）；
- 完整套件：**13 passed / 0 failed / 1 skipped**（skip = 来源面板，CLI 1.x 未投影 tool result meta）；
- 单独合并用例：**1 passed**（预览 → 执行 → 撤销），4.4 秒；
- 产物：`test/e2e/.artifacts/2026-11-01T08-47-53/`（完整套件）；
- 新增加载流程：总览「合并库」→ 勾选甲/乙库 → 新建目标 → 预览 → 确认 → 撤销。

## Windows（已接入，未在 Windows 实机执行）

`.github/workflows/ci.yml` 新增手动 job `e2e-windows`：

- 自托管 runner 标签：`[self-hosted, Windows, dsh-profile]`；
- 需 `dsh.cmd` 在 PATH，且有可用的 web profile；
- 触发：Actions → Run workflow → `run_e2e_windows=true`；
- 环境：`DSH_E2E_BROWSER=chromium`、`DSH_E2E_DSH_BIN=dsh.cmd`；
- 安装 `npx playwright install chromium`，跑 `npm run test:e2e`，失败上传 artifacts。

本地 Windows PowerShell：

```powershell
npm ci
npx playwright install chromium
$env:DSH_E2E_BROWSER = "chromium"
$env:DSH_E2E_DSH_BIN = "dsh.cmd"
npm run test:e2e
# 只跑合并：$env:DSH_E2E_ONLY = "合并"
```

宿主侧已做：
- Windows 默认 bin 用 `dsh.cmd`；
- `spawn` 在 Windows 走 `shell: true`，以解析 `.cmd`；
- profile `node_modules` 用 junction（无需管理员权限）；
- 进程清理用 `taskkill /T /F`。

## 未验证项

- 本会话没有 Windows 主机/runner，`e2e-windows` 未实际运行；
- Windows 上 `dsh.cmd`、profile 路径、Playwright Chromium 需在 runner 首次执行时确认；
- macOS 只跑 WebKit；Chromium 未安装，不影响默认套件（失败会回退 Chromium）。
