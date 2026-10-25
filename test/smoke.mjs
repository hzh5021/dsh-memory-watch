/**
 * dsh-memory-watch 离线冒烟测试。
 *
 * 不连宿主、不碰真家：假 ctx + 临时目录，把每条路径都走一遍。
 * 跑法：node test/smoke.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mod = await import("../lib/index.js");
const I = mod._internals;

let passed = 0;
function ok(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${label}`);
  } catch (error) {
    console.error(`FAIL  ${label}`);
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
async function okAsync(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${label}`);
  } catch (error) {
    console.error(`FAIL  ${label}`);
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}

console.log("dsh-memory-watch · smoke");

// ── 1. 选项 ────────────────────────────────────────────────────────────────
ok("resolveOptions：默认值成形", () => {
  const o = I.resolveOptions();
  assert.equal(o.home, I.DEFAULT_HOME);
  assert.equal(o.ledger, I.DEFAULT_LEDGER);
  assert.equal(o.enabled, true);
  assert.equal(o.highRatio, 0.7);
  assert.equal(o.floorRatio, 0.45);
  assert.equal(o.keepSections, 12);
});

ok("resolveOptions：越界值被夹住，非法值退回默认", () => {
  const o = I.resolveOptions({ highRatio: 7, floorRatio: -3, keepSections: 0, cooldownMs: -5, enabled: false });
  assert.equal(o.highRatio, 1);
  assert.equal(o.floorRatio, 0);
  assert.equal(o.keepSections, 1);
  assert.equal(o.cooldownMs, 0);
  assert.equal(o.enabled, false);
});

// ── 2. 消息形状 ────────────────────────────────────────────────────────────
ok("snapshotMessage：形状是 role/content/source", () => {
  const m = I.snapshotMessage("hello");
  assert.equal(m.role, "user");
  assert.deepEqual(m.content, [{ type: "text", text: "hello" }]);
  assert.equal(m.source.kind, I.SOURCE);
  assert.equal(m.source.form, "snapshot");
});

ok("reminderText：带上压力/窗口/比例，且不出现档案段（没传）", () => {
  const t = I.reminderText({ pressure: 100000, projected: 120000, window: 200000, ratio: 0.6 });
  assert.match(t, /memory-watch/);
  assert.match(t, /120000/);
  assert.match(t, /200000/);
  assert.match(t, /60%/);
  assert.doesNotMatch(t, /账本自己也压过/);
});

ok("reminderText：有档案结果时补一句", () => {
  const t = I.reminderText({ pressure: 1, archive: { archivedSections: 5 } });
  assert.match(t, /搬走 5 节/);
});

// ── 3. 压力读取 ────────────────────────────────────────────────────────────
ok("readPressure：优先读 contextPressure 投影", () => {
  const ctx = { sessionProjections: { stateOf: () => ({ pressureTokens: 10, projectedTokens: 11, contextWindow: 100 }) } };
  const f = I.readPressure(ctx, { session: { id: "s1" } });
  assert.equal(f.source, "projection");
  assert.equal(f.pressure, 10);
  assert.equal(f.projected, 11);
  assert.equal(f.window, 100);
});

ok("readPressure：投影抛错时退回 tokenMeter.measure", () => {
  const ctx = {
    sessionProjections: { stateOf: () => { throw new Error("boom"); } },
    tokenMeter: { measure: () => ({ totalTokens: 4242 }) },
  };
  const f = I.readPressure(ctx, { session: { id: "s1" } });
  assert.equal(f.source, "measure");
  assert.equal(f.pressure, 4242);
  assert.equal(f.window, null);
});

ok("readPressure：什么都没有时返回 none，不抛", () => {
  const f = I.readPressure({}, {});
  assert.equal(f.source, "none");
  assert.equal(f.pressure, null);
});

// ── 4. 说话时机 ────────────────────────────────────────────────────────────
const O = I.resolveOptions({ cooldownMs: 60_000, minGrowthTokens: 10_000 });
const idle = { lastInjectedAt: null, lastInjectedTokens: null };

ok("shouldSpeak：高水位直接说", () => {
  const v = I.shouldSpeak({ pressure: 150_000, projected: null, window: 200_000 }, idle, O, 1_000_000);
  assert.equal(v.speak, true);
  assert.equal(v.reason, "high");
});

ok("shouldSpeak：低水位不说", () => {
  const v = I.shouldSpeak({ pressure: 10_000, projected: null, window: 200_000 }, idle, O, 1_000_000);
  assert.equal(v.speak, false);
  assert.equal(v.reason, "below-floor");
});

ok("shouldSpeak：中段要长够 minGrowthTokens 才说", () => {
  const memory = { lastInjectedAt: 0, lastInjectedTokens: 100_000 };
  const small = I.shouldSpeak({ pressure: 105_000, projected: null, window: 200_000 }, memory, O, 10_000_000);
  assert.equal(small.speak, false);
  assert.equal(small.reason, "no-growth");
  const big = I.shouldSpeak({ pressure: 130_000, projected: null, window: 200_000 }, memory, O, 10_000_000);
  assert.equal(big.speak, true);
  assert.equal(big.reason, "growth");
});

ok("shouldSpeak：防抖期内不说话", () => {
  const memory = { lastInjectedAt: 1_000_000, lastInjectedTokens: 0 };
  const v = I.shouldSpeak({ pressure: 199_000, projected: null, window: 200_000 }, memory, O, 1_030_000);
  assert.equal(v.speak, false);
  assert.equal(v.reason, "cooldown");
});

ok("shouldSpeak：没有窗口时用绝对兜底线", () => {
  const o = I.resolveOptions({ absoluteFallbackTokens: 50_000, cooldownMs: 0, minGrowthTokens: 0 });
  assert.equal(I.shouldSpeak({ pressure: 10_000, projected: null, window: null }, idle, o, 0).speak, false);
  const v = I.shouldSpeak({ pressure: 60_000, projected: null, window: null }, idle, o, 0);
  assert.equal(v.speak, true);
  assert.equal(v.reason, "absolute");
});

ok("shouldSpeak：projected 比 pressure 优先", () => {
  const v = I.shouldSpeak({ pressure: 1000, projected: 150_000, window: 200_000 }, idle, O, 0);
  assert.equal(v.effective, 150_000);
});

// ── 5. 切节与提要 ──────────────────────────────────────────────────────────
ok("splitSections：前言与节分得开", () => {
  const text = "# 标题\n\n说明一句。\n\n## 甲\n正文甲\n\n## 乙\n正文乙\n";
  const { preamble, sections } = I.splitSections(text);
  assert.match(preamble, /^# 标题/);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, "甲");
  assert.equal(sections[1].title, "乙");
});

ok("condense：标题 + 前几行，长行截断", () => {
  const long = "啊".repeat(300);
  const c = I.condense({ title: "很久以前", body: `${long}\n第二行\n第三行\n第四行` }, { maxLines: 2, maxChars: 600 });
  assert.match(c, /^- \*\*很久以前\*\*/m);
  assert.match(c, /…/);
  const lines = c.split("\n").filter(l => l.startsWith("  - "));
  assert.equal(lines.length, 2);
});

