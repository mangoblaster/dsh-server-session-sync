# Validation / 验收记录 — 0.2.0

[English](#english) | [简体中文](#简体中文)

## English

Date: 2026-11-11 (Hong Kong time).

The renamed release keeps the previously validated transfer algorithm and data formats. Package/plugin names and API namespaces were updated consistently; documentation is bilingual and settings copy was simplified. Existing settings, recovery and backup directory names remain compatible.

### Automated checks

22 JavaScript and 13 Python tests cover frame integrity, size limits, authentication rejection, configuration, deduplication, mixed-format stores, conflict staging, offline recovery, hostile archives, service-failure rollback and Python/Node snapshot interoperability. All 35 tests, syntax checks and packaging checks passed again for the renamed release. Package, host, client, bundle and API identifiers were also checked for consistency. CI covers additional platform combinations.

### Real-server acceptance before the identity rename

Environment: Windows 11 / Node 24.12.0 / DSH 0.2.2-rc.1, with Linux/systemd and Python 3.14.4 on the server.

| Check | Result |
|---|---|
| Read-only mixed local store | 80 healthy v4 logs, 11 legacy-only directories skipped, 8 v4 directories with legacy residues |
| SSH/environment probe | Passed |
| Push | Remote logs and index increased from 79 to 80; service active |
| DSH authentication/list API | Unauthenticated request: 401; authenticated request listed 80 sessions |
| Pull | 79 unchanged, 1 staged update; existing local bytes untouched |
| Backup restoration | Original 79 logs and index restored, service active, all tracked log hashes matched the pre-test state |

DSH automatically appended one session/end-seed event during testing. The plugin correctly treated it as a remote update rather than suppressing the difference. The original remote store was restored and backups retained.

### UI acceptance reported by the user and DeepSeek

- Installation/loading through the Web profile, with the required authentication interface available.
- Settings form population and successful connection checks.
- Transfer preview stages, received-byte progress, differences, legacy-skip notes, confirmation and cancellation.
- Remote session list, opening a session and rendering Markdown, lists, inline code and fenced code blocks.

The preview expires after generation; skipped details use native details/summary elements. UI acceptance did not repeat destructive transfers, which were covered by backend acceptance. It does not establish compatibility with every Electron version. The identity rename itself has automated checks; the earlier real-server/UI results must not be presented as a fresh live deployment of the new package name.

No real connection parameters, tokens, conversation contents or unredacted screenshots are included in this public record.

## 简体中文

日期：2026-11-11（香港时间）。

同步算法和数据格式沿用已验收版本；本次统一改包名、插件注册标识和 API 命名空间，并补充双语文档。配置、恢复和备份目录名称兼容旧版。

## 自动化

JavaScript 22 项、Python 13 项，合计 35 项测试；覆盖压缩帧完整性、边界限制、认证拒绝、配置、去重、混合格式库、冲突暂存、离线恢复、恶意归档、服务失败回滚和跨运行时快照互通。

旧标识版本已完成独立安装及真机验收。本次更名后，35 项测试、语法和打包检查再次通过，包名、宿主、客户端、bundle 和 API 标识一致性检查通过，依赖审计未报告漏洞。不将旧版真机验收冒充新标识已重新部署；其他平台组合以后续仓库 CI 为准。

## 真机后端

环境：Windows 11 / Node 24.12.0 / DSH 0.2.2-rc.1；远端 Linux/systemd / Python 3.14.4。

| 场景 | 结果 |
|---|---|
| 本机混合库只读扫描 | 80 个健康 v4，跳过 11 个仅旧格式目录；8 个目录有旧版本残留 |
| SSH 与远端环境探测 | 通过 |
| 上传 | 远端由 79 个会话变为 80，索引 80，服务 active |
| 真实 DSH 登录与列表 API | 未认证 401；认证成功后可读取 80 个会话 |
| 拉取 | 79 个不变，1 个更新暂存；本机原有会话字节不变 |
| 备份恢复 | 恢复至原先 79 个会话和索引，服务 active，所有受追踪日志摘要与测试前一致 |

测试中 DSH 自动补写了一条 session/end-seed，插件按真实内容变化将它暂存，没有忽略或覆盖本机版本。测试完成后恢复远端原库，并保留备份。

## 界面补测

由用户与 DeepSeek 在真实 Chromium 中完成并报告通过：

- web profile 安装和加载插件，无认证接口缺失错误。
- 设置表单正确回填，连接测试成功并显示 Python、服务与工作区状态。
- 上传预览显示读取、下载字节进度、差异、旧格式跳过提示、确认与取消入口。
- 真实远端页面列出会话，可打开会话，Markdown、列表、内联代码及代码块正常渲染。

预览有效期从生成完成时开始。跳过目录明细使用原生 details/summary，可展开查看。

界面补测没有再次执行上传替换；数据写入行为由上述真机后端验收覆盖。现有实机设置页记录来自 web profile，未将其表述为所有 Electron 版本的独立验证。

此公开记录不附真实连接参数、会话内容、访问令牌或未脱敏截图。
