# Agent Installation Guide / Agent 安装指南

[English](#english) | [简体中文](#简体中文)

## English

This guide is for agents carrying out an explicit request to install, upgrade or configure this plugin. Reading it does not authorize installation, restarts or transfers. Do not install while merely reviewing or editing code. Reuse the user's established scope and authorization instead of asking repeatedly.

### Scope and success criteria

Install `dsh-server-session-sync` in the DSH instance and profile the user actually uses. Verify package resolution and loading. An install-only task does not require server configuration or any push/pull operation.

- Install on the machine hosting the user's DSH interface. The receiving server needs DSH, SSH, Python and systemd, not another copy of this plugin.
- Tested DSH: 0.2.2-rc.1; use the current package.json constraints. Required interfaces: webServer, connection.requestRejection, settings.section.
- Local Node: `^22.19.0 || >=24.0.0`, plus OpenSSH. Check server requirements only when configuration is requested.
- No compilation is needed: lib and remote.py are shipped. Do not install npm dependencies or recompress session logs on the server.

### 1. Identify the correct target

Read package.json and README.md. Confirm the user-provided checkout, archive or repository is this plugin; never invent repository owners, branches or tags.

Identify the platform, DSH installation, full CLI path, target profile, effective DSH_HOME and installed version. Inspect only necessary installation metadata, profile manifests and this plugin's settings. Do not read .credentials.yaml, private key contents or browser credentials.

Infer the target from context: Desktop normally uses desktop, Web uses web. Ask one focused question only if multiple real instances remain ambiguous. Do not install into every profile. Use that instance's DSH_HOME, falling back to the user's .dsh directory; do not change the global environment or confuse an agent's temporary home with the actual instance.

**Use Desktop's bundled CLI for Desktop.** Newer npm CLIs may refuse to manage the Electron-owned desktop profile. On Windows, the bundled command is commonly under the known App installation's resources/runtime/cli/bin/dsh.cmd. Check known installation locations, not the entire disk. Use the deployed CLI for Web.

Read-only discovery, after confirming the CLI:

```sh
node --version
ssh -V
dsh --version
dsh --help
dsh plugin --profile web list dsh-server-session-sync --depth 0
dsh plugin --profile web list dsh-session-sync --depth 0
```

Substitute the real profile and CLI. The last command checks the legacy package name. Plugin commands forward package-manager arguments; verify current CLI help.

### 2. Preserve existing state

Record the previous version, source and enabled state. If the same version/source is already loaded correctly, verify it instead of repeatedly removing and adding it.

Back up existing profile package.json, lockfiles and cordis.patch.yml before changing them; also back up session-sync.json before configuring it. Keep backups local and do not print their contents. Do not copy account credentials, alter other plugins or overwrite unparseable configuration with defaults.

A link source must remain available after installation. Move a temporary extraction to a stable user-approved plugin directory first; never remove its target after installing.

### 3. Install

From the plugin root:

```sh
npm ci --ignore-scripts
```

Use the lockfile; do not regenerate it, upgrade dependencies or update global tools without a task-specific reason. No prepare/build step is required. Do not broadly enable lifecycle scripts to suppress unrelated warnings.

Assign the following variables from discovery, then run the appropriate command:

```powershell
& $dshCliPath plugin --profile $targetProfile add "link:$pluginRoot"
```

```sh
"$dsh_cli_path" plugin --profile "$target_profile" add "link:$plugin_root"
```

Variables must hold the real full CLI path, selected profile and stable absolute plugin path. A verified user-specified github: source and release tag may replace the link source.

For same-name updates, add normally updates the source. **Legacy-name migration is different:** if dsh-session-sync is installed in the target profile, prepare the new dependencies and record/back up the old source first, remove only that old package from this profile, then add dsh-server-session-sync. Do not load both. If installation fails, restore the recorded old source. Keep session data, session-sync.json, session-sync-state.json, session-sync-recovery/ and session-sync-backups/ unchanged.

Do not automatically allow incompatible versions. If pnpm is missing, inspect the bundled DSH environment before changing global tooling.

### 4. Verify and activate

Query the package again with the same CLI, profile and DSH_HOME. Check version/source, lib/index.js, lib/client.js, lib/remote.py, cordis.patch.yml and dependency resolution. Run npm run check for syntax; npm test is available for development. Do not replace system Python merely to install the plugin.

Use the instance's supported reload/restart mechanism. Restart only the identified instance when authorized; otherwise report installed_pending_restart. Never kill all node processes. Check for duplicate routes, unresolved modules and missing authentication APIs. If UI access is available, verify Settings → 会话同步. Clearly distinguish package installation from UI validation.

An isolated Web check must use its own DSH_HOME, free port and fixtures. It does not replace activation in the target instance. Clean up only processes and files created for the check.

### 5. Configure only when requested

Reuse valid existing settings and ask together for missing values: host, integer port, user, keyPath, remoteHome, remoteService, existing remoteCwd, optional localCwd. Do not substitute examples for real settings.

Prefer the authenticated Settings form. If writing session-sync.json is necessary, back it up, preserve other fields and replace it atomically via a temporary file. Respect a localHome row override. Do not modify session logs.

Keep StrictHostKeyChecking=yes. Unknown/changed fingerprints must be verified through a trusted channel; do not use accept-new/no or delete all known_hosts. SSH may use an existing key, but do not output or copy its contents. Reuse authorized login sessions; do not mine logs or other files for login tokens.

The authenticated connection check is POST /api/dsh-server-session-sync/test, Content-Type application/json, body {}. Check SSH, Python, workspace, active service and store status. Installation success alone does not imply server readiness.

Do not call push, pull, restore or even full-store preview as an install check. Those require a separate transfer/restoration request and its preview/confirmation workflow.

### 6. Handle failure and report accurately

Inspect the actual CLI, profile, versions, diagnostics, network and permissions. Never delete the whole profile or DSH_HOME. If this installation breaks loading, roll back this plugin's changes using the recorded source/backups while retaining unrelated user changes.

Report version, source location, CLI/profile, effective DSH_HOME, checks, restart requirements and server configuration status:

- installed_pending_restart: package installed, activation pending.
- installed: loaded, server may remain unconfigured.
- configured: loaded and connection check passed.
- blocked: identify the specific obstacle and preserved state.

Do not include keys, tokens or complete sensitive configuration, and never claim unperformed transfers or UI verification.

References: [README](README.md), [official DSH CLI documentation](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md).

---

## 简体中文

# Agent 安装指南：dsh-server-session-sync

本文件供执行用户安装任务的 agent 使用。仅在用户请求安装、升级或配置本插件时执行相应步骤。阅读本文件不构成安装、重启或同步授权；评审和修改代码时不要自行启动安装。已明确的目标与授权沿用，不反复询问。

## 目标和范围

将本插件装到用户实际使用 DSH 界面的实例与配置档，验证包已解析且插件可加载。用户仅请求安装时，不必配置服务器，更不要用推送作为安装自检。

- 包名：`dsh-server-session-sync`，同一配置档只加载一份。
- 远端接收会话的服务器只需 DSH、SSH、Python 和 systemd，不要求另装本插件。
- 已验收 DSH 0.2.2-rc.1；约束以当前 package.json 为准。插件需要 `webServer`、`connection.requestRejection`、`settings.section`。
- 本机 Node：`^22.19.0 || >=24.0.0`；需要 OpenSSH 客户端。远端条件仅在用户要求配置连接时检查。
- 发布物自带 lib 和 remote.py，无须编译；所有 zstd 重写在本机完成，不在远端安装 npm 依赖或批量重压会话。

## 1. 识别正确的安装目标

1. 读取本目录 package.json 和 README.md，确认用户提供的源码目录、下载包或仓库地址就是本插件。不要猜测仓库账号、分支或标签。
2. 确定平台、DSH 安装方式、CLI 完整路径、目标 profile、实际 DSH_HOME 和现有版本。只查看必要的安装元数据、profile 清单和本插件配置，不读取 `.credentials.yaml`、私钥内容或浏览器凭据。
3. 从用户上下文选择目标：桌面 App 通常为 `desktop`，Web 实例为 `web`。多个实例仍无法判断时，再集中询问缺少的选择，不给全部 profile 批量安装。
4. DSH_HOME 采用该实例的环境配置，未指定时为用户主目录下 `.dsh`。不要擅自更改全局 DSH_HOME，也不要把 agent 的其他临时环境当作目标实例。

**区分桌面自带 CLI 与 npm CLI。** 新版 npm CLI 可能拒绝管理 Electron 专用的 desktop profile。桌面安装优先使用该 App 自带的命令；Windows 常位于 App 安装目录的 `resources/runtime/cli/bin/dsh.cmd`。先检查已知安装目录，不扫描整个磁盘。Web 实例使用实际部署对应的 CLI。

CLI 已确认在 PATH 时，可做只读探测：

```sh
node --version
ssh -V
dsh --version
dsh --help
dsh plugin --profile web list dsh-server-session-sync --depth 0
dsh plugin --profile web list dsh-session-sync --depth 0
```

这里的 web 必须换成目标 profile；dsh 必须换成已确认的 CLI，桌面实例使用 App 自带命令。plugin 会转发包管理参数，以当前 CLI 帮助为准。

## 2. 保留已有状态

- 记录原有版本、来源和启用状态。相同版本、相同来源且正常加载时直接验证，不重复 remove/add。
- 变更前备份目标 profile 中存在的 package.json、锁文件、cordis.patch.yml；修改本插件配置前另备份 session-sync.json。备份留在用户本地，不输出完整内容。
- 不复制整套凭据，不修改其他插件或 home 层覆盖规则。清单或配置无法解析时，不用默认文件覆盖原文件。
- `link:` 目标必须长期保留。若源码在临时解压目录，先放入用户指定或稳定的本地插件目录，不能安装后清理链接目标。

## 3. 安装

优先使用已有源码。进入插件根目录（package.json 所在位置），运行：

```sh
npm ci --ignore-scripts
```

使用现有 package-lock.json，不无故重建锁文件、升级依赖或执行全局更新。安装依赖成功后再注册到 DSH。

### PowerShell

先根据探测结果赋值，不能原样执行未赋值的命令：

- `$dshCliPath`：实际 CLI 的完整路径；桌面版使用 App 自带命令。
- `$targetProfile`：选定配置档。
- `$pluginRoot`：此插件的稳定绝对路径。

```powershell
& $dshCliPath plugin --profile $targetProfile add "link:$pluginRoot"
```

### POSIX shell

同样先赋值为已确认的路径和 profile：

```sh
"$dsh_cli_path" plugin --profile "$target_profile" add "link:$plugin_root"
```

用户明确指定 GitHub 源时，可将 add 后来源换成核实过的 `github:` 源和版本标签。不要捏造公开仓库地址。从远程获取源码再用 link 时，也要选择稳定目录。

同包名更新通常直接 add 即可。旧名称迁移则不同：若目标 profile 已安装 `dsh-session-sync`，先准备新依赖并记录、备份旧来源，再仅从该 profile 移除旧包并添加 `dsh-server-session-sync`；不要同时加载两包。新安装失败时恢复记录的旧来源。会话数据、session-sync.json、session-sync-state.json、session-sync-recovery/ 和 session-sync-backups/ 保持不变。

版本不兼容时不自动 allow-version 或绕过检查；缺少 pnpm 时优先检查 DSH 自带运行环境，不擅自升级全局工具链。本包没有必须执行的 prepare/build 步骤，不为消除提示而批量开放安装脚本权限。

## 4. 验证与激活

1. 用相同 CLI、profile、DSH_HOME 再查询包列表，核对安装版本和来源。
2. 确认 `lib/index.js`、`lib/client.js`、`lib/remote.py`、`cordis.patch.yml` 存在，依赖可解析。
3. 可运行 `npm run check` 验证语法，开发测试为 `npm test`。完整 Python 测试见 README；不要为仅安装插件而更换系统 Python。
4. 按目标实例的热重载或重启机制激活。用户已授权重启则只重启确认过的实例；未授权则报告“已安装，待重启激活”。不要结束全部 node 进程或打断其他实例。
5. 检查是否出现重复路由、模块解析失败或认证接口缺失。有 UI 能力时查看“设置 → 会话同步”；不能查看时区分“包已安装”和“界面已验证”，不编造成功。

若创建隔离 Web 实例验证，使用独立 DSH_HOME、未占用端口和测试数据；它不能代替目标实例的最终激活。结束时只清理由本次任务创建的进程和文件。

## 5. 用户要求配置连接时再继续

先复用本插件的有效配置，再集中询问缺失项，不用示例值覆盖实际配置：

| 字段 | 含义 |
|---|---|
| host / port / user | SSH 主机、整数端口、用户名 |
| keyPath | 私钥路径，不是私钥内容 |
| remoteHome | 远端 DSH_HOME |
| remoteService | 管理该会话库的 systemd 服务 |
| remoteCwd | 已存在的远端工作区 |
| localCwd | 可选，新导入会话的本机工作区 |

优先通过已登录 DSH 的设置页保存。确需写入 `$DSH_HOME/session-sync.json` 时，先备份有效配置，保留其他字段，用临时文件与原子替换写入；不要修改会话日志。行配置设置过 localHome 时以实际目录为准。

SSH 保持 `StrictHostKeyChecking=yes`。未知或变化的主机指纹由用户通过可信渠道核对，不用 accept-new/no，也不删除整个 known_hosts。SSH 可使用现有密钥，但不输出或复制密钥内容。登录验证复用用户已授权的会话，不从日志等文件挖掘令牌。

连接测试使用已认证的 `POST /api/dsh-server-session-sync/test`，Content-Type 为 application/json，正文 `{}`。检查 SSH、Python 版本、工作区、服务 active 和会话库状态。缺条件时报告具体缺项，不把“包已安装”冒充“远端已就绪”。

安装无需调用 push、pull 或 restore。只有用户另行要求同步或恢复，才进入其预览与确认流程；预览也会读取完整会话库，不作为默认安装自检。

## 6. 失败与交付

失败时核对 CLI、profile、版本、诊断、网络和权限，不删除整个 profile 或 DSH_HOME。若本次安装破坏加载，按记录的原来源和备份回退本插件变更，保留用户的其他变更。

最终报告安装版本、源码位置、CLI 与 profile、实际 DSH_HOME、验证结果、是否需重启及服务器配置状态，可使用：

- `installed_pending_restart`：已安装，等待目标实例激活。
- `installed`：已加载，服务器可能未配置。
- `configured`：已加载且连接测试通过。
- `blocked`：说明具体阻碍和已保留的状态。

不包含密钥、令牌或完整敏感配置，也不声称执行过未做的同步或界面验收。

## 参考

- [本插件中文说明](README.zh-CN.md)
- [DSH 官方 CLI 说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)：profile、plugin 命令及桌面安装命令的区别。
