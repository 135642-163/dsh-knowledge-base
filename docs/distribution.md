# 分发与市场更新（v0.6.0）

当前策略：**GitHub bundle**，暂不发布 npm。

## 为什么不用 npm

npm 上的 `dsh-knowledge-base` 已被另一位作者（`htcqp802`，0.1.5）占用，
本插件不能再用这个名字发布。要上 npm 必须改名/加 scope（如
`@135642-163/dsh-knowledge-base`），会同时影响 `cordis.patch.yml` 的 `name`、
安装脚本和已有用户的软链，因此本轮先走 GitHub 安装 + 市场 catalog；
等包名/scope 确定后再单独做 npm 发布。

## 安装（新用户）

插件已声明 `dsh.bundle.patch`，安装后会由 `cordis.patch.yml` 自动挂载，
不再需要手工编辑 profile patch：

```bash
dsh plugin --profile web add github:135642-163/dsh-knowledge-base
```

安装后重启 `dsh web`（或让 HMR 应用），新会话执行 `kb_list` 验证。

市场（dsh-market）上架后同样可以一键安装；更新检查对 GitHub 安装比较
**已安装 commit 与远端默认分支 HEAD**。因此发布新版本只需要：

```bash
git push origin main
```

不需要打 tag 或发 GitHub Release（对 GitHub 安装而言）。

## 已有脚本安装用户迁移

当前用 `install-to-machine.sh` 的用户，profile 里已有一条：

```yaml
- insert:
    - id: knowledge-base
      name: dsh-knowledge-base
```

如果再用市场/CLI 安装 bundle，会出现**同一个 id 被插入两次**，启动时报
duplicate loader id。迁移步骤：

1. 备份 `~/.dsh/knowledge`；
2. 从 `~/.dsh/profiles/web/cordis.patch.yml` 删除上面这段 `insert`（保留其他行）；
3. 删除软链 `~/.dsh/profiles/node_modules/dsh-knowledge-base`；
4. 执行 `dsh plugin --profile web add github:135642-163/dsh-knowledge-base`；
5. 重启 `dsh web`，`kb_list` 验证。

不迁移也可以继续使用脚本安装；只是市场不会跟踪更新。

## OCR 模型

`autoDownloadModels` 默认 `true`：市场/GitHub 安装没有预置
`data/tessdata` 时，首次走 tesseract 家族 OCR 会自动下载缺失模型到
`~/.dsh/tools/tessdata`（优先复用 langPath 中已有模型）。rapidocr 自带模型，
不会触发下载。

关闭自动下载：

```yaml
- id: knowledge-base
  config:
    autoDownloadModels: false
```

然后按 README「中文 OCR 模型数据」手动放置模型。下载失败会给出包含 URL 的明确错误。

## 上架 catalog

投稿材料在 `docs/catalog-pr/`：catalog 每个插件一个 YAML 文件，路径为
`data/plugins/<owner>__<repo>.yml`。本仓库对应：

```
data/plugins/135642-163__dsh-knowledge-base.yml
```

关键点：

- `name` 是 `135642-163/dsh-knowledge-base`（owner/repo，列表链接文字），
  不是 npm 包名；
- **不要写 `npm:` 字段**：catalog 会从 registry 自动采集 npm 映射，手写会被
  校验拒绝；本仓库因名称冲突本就不发 npm；
- 不需要 `tarball:`：本仓库无 build scripts，可从源码安装；
- `category` 用 `memory`；`description.en` 一行、以句号结尾，含 `: ` 时加引号；
- 一个 PR 只加这一个文件；**不要手工改 README.md / README.zh.md**（合并后自动生成）；
- PR 标题/正文模板见 `docs/catalog-pr/PR.md`，提交步骤见 `docs/catalog-pr/README.md`。

合并后市场重建，GitHub 安装按 commit 比对更新；发布新版本仍只需
`git push origin main`。

## 验证

```bash
# 1) bundle 能挂载（隔离 profile，不碰真实库）
DSH_HOME=/tmp/dsh-bundle-test dsh --profile web --dump-config | grep -A5 knowledge-base

# 2) 市场更新检查（已安装后）
curl -s "http://127.0.0.1:55929/dsh-market/api/v1/updates?name=dsh-knowledge-base&force=1"

# 3) 本地包内容（不含 35MB tessdata / test / node_modules）
npm pack --dry-run
```
