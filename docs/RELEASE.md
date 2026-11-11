# Release / 发布 0.2.0

[English](#english) | [简体中文](#简体中文)

## English

This directory is the repository root. Upload its contents, including .github/, .gitignore and .gitattributes, to a repository named **dsh-server-session-sync** without adding another directory level.

1. Create an empty repository and upload/push these files.
2. Wait for the Checks workflow to pass.
3. Create tag v0.2.0 and use the corresponding CHANGELOG.md section as release notes.
4. Suggested topics: dsh-plugin, deepseek-harness, session-sync, ssh.

If a repository was already created under the old name, rename it in GitHub Settings → Repository name → Rename. Replace its files with this renamed release, rather than only changing the repository title: the package name and plugin/API identifiers changed too.

Repository, bugs and homepage metadata are optional and have been left unset until the final public URL is known. Runtime code, tests, lockfile, MIT license and CI are included. Development history, node_modules, caches, real sessions, private configuration, live-test drivers and private screenshots are excluded.

Local checks:

```sh
npm ci --ignore-scripts
npm run check
npm test
python -B -m unittest discover -s test -p '*_test.py' -v
npm pack --dry-run
```

Use py -3.12 on Windows if appropriate. For migration from the installed dsh-session-sync package, follow README.md or AGENTS.md; do not load both packages or delete existing session/configuration/backup data.

Release scope remains v4 logs and the documented Linux/systemd server. Push replaces the remote v4 store; existing local-session updates require offline recovery. Do not advertise automatic bidirectional event merging or universal DSH compatibility.

## 简体中文

本目录就是仓库根目录，可直接将其中所有文件上传到新的 GitHub 仓库，包括 `.github/`、`.gitignore` 和 `.gitattributes`。

仓库名称建议使用 **dsh-server-session-sync**。若旧名称仓库已创建，可在 GitHub Settings → Repository name → Rename 改名；还需用本目录内容更新仓库文件，不能只改仓库标题而保留旧包标识。

## GitHub

1. 新建空仓库，将本目录内容放在仓库根目录，不要再包一层目录。
2. 推送后检查 GitHub Actions 的 Checks 是否通过。
3. 创建标签 `v0.2.0`，以 CHANGELOG.md 的 0.2.0 内容作为 Release 说明。
4. 可添加仓库 topic：`dsh-plugin`、`deepseek-harness`、`session-sync`。

仓库账号和地址未知，因此 package.json 没有填写 repository、bugs 或 homepage。这些是可选元数据，不影响 GitHub 源安装或本地安装；确定仓库地址后可补充。

运行代码、测试、锁定依赖清单、MIT 许可和自动检查已包含。未包含开发机器的 .git 历史、node_modules、缓存、实际会话、连接配置、测试驱动脚本或私人截图。

## 本机检查

```sh
npm ci --ignore-scripts
npm run check
npm test
python -B -m unittest discover -s test -p '*_test.py' -v
npm pack --dry-run
```

Windows Python 命令可使用 `py -3.12`。首次安装后重启对应的 DSH 配置档。原版与新版不能在同一配置档同时加载。

## 发布边界

只支持 v4 日志及文档列明的 Linux/systemd 远端。上传仍然是全量替换；已有本机会话的远端更新仍需离线应用。不要将 0.2.0 的发布表述为自动双向合并或所有 DSH 版本兼容。
