"use strict";
/*
 * Codex Archive Importer
 * Desktop-only Obsidian community plugin.
 *
 * The plugin deliberately treats Codex rollout JSONL files as the source of
 * truth. session_index.jsonl is used only as an optional metadata hint.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.__test = void 0;
const { Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, normalizePath, } = require("obsidian");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const PLUGIN_VERSION = "0.3.0";
const NOTE_FORMAT_VERSION = 7;
const DEFAULT_SETTINGS = {
    codexRoot: path.join(os.homedir(), ".codex"),
    outputFolder: "Codex Archive",
    organizeByDate: true,
    includeActive: true,
    includeArchived: true,
    includeSubagents: false,
    excludeGuardianReviewSessions: true,
    excludeRecommendedPluginSessions: true,
    toolDetail: "calls",
    redactSecrets: true,
    includeLocalImageReferences: true,
    copyLocalImages: true,
    imageAttachmentFolder: "Codex Archive/_Attachments",
    maxImageMb: 25,
    maxToolTextChars: 6000,
    maxRecordMb: 8,
    createImportReport: true,
    renameNotesWhenTitleChanges: true,
    chatgptCacheRoot: path.join(os.homedir(), "AppData", "Local", "Packages", "OpenAI.Codex_2p2nqsd0c76g0", "LocalCache", "Roaming", "Codex", "web", "Codex"),
    chatgptCacheOutputFolder: "ChatGPT Cache Index",
    chatgptCacheMaxFileMb: 128,
};
function nowIso() {
    return new Date().toISOString();
}
function expandPath(input) {
    const home = os.homedir();
    let value = String(input || "").trim();
    value = value.replace(/^~(?=$|[\\/])/, home);
    value = value.replace(/%USERPROFILE%/gi, home);
    value = value.replace(/\$\{HOME\}|\$HOME/g, home);
    return path.resolve(value || path.join(home, ".codex"));
}
function toPosix(value) {
    return String(value || "").replace(/\\/g, "/");
}
function isUuidLike(value) {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(value);
}
function firstNonEmpty(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim())
            return value.trim();
    }
    return "";
}
function safeDate(value, fallback) {
    if (value instanceof Date && !Number.isNaN(value.getTime()))
        return value;
    if (typeof value === "string" || typeof value === "number") {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime()))
            return parsed;
    }
    return fallback || new Date();
}
function compactIso(value, fallback) {
    return safeDate(value, fallback).toISOString();
}
function parseTimestampMs(value) {
    if (value instanceof Date)
        return Number.isNaN(value.getTime()) ? 0 : value.getTime();
    if (typeof value === "number" && Number.isFinite(value)) {
        const ms = value < 10000000000 ? value * 1000 : value;
        return ms > 946684800000 && ms < 4102444800000 ? ms : 0;
    }
    if (typeof value !== "string" || !value.trim())
        return 0;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && /^\d+(?:\.\d+)?$/.test(value.trim()))
        return parseTimestampMs(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 946684800000 && parsed < 4102444800000 ? parsed : 0;
}
function collectTimestampMsDeep(value, maxDepth = 8) {
    let latest = 0;
    const seen = new Set();
    const visit = (node, key = "", depth = 0) => {
        if (node == null || depth > maxDepth)
            return;
        if (typeof node !== "object") {
            if (/(?:^|_)(?:timestamp|time|created_at|createdAt|updated_at|updatedAt|completed_at|completedAt|finished_at|finishedAt)$/i.test(key)) {
                latest = Math.max(latest, parseTimestampMs(node));
            }
            return;
        }
        if (seen.has(node))
            return;
        seen.add(node);
        if (Array.isArray(node)) {
            for (const child of node)
                visit(child, key, depth + 1);
            return;
        }
        for (const [childKey, child] of Object.entries(node))
            visit(child, childKey, depth + 1);
    };
    visit(value);
    return latest;
}
function formatDate(value, fallback) {
    const date = safeDate(value, fallback);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}
function formatLocalStamp(value) {
    const date = safeDate(value);
    const datePart = formatDate(date);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${datePart} ${hours}:${minutes}:${seconds}`;
}
function humanBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0)
        return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    const digits = index === 0 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(digits)} ${units[index]}`;
}
function yamlString(value) {
    return JSON.stringify(String(value !== null && value !== void 0 ? value : ""));
}
function sanitizeFileName(value, maxLength = 110) {
    let result = String(value || "Untitled")
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[. ]+$/g, "");
    if (!result)
        result = "Untitled";
    if (result.length > maxLength)
        result = result.slice(0, maxLength).trim();
    return result;
}
function stripMarkdownForTitle(value) {
    return String(value || "")
        .replace(/^#+\s*/gm, "")
        .replace(/[`*_~>\[\]()]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}
function titleFromText(value) {
    const cleaned = stripMarkdownForTitle(value);
    if (!cleaned)
        return "Untitled Codex conversation";
    const firstLine = cleaned.split(/[\r\n]/)[0].trim();
    return firstLine.length > 88 ? `${firstLine.slice(0, 85).trim()}…` : firstLine;
}
function normalizeForDedup(value) {
    return String(value || "")
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
function truncateText(value, maxChars) {
    const text = String(value || "");
    if (!maxChars || text.length <= maxChars)
        return text;
    return `${text.slice(0, maxChars).trimEnd()}\n\n… [truncated ${text.length - maxChars} characters]`;
}
function redactSensitiveText(value) {
    let text = String(value || "");
    text = text.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
    text = text.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED OPENAI KEY]");
    text = text.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[REDACTED GITHUB TOKEN]");
    text = text.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED GITHUB TOKEN]");
    text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS ACCESS KEY]");
    text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED JWT]");
    text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED TOKEN]");
    text = text.replace(/((?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|SEND[_-]?MAIL[_-]?TOKEN)\s*[:=]\s*)(["']?)([^\s"'`]{6,})(\2)/gi, "$1$2[REDACTED]$4");
    text = text.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi, "$1[REDACTED]$3");
    text = text.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]{100,}/g, "[INLINE IMAGE DATA OMITTED]");
    return text;
}
function extractImageRefsFromText(value) {
    let text = String(value || "").replace(/\r\n/g, "\n");
    const images = [];
    const push = (raw) => {
        let candidate = String(raw || "").trim().replace(/^["'`<]+|["'`>]+$/g, "");
        if (!candidate)
            return;
        candidate = candidate.replace(/^path\s*=\s*/i, "").trim();
        // Some Codex Desktop records flatten a Windows clipboard path into spaces,
        // e.g. "C Users Name AppData Local Temp codex-clipboard-....png".
        if (/^[A-Za-z]\s+Users\s+/i.test(candidate) && /codex-clipboard-[^\s]+\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/i.test(candidate)) {
            const match = candidate.match(/^([A-Za-z])\s+Users\s+(.+?)\s+AppData\s+Local\s+Temp\s+(codex-clipboard-[^\s]+\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic|heif))$/i);
            if (match)
                candidate = `${match[1]}:\\Users\\${match[2]}\\AppData\\Local\\Temp\\${match[3]}`;
        }
        images.push(candidate);
    };
    const patterns = [
        /<image[^>]*?(?:path|src)=["']([^"']+)["'][^>]*>/gi,
        /image\s+name\s*=\s*["']?[^\n"']*["']?\s+path\s*=\s*["']?([^\n"']+\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic|heif))["']?/gi,
        /\[Image:\s*([^\]]+)\]/gi,
    ];
    for (const pattern of patterns) {
        text = text.replace(pattern, (_whole, ref) => {
            push(ref);
            return "";
        });
    }
    return { text: text.replace(/\n{3,}/g, "\n\n").trim(), images: [...new Set(images)] };
}
function cleanGeneratedUserText(value, includeSystemGenerated = false) {
    let text = String(value || "").replace(/\r\n/g, "\n");
    text = text.replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "");
    text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
    text = text.replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/gi, "");
    text = text.replace(/<collaboration_mode>[\s\S]*?<\/collaboration_mode>/gi, "");
    text = text.replace(/<developer_instructions>[\s\S]*?<\/developer_instructions>/gi, "");
    const requestMarker = text.match(/##\s+My request for Codex:\s*\n([\s\S]*)/i);
    if (requestMarker && requestMarker[1].trim())
        text = requestMarker[1];
    text = text.trim();
    if (!text)
        return "";
    if (!includeSystemGenerated) {
        const internalPrefixes = [
            "# AGENTS.md instructions for ",
            "Message Type: FINAL_ANSWER",
            "<environment_context>",
            "You are Codex,",
        ];
        if (internalPrefixes.some((prefix) => text.startsWith(prefix)))
            return "";
    }
    return text;
}
function contentPartsToText(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    const parts = [];
    for (const item of content) {
        if (typeof item === "string") {
            parts.push(item);
            continue;
        }
        if (!item || typeof item !== "object")
            continue;
        const record = item;
        const text = firstNonEmpty(record.text, record.value, record.message);
        if (text) {
            parts.push(text);
            continue;
        }
        if (record.type === "input_image" || record.type === "image") {
            const imageRef = firstNonEmpty(record.image_url, record.path, record.url);
            if (imageRef)
                parts.push(`[Image: ${imageRef}]`);
        }
    }
    return parts.join("\n").trim();
}
function parseArguments(raw) {
    if (raw && typeof raw === "object")
        return raw;
    if (typeof raw !== "string")
        return raw;
    const trimmed = raw.trim();
    if (!trimmed)
        return "";
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return raw;
    }
}
function stringifyToolValue(value) {
    if (typeof value === "string")
        return value;
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
        return String(value !== null && value !== void 0 ? value : "");
    }
}
function collectFilePathsFromValue(value, target) {
    if (!value)
        return;
    if (typeof value === "string") {
        const patterns = [
            /^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm,
            /^diff --git a\/(.+?) b\/(.+)$/gm,
            /^\+\+\+ b\/(.+)$/gm,
            /^--- a\/(.+)$/gm,
        ];
        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(value)) !== null) {
                const candidate = (match[2] || match[1] || "").trim();
                if (candidate && candidate !== "/dev/null")
                    target.add(toPosix(candidate));
            }
        }
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value)
            collectFilePathsFromValue(item, target);
        return;
    }
    if (typeof value === "object") {
        const record = value;
        for (const key of ["path", "file", "file_path", "filepath", "target", "destination"]) {
            const candidate = record[key];
            if (typeof candidate === "string" && candidate.trim())
                target.add(toPosix(candidate.trim()));
        }
        for (const nested of Object.values(record))
            collectFilePathsFromValue(nested, target);
    }
}
function isLikelySubagent(meta) {
    var _a;
    const source = stringifyToolValue(meta.sourceDetail || meta.source || "").toLowerCase();
    const role = firstNonEmpty(meta.agentRole, meta.agent_role, (_a = meta.threadSource) === null || _a === void 0 ? void 0 : _a.agent_role).toLowerCase();
    return Boolean(role) || source.includes("subagent") || source.includes("sub_agent");
}
function firstUserText(session) {
    var _a;
    return firstNonEmpty((_a = (session.items || []).find((item) => item.role === "user")) === null || _a === void 0 ? void 0 : _a.text)
        .toLowerCase()
        .replace(/[\s\u2026.]+/g, " ")
        .trim();
}
function isGuardianReviewSession(session) {
    const source = stringifyToolValue(session.sourceDetail || session.source || "").toLowerCase();
    const role = firstNonEmpty(session.agentRole, session.agent_role).toLowerCase();
    const model = firstNonEmpty(session.model).toLowerCase();
    // Metadata is authoritative. Do not inspect the full transcript: normal main
    // sessions may contain quoted guardian prompts in nested history/tool output.
    const metadataMatch = model.includes("codex-auto-review") ||
        model.includes("auto-review") ||
        source.includes('"guardian"') ||
        source.includes("guardian") ||
        source.includes("approval_review") ||
        source.includes("approval-review") ||
        role === "guardian" ||
        role === "approval_reviewer" ||
        role === "approval-reviewer";
    if (metadataMatch)
        return true;
    // Text is only a conservative fallback and only examines the first user turn.
    const opening = firstUserText(session);
    if (!opening)
        return false;
    return (/^the following is the codex agent history.{0,220}(?:request action|action request).{0,120}(?:assessing|assess|review)/i.test(opening) ||
        /^the following is the codex agent history whose request action you are assessing/i.test(opening) ||
        /^treat (?:the )?(?:following|history).{0,160}(?:untrusted|agent history).{0,160}(?:approve|approval|permission|policy)/i.test(opening));
}
function isRecommendedPluginSession(session) {
    // Only classify a dedicated internal plugin-recommendation thread. A normal
    // session may quote this text later, which must not suppress the whole chat.
    const opening = firstUserText(session);
    const title = firstNonEmpty(session.title).toLowerCase().replace(/[\s\u2026.]+/g, " ").trim();
    const candidate = opening || title;
    if (!candidate)
        return false;
    return (/^recommended\s*plugins?(?:\s|:|$)/i.test(candidate) ||
        /^here is a list of plugins that are available but not installed(?:\s|[.!?]|$)/i.test(candidate) ||
        /^plugins that are available but not installed(?:\s|[.!?]|$)/i.test(candidate));
}
function extractThreadIdFromFileName(filePath) {
    const name = path.basename(filePath, ".jsonl");
    const matches = name.match(/[0-9a-f]{8}-[0-9a-f-]{20,}/gi);
    return (matches === null || matches === void 0 ? void 0 : matches.length) ? matches[matches.length - 1] : "";
}
function normalizeRolloutRecord(record) {
    if (!record || typeof record !== "object")
        return null;
    if (typeof record.type === "string") {
        return { timestamp: record.timestamp, ordinal: record.ordinal, type: record.type, payload: record.payload };
    }
    if (record.item && typeof record.item === "object") {
        const item = record.item;
        if (typeof item.type === "string") {
            return { timestamp: record.timestamp, ordinal: record.ordinal, type: item.type, payload: item.payload };
        }
        const keys = Object.keys(item);
        if (keys.length === 1) {
            const key = keys[0];
            return { timestamp: record.timestamp, ordinal: record.ordinal, type: key, payload: item[key] };
        }
    }
    return null;
}
async function readJsonLinesSafely(filePath, maxRecordBytes, onRecord) {
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    let parts = [];
    let partBytes = 0;
    let dropping = false;
    let lineNumber = 0;
    let malformed = 0;
    let oversized = 0;
    const consumeLine = async (lastPart) => {
        lineNumber += 1;
        if (dropping) {
            oversized += 1;
        }
        else {
            const allParts = lastPart && lastPart.length ? [...parts, lastPart] : parts;
            let line = Buffer.concat(allParts).toString("utf8");
            if (line.endsWith("\r"))
                line = line.slice(0, -1);
            if (line.trim()) {
                try {
                    await onRecord(JSON.parse(line), lineNumber);
                }
                catch {
                    malformed += 1;
                }
            }
        }
        parts = [];
        partBytes = 0;
        dropping = false;
    };
    for await (const rawChunk of stream) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        let start = 0;
        while (start < chunk.length) {
            const newline = chunk.indexOf(0x0a, start);
            const end = newline === -1 ? chunk.length : newline;
            const segment = chunk.subarray(start, end);
            if (!dropping && segment.length) {
                if (partBytes + segment.length <= maxRecordBytes) {
                    parts.push(segment);
                    partBytes += segment.length;
                }
                else {
                    parts = [];
                    partBytes = 0;
                    dropping = true;
                }
            }
            if (newline !== -1) {
                await consumeLine();
                start = newline + 1;
            }
            else {
                start = chunk.length;
            }
        }
    }
    if (parts.length || dropping)
        await consumeLine();
    return { malformed, oversized, lines: lineNumber };
}
async function readSessionIndex(codexRoot, maxRecordBytes) {
    const indexPath = path.join(codexRoot, "session_index.jsonl");
    const entries = new Map();
    try {
        await fsp.access(indexPath);
    }
    catch {
        return entries;
    }
    await readJsonLinesSafely(indexPath, maxRecordBytes, (record) => {
        const id = firstNonEmpty(record.id, record.thread_id, record.threadId, record.session_id, record.sessionId);
        if (!id)
            return;
        const previous = entries.get(id) || {};
        entries.set(id, {
            ...previous,
            ...record,
            id,
            title: firstNonEmpty(record.title, record.name, record.thread_name, previous.title),
            updatedAt: firstNonEmpty(record.updated_at, record.updatedAt, record.timestamp, previous.updatedAt),
            cwd: firstNonEmpty(record.cwd, record.project_path, previous.cwd),
        });
    });
    return entries;
}
async function walkJsonlFiles(rootDir, status, rolloutOnly = false) {
    const files = [];
    async function walk(current) {
        let entries;
        try {
            entries = await fsp.readdir(current, { withFileTypes: true });
        }
        catch (error) {
            if ((error === null || error === void 0 ? void 0 : error.code) === "ENOENT")
                return;
            throw error;
        }
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
            }
            else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl") && (!rolloutOnly || /^rollout-.*\.jsonl$/i.test(entry.name))) {
                const stat = await fsp.stat(fullPath);
                files.push({ path: fullPath, status, size: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs });
            }
        }
    }
    await walk(rootDir);
    return files;
}
async function scanCodexFiles(codexRoot, mode, settings) {
    const byPath = new Map();
    const add = (file) => byPath.set(path.resolve(file.path), file);
    if (mode !== "archived" && settings.includeActive) {
        for (const file of await walkJsonlFiles(path.join(codexRoot, "sessions"), "active", true))
            add(file);
    }
    if (mode !== "active" && settings.includeArchived) {
        for (const file of await walkJsonlFiles(path.join(codexRoot, "archived_sessions"), "archived", true))
            add(file);
    }
    // Codex builds and migrations have occasionally left rollout files in nested
    // or non-standard locations. A full-root fallback ensures newly created
    // sessions are discovered even when the folder layout changes.
    const fallback = await walkJsonlFiles(codexRoot, "active", true);
    for (const file of fallback) {
        const normalized = toPosix(path.resolve(file.path)).toLowerCase();
        const isArchived = normalized.includes("/archived_sessions/");
        if ((isArchived && (mode === "active" || !settings.includeArchived)) || (!isArchived && (mode === "archived" || !settings.includeActive)))
            continue;
        add({ ...file, status: isArchived ? "archived" : "active", discoveredByFallback: true });
    }
    const files = [...byPath.values()];
    files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
    return files;
}
function extractLocalImageReferences(payload) {
    const images = [];
    const seen = new Set();
    const visit = (value, key = "") => {
        if (value == null || seen.has(value))
            return;
        if (typeof value === "string") {
            const candidate = value.trim();
            if (!candidate)
                return;
            const imageKey = /(?:image|local_images?|localImages?|path|file|url)$/i.test(key);
            const looksLikeImage = /^(?:data:image\/|file:\/\/)/i.test(candidate) || /\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)(?:[?#].*)?$/i.test(candidate);
            if (imageKey && looksLikeImage)
                images.push(candidate);
            return;
        }
        if (typeof value !== "object")
            return;
        seen.add(value);
        if (Array.isArray(value)) {
            for (const item of value)
                visit(item, key);
            return;
        }
        for (const [childKey, child] of Object.entries(value))
            visit(child, childKey);
    };
    visit(payload);
    return [...new Set(images)];
}
function addTranscriptItem(session, item) {
    const text = String(item.text || "").trim();
    if (!text)
        return;
    session.items.push({
        role: item.role,
        text,
        timestamp: item.timestamp || "",
        toolName: item.toolName || "",
        callId: item.callId || "",
        origin: item.origin || "",
        images: Array.isArray(item.images) ? [...new Set(item.images.filter(Boolean))] : [],
        imageEmbeds: [],
        imageWarnings: [],
        sequence: session.sequence++,
    });
}
function deduplicateTranscript(items) {
    const output = [];
    for (const item of items) {
        const normalized = normalizeForDedup(item.text);
        if (!normalized)
            continue;
        const recent = output.slice(-5);
        const duplicate = recent.some((previous) => {
            if (previous.role !== item.role || normalizeForDedup(previous.text) !== normalized)
                return false;
            if (item.role === "tool-call" || item.role === "tool-output") {
                return previous.callId && item.callId && previous.callId === item.callId;
            }
            const previousTime = Date.parse(previous.timestamp || "");
            const currentTime = Date.parse(item.timestamp || "");
            if (Number.isFinite(previousTime) && Number.isFinite(currentTime)) {
                return Math.abs(currentTime - previousTime) <= 5000;
            }
            return item.sequence - previous.sequence <= 3;
        });
        if (!duplicate)
            output.push(item);
        else {
            const target = [...output].reverse().find((previous) => previous.role === item.role && normalizeForDedup(previous.text) === normalized);
            if (target && Array.isArray(item.images) && item.images.length) {
                target.images = [...new Set([...(target.images || []), ...item.images])];
            }
        }
    }
    return output;
}
async function parseCodexSessionFile(file, indexEntry, settings) {
    const fallbackDate = new Date(file.mtimeMs || file.birthtimeMs || Date.now());
    const session = {
        threadId: extractThreadIdFromFileName(file.path),
        sessionId: "",
        status: file.status,
        sourceFile: file.path,
        createdAt: "",
        updatedAt: "",
        sourceModifiedAt: new Date(file.mtimeMs || Date.now()).toISOString(),
        lastActivityAt: "",
        latestRecordTimestampMs: 0,
        cwd: "",
        model: "",
        source: "",
        sourceDetail: null,
        cliVersion: "",
        title: firstNonEmpty(indexEntry === null || indexEntry === void 0 ? void 0 : indexEntry.title),
        gitBranch: "",
        gitCommit: "",
        gitRepository: "",
        agentRole: "",
        items: [],
        filesModified: new Set(),
        sequence: 0,
        malformedRecords: 0,
        oversizedRecords: 0,
        totalLines: 0,
    };
    const maxRecordBytes = Math.max(1, Number(settings.maxRecordMb) || 8) * 1024 * 1024;
    const result = await readJsonLinesSafely(file.path, maxRecordBytes, (rawRecord) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
        const record = normalizeRolloutRecord(rawRecord);
        if (!record)
            return;
        const timestamp = firstNonEmpty(record.timestamp, rawRecord === null || rawRecord === void 0 ? void 0 : rawRecord.created_at, rawRecord === null || rawRecord === void 0 ? void 0 : rawRecord.updated_at, rawRecord === null || rawRecord === void 0 ? void 0 : rawRecord.timestamp);
        const directTimestampMs = parseTimestampMs(timestamp);
        const deepTimestampMs = collectTimestampMsDeep(rawRecord);
        const timestampMs = Math.max(directTimestampMs, deepTimestampMs);
        if (timestampMs) {
            const timestampIso = new Date(timestampMs).toISOString();
            if (!session.createdAt || timestampMs < parseTimestampMs(session.createdAt))
                session.createdAt = timestampIso;
            if (timestampMs > session.latestRecordTimestampMs) {
                session.latestRecordTimestampMs = timestampMs;
                session.updatedAt = timestampIso;
            }
        }
        const payload = record.payload || {};
        if (record.type === "session_meta") {
            const meta = payload.meta || payload;
            session.threadId = firstNonEmpty(meta.id, meta.thread_id, meta.threadId, session.threadId);
            session.sessionId = firstNonEmpty(meta.session_id, meta.sessionId, session.sessionId);
            session.cwd = firstNonEmpty(meta.cwd, session.cwd);
            session.sourceDetail = (_a = meta.source) !== null && _a !== void 0 ? _a : session.sourceDetail;
            session.source = firstNonEmpty(typeof meta.source === "string" ? meta.source : (_b = meta.source) === null || _b === void 0 ? void 0 : _b.type, meta.originator, session.source);
            session.cliVersion = firstNonEmpty(meta.cli_version, meta.cliVersion, session.cliVersion);
            session.agentRole = firstNonEmpty(meta.agent_role, meta.agentRole, (_c = meta.thread_source) === null || _c === void 0 ? void 0 : _c.agent_role, session.agentRole);
            const git = payload.git || meta.git || {};
            session.gitBranch = firstNonEmpty(git.branch, git.branch_name, session.gitBranch);
            session.gitCommit = firstNonEmpty(git.commit_hash, git.commit, git.head, session.gitCommit);
            session.gitRepository = firstNonEmpty(git.repository_url, git.remote_url, session.gitRepository);
            return;
        }
        if (record.type === "turn_context") {
            session.cwd = firstNonEmpty(payload.cwd, session.cwd);
            session.model = firstNonEmpty(payload.model, session.model);
            return;
        }
        if (record.type === "event_msg") {
            const eventType = firstNonEmpty(payload.type).toLowerCase();
            if (eventType === "user_message") {
                const extracted = extractImageRefsFromText(firstNonEmpty(payload.message, payload.text));
                let text = cleanGeneratedUserText(extracted.text, false);
                const images = [...new Set([...extractLocalImageReferences(payload), ...extracted.images])];
                addTranscriptItem(session, { role: "user", text, timestamp, origin: "event_msg", images });
            }
            else if (eventType === "agent_message") {
                const text = firstNonEmpty(payload.message, payload.text);
                addTranscriptItem(session, { role: "assistant", text, timestamp, origin: "event_msg" });
            }
            else if (["thread_name_updated", "thread_name_update", "thread_renamed"].includes(eventType)) {
                session.title = firstNonEmpty(payload.name, payload.title, payload.thread_name, session.title);
            }
            else if (eventType === "task_complete" && payload.last_agent_message) {
                addTranscriptItem(session, {
                    role: "assistant",
                    text: String(payload.last_agent_message),
                    timestamp,
                    origin: "task_complete",
                });
            }
            return;
        }
        if (record.type !== "response_item")
            return;
        const itemType = firstNonEmpty(payload.type).toLowerCase();
        if (itemType === "message") {
            const role = firstNonEmpty(payload.role).toLowerCase();
            const extracted = extractImageRefsFromText(contentPartsToText(payload.content));
            let text = extracted.text;
            if (role === "user")
                text = cleanGeneratedUserText(text, false);
            const images = [...new Set([...extractLocalImageReferences(payload), ...extracted.images])];
            if (role === "assistant")
                addTranscriptItem(session, { role: "assistant", text, timestamp, origin: "response_item", images });
            if (role === "user")
                addTranscriptItem(session, { role: "user", text, timestamp, origin: "response_item", images });
            return;
        }
        const isToolCall = ["function_call", "custom_tool_call", "local_shell_call", "tool_call"].includes(itemType);
        if (isToolCall) {
            const toolName = firstNonEmpty(payload.name, payload.tool_name, (_d = payload.command) === null || _d === void 0 ? void 0 : _d.name, itemType);
            const args = parseArguments((_g = (_f = (_e = payload.arguments) !== null && _e !== void 0 ? _e : payload.input) !== null && _f !== void 0 ? _f : payload.command) !== null && _g !== void 0 ? _g : payload.action);
            collectFilePathsFromValue(args, session.filesModified);
            if (settings.toolDetail !== "none") {
                addTranscriptItem(session, {
                    role: "tool-call",
                    text: stringifyToolValue(args),
                    timestamp,
                    toolName,
                    callId: firstNonEmpty(payload.call_id, payload.callId, payload.id),
                    origin: "response_item",
                });
            }
            return;
        }
        const isToolOutput = [
            "function_call_output",
            "custom_tool_call_output",
            "local_shell_call_output",
            "tool_call_output",
        ].includes(itemType);
        if (isToolOutput && settings.toolDetail === "calls-and-output") {
            const output = (_k = (_j = (_h = payload.output) !== null && _h !== void 0 ? _h : payload.result) !== null && _j !== void 0 ? _j : payload.content) !== null && _k !== void 0 ? _k : payload.text;
            addTranscriptItem(session, {
                role: "tool-output",
                text: stringifyToolValue(output),
                timestamp,
                toolName: firstNonEmpty(payload.name, payload.tool_name, "tool output"),
                callId: firstNonEmpty(payload.call_id, payload.callId, payload.id),
                origin: "response_item",
            });
        }
    });
    session.malformedRecords = result.malformed;
    session.oversizedRecords = result.oversized;
    session.totalLines = result.lines;
    session.items = deduplicateTranscript(session.items);
    session.createdAt = compactIso(session.createdAt || (indexEntry === null || indexEntry === void 0 ? void 0 : indexEntry.created_at), fallbackDate);
    const rolloutUpdatedMs = session.latestRecordTimestampMs || Date.parse(session.updatedAt || "") || 0;
    const indexUpdatedMs = parseTimestampMs(indexEntry === null || indexEntry === void 0 ? void 0 : indexEntry.updatedAt);
    const lastActivityMs = Math.max(rolloutUpdatedMs, indexUpdatedMs);
    session.lastActivityAt = lastActivityMs
        ? new Date(lastActivityMs).toISOString()
        : new Date(file.mtimeMs || Date.now()).toISOString();
    session.updatedAt = session.lastActivityAt;
    session.sourceModifiedAt = new Date(file.mtimeMs || Date.now()).toISOString();
    session.cwd = firstNonEmpty(session.cwd, indexEntry === null || indexEntry === void 0 ? void 0 : indexEntry.cwd);
    session.title = firstNonEmpty(session.title, indexEntry === null || indexEntry === void 0 ? void 0 : indexEntry.title);
    if (!session.title) {
        const firstUser = session.items.find((item) => item.role === "user");
        session.title = titleFromText((firstUser === null || firstUser === void 0 ? void 0 : firstUser.text) || "");
    }
    session.title = titleFromText(session.title);
    if (!session.threadId)
        session.threadId = firstNonEmpty(session.sessionId, `unknown-${file.mtimeMs}-${file.size}`);
    session.isSubagent = isLikelySubagent(session);
    session.isGuardianReview = isGuardianReviewSession(session);
    session.isRecommendedPluginSession = isRecommendedPluginSession(session);
    session.project = session.cwd ? session.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || "" : "";
    return session;
}
function normalizeImageReference(value) {
    let ref = String(value || "").trim();
    if (!ref)
        return "";
    if (/^file:\/\//i.test(ref)) {
        try {
            const url = new URL(ref);
            ref = decodeURIComponent(url.pathname || "");
            if (process.platform === "win32" && /^\/[A-Za-z]:\//.test(ref))
                ref = ref.slice(1);
        }
        catch { }
    }
    return ref;
}
function resolveImagePath(reference, session) {
    const ref = normalizeImageReference(reference);
    if (!ref || /^data:image\//i.test(ref) || /^https?:\/\//i.test(ref))
        return "";
    const candidates = [];
    if (path.isAbsolute(ref))
        candidates.push(ref);
    else {
        if (session.cwd)
            candidates.push(path.resolve(session.cwd, ref));
        if (session.sourceFile)
            candidates.push(path.resolve(path.dirname(session.sourceFile), ref));
    }
    return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}
function imageExtension(reference, mime = "") {
    const ext = path.extname(reference || "").toLowerCase();
    if (/^\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/.test(ext))
        return ext === ".jpeg" ? ".jpg" : ext;
    const map = {
        "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
        "image/bmp": ".bmp", "image/svg+xml": ".svg", "image/avif": ".avif", "image/heic": ".heic", "image/heif": ".heif",
    };
    return map[mime.toLowerCase()] || ".png";
}
function decodeDataImage(reference) {
    const match = String(reference || "").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
    if (!match)
        return null;
    return { mime: match[1], data: Buffer.from(match[2].replace(/\s+/g, ""), "base64") };
}
function safeMarkdownText(value, settings, maxChars) {
    let text = String(value || "").replace(/\u0000/g, "");
    if (settings.redactSecrets)
        text = redactSensitiveText(text);
    if (maxChars)
        text = truncateText(text, maxChars);
    return text.trim();
}
function fencedBlock(value, language = "") {
    const text = String(value || "");
    const matches = text.match(/`+/g) || [];
    const longest = matches.reduce((max, run) => Math.max(max, run.length), 0);
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `${fence}${language}\n${text}\n${fence}`;
}
function renderTranscriptItem(item, settings) {
    var _a;
    const time = item.timestamp ? ` · ${formatLocalStamp(item.timestamp)}` : "";
    if (item.role === "user" || item.role === "assistant") {
        const heading = item.role === "user" ? "User" : "Codex";
        const body = safeMarkdownText(item.text, settings);
        const extras = [];
        if (Array.isArray(item.imageEmbeds) && item.imageEmbeds.length)
            extras.push(item.imageEmbeds.join("\n"));
        if (settings.includeLocalImageReferences && Array.isArray(item.images) && item.images.length && !((_a = item.imageEmbeds) === null || _a === void 0 ? void 0 : _a.length)) {
            extras.push(`_Local images:_ ${item.images.map((image) => `\`${safeMarkdownText(image, settings)}\``).join(", ")}`);
        }
        if (Array.isArray(item.imageWarnings) && item.imageWarnings.length) {
            extras.push(item.imageWarnings.map((warning) => `> [!warning] Image not imported\n> ${warning}`).join("\n\n"));
        }
        const content = [body, ...extras].filter(Boolean).join("\n\n");
        if (!content)
            return "";
        return `### ${heading}${time}\n\n${content}`;
    }
    const toolName = sanitizeFileName(item.toolName || (item.role === "tool-call" ? "tool call" : "tool output"), 80);
    const label = item.role === "tool-call" ? "Tool call" : "Tool output";
    const maxChars = Math.max(500, Number(settings.maxToolTextChars) || 6000);
    const body = safeMarkdownText(item.text, settings, maxChars);
    if (!body)
        return "";
    const language = body.trim().startsWith("{") || body.trim().startsWith("[") ? "json" : "text";
    return `<details>\n<summary>${label}: ${toolName}${time}</summary>\n\n${fencedBlock(body, language)}\n\n</details>`;
}
function renderSessionMarkdown(session, settings) {
    const tags = ["codex", session.status === "archived" ? "codex/archived" : "codex/active"];
    if (session.project)
        tags.push(`project/${session.project.replace(/\s+/g, "-").toLowerCase()}`);
    const lines = [
        "---",
        "source: codex-desktop",
        `codex_thread_id: ${yamlString(session.threadId)}`,
        `codex_session_id: ${yamlString(session.sessionId || session.threadId)}`,
        `status: ${yamlString(session.status)}`,
        `archived: ${session.status === "archived" ? "true" : "false"}`,
        `created: ${yamlString(session.createdAt)}`,
        `updated: ${yamlString(session.updatedAt)}`,
        `source_file_modified: ${yamlString(session.sourceModifiedAt)}`,
        `last_activity_at: ${yamlString(session.lastActivityAt || session.updatedAt)}`,
        `imported_at: ${yamlString(nowIso())}`,
        `project: ${yamlString(session.project)}`,
        `project_path: ${yamlString(session.cwd)}`,
        `model: ${yamlString(session.model)}`,
        `codex_source: ${yamlString(session.source)}`,
        `codex_cli_version: ${yamlString(session.cliVersion)}`,
        `source_file: ${yamlString(toPosix(session.sourceFile))}`,
        `note_format_version: ${NOTE_FORMAT_VERSION}`,
        "tags:",
        ...tags.map((tag) => `  - ${yamlString(tag)}`),
        "---",
        "",
        `# ${session.title}`,
        "",
        "> [!info] Codex archive",
        `> Imported from Codex ${session.status === "archived" ? "archived" : "active"} session data. The source JSONL is read-only.`,
        "",
        "## Session",
        "",
        `- **Thread ID:** \`${session.threadId}\``,
        `- **Created:** ${formatLocalStamp(session.createdAt)}`,
        `- **Updated:** ${formatLocalStamp(session.updatedAt)}`,
        `- **Source file modified:** ${formatLocalStamp(session.sourceModifiedAt)}`,
        `- **Project:** ${session.project || "—"}`,
        `- **Project path:** ${session.cwd ? `\`${session.cwd}\`` : "—"}`,
        `- **Model:** ${session.model || "—"}`,
    ];
    if (session.gitBranch || session.gitCommit || session.gitRepository) {
        lines.push(`- **Git branch:** ${session.gitBranch || "—"}`);
        lines.push(`- **Git commit:** ${session.gitCommit ? `\`${session.gitCommit}\`` : "—"}`);
        lines.push(`- **Git repository:** ${session.gitRepository || "—"}`);
    }
    const files = [...session.filesModified].sort();
    if (files.length) {
        lines.push("", "## Files referenced or modified", "");
        for (const file of files)
            lines.push(`- \`${safeMarkdownText(file, settings)}\``);
    }
    lines.push("", "## Conversation", "");
    const renderedItems = session.items.map((item) => renderTranscriptItem(item, settings)).filter(Boolean);
    if (renderedItems.length)
        lines.push(renderedItems.join("\n\n---\n\n"));
    else
        lines.push("_No human-visible user or assistant messages were found in this rollout file._");
    if (session.malformedRecords || session.oversizedRecords) {
        lines.push("", "## Import warnings", "", `- Malformed JSONL records skipped: ${session.malformedRecords}`, `- Oversized JSONL records skipped: ${session.oversizedRecords}`);
    }
    lines.push("");
    return lines.join("\n");
}
function buildRenderSignature(settings) {
    const relevant = {
        noteFormatVersion: NOTE_FORMAT_VERSION,
        outputFolder: settings.outputFolder,
        organizeByDate: settings.organizeByDate,
        toolDetail: settings.toolDetail,
        redactSecrets: settings.redactSecrets,
        includeLocalImageReferences: settings.includeLocalImageReferences,
        copyLocalImages: settings.copyLocalImages,
        imageAttachmentFolder: settings.imageAttachmentFolder,
        maxImageMb: settings.maxImageMb,
        maxToolTextChars: settings.maxToolTextChars,
        maxRecordMb: settings.maxRecordMb,
        renameNotesWhenTitleChanges: settings.renameNotesWhenTitleChanges,
        excludeGuardianReviewSessions: settings.excludeGuardianReviewSessions,
        excludeRecommendedPluginSessions: settings.excludeRecommendedPluginSessions,
    };
    return JSON.stringify(relevant);
}
function sourceFingerprint(file) {
    return `${file.size}:${Math.floor(file.mtimeMs)}`;
}
function choosePreferredSession(existing, candidate) {
    if (!existing)
        return candidate;
    const latestSourceModifiedAt = new Date(Math.max(Date.parse(existing.sourceModifiedAt || existing.updatedAt || 0) || 0, Date.parse(candidate.sourceModifiedAt || candidate.updatedAt || 0) || 0)).toISOString();
    const existingScore = existing.items.length * 1000 + existing.totalLines;
    const candidateScore = candidate.items.length * 1000 + candidate.totalLines;
    const preferred = candidateScore !== existingScore
        ? (candidateScore > existingScore ? candidate : existing)
        : (Date.parse(candidate.updatedAt) >= Date.parse(existing.updatedAt) ? candidate : existing);
    preferred.sourceModifiedAt = latestSourceModifiedAt;
    return preferred;
}
function desiredNotePath(session, settings) {
    const activityDate = safeDate(session.lastActivityAt || session.updatedAt || session.createdAt, safeDate(session.sourceModifiedAt || session.fileMtimeMs));
    const date = formatDate(activityDate);
    const year = String(activityDate.getFullYear());
    const month = String(activityDate.getMonth() + 1).padStart(2, "0");
    const shortId = String(session.threadId).replace(/-/g, "").slice(-8) || "unknown";
    const fileName = `${date} - ${sanitizeFileName(session.title)} [${shortId}].md`;
    const folderParts = [settings.outputFolder];
    if (settings.organizeByDate)
        folderParts.push(year, month);
    return normalizePath([...folderParts, fileName].filter(Boolean).join("/"));
}
async function validateCodexRoot(codexRoot) {
    const resolved = expandPath(codexRoot);
    const details = { resolved, valid: false, active: false, archived: false, index: false, message: "" };
    try {
        const rootStat = await fsp.stat(resolved);
        if (!rootStat.isDirectory()) {
            details.message = "The configured path is not a directory.";
            return details;
        }
        details.active = await existsDirectory(path.join(resolved, "sessions"));
        details.archived = await existsDirectory(path.join(resolved, "archived_sessions"));
        details.index = await existsFile(path.join(resolved, "session_index.jsonl"));
        details.valid = details.active || details.archived;
        details.message = details.valid
            ? `Found${details.active ? " active sessions" : ""}${details.active && details.archived ? " and" : ""}${details.archived ? " archived sessions" : ""}.`
            : "No sessions or archived_sessions directory was found.";
    }
    catch (error) {
        details.message = `Cannot access path: ${error.message}`;
    }
    return details;
}
async function existsDirectory(filePath) {
    try {
        return (await fsp.stat(filePath)).isDirectory();
    }
    catch {
        return false;
    }
}
async function existsFile(filePath) {
    try {
        return (await fsp.stat(filePath)).isFile();
    }
    catch {
        return false;
    }
}
function makeReportMarkdown(report, codexRoot) {
    const lines = [
        "---",
        "source: codex-archive-importer",
        `created: ${yamlString(report.finishedAt)}`,
        "tags:",
        "  - codex/import-report",
        "---",
        "",
        `# Codex import report — ${formatLocalStamp(report.finishedAt)}`,
        "",
        `- **Plugin version:** ${PLUGIN_VERSION}`,
        `- **Codex root:** \`${codexRoot}\``,
        `- **Mode:** ${report.mode}`,
        `- **Duration:** ${report.durationMs} ms`,
        `- **JSONL files found:** ${report.filesFound}`,
        `- **Files parsed:** ${report.filesParsed}`,
        `- **Sessions imported:** ${report.imported}`,
        `- **Sessions updated:** ${report.updated}`,
        `- **Unchanged sessions skipped:** ${report.skipped}`,
        `- **Guardian/review sessions skipped:** ${report.guardianReviewSkipped}`,
        `- **Recommended-plugin system sessions skipped:** ${report.recommendedPluginSkipped}`,
        `- **Subagent sessions skipped:** ${report.subagentsSkipped}`,
        `- **Empty sessions skipped:** ${report.emptySkipped}`,
        `- **Malformed records skipped:** ${report.malformedRecords}`,
        `- **Oversized records skipped:** ${report.oversizedRecords}`,
        `- **Images copied:** ${report.imagesCopied}`,
        `- **Images reused:** ${report.imagesReused}`,
        `- **Images not imported:** ${report.imagesFailed}`,
        `- **Source size scanned:** ${humanBytes(report.totalBytes)}`,
        `- **Files found by full-root fallback:** ${report.fallbackDiscovered || 0}`,
        `- **Discovered by source-path month:** ${Object.entries(report.discoveredByPathMonth || {}).sort().map(([month, count]) => `${month}: ${count}`).join(", ") || "none"}`,
        `- **Parsed by last-activity month:** ${Object.entries(report.parsedByActivityMonth || {}).sort().map(([month, count]) => `${month}: ${count}`).join(", ") || "none"}`,
        `- **Guardian/review skipped by month:** ${Object.entries(report.guardianSkippedByMonth || {}).sort().map(([month, count]) => `${month}: ${count}`).join(", ") || "none"}`,
        `- **Recommended-plugin skipped by month:** ${Object.entries(report.recommendedSkippedByMonth || {}).sort().map(([month, count]) => `${month}: ${count}`).join(", ") || "none"}`,
    ];
    if (report.errors.length) {
        lines.push("", "## Errors", "");
        for (const error of report.errors)
            lines.push(`- ${error}`);
    }
    lines.push("");
    return lines.join("\n");
}
class ImportSummaryModal extends Modal {
    constructor(app, report) {
        super(app);
        this.report = report;
    }
    onOpen() {
        this.contentEl.empty();
        this.contentEl.createEl("h2", { text: "Codex import complete" });
        const wrapper = this.contentEl.createDiv({ cls: "codex-importer-summary" });
        const table = wrapper.createEl("table");
        const rows = [
            ["Files found", this.report.filesFound],
            ["Files parsed", this.report.filesParsed],
            ["Imported", this.report.imported],
            ["Updated", this.report.updated],
            ["Unchanged", this.report.skipped],
            ["Guardian/review skipped", this.report.guardianReviewSkipped],
            ["Guardian notes trashed", this.report.guardianNotesTrashed],
            ["Recommended-plugin skipped", this.report.recommendedPluginSkipped],
            ["Recommended-plugin notes trashed", this.report.recommendedPluginNotesTrashed],
            ["Subagents skipped", this.report.subagentsSkipped],
            ["Empty skipped", this.report.emptySkipped],
            ["Malformed records", this.report.malformedRecords],
            ["Oversized records", this.report.oversizedRecords],
            ["Images copied", this.report.imagesCopied],
            ["Images reused", this.report.imagesReused],
            ["Images not imported", this.report.imagesFailed],
            ["Duration", `${this.report.durationMs} ms`],
        ];
        for (const [label, value] of rows) {
            const row = table.createEl("tr");
            row.createEl("th", { text: String(label) });
            row.createEl("td", { text: String(value) });
        }
        if (this.report.reportPath) {
            const paragraph = wrapper.createEl("p");
            paragraph.appendText("Report: ");
            const link = paragraph.createEl("a", { text: this.report.reportPath, href: "#" });
            link.addEventListener("click", async (event) => {
                event.preventDefault();
                const file = this.app.vault.getAbstractFileByPath(this.report.reportPath);
                if (file instanceof TFile)
                    await this.app.workspace.getLeaf(true).openFile(file);
                this.close();
            });
        }
        if (this.report.errors.length) {
            wrapper.createEl("h3", { text: "Errors" });
            wrapper.createEl("div", {
                cls: "codex-importer-errors",
                text: this.report.errors.slice(0, 20).join("\n"),
            });
        }
        new Setting(this.contentEl).addButton((button) => button.setButtonText("Close").setCta().onClick(() => this.close()));
    }
    onClose() {
        this.contentEl.empty();
    }
}
class PreviewModal extends Modal {
    constructor(app, preview) {
        super(app);
        this.preview = preview;
    }
    onOpen() {
        this.contentEl.empty();
        this.contentEl.createEl("h2", { text: "Codex import preview" });
        const list = this.contentEl.createEl("ul");
        list.createEl("li", { text: `Codex root: ${this.preview.codexRoot}` });
        list.createEl("li", { text: `Active JSONL files: ${this.preview.activeCount}` });
        list.createEl("li", { text: `Archived JSONL files: ${this.preview.archivedCount}` });
        list.createEl("li", { text: `Total source size: ${humanBytes(this.preview.totalBytes)}` });
        list.createEl("li", { text: `Output folder: ${this.preview.outputFolder}` });
        new Setting(this.contentEl).addButton((button) => button.setButtonText("Close").setCta().onClick(() => this.close()));
    }
    onClose() {
        this.contentEl.empty();
    }
}
function defaultChatgptCacheRoot() {
    return path.join(os.homedir(), "AppData", "Local", "Packages", "OpenAI.Codex_2p2nqsd0c76g0", "LocalCache", "Roaming", "Codex", "web", "Codex");
}
function collectChatgptSidebarEntries(value) {
    const entries = [];
    const seen = new Set();
    const visit = (node, depth = 0) => {
        var _a;
        if (node == null || depth > 20)
            return;
        if (typeof node !== "object")
            return;
        if (seen.has(node))
            return;
        seen.add(node);
        if (Array.isArray(node)) {
            for (const child of node)
                visit(child, depth + 1);
            return;
        }
        const conversationId = firstNonEmpty(node.conversationId, node.conversation_id, (_a = node.conversation) === null || _a === void 0 ? void 0 : _a.id, node.id && /conversation/i.test(String(node.type || node.kind || "")) ? node.id : "");
        const url = firstNonEmpty(node.url, node.href, node.location, node.path);
        const urlMatch = String(url || "").match(/(?:chatgpt\.com)?\/c\/([0-9a-f-]{16,})/i);
        const resolvedId = conversationId || (urlMatch === null || urlMatch === void 0 ? void 0 : urlMatch[1]) || "";
        const title = firstNonEmpty(node.title, node.label, node.name, node.pageTitle, node.text);
        if (resolvedId || (title && /chatgpt/i.test(String(url || "")))) {
            entries.push({
                conversationId: resolvedId,
                title: title || `ChatGPT conversation ${resolvedId.slice(0, 8)}`,
                url,
                updatedAt: firstNonEmpty(node.updatedAt, node.updated_at, node.lastUpdatedAt, node.timestamp),
                source: "browser-sidebar-page-states.json",
            });
        }
        for (const child of Object.values(node))
            visit(child, depth + 1);
    };
    visit(value);
    return entries;
}
function extractChatgptCacheEntriesFromText(text, sourceFile) {
    const entries = [];
    const normalized = String(text || "").replace(/\u0000/g, "");
    const idPattern = /(?:conversationId|conversation_id|\/c\/)["'=: \\]*([0-9a-f]{8}-[0-9a-f-]{20,})/gi;
    let match;
    while ((match = idPattern.exec(normalized)) !== null) {
        const conversationId = match[1];
        const start = Math.max(0, match.index - 1200);
        const end = Math.min(normalized.length, match.index + 2200);
        const window = normalized.slice(start, end);
        const titleMatches = [
            /["']title["']\s*[:=]\s*["']([^"'\r\n]{2,180})["']/i,
            /["']name["']\s*[:=]\s*["']([^"'\r\n]{2,180})["']/i,
            /["']label["']\s*[:=]\s*["']([^"'\r\n]{2,180})["']/i,
        ];
        let title = "";
        for (const pattern of titleMatches) {
            const titleMatch = window.match(pattern);
            if (titleMatch) {
                title = titleMatch[1];
                break;
            }
        }
        const urlMatch = window.match(/https?:\/\/chatgpt\.com\/c\/[0-9a-f-]{16,}/i);
        const updatedMatch = window.match(/["'](?:updated_at|updatedAt|update_time)["']\s*[:=]\s*["']?([^,"'\s}]{8,40})/i);
        entries.push({
            conversationId,
            title: title || `ChatGPT conversation ${conversationId.slice(0, 8)}`,
            url: (urlMatch === null || urlMatch === void 0 ? void 0 : urlMatch[0]) || `https://chatgpt.com/c/${conversationId}`,
            updatedAt: (updatedMatch === null || updatedMatch === void 0 ? void 0 : updatedMatch[1]) || "",
            source: sourceFile,
        });
    }
    return entries;
}
async function discoverChatgptCacheEntries(cacheRootInput, maxFileMb = 128) {
    const cacheRoot = expandPath(cacheRootInput || defaultChatgptCacheRoot());
    const entries = [];
    const warnings = [];
    const sidebarPath = path.join(cacheRoot, "browser-sidebar-page-states.json");
    if (fs.existsSync(sidebarPath)) {
        try {
            const raw = await fsp.readFile(sidebarPath, "utf8");
            entries.push(...collectChatgptSidebarEntries(JSON.parse(raw)));
        }
        catch (error) {
            warnings.push(`Could not parse ${sidebarPath}: ${error.message}`);
        }
    }
    const roots = [
        path.join(cacheRoot, "Default", "Local Storage", "leveldb"),
        path.join(cacheRoot, "Default", "Session Storage"),
        path.join(cacheRoot, "Default", "WebStorage"),
    ].filter((candidate) => fs.existsSync(candidate));
    const maxBytes = Math.max(1, Number(maxFileMb) || 128) * 1024 * 1024;
    for (const root of roots) {
        let files = [];
        try {
            files = await fsp.readdir(root, { withFileTypes: true });
        }
        catch { }
        for (const item of files) {
            if (!item.isFile() || !/(?:\.ldb|\.log|^LOG$|^LOG\.old$)/i.test(item.name))
                continue;
            const filePath = path.join(root, item.name);
            try {
                const stat = await fsp.stat(filePath);
                if (stat.size <= 0 || stat.size > maxBytes)
                    continue;
                const buffer = await fsp.readFile(filePath);
                const utf8 = buffer.toString("utf8");
                const utf16 = buffer.length % 2 === 0 ? buffer.toString("utf16le") : "";
                entries.push(...extractChatgptCacheEntriesFromText(utf8, filePath));
                if (utf16)
                    entries.push(...extractChatgptCacheEntriesFromText(utf16, filePath));
            }
            catch (error) {
                warnings.push(`Could not inspect ${filePath}: ${error.message}`);
            }
        }
    }
    const deduped = new Map();
    for (const entry of entries) {
        const id = firstNonEmpty(entry.conversationId);
        if (!id)
            continue;
        const previous = deduped.get(id);
        const score = (candidate) => (candidate.title && !candidate.title.startsWith("ChatGPT conversation ") ? 3 : 0) + (candidate.url ? 1 : 0) + (candidate.updatedAt ? 1 : 0);
        if (!previous || score(entry) > score(previous))
            deduped.set(id, entry);
    }
    return { cacheRoot, entries: [...deduped.values()], warnings };
}
function renderChatgptCacheIndexNote(entry) {
    const title = titleFromText(entry.title || `ChatGPT conversation ${entry.conversationId.slice(0, 8)}`);
    const updated = entry.updatedAt ? compactIso(entry.updatedAt) : "";
    return [
        "---",
        "source: chatgpt-desktop-cache",
        `conversation_id: ${yamlString(entry.conversationId)}`,
        `title: ${yamlString(title)}`,
        `url: ${yamlString(entry.url || `https://chatgpt.com/c/${entry.conversationId}`)}`,
        `updated: ${yamlString(updated)}`,
        `cache_source_file: ${yamlString(toPosix(entry.source || ""))}`,
        `imported_at: ${yamlString(nowIso())}`,
        "cache_only: true",
        "tags:",
        "  - chatgpt",
        "  - chatgpt/cache-index",
        "---",
        "",
        `# ${title}`,
        "",
        "> [!warning] Local cache index only",
        "> This note was created from ChatGPT Desktop local cache metadata. The cache may be incomplete and this note does not claim to contain the full conversation transcript.",
        "",
        "## Conversation",
        "",
        `- **Conversation ID:** \`${entry.conversationId}\``,
        `- **URL:** ${entry.url || `https://chatgpt.com/c/${entry.conversationId}`}`,
        `- **Cached update time:** ${updated ? formatLocalStamp(updated) : "Unknown"}`,
        `- **Cache source:** \`${toPosix(entry.source || "")}\``,
        "",
    ].join("\n");
}
class CodexArchiveImporterSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        new Setting(containerEl).setName("Codex source").setHeading();
        new Setting(containerEl)
            .setName("Codex data folder")
            .setDesc("Usually ~/.codex on macOS/Linux or %USERPROFILE%\\.codex on Windows.")
            .addText((text) => text
            .setPlaceholder(path.join(os.homedir(), ".codex"))
            .setValue(this.plugin.settings.codexRoot)
            .onChange(async (value) => {
            this.plugin.settings.codexRoot = value;
            await this.plugin.saveSettings();
        }))
            .addButton((button) => button.setButtonText("Validate").onClick(async () => {
            const result = await validateCodexRoot(this.plugin.settings.codexRoot);
            new Notice(`${result.valid ? "Valid" : "Invalid"}: ${result.message}`);
            this.display();
        }));
        const status = containerEl.createDiv({ cls: "codex-importer-path-status" });
        status.setText(`Resolved path: ${expandPath(this.plugin.settings.codexRoot)}`);
        new Setting(containerEl)
            .setName("Import active sessions")
            .setDesc("Read rollout files under sessions.")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.includeActive).onChange(async (value) => {
            this.plugin.settings.includeActive = value;
            await this.plugin.saveSettings();
        }));
        new Setting(containerEl)
            .setName("Import archived sessions")
            .setDesc("Read rollout files under archived_sessions.")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.includeArchived).onChange(async (value) => {
            this.plugin.settings.includeArchived = value;
            await this.plugin.saveSettings();
        }));
        new Setting(containerEl)
            .setName("Exclude guardian/review sessions")
            .setDesc("Skip internal Codex approval-review sessions while retaining ordinary subagent sessions. Enabled by default.")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.excludeGuardianReviewSessions).onChange(async (value) => {
            this.plugin.settings.excludeGuardianReviewSessions = value;
            await this.plugin.saveSettings();
        }));
        new Setting(containerEl)
            .setName("Exclude recommended-plugin system sessions")
            .setDesc("Skip internal sessions whose content begins with recommendedplugins or lists available-but-not-installed plugins. Enabled by default.")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.excludeRecommendedPluginSessions).onChange(async (value) => {
            this.plugin.settings.excludeRecommendedPluginSessions = value;
            await this.plugin.saveSettings();
        }));
        new Setting(containerEl)
            .setName("Include subagent sessions")
            .setDesc("Disabled by default because subagent rollouts can be numerous and repetitive.")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.includeSubagents).onChange(async (value) => {
            this.plugin.settings.includeSubagents = value;
            await this.plugin.saveSettings();
        }));
        new Setting(containerEl).setName("ChatGPT Desktop cache (experimental)").setHeading();
        new Setting(containerEl)
            .setName("ChatGPT cache folder")
            .setDesc("Windows desktop cache root. This importer creates index notes from locally cached metadata; it does not guarantee full transcripts.")
            .addText((text) => text.setValue(this.plugin.settings.chatgptCacheRoot || defaultChatgptCacheRoot()).onChange(async (value) => {
            this.plugin.settings.chatgptCacheRoot = value;
            await this.plugin.saveSettings();
        }));
        new Setting(containerEl)
            .setName("ChatGPT cache index folder")
            .setDesc("Vault-relative destination for ChatGPT Desktop cache index notes.")
            .addText((text) => text.setValue(this.plugin.settings.chatgptCacheOutputFolder).onChange(async (value) => {
            this.plugin.settings.chatgptCacheOutputFolder = normalizePath(value.trim() || "ChatGPT Cache Index");
            await this.plugin.saveSettings();
        }));
        new Setting(containerEl)
            .setName("Maximum cache file size")
            .setDesc("LevelDB files larger than this many MB are skipped during the experimental scan.")
            .addText((text) => text.setValue(String(this.plugin.settings.chatgptCacheMaxFileMb)).onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 1024) {
                this.plugin.settings.chatgptCacheMaxFileMb = parsed;
                await this.plugin.saveSettings();
            }
        }));
        new Setting(containerEl)
            .setName("Import ChatGPT cache index")
            .setDesc("Close ChatGPT Desktop first. Imports locally cached conversation IDs and titles when available.")
            .addButton((button) => button.setButtonText("Import cache index").setCta().onClick(() => this.plugin.importChatgptCacheIndex()));
        new Setting(containerEl).setName("Markdown output").setHeading();
        new Setting(containerEl)
            .setName("Output folder")
            .setDesc("Folder inside this vault. The plugin never writes to the Codex data folder.")
            .addText((text) => text.setValue(this.plugin.settings.outputFolder).onChange(async (value) => {
            this.plugin.settings.outputFolder = normalizePath(value.trim() || "Codex Archive");
            await this.plugin.saveSettings();
        }));
        new Setting(containerEl)
            .setName("Organize by year and month")
            .setDesc("Create Output folder/YYYY/MM/.")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.organizeByDate).onChange(async (value) => {
            this.plugin.settings.organizeByDate = value;
            await this.plugin.saveSettings();
        }));
        new Setting(containerEl)
            .setName("Tool detail")
            .setDesc("Tool outputs can be very large and may contain sensitive command output.")
            .addDropdown((dropdown) => dropdown
            .addOption("none", "Messages only")
            .addOption("calls", "Messages and tool calls")
            .addOption("calls-and-output", "Messages, calls, and outputs")
            .setValue(this.plugin.settings.toolDetail)
            .onChange(async (value) => {
            this.plugin.settings.toolDetail = value;
            await this.plugin.saveSettings();
        }));
        new Setting(containerEl)
            .setName("Redact likely secrets")
            .setDesc("Masks common API keys, bearer tokens, private keys, JWTs, passwords, and inline base64 images.")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.redactSecrets).onChange(async (value) => {
            this.plugin.settings.redactSecrets = value;
            await this.plugin.saveSettings();
        }));
        new Setting(containerEl)
            .setName("Include local image references")
            .setDesc("Keeps original image paths when an image cannot be copied or image copying is disabled.")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.includeLocalImageReferences).onChange(async (value) => {
            this.plugin.settings.includeLocalImageReferences = value;
            await this.plugin.saveSettings();
        }));
        new Setting(containerEl)
            .setName("Copy local images into vault")
            .setDesc("Copies Codex-referenced local or inline images into the vault and embeds them in the conversation note.")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.copyLocalImages).onChange(async (value) => {
            this.plugin.settings.copyLocalImages = value;
            await this.plugin.saveSettings();
        }));
        new Setting(containerEl)
            .setName("Image attachment folder")
            .setDesc("Vault-relative destination for imported Codex images.")
            .addText((text) => text.setValue(this.plugin.settings.imageAttachmentFolder).onChange(async (value) => {
            this.plugin.settings.imageAttachmentFolder = normalizePath(value.trim() || `${this.plugin.settings.outputFolder}/_Attachments`);
            await this.plugin.saveSettings();
        }));
        new Setting(containerEl)
            .setName("Maximum image size")
            .setDesc("Images larger than this many MB are not copied.")
            .addText((text) => text.setValue(String(this.plugin.settings.maxImageMb)).onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 500) {
                this.plugin.settings.maxImageMb = parsed;
                await this.plugin.saveSettings();
            }
        }));
        new Setting(containerEl)
            .setName("Maximum tool text")
            .setDesc("Maximum characters stored for each tool call or output.")
            .addText((text) => text.setValue(String(this.plugin.settings.maxToolTextChars)).onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed >= 500) {
                this.plugin.settings.maxToolTextChars = parsed;
                await this.plugin.saveSettings();
            }
        }));
        new Setting(containerEl)
            .setName("Maximum JSONL record size")
            .setDesc("Oversized single records are skipped to protect Obsidian from very large compaction or image records. Value is in MB.")
            .addText((text) => text.setValue(String(this.plugin.settings.maxRecordMb)).onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 128) {
                this.plugin.settings.maxRecordMb = parsed;
                await this.plugin.saveSettings();
            }
        }));
        new Setting(containerEl)
            .setName("Create import report")
            .setDesc("Create a Markdown report under _Import Reports after each run.")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.createImportReport).onChange(async (value) => {
            this.plugin.settings.createImportReport = value;
            await this.plugin.saveSettings();
        }));
        new Setting(containerEl)
            .setName("Rename notes when titles change")
            .setDesc("Move an existing imported note when Codex or the first prompt provides a better title.")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.renameNotesWhenTitleChanges).onChange(async (value) => {
            this.plugin.settings.renameNotesWhenTitleChanges = value;
            await this.plugin.saveSettings();
        }));
        new Setting(containerEl).setName("Actions").setHeading();
        new Setting(containerEl)
            .setName("Preview source")
            .setDesc("Count files without parsing conversation content.")
            .addButton((button) => button.setButtonText("Preview").onClick(() => this.plugin.previewImport()));
        new Setting(containerEl)
            .setName("Import or update")
            .setDesc("Import new sessions and rebuild sessions whose source file has changed.")
            .addButton((button) => button.setButtonText("Import now").setCta().onClick(() => this.plugin.importSessions("all", false)));
        new Setting(containerEl)
            .setName("Full rescan and rebuild")
            .setDesc("Rediscover every rollout JSONL under the entire Codex root, ignore old fingerprints, and rebuild or move all notes.")
            .addButton((button) => button.setButtonText("Full rescan").setWarning().onClick(() => this.plugin.importSessions("all", true)));
        new Setting(containerEl)
            .setName("Reset import state")
            .setDesc("Forget fingerprints and note mappings. Existing Markdown notes are not deleted.")
            .addButton((button) => button.setButtonText("Reset state").setWarning().onClick(async () => {
            this.plugin.state.sessions = {};
            this.plugin.state.files = {};
            this.plugin.state.renderSignature = "";
            await this.plugin.savePluginData();
            new Notice("Codex import state reset. Existing notes were not deleted.");
        }));
    }
}
class CodexArchiveImporterPlugin extends Plugin {
    constructor() {
        super(...arguments);
        this.importInProgress = false;
    }
    async onload() {
        if (!Platform.isDesktopApp) {
            new Notice("Codex Archive Importer is available on desktop only.");
            return;
        }
        await this.loadPluginData();
        this.addSettingTab(new CodexArchiveImporterSettingTab(this.app, this));
        this.addRibbonIcon("archive-restore", "Import Codex conversations", () => this.importSessions("all", false));
        this.addCommand({
            id: "import-all-codex-conversations",
            name: "Import or update all conversations",
            callback: () => this.importSessions("all", false),
        });
        this.addCommand({
            id: "import-active-codex-conversations",
            name: "Import or update active conversations",
            callback: () => this.importSessions("active", false),
        });
        this.addCommand({
            id: "import-archived-codex-conversations",
            name: "Import or update archived conversations",
            callback: () => this.importSessions("archived", false),
        });
        this.addCommand({
            id: "preview-codex-import",
            name: "Preview import source",
            callback: () => this.previewImport(),
        });
        this.addCommand({
            id: "import-chatgpt-desktop-cache-index",
            name: "Import ChatGPT Desktop cache index (experimental)",
            callback: () => this.importChatgptCacheIndex(),
        });
        this.addCommand({
            id: "force-rebuild-codex-conversations",
            name: "Full rescan and rebuild all conversations",
            callback: () => this.importSessions("all", true),
        });
    }
    async loadPluginData() {
        var _a, _b, _c, _d, _e;
        const data = (await this.loadData()) || {};
        const savedSettings = data.settings || {};
        this.settings = { ...DEFAULT_SETTINGS, ...savedSettings };
        if ((data.settingsSchemaVersion || 0) < 1) {
            this.settings.excludeGuardianReviewSessions = true;
            this.settings.excludeRecommendedPluginSessions = true;
        }
        this.state = {
            sessions: ((_a = data.state) === null || _a === void 0 ? void 0 : _a.sessions) || {},
            files: ((_b = data.state) === null || _b === void 0 ? void 0 : _b.files) || {},
            renderSignature: ((_c = data.state) === null || _c === void 0 ? void 0 : _c.renderSignature) || "",
            lastReportPath: ((_d = data.state) === null || _d === void 0 ? void 0 : _d.lastReportPath) || "",
            chatgptCache: ((_e = data.state) === null || _e === void 0 ? void 0 : _e.chatgptCache) || {},
        };
    }
    async saveSettings() {
        await this.savePluginData();
    }
    async savePluginData() {
        await this.saveData({ settingsSchemaVersion: 2, settings: this.settings, state: this.state });
    }
    async previewImport() {
        try {
            const validation = await validateCodexRoot(this.settings.codexRoot);
            if (!validation.valid) {
                new Notice(`Codex folder is invalid: ${validation.message}`);
                return;
            }
            const codexRoot = validation.resolved;
            const active = this.settings.includeActive
                ? await walkJsonlFiles(path.join(codexRoot, "sessions"), "active")
                : [];
            const archived = this.settings.includeArchived
                ? await walkJsonlFiles(path.join(codexRoot, "archived_sessions"), "archived")
                : [];
            const all = [...active, ...archived];
            new PreviewModal(this.app, {
                codexRoot,
                activeCount: active.length,
                archivedCount: archived.length,
                totalBytes: all.reduce((sum, file) => sum + file.size, 0),
                outputFolder: this.settings.outputFolder,
            }).open();
        }
        catch (error) {
            new Notice(`Preview failed: ${error.message}`);
        }
    }
    async ensureFolder(folderPath) {
        const normalized = normalizePath(folderPath);
        if (!normalized)
            return;
        const parts = normalized.split("/").filter(Boolean);
        let current = "";
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            const existing = this.app.vault.getAbstractFileByPath(current);
            if (!existing)
                await this.app.vault.createFolder(current);
            else if (existing instanceof TFile)
                throw new Error(`A file blocks the folder path: ${current}`);
        }
    }
    async uniquePath(desiredPath, currentPath = "") {
        if (desiredPath === currentPath)
            return desiredPath;
        if (!this.app.vault.getAbstractFileByPath(desiredPath))
            return desiredPath;
        const extension = path.posix.extname(desiredPath);
        const base = desiredPath.slice(0, -extension.length);
        let index = 2;
        while (this.app.vault.getAbstractFileByPath(`${base} (${index})${extension}`))
            index += 1;
        return `${base} (${index})${extension}`;
    }
    async importChatgptCacheIndex() {
        var _a;
        if (this.importInProgress) {
            new Notice("An import is already running.");
            return;
        }
        this.importInProgress = true;
        new Notice("Scanning ChatGPT Desktop cache metadata...");
        try {
            const result = await discoverChatgptCacheEntries(this.settings.chatgptCacheRoot || defaultChatgptCacheRoot(), this.settings.chatgptCacheMaxFileMb);
            if (!fs.existsSync(result.cacheRoot))
                throw new Error(`Cache folder not found: ${result.cacheRoot}`);
            const outputFolder = normalizePath(this.settings.chatgptCacheOutputFolder || "ChatGPT Cache Index");
            await this.ensureFolder(outputFolder);
            let imported = 0;
            let updated = 0;
            for (const entry of result.entries) {
                const title = titleFromText(entry.title || `ChatGPT conversation ${entry.conversationId.slice(0, 8)}`);
                const shortId = entry.conversationId.slice(0, 8);
                const notePath = normalizePath(`${outputFolder}/${sanitizeFileName(title)} [${shortId}].md`);
                const markdown = renderChatgptCacheIndexNote(entry);
                const previousPath = (_a = this.state.chatgptCache[entry.conversationId]) === null || _a === void 0 ? void 0 : _a.notePath;
                let targetPath = previousPath || notePath;
                if (previousPath && previousPath !== notePath && this.settings.renameNotesWhenTitleChanges) {
                    const previousFile = this.app.vault.getAbstractFileByPath(previousPath);
                    if (previousFile instanceof TFile) {
                        targetPath = await this.uniquePath(notePath, previousPath);
                        await this.app.fileManager.renameFile(previousFile, targetPath);
                    }
                    else
                        targetPath = notePath;
                }
                const existing = this.app.vault.getAbstractFileByPath(targetPath);
                if (existing instanceof TFile) {
                    const old = await this.app.vault.read(existing);
                    if (old !== markdown)
                        await this.app.vault.modify(existing, markdown);
                    updated += 1;
                }
                else {
                    await this.app.vault.create(targetPath, markdown);
                    imported += 1;
                }
                this.state.chatgptCache[entry.conversationId] = { notePath: targetPath, title, updatedAt: entry.updatedAt || "" };
            }
            await this.savePluginData();
            const warningText = result.warnings.length ? ` ${result.warnings.length} cache files could not be inspected.` : "";
            new Notice(`ChatGPT cache index complete: ${imported} imported, ${updated} updated.${warningText}`);
            if (!result.entries.length)
                new Notice("No ChatGPT conversation IDs were found. Close ChatGPT Desktop and try again, or use the official ChatGPT export ZIP.");
        }
        catch (error) {
            new Notice(`ChatGPT cache index failed: ${error.message}`);
        }
        finally {
            this.importInProgress = false;
        }
    }
    async importSessionImages(session, report) {
        if (!this.settings.copyLocalImages)
            return;
        const folder = normalizePath(this.settings.imageAttachmentFolder || `${this.settings.outputFolder}/_Attachments`);
        await this.ensureFolder(folder);
        const maxBytes = Math.max(1, Number(this.settings.maxImageMb) || 25) * 1024 * 1024;
        const cache = new Map();
        for (const item of session.items) {
            if (!Array.isArray(item.images) || !item.images.length)
                continue;
            for (const reference of item.images) {
                try {
                    let data;
                    let ext = "";
                    let sourceKey = reference;
                    const inline = decodeDataImage(reference);
                    if (inline) {
                        data = inline.data;
                        ext = imageExtension("", inline.mime);
                        sourceKey = `inline:${crypto.createHash("sha256").update(data).digest("hex")}`;
                    }
                    else {
                        if (/^https?:\/\//i.test(reference))
                            throw new Error("remote HTTP images are not downloaded");
                        const sourcePath = resolveImagePath(reference, session);
                        if (!sourcePath)
                            throw new Error("local file was not found");
                        const stat = await fsp.stat(sourcePath);
                        if (!stat.isFile())
                            throw new Error("reference is not a file");
                        if (stat.size > maxBytes)
                            throw new Error(`file exceeds ${this.settings.maxImageMb} MB`);
                        data = await fsp.readFile(sourcePath);
                        ext = imageExtension(sourcePath);
                        sourceKey = path.resolve(sourcePath);
                    }
                    if (data.length > maxBytes)
                        throw new Error(`image exceeds ${this.settings.maxImageMb} MB`);
                    let vaultPath = cache.get(sourceKey);
                    if (!vaultPath) {
                        const hash = crypto.createHash("sha256").update(data).digest("hex");
                        const base = sanitizeFileName(path.basename(normalizeImageReference(reference), path.extname(normalizeImageReference(reference))) || "codex-image", 70);
                        vaultPath = normalizePath(`${folder}/${base}-${hash.slice(0, 12)}${ext}`);
                        const existing = this.app.vault.getAbstractFileByPath(vaultPath);
                        if (!existing) {
                            await this.app.vault.createBinary(vaultPath, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
                            report.imagesCopied += 1;
                        }
                        else if (!(existing instanceof TFile)) {
                            throw new Error(`a folder exists at ${vaultPath}`);
                        }
                        else {
                            report.imagesReused += 1;
                        }
                        cache.set(sourceKey, vaultPath);
                    }
                    else {
                        report.imagesReused += 1;
                    }
                    item.imageEmbeds.push(`![[${vaultPath}]]`);
                }
                catch (error) {
                    report.imagesFailed += 1;
                    item.imageWarnings.push(`${safeMarkdownText(reference, this.settings)} — ${error.message}`);
                }
            }
            item.imageEmbeds = [...new Set(item.imageEmbeds)];
            item.imageWarnings = [...new Set(item.imageWarnings)];
        }
    }
    async upsertSessionNote(session, markdown) {
        const previous = this.state.sessions[session.threadId] || {};
        const desired = desiredNotePath(session, this.settings);
        let notePath = previous.notePath || desired;
        const folderChanged = previous.notePath && path.posix.dirname(previous.notePath) !== path.posix.dirname(desired);
        const shouldMove = previous.notePath && previous.notePath !== desired && (folderChanged || this.settings.renameNotesWhenTitleChanges);
        if (shouldMove) {
            const oldFile = this.app.vault.getAbstractFileByPath(previous.notePath);
            if (oldFile instanceof TFile) {
                const target = await this.uniquePath(desired, previous.notePath);
                await this.ensureFolder(path.posix.dirname(target));
                await this.app.fileManager.renameFile(oldFile, target);
                notePath = target;
            }
            else {
                notePath = desired;
            }
        }
        else if (!previous.notePath) {
            notePath = desired;
        }
        await this.ensureFolder(path.posix.dirname(notePath));
        const existing = this.app.vault.getAbstractFileByPath(notePath);
        let action = "imported";
        if (existing instanceof TFile) {
            const previousContent = await this.app.vault.read(existing);
            if (previousContent !== markdown)
                await this.app.vault.modify(existing, markdown);
            action = "updated";
        }
        else if (existing) {
            throw new Error(`Cannot write note because a folder exists at ${notePath}`);
        }
        else {
            await this.app.vault.create(notePath, markdown);
        }
        return { notePath, action };
    }
    async writeReport(report, codexRoot) {
        if (!this.settings.createImportReport)
            return "";
        const folder = normalizePath(`${this.settings.outputFolder}/_Import Reports`);
        await this.ensureFolder(folder);
        const baseName = `${formatDate(report.finishedAt)} ${formatLocalStamp(report.finishedAt).slice(11).replace(/:/g, "")}`;
        const reportPath = await this.uniquePath(normalizePath(`${folder}/${baseName} - Codex import report.md`));
        await this.app.vault.create(reportPath, makeReportMarkdown(report, codexRoot));
        this.state.lastReportPath = reportPath;
        return reportPath;
    }
    async importSessions(mode, force) {
        if (this.importInProgress) {
            new Notice("A Codex import is already running.");
            return;
        }
        this.importInProgress = true;
        const started = Date.now();
        new Notice("Scanning Codex conversations…");
        const report = {
            mode,
            filesFound: 0,
            filesParsed: 0,
            imported: 0,
            updated: 0,
            skipped: 0,
            subagentsSkipped: 0,
            guardianReviewSkipped: 0,
            guardianNotesTrashed: 0,
            recommendedPluginSkipped: 0,
            recommendedPluginNotesTrashed: 0,
            emptySkipped: 0,
            malformedRecords: 0,
            oversizedRecords: 0,
            imagesCopied: 0,
            imagesReused: 0,
            imagesFailed: 0,
            totalBytes: 0,
            errors: [],
            durationMs: 0,
            finishedAt: "",
            reportPath: "",
            discoveredByPathMonth: {},
            parsedByActivityMonth: {},
            guardianSkippedByMonth: {},
            recommendedSkippedByMonth: {},
            fallbackDiscovered: 0,
        };
        try {
            const validation = await validateCodexRoot(this.settings.codexRoot);
            if (!validation.valid)
                throw new Error(validation.message);
            const codexRoot = validation.resolved;
            if (force)
                this.state.files = {};
            const files = await scanCodexFiles(codexRoot, mode, this.settings);
            report.filesFound = files.length;
            report.fallbackDiscovered = files.filter((file) => file.discoveredByFallback).length;
            for (const file of files) {
                const normalized = toPosix(file.path);
                const match = normalized.match(/\/(20\d{2})\/(0[1-9]|1[0-2])\//);
                const key = match ? `${match[1]}-${match[2]}` : "unknown";
                report.discoveredByPathMonth[key] = (report.discoveredByPathMonth[key] || 0) + 1;
            }
            report.totalBytes = files.reduce((sum, file) => sum + file.size, 0);
            const maxRecordBytes = Math.max(1, Number(this.settings.maxRecordMb) || 8) * 1024 * 1024;
            const indexEntries = await readSessionIndex(codexRoot, maxRecordBytes);
            const currentSignature = buildRenderSignature(this.settings);
            const renderChanged = currentSignature !== this.state.renderSignature;
            const forceAll = force || renderChanged;
            const previousByPath = new Map();
            for (const [sourcePath, fileState] of Object.entries(this.state.files || {})) {
                previousByPath.set(path.resolve(sourcePath), fileState);
            }
            const parsedByThread = new Map();
            for (const file of files) {
                const fingerprint = sourceFingerprint(file);
                const previousPathState = previousByPath.get(path.resolve(file.path));
                if (!forceAll && (previousPathState === null || previousPathState === void 0 ? void 0 : previousPathState.fingerprint) === fingerprint) {
                    report.skipped += 1;
                    continue;
                }
                try {
                    const fileThreadId = extractThreadIdFromFileName(file.path);
                    const session = await parseCodexSessionFile(file, indexEntries.get(fileThreadId), this.settings);
                    report.filesParsed += 1;
                    this.state.files[path.resolve(file.path)] = {
                        fingerprint,
                        threadId: session.threadId,
                        status: session.status,
                    };
                    report.malformedRecords += session.malformedRecords;
                    report.oversizedRecords += session.oversizedRecords;
                    session.sourceFingerprint = fingerprint;
                    session.fileMtimeMs = file.mtimeMs;
                    const activityMonth = formatDate(session.lastActivityAt).slice(0, 7);
                    report.parsedByActivityMonth[activityMonth] = (report.parsedByActivityMonth[activityMonth] || 0) + 1;
                    if (session.isGuardianReview && this.settings.excludeGuardianReviewSessions) {
                        report.guardianReviewSkipped += 1;
                        report.guardianSkippedByMonth[activityMonth] = (report.guardianSkippedByMonth[activityMonth] || 0) + 1;
                        const previous = this.state.sessions[session.threadId];
                        if (previous === null || previous === void 0 ? void 0 : previous.notePath) {
                            const oldNote = this.app.vault.getAbstractFileByPath(previous.notePath);
                            if (oldNote instanceof TFile) {
                                await this.app.fileManager.trashFile(oldNote);
                                report.guardianNotesTrashed += 1;
                            }
                            delete this.state.sessions[session.threadId];
                        }
                        continue;
                    }
                    if (session.isRecommendedPluginSession && this.settings.excludeRecommendedPluginSessions) {
                        report.recommendedPluginSkipped += 1;
                        report.recommendedSkippedByMonth[activityMonth] = (report.recommendedSkippedByMonth[activityMonth] || 0) + 1;
                        const previous = this.state.sessions[session.threadId];
                        if (previous === null || previous === void 0 ? void 0 : previous.notePath) {
                            const oldNote = this.app.vault.getAbstractFileByPath(previous.notePath);
                            if (oldNote instanceof TFile) {
                                await this.app.fileManager.trashFile(oldNote);
                                report.recommendedPluginNotesTrashed += 1;
                            }
                            delete this.state.sessions[session.threadId];
                        }
                        continue;
                    }
                    if (session.isSubagent && !this.settings.includeSubagents) {
                        report.subagentsSkipped += 1;
                        continue;
                    }
                    if (!session.items.some((item) => item.role === "user" || item.role === "assistant")) {
                        report.emptySkipped += 1;
                        continue;
                    }
                    parsedByThread.set(session.threadId, choosePreferredSession(parsedByThread.get(session.threadId), session));
                }
                catch (error) {
                    report.errors.push(`${file.path}: ${error.message}`);
                }
            }
            for (const session of parsedByThread.values()) {
                try {
                    await this.importSessionImages(session, report);
                    const markdown = renderSessionMarkdown(session, this.settings);
                    const result = await this.upsertSessionNote(session, markdown);
                    report[result.action] += 1;
                    this.state.sessions[session.threadId] = {
                        sourcePath: session.sourceFile,
                        fingerprint: session.sourceFingerprint,
                        notePath: result.notePath,
                        status: session.status,
                        updatedAt: session.updatedAt,
                        lastActivityAt: session.lastActivityAt,
                        sourceModifiedAt: session.sourceModifiedAt,
                        title: session.title,
                    };
                }
                catch (error) {
                    report.errors.push(`${session.threadId}: ${error.message}`);
                }
            }
            this.state.renderSignature = currentSignature;
            report.finishedAt = nowIso();
            report.durationMs = Date.now() - started;
            report.reportPath = await this.writeReport(report, codexRoot);
            await this.savePluginData();
            new ImportSummaryModal(this.app, report).open();
            new Notice(`Codex import complete: ${report.imported} imported, ${report.updated} updated, ${report.skipped} unchanged.`);
        }
        catch (error) {
            report.finishedAt = nowIso();
            report.durationMs = Date.now() - started;
            new Notice(`Codex import failed: ${error.message}`);
        }
        finally {
            this.importInProgress = false;
        }
    }
}
exports.default = CodexArchiveImporterPlugin;
// Pure helpers exported for the included self-test. They are not part of the
// user-facing Obsidian API.
exports.__test = {
    cleanGeneratedUserText,
    extractImageRefsFromText,
    contentPartsToText,
    deduplicateTranscript,
    desiredNotePath,
    extractThreadIdFromFileName,
    parseCodexSessionFile,
    isGuardianReviewSession,
    isRecommendedPluginSession,
    redactSensitiveText,
    renderSessionMarkdown,
    parseTimestampMs,
    collectTimestampMsDeep,
    scanCodexFiles,
    validateCodexRoot,
    collectChatgptSidebarEntries,
    extractChatgptCacheEntriesFromText,
    discoverChatgptCacheEntries,
    renderChatgptCacheIndexNote,
};

module.exports = exports.default;
