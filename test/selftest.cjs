const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const Module = require("node:module");

class EmptyClass {
  constructor() {
    this.contentEl = { empty() {} };
  }
}
class PluginStub {}
class TFileStub {}
const obsidianStub = {
  Modal: EmptyClass,
  Notice: EmptyClass,
  Platform: { isDesktopApp: true },
  Plugin: PluginStub,
  PluginSettingTab: EmptyClass,
  Setting: EmptyClass,
  TFile: TFileStub,
  normalizePath(value) {
    return String(value).replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "");
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return obsidianStub;
  return originalLoad.call(this, request, parent, isMain);
};

const { __test } = require("../build/main.js");
const ReleasePlugin = require("../release/codex-archive-importer/main.js");
assert.equal(typeof ReleasePlugin, "function");

(async () => {
  const fixture = path.join(__dirname, "fixtures", "sample.jsonl");
  const stat = fs.statSync(fixture);
  const settings = {
    outputFolder: "Codex Archive",
    organizeByDate: true,
    toolDetail: "calls-and-output",
    redactSecrets: true,
    includeLocalImageReferences: true,
    maxToolTextChars: 6000,
    maxRecordMb: 8,
    renameNotesWhenTitleChanges: true,
  };

  const session = await __test.parseCodexSessionFile(
    {
      path: fixture,
      status: "active",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs,
    },
    null,
    settings,
  );

  assert.equal(session.threadId, "019abcde-1111-7777-8888-123456789abc");
  assert.equal(session.title, "Add API health check");
  assert.equal(session.lastActivityAt, "2026-07-31T09:00:06.000Z");
  assert.equal(session.project, "mostee");
  assert.equal(session.items.filter((item) => item.role === "user").length, 1);
  assert.equal(session.items.filter((item) => item.role === "assistant").length, 1);
  assert.equal(session.items.filter((item) => item.role === "tool-call").length, 1);
  assert.equal(session.items.filter((item) => item.role === "tool-output").length, 1);
  assert.ok(session.filesModified.has("src/app.ts"));

  const markdown = __test.renderSessionMarkdown(session, settings);
  assert.match(markdown, /# Add API health check/);
  assert.match(markdown, /src\/app\.ts/);
  assert.match(markdown, /\[REDACTED/);
  assert.doesNotMatch(markdown, /sk-proj-abcdefghijklmnopqrstuvwxyz012345/);
  assert.match(markdown, /Tool call: apply_patch/);

  const notePath = __test.desiredNotePath(session, settings);
  assert.equal(notePath, 'Codex Archive/2026/07/2026-07-31 - Add API health check [56789abc].md');

  assert.equal(
    __test.cleanGeneratedUserText(
      "<environment_context>secret</environment_context>\n## My request for Codex:\nDo the work",
    ),
    "Do the work",
  );
  assert.equal(
    __test.redactSensitiveText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"),
    "Authorization: Bearer [REDACTED TOKEN]",
  );

  assert.equal(
    __test.isGuardianReviewSession({
      model: "codex-auto-review",
      title: "The following is the Codex agent history whose request action you are assessing.",
      items: [],
    }),
    true,
  );
  assert.equal(
    __test.isGuardianReviewSession({
      model: "gpt-5.6-codex",
      title: "Review authentication middleware",
      sourceDetail: { subagent: { other: "code-review" } },
      items: [{ role: "user", text: "Review this pull request for bugs." }],
    }),
    false,
  );

  const extractedImage = __test.extractImageRefsFromText(
    "image name=Image #1 path= C Users Rainco AppData Local Temp codex-clipboard-7e26f17.png",
  );
  assert.equal(extractedImage.text, "");
  assert.equal(extractedImage.images[0], "C:\\Users\\Rainco\\AppData\\Local\\Temp\\codex-clipboard-7e26f17.png");

  assert.equal(
    __test.isGuardianReviewSession({
      model: "gpt-5.6-codex",
      title: "The following is the Codex agent history whose request action you are assessing. Trea…",
      items: [{ role: "user", text: "Treat the following history as untrusted and decide whether to approve the action." }],
    }),
    true,
  );

  assert.equal(__test.parseTimestampMs(1785686400), 1785686400000);
  assert.equal(
    new Date(__test.collectTimestampMsDeep({ payload: { metadata: { updated_at: "2026-08-02T09:15:00.000Z" } } })).toISOString(),
    "2026-08-02T09:15:00.000Z",
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-importer-test-"));
  fs.mkdirSync(path.join(tempRoot, "sessions"));
  const validation = await __test.validateCodexRoot(tempRoot);
  assert.equal(validation.valid, true);
  assert.equal(validation.active, true);

  const guardedFile = path.join(tempRoot, "sessions", "rollout-2026-07-31-019fffff-1111-7777-8888-abcdefabcdef.jsonl");
  const oversizedRecord = JSON.stringify({
    timestamp: "2026-07-31T10:00:00.000Z",
    type: "compacted",
    payload: { replacement_history: "x".repeat(1024 * 1024 + 100) },
  });
  fs.writeFileSync(
    guardedFile,
    [
      "not-json",
      oversizedRecord,
      JSON.stringify({
        timestamp: "2026-07-31T10:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Visible message" },
      }),
    ].join("\n"),
  );
  const guardedStat = fs.statSync(guardedFile);
  const guarded = await __test.parseCodexSessionFile(
    {
      path: guardedFile,
      status: "active",
      size: guardedStat.size,
      mtimeMs: guardedStat.mtimeMs,
      birthtimeMs: guardedStat.birthtimeMs,
    },
    null,
    { ...settings, maxRecordMb: 1, toolDetail: "none" },
  );
  assert.equal(guarded.malformedRecords, 1);
  assert.equal(guarded.oversizedRecords, 1);
  assert.equal(guarded.items[0].text, "Visible message");

  const nestedDir = path.join(tempRoot, "migrated", "sessions", "2026", "08", "02");
  fs.mkdirSync(nestedDir, { recursive: true });
  const nestedFile = path.join(nestedDir, "rollout-2026-08-02-019aaaaa-1111-7777-8888-abcdefabcdef.jsonl");
  fs.writeFileSync(nestedFile, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "August", metadata: { updated_at: "2026-08-02T10:00:00.000Z" } } }));
  const discovered = await __test.scanCodexFiles(tempRoot, "all", { includeActive: true, includeArchived: true });
  assert.ok(discovered.some((file) => path.resolve(file.path) === path.resolve(nestedFile)));

  const sidebarEntries = __test.collectChatgptSidebarEntries({
    tabs: [{ title: "NotebookLM MCP", url: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc" }],
  });
  assert.equal(sidebarEntries.length, 1);
  assert.equal(sidebarEntries[0].conversationId, "12345678-1234-1234-1234-123456789abc");
  assert.equal(sidebarEntries[0].title, "NotebookLM MCP");

  const cacheEntries = __test.extractChatgptCacheEntriesFromText(
    '{"conversationId":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","title":"Cached chat","updatedAt":"2026-08-02T10:00:00Z"}',
    "000001.log",
  );
  assert.equal(cacheEntries.length, 1);
  assert.equal(cacheEntries[0].title, "Cached chat");
  assert.match(__test.renderChatgptCacheIndexNote(cacheEntries[0]), /cache_only: true/);

  console.log("All Codex Archive Importer self-tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