// ── 6. 滚动压缩（纯函数） ──────────────────────────────────────────────────
function fakeLedger(n) {
  const parts = ["# 长期记忆库\n\n> 说明。\n"];
  for (let i = 1; i <= n; i += 1) {
    parts.push(`\n## 2026-10-${String(i).padStart(2, "0")} · 第 ${i} 件事\n\n${"正文。".repeat(120)}\n`);
  }
  return parts.join("");
}

ok("consolidateLedger：节数不够时不动", () => {
  const text = fakeLedger(5);
  const r = I.consolidateLedger(text, { keepSections: 12 });
  assert.equal(r.archived, null);
  assert.equal(r.reason, "nothing-old");
  assert.equal(r.text, text);
});

ok("consolidateLedger：搬走最老的、留下最新的", () => {
  const text = fakeLedger(20);
  const r = I.consolidateLedger(text, { keepSections: 12 });
  assert.equal(r.reason, "consolidated");
  assert.equal(r.archived.length, 8);
  assert.equal(r.archived[0].title.includes("第 1 件事"), true);
  assert.ok(r.savedChars > 0);
  assert.match(r.text, /## 巩固层/);
  assert.match(r.text, /## 2026-10-20 · 第 20 件事/);
  assert.doesNotMatch(r.text, /第 1 件事\n\n正文/);
});

ok("consolidateLedger：再压一遍不动（幂等）", () => {
  const first = I.consolidateLedger(fakeLedger(20), { keepSections: 12 });
  const second = I.consolidateLedger(first.text, { keepSections: 12 });
  assert.equal(second.archived, null);
  assert.equal(second.text, first.text);
});

ok("consolidateLedger：有超大节时宁可不压", () => {
  const big = `# 头\n\n## 超大节\n${"x".repeat(500)}\n\n## 小节甲\n正文\n\n## 小节乙\n正文\n`;
  const r = I.consolidateLedger(big, { keepSections: 1, minArchiveSections: 1, sectionMaxChars: 100 });
  assert.equal(r.reason, "oversize-section");
});

// ── 6b. 按日期判新旧 ──────────────────────────────────────────────────────

ok("sectionDate：认得出标题里的日期，认不出给 null", () => {
  assert.equal(I.sectionDate("2026-10-26 03:45 · 错题集搬家"), Date.UTC(2026, 9, 26));
  assert.equal(I.sectionDate("2026-10-25 凌晨 · 某个凌晨的节"), Date.UTC(2026, 9, 25));
  assert.equal(I.sectionDate("2026-10-19 ~ 2026-10-22（旧节已搬）"), Date.UTC(2026, 9, 19));
  assert.equal(I.sectionDate("巩固层（旧节的提要）"), null);
});

ok("consolidateLedger：账是「新在前」时，搬的仍是日期最旧的那批", () => {
  // fakeLedger 是"旧在前"；这里倒过来，模拟"新节插在最前面"那种真实写法。
  const chunks = [];
  for (let i = 20; i >= 1; i -= 1) {
    chunks.push(`\n## 2026-10-${String(i).padStart(2, "0")} · 第 ${i} 件事\n\n${"正文。".repeat(120)}\n`);
  }
  const reversed = `# 头\n\n> 说明\n${chunks.join("")}`;
  const r = I.consolidateLedger(reversed, { keepSections: 12 });
  assert.equal(r.reason, "consolidated");
  assert.equal(r.archived.length, 8);
  assert.equal(r.archived[0].title.includes("第 1 件事"), true);
  assert.equal(r.archived[7].title.includes("第 8 件事"), true);
  assert.match(r.text, /## 2026-10-20 · 第 20 件事/);
});

ok("consolidateLedger：无日期的节不动，也不占 keep 名额", () => {
  const body = "正文。".repeat(120);
  const text = `# 头\n\n## 备忘甲\n没有日期\n\n## 2026-10-01 · 老一\n${body}\n\n## 2026-10-02 · 老二\n${body}\n\n## 2026-10-03 · 老三\n${body}\n`;
  const r = I.consolidateLedger(text, { keepSections: 1, minArchiveSections: 1 });
  assert.equal(r.reason, "consolidated");
  assert.equal(r.archived.length, 2);
  assert.equal(r.archived[0].title, "2026-10-01 · 老一");
  assert.match(r.text, /## 备忘甲/);
  assert.match(r.text, /## 2026-10-03 · 老三/);
  assert.doesNotMatch(r.text, /## 2026-10-01 · 老一/);
});

ok("consolidateLedger：巩固层排在中间也被认出来（只留一个、不搬、提要没丢）", () => {
  const body = "正文。".repeat(120);
  const text = [
    "# 头", "", "> 说明", "",
    "## 2026-10-05 · 新节", "", body, "",
    "## 巩固层（旧节的提要）", "", "> 2026-10-20 旧节的提要。", "", "- **很旧的一节**", "",
    "## 2026-10-01 · 老一", "", body, "",
    "## 2026-10-02 · 老二", "", body, "",
  ].join("\n");
  const r = I.consolidateLedger(text, { keepSections: 1, minArchiveSections: 1 });
  assert.equal(r.reason, "consolidated");
  assert.equal(r.text.split("\n").filter(line => line.trim() === "## 巩固层（旧节的提要）").length, 1);
  assert.equal(r.archived.some(section => section.title.includes("巩固层")), false);
  assert.match(r.text, /很旧的一节/);
  assert.match(r.text, /## 2026-10-05 · 新节/);
});

// ── 7. 落磁盘（临时家） ────────────────────────────────────────────────────
const home = await mkdtemp(join(tmpdir(), "memwatch-"));
await writeFile(join(home, "长期记忆库.md"), fakeLedger(20), "utf8");
const options = I.resolveOptions({ home, keepSections: 12 });

await okAsync("consolidateHome：主本瘦了、档案长出来了", async () => {
  const result = await I.consolidateHome(options);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.archivedSections, 8);
  const ledger = await readFile(join(home, "长期记忆库.md"), "utf8");
  assert.match(ledger, /## 巩固层/);
  const archiveInfo = await stat(join(home, "记忆档案", I.ARCHIVE_FILE));
  assert.ok(archiveInfo.size > 1000);
  const archive = await readFile(join(home, "记忆档案", I.ARCHIVE_FILE), "utf8");
  assert.match(archive, /第 1 件事/);
  assert.match(archive, /归档（共 8 节）/);
});

await okAsync("consolidateHome：第二遍不再动", async () => {
  const again = await I.consolidateHome(options);
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
});

await okAsync("consolidateHome：账本不存在时安静返回错误", async () => {
  const result = await I.consolidateHome(I.resolveOptions({ home: join(home, "nope") }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "error");
});

// ── 7b. 没配家：只提醒，一次磁盘动作都不做 ─────────────────────────────────
const bare = { ...I.resolveOptions({}), home: "", worknoteFile: "" };

await okAsync("consolidateHome：没配 home 时不碰文件，回 no-home", async () => {
  const before = (await readdir(process.cwd())).sort();
  const result = await I.consolidateHome(bare);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-home");
  const after = (await readdir(process.cwd())).sort();
  assert.deepEqual(after, before, "当前工作目录里不该多出任何东西");
});

await okAsync("consolidateWorknote：没配笔记时整条跳过", async () => {
  const result = await I.consolidateWorknote(bare);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-worknote");
});

await okAsync("consolidateWorknote：相对路径 + 没配 home 时也不写盘", async () => {
  const result = await I.consolidateWorknote({ ...bare, worknoteFile: "相对笔记.md" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-home");
});

// ── 8. apply() 的接线 ─────────────────────────────────────────────────────
ok("apply：pre-step 在压力到线时追加一条 snapshot 消息", () => {
  const handlers = new Map();
  const ctx = {
    on(type, fn) {
      const list = handlers.get(type) ?? [];
      list.push(fn);
      handlers.set(type, list);
    },
    sessionProjections: { stateOf: () => ({ pressureTokens: 190_000, projectedTokens: 195_000, contextWindow: 200_000 }) },
  };
  mod.apply(ctx, { home, cooldownMs: 0, probeFile: "" });
  const handler = handlers.get("agent/pre-step")[0];
  const decision = { kind: "allow", messages: [{ role: "user", content: [{ type: "text", text: "原有消息" }] }] };
  return handler({ agent: { session: { id: "s1" } }, signal: { aborted: false } }, async () => decision).then(out => {
    assert.equal(out.messages.length, 2);
    assert.equal(out.messages[0].content[0].text, "原有消息");
    assert.equal(out.messages[1].source.kind, I.SOURCE);
  });
});

ok("apply：压力低时原样返回（同一条消息引用）", async () => {
  const handlers = new Map();
  const ctx = {
    on(type, fn) {
      handlers.set(type, (handlers.get(type) ?? []).concat(fn));
    },
    sessionProjections: { stateOf: () => ({ pressureTokens: 1_000, contextWindow: 200_000 }) },
  };
  mod.apply(ctx, { home, cooldownMs: 0, absoluteFallbackTokens: 0, probeFile: "" });
  const handler = handlers.get("agent/pre-step")[0];
  const decision = { kind: "allow", messages: [] };
  const out = await handler({ agent: { session: { id: "s2" } }, signal: { aborted: false } }, async () => decision);
  assert.equal(out, decision);
});

ok("apply：reject 决策不被插手", async () => {
  const handlers = new Map();
  const ctx = {
    on(type, fn) {
      handlers.set(type, (handlers.get(type) ?? []).concat(fn));
    },
    sessionProjections: { stateOf: () => ({ pressureTokens: 999_999, contextWindow: 1 }) },
  };
  mod.apply(ctx, { home, cooldownMs: 0, probeFile: "" });
  const handler = handlers.get("agent/pre-step")[0];
  const decision = { kind: "reject", messages: [] };
  const out = await handler({ agent: { session: { id: "s3" } }, signal: { aborted: false } }, async () => decision);
  assert.equal(out, decision);
});

// ── 7b. 第二本账（错题集那类） ────────────────────────────────────────────

await okAsync("consolidateMistakes：临时家里搬走旧节，原文进 错题集-归档.md", async () => {
  const mhome = await mkdtemp(join(tmpdir(), "memwatch-mistakes-"));
  const body = "正文。".repeat(120);
  const chunks = ["# 错题集", "", "> 规矩", ""];
  for (let i = 20; i >= 1; i -= 1) {
    chunks.push(`## 2026-10-${String(i).padStart(2, "0")}`, "", `- **第 ${i} 件事**`, "  - 错在哪：某某", "", body, "");
  }
  await writeFile(join(mhome, "错题集.md"), chunks.join("\n"), "utf8");
  const opts = I.resolveOptions({ home: mhome, mistakesKeepSections: 3, mistakesMinArchiveSections: 1 });
  assert.equal(opts.mistakesFile, "错题集.md");
  assert.equal(opts.mistakesKeepSections, 3);
  const result = await I.consolidateMistakes(opts);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.archivedSections, 17);
  const book = await readFile(join(mhome, "错题集.md"), "utf8");
  assert.match(book, /## 巩固层/);
  assert.match(book, /## 2026-10-20/);
  assert.doesNotMatch(book, /## 2026-10-01\n\n- \*\*第 1 件事\*\*/);
  const archive = await readFile(join(mhome, "记忆档案", "错题集-归档.md"), "utf8");
  assert.match(archive, /第 1 件事/);
  assert.match(archive, /归档（共 17 节）/);
  const again = await I.consolidateMistakes(opts);
  assert.equal(again.changed, false);
  await rm(mhome, { recursive: true, force: true });
});

await okAsync("consolidateMistakes：节不够时不动；配成 null 或没 home 就跳过", async () => {
  const mhome = await mkdtemp(join(tmpdir(), "memwatch-mistakes2-"));
  await writeFile(join(mhome, "错题集.md"), "# 错题集\n\n## 2026-10-25\n\n- 一条\n", "utf8");
  const first = await I.consolidateMistakes(I.resolveOptions({ home: mhome }));
  assert.equal(first.changed, false);
  assert.equal(first.reason, "nothing-old");
  const off = await I.consolidateMistakes(I.resolveOptions({ home: mhome, mistakesFile: null }));
  assert.equal(off.reason, "no-mistakes");
  const noHome = await I.consolidateMistakes(I.resolveOptions({ home: "" }));
  assert.equal(noHome.reason, "no-home");
  await rm(mhome, { recursive: true, force: true });
});

// ── 9. 启动探针 ───────────────────────────────────────────────────────────

ok("resolveOptions：探针默认不写，配了才写", () => {
  assert.equal(I.resolveOptions().probeFile, "");
  assert.equal(I.resolveOptions({ probeFile: "probe.log" }).probeFile, "probe.log");
  assert.equal(I.resolveOptions({ probeFile: null }).probeFile, "");
});

await okAsync("writeProbe：追一行，带版本、代码哈希和三条结论", async () => {
  const phome = await mkdtemp(join(tmpdir(), "memwatch-probe-"));
  const probe = join(phome, "probe.log");
  const options = I.resolveOptions({ home: phome, probeFile: probe });
  const r = await I.writeProbe(options, {
    home: { ok: true, changed: false, reason: "nothing-fresh" },
    worknote: { ok: true, changed: true, archivedSections: 3, savedChars: 1234 },
    mistakes: { ok: false, reason: "error" },
  });
  assert.equal(r.ok, true);
  const first = await readFile(probe, "utf8");
  assert.match(first, /code=[0-9a-f]{12}/);
  assert.match(first, /ledger=nothing-fresh/);
  assert.match(first, /worknote=搬了3节/);
  assert.match(first, /mistakes=失败:error/);
  const r2 = await I.writeProbe(options, { home: { ok: true, changed: false, reason: "nothing-old" } });
  assert.equal(r2.ok, true);
  assert.equal((await readFile(probe, "utf8")).trim().split("\n").length, 2);
  const no = await I.writeProbe(I.resolveOptions({ home: phome, probeFile: null }), {});
  assert.equal(no.reason, "no-probe");
  await rm(phome, { recursive: true, force: true });
});

await okAsync("apply：启动时自己往探针里留一行", async () => {
  const ahome = await mkdtemp(join(tmpdir(), "memwatch-apply-probe-"));
  await writeFile(join(ahome, "长期记忆库.md"), "# 账\n\n## 2026-10-20 · 甲\n正文\n", "utf8");
  const probe = join(ahome, "probe.log");
  mod.apply({ on() {} }, { home: ahome, probeFile: probe });
  await new Promise(resolve => setTimeout(resolve, 300));
  const text = await readFile(probe, "utf8");
  assert.match(text, /ledger=nothing-old/);
  assert.match(text, /code=[0-9a-f]{12}/);
  await rm(ahome, { recursive: true, force: true });
});

// ── 收尾 ───────────────────────────────────────────────────────────────────
await rm(home, { recursive: true, force: true });
await rm(join(home, "记忆档案"), { recursive: true, force: true }).catch(() => {});

console.log(`\n${passed} 条通过${process.exitCode ? "，有失败" : "，全绿"}`);