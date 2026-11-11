# Changelog

[English](#english) | [简体中文](#简体中文)

## English

### 0.2.0 — 2026-11-11

- Rename the project and package to dsh-server-session-sync to emphasize computer-to-server session synchronization; update plugin identifiers and API routes together.
- Provide English/Chinese documentation and a bilingual AGENTS.md installation guide, including Desktop-bundled versus npm CLI selection.
- Simplify settings copy and describe the operation as pushing to a server.
- Add push, pull and restore previews, download progress and explicit confirmation.
- Apply DSH Connection authentication and request-origin checks to every route; validate connection settings.
- Enforce SSH host fingerprint verification and safely quote remote arguments; explain missing Python and host key errors.
- Receive and validate uploads before stopping the service; back up before switching and attempt rollback on ordinary failures.
- Add backup listing/restoration, staged local updates and offline recovery commands.
- Fix truncated-log false positives, lost tails, duplicate import counts and false restart-success messages.
- Correct Chinese workspace encoding and DSH_HOME handling. Preserve and report legacy logs without automatic migration.
- Include 35 automated tests, Windows/Linux CI, real-server backend validation and user-reported UI acceptance.

### 0.1.0

- Initial session push/pull and settings form, previously named dsh-session-sync.

## 简体中文

## 0.2.0 — 2026-11-11

- 项目及包名改为 dsh-server-session-sync，突出电脑与服务器之间的会话同步；注册标识和 API 路径同步更新。
- 提供中英文说明文档，以及同一文件内双语的 AGENTS.md。
- 精简设置页说明，统一“推送到服务器”的描述，移除底部带宽耗时段落。
- 提供 AGENTS.md 自主安装指南，区分桌面自带 CLI 与 npm CLI。
- 新增上传、拉取和恢复前预览、下载进度及明确确认。
- 所有接口接入 DSH Connection 身份与来源校验，严格验证连接配置。
- SSH 使用严格主机指纹检查和安全传参；明确提示缺少 Python 或指纹验证失败。
- 上传先收齐并校验，再停止服务、备份、替换和启动；普通错误尝试回滚。
- 新增远端备份列表、恢复，以及本机远端更新暂存和离线应用命令。
- 修复截断日志误判健康、尾部丢失、重复导入计数和服务重启失败仍提示成功。
- 正确处理中文工作区编码与 DSH_HOME。
- 混合库中已知旧格式跳过并报告，旧日志保留，不自动迁移。
- 增加 35 项自动化测试及 Windows/Linux 检查流程；完成真机后端和用户补充的 UI 验收。

## 0.1.0

- 初始版本，提供会话上传、拉取和设置表单。
