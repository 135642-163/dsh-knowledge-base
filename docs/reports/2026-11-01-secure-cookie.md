# bzCookie 安全存储（2026-11-01）

## 实现

- 新增 `lib/secure-cookie.js`：
  - macOS：Keychain `security` generic password，service `dsh-knowledge-wiki`，account `biaozhun.org`；
  - Linux：Secret Service `secret-tool`（Cookie 通过 stdin 传入，不进进程参数）；
  - Windows：DPAPI（CurrentUser）加密文件 `~/.dsh/knowledge-wiki/bzCookie.dpapi`；
  - 统一 marker `~/.dsh/knowledge-wiki/bzCookie.enabled`，避免每次启动都访问钥匙串。
- 启动时（`lib/index.js`）：
  - marker 存在 → 优先读安全存储；
  - 旧 `bzCookie` 配置存在且没有 marker → 首次启动自动迁移到安全存储；
  - 安全存储不可用/失败 → 回退配置值并写 `.plugin-load.log` 警告（不记录 Cookie）；
  - 新增 `bzCookieStorage: auto | config`，默认 auto；`config` 保留纯配置调试路径。
- 新增 `scripts/set-bz-cookie.mjs`：
  - `pbpaste | node scripts/set-bz-cookie.mjs` / `BZ_COOKIE=... node ...`；
  - `--status` 只显示 backend/enabled/configured，不打印 Cookie；
  - `--clear` 清除安全存储与 marker。
- `scripts/std-check-daily.mjs`、`scripts/fetch-standards.mjs` 也支持从安全存储取 Cookie。
- Web 工作台仍只显示“已配置/未配置”；Cookie 不进任何返回值/日志。

## 实测

- 本机 macOS：`node scripts/set-bz-cookie.mjs --status` 返回
  `backend=macos-keychain / enabled=true / configured=true`（未输出 Cookie）；
- 旧 profile 明文 Cookie 在插件重载时完成迁移（日志只记“已迁移”，不记内容）；
- 全量测试 **1292**（1288 通过、4 跳过，0 失败）。

## 安全边界

- macOS 保存时 Cookie 仍会出现在 `security` 子进程 argv 中（同用户可见）；钥匙串静态加密，优于 profile 明文；
- Linux `secret-tool` 走 stdin；
- Windows DPAPI 使用当前用户密钥，换用户/换机需重新设置；
- 迁移后建议手动删除 profile 中的明文 `bzCookie`；
- 不支持平台会明确报错，不会偷偷写明文文件。
