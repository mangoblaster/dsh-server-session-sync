# dsh-server-session-sync

[English](README.md) | **简体中文**

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 添加「设置 → 会话同步」，通过 SSH 在电脑和远端 DSH 之间传输会话。

**当前版本：0.2.0。** 上传、拉取、备份恢复及界面交互已在 DSH 0.2.2-rc.1 上验收，见 [验收记录](docs/VALIDATION.md)。

## 功能

- 上传和拉取前显示新增、变化、不变及移除的会话列表。
- 上传先收齐并校验，再停止远端服务、备份、替换和启动；普通执行失败会尝试回滚。
- 拉取新会话直接导入；已有会话的更新或冲突暂存，退出本机 DSH 后再应用。
- 设置页支持连接测试、下载进度、跳过明细和远端备份恢复。
- 严格检查 zstd 帧、校验和、UTF-8 和 JSON；已知旧格式保留并报告，不静默丢弃。

**上传是全量替换。** 远端独有的 v4 会话会移入备份。不要两端同时写入同一会话。

## 环境要求

| 本机 | 远端 |
|---|---|
| Node `^22.19.0` 或 `>=24`、OpenSSH 客户端 | Linux、Python 3.8+、systemd、DSH |
| DSH `>=0.2.2-rc.1`，提供 Connection 认证接口 | SSH 用户可读写目标 DSH_HOME 并管理指定服务 |
| `session.v4.jsonl.zstd` 格式 | 目标工作区已存在，该会话库仅由配置的服务写入 |

已验收：Windows 11 / Node 24.12.0 / DSH 0.2.2-rc.1，以及 Linux/systemd 远端 / Python 3.14.4。其他版本仍受上述接口和文件格式要求约束。

本机不需要系统 tar、rsync 或 zstd 命令。远端 Python 只做文件操作和 SHA-256 校验，zstd 重写留在本机完成。

## 安装

Agent 请先阅读 [自主安装指南](AGENTS.md)，其中包含目标实例识别、桌面 CLI 选择、安装验证和配置步骤。

下载或克隆本仓库，进入包含 package.json 的目录，执行：

```sh
npm ci --ignore-scripts
```

PowerShell：

```powershell
dsh plugin --profile desktop add "link:$((Get-Location).Path)"
```

Linux / macOS shell：

```sh
dsh plugin --profile desktop add "link:$(pwd)"
```

Web 配置档将 `desktop` 改为 `web`。装好后重启对应 DSH 实例，打开「设置 → 会话同步」。同一配置档只加载一份本插件。

桌面版优先使用 App 自带的 DSH CLI；新版 npm CLI 可能不允许管理 desktop profile。详见 [Agent 安装指南](AGENTS.md)。

DSH 也支持 GitHub 插件源：在 `dsh plugin --profile desktop add` 后使用本仓库的 `github:` 源和版本标签。具体源地址取决于你发布仓库的账号及名称。

### 从旧名称迁移

旧包名为 `dsh-session-sync`，新包名为 **`dsh-server-session-sync`**；插件注册标识和接口前缀也已更新为 `/api/dsh-server-session-sync/`。同一配置档不要同时加载新旧两包。

先准备好新源码和依赖，记录并备份目标 profile 的旧安装来源及配置，再用该实例对应的 CLI 移除旧包并添加新来源。安装失败时按记录回退旧来源。只修改 GitHub 仓库名不会自动更新已安装插件。

会话数据以及 `session-sync.json`、`session-sync-state.json`、`session-sync-recovery/`、`session-sync-backups/` 的名称和格式不变，请保留。

## 首次连接与配置

1. 先在终端 SSH 到目标服务器，通过可信渠道核对主机指纹并加入 known_hosts，然后退出。
2. 在设置页填写连接信息并保存，再点击「测试连接」。
3. 暂停两端对话后，再预览同步。

SSH 示例，需替换为你的连接参数：

```sh
ssh -i /absolute/path/to/key -p 22 user@example.invalid
```

| 字段 | 说明 |
|---|---|
| 服务器地址 | IP 或域名，不带用户名、端口或 URL 前缀 |
| SSH 端口 / 用户名 | 默认 22 / root；可用具有相应权限的专用用户 |
| 私钥路径 | 本机绝对路径，支持 `~/`；不保存私钥内容 |
| 远端 DSH 目录 | 如 `/home/user/.dsh`，使用规范绝对路径，不接受符号链接或宽泛根目录 |
| 远端工作区目录 | 必须存在，上传会话统一归属这里 |
| 远端服务名 | 管理该会话库唯一写入进程的 systemd 单元，如 `dsh-web` |
| 拉取到的工作区 | 新导入会话归属的本机目录；留空使用最近有效工作区。已有会话更新保留原本机归属 |

