# ChatGPT to Obsidian Archive Importer

**ChatGPT to Obsidian Archive Importer** is an Obsidian plugin that imports Codex Desktop, Codex CLI  and ChatGPT Desktop sessions from local JSONL files into Obsidian notes. It supports active and archived sessions.

Version 0.3.0 adds an **experimental ChatGPT Desktop cache index importer**. It scans the local Windows desktop cache for conversation IDs, titles, URLs, and cached update metadata, then creates index-only Obsidian notes. Because the desktop cache may be partial, these notes are marked `cache_only: true` and do not claim to contain full transcripts.


A desktop-only Obsidian community plugin that imports local Codex Desktop and Codex CLI conversations into durable Markdown notes.

## Why this plugin

Codex stores local conversation rollouts as JSON Lines files under the Codex data directory. Those files contain useful prompts and answers, but also internal events, duplicate message representations, tool payloads, large compaction records, and potentially sensitive command output. Codex Archive Importer converts the human-visible conversation into an Obsidian-friendly archive while applying conservative safety and performance controls.

## Features

- Imports active sessions from `~/.codex/sessions/**.jsonl`.
- Imports archived sessions from `~/.codex/archived_sessions/**.jsonl`.
- Uses `session_index.jsonl` only as an optional title and metadata hint.
- Converts user and Codex messages into Markdown with YAML frontmatter.
- Incrementally updates notes when the source JSONL changes.
- Uses Codex thread IDs to avoid duplicate notes.
- Detects moved sessions when a conversation is archived.
- Optionally includes tool calls and truncated tool outputs.
- Extracts referenced or modified file paths from patch/tool payloads.
- Filters common environment, developer, and replay wrappers.
- Deduplicates messages persisted as both `event_msg` and `response_item` records.
- Masks common API keys, bearer tokens, JWTs, private keys, passwords, and credentials in URLs.
- Skips abnormally large single JSONL records to protect Obsidian from compaction payloads.
- Copies Codex local and base64-inline images into the Vault and embeds them in the matching message.
- Uses SHA-256 content hashes to deduplicate image attachments and avoid filename collisions.
- Excludes subagent sessions by default.
- Produces an optional Markdown import report.
- Makes no network requests and sends no telemetry.

## Installation

### Ready-built manual installation

1. Download `chatgpt-archive-importer` folder in this project.
2. Copy the `chatgpt-archive-importer` folder into:

   ```text
   <your-vault>/.obsidian/plugins/
   ```

3. Restart or reload Obsidian.
4. Open **Settings → Community plugins** and enable **Codex Archive Importer**.
5. Open the plugin settings and validate the Codex data folder.
6. Run **Import now** or use the command palette.

The default Codex data folder is:

```text
Windows: %USERPROFILE%\.codex
macOS/Linux: ~/.codex
```

## Commands

- `Chatgpt Archive Importer: Import or update all conversations`
- `Chatgpt Archive Importer: Import or update active conversations`
- `Chatgpt Archive Importer: Import or update archived conversations`
- `Chatgpt Archive Importer: Preview import source`
- `Chatgpt Archive Importer: Force rebuild all imported conversations`

## Output

The default layout is:

```text
Codex Archive/
├── 2026/
│   └── 07/
│       └── 2026-07-31 - Add API health check [56789abc].md
└── _Import Reports/
    └── 2026-07-31 121500 - Codex import report.md
```

Each conversation note includes:

- Codex thread/session ID
- Active or archived status
- Created and updated timestamps
- Project name and working directory
- Model and Codex version when available
- Referenced or modified files
- User/Codex transcript
- Optional tool calls and outputs
- Import warnings for malformed or oversized records

## Security and privacy

This plugin is desktop-only because it uses Node.js filesystem access to read files outside the Obsidian vault.

- Codex source files are opened read-only.
- The plugin writes only to the configured folder inside the current vault.
- The plugin does not access the network and contains no telemetry.
- Secret redaction is best-effort and cannot guarantee that every credential or personal detail is detected.
- Tool outputs can contain source code, environment values, file paths, database content, and credentials. Keep tool outputs disabled unless needed.
- `source_file` and `project_path` frontmatter fields may expose local usernames and directory names inside the vault.
- Back up the vault before a large first import.

## Deliberate exclusions

