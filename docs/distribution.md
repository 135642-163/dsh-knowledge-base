# 分发与市场更新（v0.16.0）

## 0.16.0 的两个关键变更

1. **包名与 loader id 改名**（解决市场撞名）：
   - 包名：`dsh-knowledge-wiki`（原 `dsh-knowledge-base`）；
   - loader id：`knowledge-wiki`（原 `knowledge-base`）；
   - 与已收录的 `htcqp802/dsh-knowledge-base` 不再冲突。
2. **放宽 DSH 兼容范围**：`peerDependencies["@deepseek-ai/dsh-tools"]` 改为
   `>=0.1.0-rc.6 <0.3.0`。已用 `dsh-tools@0.2.1-rc.2` 跑完整测试（139 个用例全通过）。

> catalog PR 的两个阻塞点（维护者评论）就是这两项，现已在 v0.16.0 修复，等待 PR 重新检查/合并。

## 安装（新用户）

插件已声明 `dsh.bundle.patch`，安装后由包内 `cordis.patch.yml` 自动挂载：

```bash
dsh plugin --profile web add github:135642-163/dsh-knowledge-base
```

重启 `dsh web`（或让 HMR 应用），新会话执行 `kb_list` 验证。

更新：GitHub 安装按“已安装 commit vs 远端默认分支 HEAD”比较，发布新版本只需
`git push origin main`，不需要 tag/Release。

## 从旧名迁移（0.16.0 之前安装的用户）

旧版注册行是 `id: knowledge-base` / `name: dsh-knowledge-base`，与新 bundle 的
`knowledge-wiki` 不冲突，所以不会出现 duplicate loader id；但会**同时加载两份插件**，
工具重名。迁移步骤：

1. 备份 `~/.dsh/knowledge`；
2. 从 `~/.dsh/profiles/web/cordis.patch.yml` 删除旧 `insert`（`id: knowledge-base`）；
3. 删除旧软链 `~/.dsh/profiles/node_modules/dsh-knowledge-base`；
4. 执行 `dsh plugin --profile web add github:135642-163/dsh-knowledge-base`；
5. 重启 `dsh web`，`kb_list` 验证。

知识库数据在 `~/.dsh/knowledge`（或自定义 kbRoot），改名不影响内容。

## 市场（dsh-market）状态

- catalog 投稿 PR：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8769>
  （当前 **open**）。
- 维护者指出的两个阻塞点：
  1. `peer dsh-tools <0.2.0` 排除当前 0.2.1 → 已修为 `<0.3.0`；
  2. 包名/loader id 与 `htcqp802/dsh-knowledge-base` 冲突 → 已改名。
- 两项修复已包含在 v0.16.0，PR 分支需重新触发检查；合并后市场重建，
  其他用户即可在 dsh-market 搜索/安装/更新。

> catalog 的 `name` 字段仍是仓库路径 `135642-163/dsh-knowledge-base`（owner/repo），
> 仓库名没有改，所以 catalog 文件不需要改；冲突只发生在包名/loader id 层面。

## 为什么暂不发布 npm

`dsh-knowledge-wiki` 这个名字在 npm 上可用，但当前机器未登录 npm（`npm whoami` 报
`ENEEDAUTH`），所以本轮仍走 GitHub 安装。登录后可发布：

```bash
npm login
npm publish --access public
```

注意 `files` 不包含 `data/tessdata`（约 35MB），首次 OCR 仍由
`autoDownloadModels` 自动补模型。

## OCR 模型

`autoDownloadModels` 默认 `true`：市场/GitHub 安装没有预置 `data/tessdata` 时，
首次走 tesseract 家族 OCR 会自动下载缺失模型到 `~/.dsh/tools/tessdata`
（优先复用 langPath 中已有模型）。rapidocr 自带模型，不会触发下载。

关闭自动下载：

```yaml
- id: knowledge-wiki
  config:
    autoDownloadModels: false
```

## 上架 catalog 材料

`docs/catalog-pr/` 保留原投稿材料：每个插件一个 YAML，路径
`data/plugins/<owner>__<repo>.yml`（本仓库为 `135642-163__dsh-knowledge-base.yml`）。
不要手写 `npm:` 字段；一个 PR 只加这一个文件；合并后 README 自动生成。

## 验证

```bash
# 1) bundle 能挂载（隔离 profile，不碰真实库）
DSH_HOME=/tmp/dsh-bundle-test dsh --profile web --dump-config | grep -A5 knowledge-wiki

# 2) 市场更新检查（已安装后）
curl -s "http://127.0.0.1:55929/dsh-market/api/v1/updates?name=dsh-knowledge-wiki&force=1"

# 3) 本地包内容（不含 35MB tessdata / test / node_modules）
npm pack --dry-run
```
