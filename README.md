# dsh-server-session-sync

**English** | [简体中文](README.zh-CN.md)

Sync [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) sessions between your computer and your server over SSH.

**Version 0.2.0.** Includes transfer previews, backups, rollback and offline recovery of remote updates. Validated with DSH 0.2.2-rc.1; see [validation notes](docs/VALIDATION.md).

## Features

- Preview new, changed, unchanged and removed sessions before transferring.
- Push only switches the remote store after receiving and verifying the complete payload.
- Back up the remote store before replacement; attempt rollback on ordinary execution failures.
- Pull imports new sessions immediately and stages updates to existing sessions for offline recovery.
- Connection checks, download progress, skipped-session details and remote backup restoration in Settings.
- Strict zstd frame, checksum, UTF-8 and JSON validation. Known legacy logs are preserved and reported.

**Push replaces the remote v4 session store.** Remote-only v4 sessions move into a backup. Do not edit the same session on both machines at once. This is not automatic event-level merging.

## Requirements

| Local machine | Server |
|---|---|
| Node `^22.19.0` or `>=24`, OpenSSH client | Linux, Python 3.8+, systemd and DSH |
| DSH `>=0.2.2-rc.1` with the Connection authentication API | SSH account able to manage the target DSH store and service |
| `session.v4.jsonl.zstd` logs | Existing workspace directory; the configured service is the store's only writer |

Tested: Windows 11 / Node 24.12.0 / DSH 0.2.2-rc.1, with a Linux/systemd server using Python 3.14.4. Other versions must provide the same interfaces and log format.

Local tar, rsync and zstd executables are not required. Zstd rewriting happens locally; server-side Python handles files and SHA-256 checks.

## Installation

Agents should read the bilingual [installation guide](AGENTS.md) first. It covers CLI selection, profile discovery, installation, verification and rollback.

Download or clone this repository into a permanent directory and run from the directory containing package.json:

```sh
npm ci --ignore-scripts
```

PowerShell:

```powershell
dsh plugin --profile desktop add "link:$((Get-Location).Path)"
```

POSIX shell:

```sh
dsh plugin --profile desktop add "link:$(pwd)"
```

Use `web` instead of `desktop` for a Web profile. For Desktop, use the CLI bundled with that Desktop installation: newer npm CLIs may refuse to manage the Electron-owned profile. Restart the corresponding DSH instance and open **Settings → 会话同步** (Session Sync).

Keep the linked source directory in place. Use only one version of the plugin per profile. DSH also accepts a verified `github:` source and release tag; the exact source depends on the published repository URL.

### Moving from the previous package name

The previous package was named `dsh-session-sync`. This release uses **`dsh-server-session-sync`**, including its plugin identifiers and `/api/dsh-server-session-sync/` routes. Do not load both packages in one profile.

Prepare the new source and dependencies first. Record and back up the selected profile's existing plugin source and configuration. Then, using the correct CLI for that instance, remove `dsh-session-sync` from that profile and add the new source. Restore the recorded old source if installation fails.

Keep session data, `session-sync.json`, `session-sync-state.json`, `session-sync-recovery/` and `session-sync-backups/`: their names and formats are unchanged. A repository rename alone does not update an installed package.

## First connection and configuration

1. SSH to the server manually, verify its fingerprint through a trusted channel, add it to known_hosts, then exit.
2. Fill in and save the plugin settings, then run **测试连接** (Test Connection).
3. Pause conversations on both machines before previewing a transfer.

Example; replace all connection parameters:

```sh
ssh -i /absolute/path/to/key -p 22 user@example.invalid
```

| Setting | Purpose |
|---|---|
| Server address | IP or hostname without a username, port or URL scheme |
| SSH port / user | Defaults to 22 / root; a suitably authorized dedicated account can be used |
| Private key path | Absolute local path; `~/` is supported. Key contents are not stored |
| Remote DSH directory | Canonical absolute DSH_HOME, e.g. `/home/user/.dsh`; no symlinks or broad root paths |
| Remote workspace | Must exist; pushed sessions are assigned here |
| Remote service | systemd unit managing the store's sole writer, e.g. `dsh-web` |
| Local workspace | Destination for new imports; blank uses a recent valid workspace. Updates retain their original local workspace |