- Internal reasoning records are not imported.
- Token counts, rate-limit events, telemetry, and most lifecycle events are ignored.
- Local and base64-inline images can be copied into a configurable Vault attachment folder. Remote HTTP images are deliberately not downloaded.
- Missing, oversized, or unsupported images are reported inline and in the import report.
- Cloud conversations that have no local rollout JSONL file cannot be imported.
- The Codex rollout format is not documented as a stable public interchange format. The parser is deliberately tolerant, but future Codex versions may require updates.

## Build from source

The repository has no runtime dependencies beyond Obsidian and Node.js APIs. Install the locked development dependency, then build and test.

```bash
npm install
npm run build
npm test
```

Release files are generated under:

```text
release/chatgpt-archive-importer/
```

## Publishing to the Obsidian community directory

1. Publish this source as a public GitHub repository.
2. Create a GitHub release tagged exactly `0.1.0`.
3. Attach `manifest.json`, `main.js`, and `styles.css` from the release folder.
4. Add the plugin to the Obsidian community plugin directory following the current submission process.

## License

MIT

---

# 中文说明

Chatgpt Archive Importer 是一个仅限桌面端使用的 Obsidian 插件，用于把 Codex Desktop／Codex CLI 本地会话导入为 Markdown 笔记。

主要特点：

- 同时扫描 `.codex/sessions` 和 `.codex/archived_sessions`。
- 首次全量导入，后续根据源文件变化增量更新。
- 以 Codex thread ID 去重，同一会话持续更新同一篇笔记。
- 自动过滤环境上下文、内部事件、推理记录和重复消息。
- 可选择导入工具调用及截断后的工具输出。
- 默认进行 API Key、Token、JWT、密码和私钥脱敏。
- 默认排除数量较多且容易重复的 subagent 会话。
- 对超大单条 JSONL 记录设置上限，避免 Obsidian 因压缩历史或内嵌图片数据卡死。
- 插件不联网、不上传数据、不修改 Codex 原始文件。

手工安装：把安装压缩包中的 `codex-archive-importer` 文件夹解压到：

```text
<你的 Vault>/.obsidian/plugins/
```

然后重启 Obsidian，在 **设置 → 第三方插件** 中启用插件。

## Version 0.2.0

Image import is enabled by default. The default attachment folder is:

```text
Codex Archive/_Attachments
```

The importer recognises absolute paths, `file://` URLs, paths relative to the Codex project directory, paths relative to the rollout file, and base64 `data:image/...` references. Files are named with a shortened SHA-256 hash, so importing the same image again reuses the existing attachment. Configure the folder and maximum image size under the plugin settings.

## Guardian/review filter

Version 0.2.2 adds an optional **Exclude guardian/review sessions** setting. It is disabled by default and does not exclude ordinary subagent sessions.

## 0.2.2

- Stronger detection for truncated and reformatted Codex guardian/approval-review prompts.
- Converts `image name=... path=...` clipboard placeholders into image attachments instead of leaving them as visible text.
- When guardian filtering is enabled, a forced re-import moves previously imported matching notes to Obsidian Trash.


## 0.2.4

- Superseded by 0.2.7 because filesystem modification times can be refreshed in bulk by Codex.

## 0.2.3

- Guardian/review filtering is now enabled by default, including a one-time migration for existing installations.
- Added an enabled-by-default filter for internal `recommendedplugins` sessions such as “Here is a list of plugins that are available but not installed.”
- A forced rebuild moves previously imported matching notes to Obsidian Trash.

## 0.2.7

- Note filenames and year/month folders use the conversation's last activity time from timestamps inside the rollout JSONL.
- `session_index.jsonl` `updated_at` is used when it is later than the rollout timestamp.
- Filesystem modification time is used only as a final fallback.
- Forced rebuilds move existing notes to the correct year/month folder.
- Added `last_activity_at` metadata and bumped the note format to rebuild notes created by 0.2.4.


## 0.2.7

- Adds a true full-root rescan that rediscovers every `rollout-*.jsonl` under the configured Codex home.
- Clears stale source-file fingerprints during a forced rebuild.
- Reads nested and numeric timestamps from newer rollout schemas.
- Reports source-path months and parsed last-activity months for diagnostics.


## 0.2.7

- Restricts guardian/review and recommended-plugin filtering to authoritative metadata or the first user turn only.
- Prevents quoted internal prompts in normal conversations from suppressing the whole session.
- Adds per-month skipped-session diagnostics to import reports.
