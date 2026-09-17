# 发布说明目录

该目录用于存放每个版本对应的 GitHub Release 说明文件。发布工作流 `.github/workflows/release.yml` 会读取这里的 Markdown 文件作为 Release 正文。

## 命名规则

- 文件名必须与发布 tag 完全一致，例如 `release-notes/v0.5.2.md`。
- 发布 tag 必须为 `v${package.json.version}`，且严格符合 `vX.X.X`。
- 文件扩展名统一使用 `.md`，内容不能为空。

## 发布流程

1. 更新 `package.json`（以及 `package-lock.json`）中的版本号。
2. 新增对应版本的发布说明文件，例如 `release-notes/v0.5.2.md`。
3. 创建并推送 `vX.X.X` 形状的 tag。
4. 工作流先校验 tag、包版本与发布说明文件，通过后再发布 npm 包，最后用该 Markdown 文件创建 GitHub Release。

## 注意事项

- tag 与 `package.json` 版本不一致时工作流直接失败。
- 对应发布说明文件缺失或为空时工作流直接失败，npm 包不会被发布。
- Release 正文不再使用 GitHub 自动生成的发行说明。
- 发布说明按 GitHub Release 的 Markdown 渲染，建议面向使用者说明功能变化，不要堆叠内部实现细节。