Settings are stored in `$DSH_HOME/session-sync.json`, falling back to `~/.dsh`; the Cordis row's `localHome` overrides the local directory.

All routes use DSH Connection login, Host and Origin checks. SSH uses `StrictHostKeyChecking=yes`; it does not automatically trust new hosts or support interactive passwords/passphrases.

## Push to the server

Choose **↑ 预览上传** (Preview Push). The plugin validates snapshots from both machines and shows differences. The preview expires 10 minutes **after it finishes generating**.

After confirmation, the server receives and verifies the archive, stops the service, checks that the preview is still current, backs up the old store, switches stores and starts the service. Configuration or session changes require a new preview.

Backups live in the server's `DSH_HOME/session-sync-backups/` and are not automatically deleted. Ordinary replacement or startup errors trigger a rollback attempt; rollback failures report the backup location.

Preview downloads a remote snapshot, which may take minutes on a slow connection. The UI shows received MiB.

## Pull and continue a remote conversation locally

Choose **↓ 预览拉取** (Preview Pull), then confirm:

- New ID: import immediately.
- Same content: skip; comparison excludes machine-specific cwd.
- Existing ID with different remote content: stage in local `DSH_HOME/session-sync-recovery/<batch>/` without overwriting an active session.
- Local content also changed, or no trusted baseline exists: flag a conflict.
- Same ID exists locally only in a legacy format: preserve it and report the skipped import; do not migrate it online.

Inspect the recovery batch:

```sh
node scripts/apply-recovery.mjs "/absolute/path/to/recovery-batch"
```

Completely exit every local DSH process before applying:

```sh
node scripts/apply-recovery.mjs "/absolute/path/to/recovery-batch" --apply --offline
```

`--offline` is your confirmation that DSH has exited; the tool cannot prove it automatically. It rechecks fingerprints, backs up all target files and replaces them atomically one at a time. Backups and their mapping are stored in `before-apply-*` inside the batch.

Conflicts are refused by default. After inspection, add `--accept-conflicts` only if you explicitly choose the remote versions. Local versions remain in backup. Events are not merged automatically.

Workflow: push from the computer → continue on the server → pull and stage → exit local DSH → apply → reopen DSH.

## Restore a server backup

Load the backup list in Settings, select a backup and preview restoration. Confirmation backs up the current store, restores the selection and starts the service. The selected backup is retained.

Restore preview reads summaries only; it neither downloads the whole store nor depends on a healthy local session store.

## Limits and troubleshooting

- Only v4 session logs are transferred, not project files, attachments, credentials or complete DSH settings.
- Known v0–v3 logs and directories without v4 logs are preserved, skipped and listed. Old files beside v4 logs do not block the transfer. Legacy logs are not migrated or deleted automatically.
- Push preserves remote legacy-only directories. When incoming v4 data supersedes the same ID, the old directory remains in the pre-transfer backup.
- Corrupt v4 logs, unknown future generations, symlinks or ambiguous duplicate IDs stop the operation.
- Limits: 256 MiB per compressed log, 512 MiB decompressed per log, 2 GiB per store/archive. Large stores require substantial local memory.
- Time limits: 20 minutes for SSH, 18 minutes for the remote helper, 20 seconds for connection checks.
- Rollback covers catchable errors, not power loss, SIGKILL or disk failure; manual recovery can still be necessary.

| Message | Action |
|---|---|
| Host key verification failed | Verify the fingerprint and known_hosts manually; do not bypass checking |
| Missing python3 | Install Python 3.8+ on the server |
| Missing workspace | Create the configured directory or correct the settings |
| Sessions changed after preview | Pause conversations and preview again |
| Local duplicate ID | Back up and resolve the ambiguity; do not select a winner solely by mtime |
| Remote updates staged | Use offline recovery above |

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
python -B -m unittest discover -s test -p '*_test.py' -v
node scripts/verify-frames.mjs /absolute/path/to/.dsh/sessions
```

On Windows, use `py -3.12` instead of `python` if needed. The inspector accepts a sessions root or one v4 file: exit 1 means corruption, exit 2 means no supported files. Automated tests use temporary fixtures and simulated services, not a live server.

GitHub Actions covers Windows/Linux, Node 22/24 and Python transactions. See [changelog](CHANGELOG.md) and [release instructions](docs/RELEASE.md).

## License

MIT. Original attribution and license notices are retained.