配置写入 `$DSH_HOME/session-sync.json`，未设置 DSH_HOME 时使用 `~/.dsh`；Cordis 行配置中的 `localHome` 可覆盖本机目录。

接口使用 DSH Connection 的登录、Host 和 Origin 校验。SSH 使用 `StrictHostKeyChecking=yes`，不会自动信任新主机；不支持交互式密码或私钥口令输入。

## 上传

点击「↑ 预览上传」，读取并校验两端快照后显示差异。预览**完成后**开始计算 10 分钟有效期。

确认替换后，远端先收齐并检查载荷，再停止服务、检查预览是否仍有效、备份旧库、替换并启动。配置或会话在预览后变化时须重新预览。

备份保存在远端 `DSH_HOME/session-sync-backups/`，不自动删除。服务启动失败等普通错误会尝试恢复旧库及索引；回滚自身失败会报告备份位置。

预览需要下载一次远端快照。带宽较低时可能需要几分钟，界面显示已接收的 MiB 数。

## 拉取与续聊回传

点击「↓ 预览拉取」并确认：

- 本机没有的 id：直接导入新会话。
- 内容相同：跳过，比较时排除机器相关的 cwd。
- 已有 id 且远端有变化：保存到本机 `DSH_HOME/session-sync-recovery/<批次>/`，不覆盖正在运行的会话。
- 本机也发生变化或没有可信基线：标记为冲突。
- 同 id 在本机仅有旧格式：保留旧文件并明确跳过，不在线迁移。

界面会给出恢复目录。先查看清单：

```sh
node scripts/apply-recovery.mjs "/absolute/path/to/recovery-batch"
```

完全退出本机所有 DSH 进程后，应用更新：

```sh
node scripts/apply-recovery.mjs "/absolute/path/to/recovery-batch" --apply --offline
```

`--offline` 表示你确认 DSH 已退出，工具无法自动证明这一点。应用前核对指纹、备份全部待替换文件，再逐个原子替换。备份保存在批次内的 `before-apply-*`，附有文件对应清单。

冲突默认拒绝应用。人工检查后，若明确选择远端版本，可添加 `--accept-conflicts`；本机版本仍留在备份中。不做事件级自动合并。

续聊流程：电脑上传 → 远端续聊 → 电脑拉取暂存 → 退出电脑 DSH → 应用更新 → 重新启动 DSH。

## 恢复远端备份

在设置中「读取备份列表」，选中备份并预览恢复。确认后会备份当前库，再恢复选定库并启动服务。选定备份不会被消耗。

恢复预览只读取摘要，不下载整库，也不依赖本机会话库健康。

## 限制与故障排查

- 只传 v4 会话日志，不传项目代码、附件、凭据或完整 DSH 设置。
- v0–v3 日志和无 v4 目录会保留、跳过并列明；v4 旁边的旧版本残留不阻断。不会自动迁移或删除旧日志。
- 上传保留远端仅旧格式的目录；若同 id 已有新的 v4 载荷，旧目录保留在替换前备份中。
- 损坏 v4、未知未来版本、符号链接或存在歧义的重复 id 会中止操作。
- 单日志压缩上限 256 MiB、解压上限 512 MiB、整库及归档上限 2 GiB；大库会占用较多本机内存。
- SSH 操作上限 20 分钟、远端助手上限 18 分钟、连接测试上限 20 秒。
- 自动回滚针对可捕获的执行错误。断电、SIGKILL 或磁盘损坏仍可能需要人工恢复。

| 提示 | 处理 |
|---|---|
| Host key verification failed | 手动 SSH，核对指纹和 known_hosts，不要跳过检查 |
| 远端缺少 python3 | 安装 Python 3.8+ |
| 工作区不存在 | 创建配置的目录或修改配置 |
| 预览后会话变化 | 暂停对话，重新预览 |
| 本机同 id 在多个目录 | 先备份并排查重复副本，不按修改时间猜测胜者 |
| 拉取后有更新暂存 | 使用上面的离线恢复流程 |

## 开发与检查

```sh
npm ci --ignore-scripts
npm run check
npm test
python -B -m unittest discover -s test -p '*_test.py' -v
node scripts/verify-frames.mjs /absolute/path/to/.dsh/sessions
```

Windows 可将 Python 命令换为 `py -3.12 -B -m unittest discover -s test -p '*_test.py' -v`。

自检支持 sessions 根目录或单个 v4 日志：损坏返回 1，无可处理文件返回 2。自动化测试只使用临时合成数据及模拟服务，不连接服务器。

GitHub Actions 覆盖 Windows/Linux、Node 22/24，以及 Python 事务测试。参阅 [更新记录](CHANGELOG.md) 和 [发布说明](docs/RELEASE.md)。

## 许可

MIT。保留原有贡献与许可声明。
