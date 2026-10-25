/**
 * dsh-memory-watch — 会话压力上来之前，先把该记的记下来。
 *
 * 为什么有这东西：
 * DSH 自己会压缩会话（`dsh-compaction-basic`）：压力到窗口约八成，它把最旧的
 * 一段摘要成一条 `<compacted-summary>`，近期一成六逐字留着。那套模板是给写代码
 * 用的工程八节（文件路径 / 错误与修复 / 下一步），拿它压对话里的偏好和取舍，
 * 出来多半只剩一句"用户偏好简短回复"，疼的地方全丢。而且它的自认计数是
 * 「每 token 四字符」的启发式，对中文严重低估 —— 整场都是中文时，压缩可能不
 * 打招呼就来。
 *
 * 所以这个插件不做第二套压缩，只做两件更靠前的事：
 *
 *  1. **盯压力、递话**：挂在 `agent/pre-step`，量当前会话的 token 压力。到线了
 *     就在这一轮开口之前把一句提醒塞进消息里 —— "该落盘了，别等压缩把你这段
 *     抹平"。注入走 pre-step、不走 `agent.inject`：wakeup 那条要等下一轮才看得见，
 *     这里要的是当场。
 *
 *  2. **顺手兑账**：那本账只长不缩，按天涨。插件提供一个纯函数的滚动压缩：
 *     最旧的若干节，正文搬去 `记忆档案\`（冻结不删），原处留一行"提要"
 *     （日期 + 标题 + 前几行要点）。信息没丢，主本不再涨。**不调模型、不猜内容**，
 *     全是确定性的字符串处理。**没配 home 就整条跳过**，一次磁盘动作都不做。
 *
 * 设计约束（照 `dsh-wakeup` 的路子）：
 *  - 不 import 任何 `@deepseek-ai/*`：宿主那套 peerDependency 版本跟 npm 上的
 *    不是同一个；消息按 DSH 的 `{ role, content, source }` 形状手搓。
 *  - 一切失败都吞掉：监视器绝不能因为量不出压力就把 agent 卡住。
 *
 * @module dsh-memory-watch
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** 插件身份，落在加载器的花名册上。 */
export const name = "memory-watch";

/** 不声明依赖任何宿主服务：只监听事件、只用内置模块。 */
export const inject = [];

/** 注入消息的 source.kind —— 别的插件/日志靠它认出这条是谁塞的。 */
const SOURCE = "dsh-memory-watch";

/**
 * 默认的家：**空**。不配就一次磁盘动作都不做（只做提醒）。
 * config.home / 环境变量 DSH_MEMORY_WATCH_HOME 可覆盖。
 */
const DEFAULT_HOME = "";

/** 那本只长不缩的账。 */
const DEFAULT_LEDGER = "长期记忆库.md";

/** 被搬走的原文放哪儿（家目录下的子目录）。 */
const DEFAULT_ARCHIVE_DIR = "记忆档案";

/** 原文落到档案里的文件名。 */
const ARCHIVE_FILE = "长期记忆库-归档.md";

/**
 * 家目录之外的另一本笔记（可选）：**默认空 = 不管它**。
 * 它通常不在家目录里，所以用绝对路径配；不想要就 config.worknoteFile: null。
 */
const DEFAULT_WORKNOTE_FILE = "";
const DEFAULT_WORKNOTE_ARCHIVE_DIR = "";
/** 这本笔记留最新多少节不动。它通常更碎更长，所以比家里的账留得多些。 */
const DEFAULT_WORKNOTE_KEEP_SECTIONS = 20;

/**
 * 第二本要滚动的账（可选）：错题集那类"一天一节、一节底下是若干条"的本子。
 * 默认文件名是个通用的中文名，跟 ledger 同理，可以自己改；**没配 home 就整条跳过**。
 * 粒度和工位笔记不同：它一天一节，一节里可能还挂着没办完的待办，
 * 所以留得比工位多（8 节）、一次也至少攒够两节才搬 —— 免得单独一天的待办被一行提要埋掉。
 */
const DEFAULT_MISTAKES_FILE = "错题集.md";
const DEFAULT_MISTAKES_KEEP_SECTIONS = 8;
const DEFAULT_MISTAKES_MIN_ARCHIVE = 2;
/** 一节留几行提要。一天一节的账，比长期记忆库宽一点。 */
const DEFAULT_MISTAKES_CONDENSED_LINES = 6;

/**
 * 启动探针（可选）：**默认空 = 不写**。
 *
 * 配上它，每次启动往这个文件追一行：版本、**正在跑的那份代码自己的 sha256**、
 * 以及三本账各自的结论。它要解决的是一个很实际的难处 —— 这个插件沉默干活、
 * 出事也吞掉，所以"它到底跑没跑"从账面上看不出来；本地插件又常常存在源目录与
 * profile 副本两份，改了源目录而实际加载副本，是踩过的坑。有了 `code=` 那一段，
 * "加载的是哪一份"就不用猜。
 *
 * 它写的是机器日志，不是账；建议放在工作区而不是账本目录里。
 */
const DEFAULT_PROBE_FILE = "";

/**
 * 巩固层的标题行（**带 `## `**，就是写进主本里那一整行）。
 * 这里曾经从 `## 巩固层…` 误改成纯标题，结果拼接处又多补了一个 `## `，
 * 成了 `## ## 巩固层…`，splitSections 认不出自己写的那一节。
 * 判据：写进文件的和拿来比对的必须是同一个字符串。
 */
const CONSOLIDATED_HEADING = "## 巩固层（旧节的提要）";

/** 同一个标题的裸文本（不带 `## `）。比对节标题时只认这一个字符串，别现场拼。 */
const CONSOLIDATED_TITLE = CONSOLIDATED_HEADING.replace(/^##\s+/, "");

/** 默认的高水位：占窗口这个比例就直接提醒。 */
const DEFAULT_HIGH_RATIO = 0.7;

/** 默认的低水位：低于它就完全不打扰。 */
const DEFAULT_FLOOR_RATIO = 0.45;

/** 两次提醒之间至少要长这么多 token，否则一声不吭。 */
const DEFAULT_MIN_GROWTH_TOKENS = 24_000;

/** 两次提醒之间至少隔这么多毫秒（防抖：一轮里连发没意义）。 */
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

/** 没有窗口信息时的绝对兜底线（有窗口就不用它）。0 = 关掉兜底。 */
const DEFAULT_ABSOLUTE_FALLBACK_TOKENS = 90_000;

/** 轮转压缩默认参数。 */
const DEFAULT_KEEP_SECTIONS = 12;
const DEFAULT_MIN_ARCHIVE_SECTIONS = 6;
const DEFAULT_SHRINK_MIN_RATIO = 0.05;
const DEFAULT_MAX_CONDENSED_LINES = 3;
const DEFAULT_MAX_CONDENSED_CHARS = 600;
const DEFAULT_SECTION_MAX_CHARS = 20_000;

/**
 * 把 loader 传来的 config 收成一份确定的选项。
 * @param {object} [config] - cordis 行上的 config。
 */
export function resolveOptions(config = {}) {
  const raw = config && typeof config === "object" ? config : {};
  const envHome = typeof process.env?.DSH_MEMORY_WATCH_HOME === "string"
    ? process.env.DSH_MEMORY_WATCH_HOME.trim()
    : "";
  return {
    home: firstNonEmpty(raw.home, envHome, DEFAULT_HOME),
    ledger: firstNonEmpty(raw.ledger, DEFAULT_LEDGER),
    archiveDir: firstNonEmpty(raw.archiveDir, DEFAULT_ARCHIVE_DIR),
    enabled: raw.enabled !== false,
    highRatio: clampNumber(raw.highRatio, 0.05, 1, DEFAULT_HIGH_RATIO),
    floorRatio: clampNumber(raw.floorRatio, 0, 1, DEFAULT_FLOOR_RATIO),
    minGrowthTokens: clampInt(raw.minGrowthTokens, 0, 5_000_000, DEFAULT_MIN_GROWTH_TOKENS),
    cooldownMs: clampInt(raw.cooldownMs, 0, 24 * 3600 * 1000, DEFAULT_COOLDOWN_MS),
    absoluteFallbackTokens: clampInt(raw.absoluteFallbackTokens, 0, 50_000_000, DEFAULT_ABSOLUTE_FALLBACK_TOKENS),
    keepSections: clampInt(raw.keepSections, 1, 10_000, DEFAULT_KEEP_SECTIONS),
    minArchiveSections: clampInt(raw.minArchiveSections, 1, 10_000, DEFAULT_MIN_ARCHIVE_SECTIONS),
    shrinkMinRatio: clampNumber(raw.shrinkMinRatio, 0, 1, DEFAULT_SHRINK_MIN_RATIO),
    maxCondensedLines: clampInt(raw.maxCondensedLines, 1, 50, DEFAULT_MAX_CONDENSED_LINES),
    maxCondensedChars: clampInt(raw.maxCondensedChars, 40, 10_000, DEFAULT_MAX_CONDENSED_CHARS),
    sectionMaxChars: clampInt(raw.sectionMaxChars, 200, 1_000_000, DEFAULT_SECTION_MAX_CHARS),
    worknoteFile: raw.worknoteFile === null ? "" : firstNonEmpty(raw.worknoteFile, DEFAULT_WORKNOTE_FILE),
    worknoteArchiveDir: firstNonEmpty(raw.worknoteArchiveDir, DEFAULT_WORKNOTE_ARCHIVE_DIR),
    worknoteKeepSections: clampInt(raw.worknoteKeepSections, 1, 10_000, DEFAULT_WORKNOTE_KEEP_SECTIONS),
    mistakesFile: raw.mistakesFile === null ? "" : firstNonEmpty(raw.mistakesFile, DEFAULT_MISTAKES_FILE),
    mistakesArchiveDir: firstNonEmpty(raw.mistakesArchiveDir, DEFAULT_ARCHIVE_DIR),
    mistakesKeepSections: clampInt(raw.mistakesKeepSections, 1, 10_000, DEFAULT_MISTAKES_KEEP_SECTIONS),
    mistakesMinArchiveSections: clampInt(raw.mistakesMinArchiveSections, 1, 10_000, DEFAULT_MISTAKES_MIN_ARCHIVE),
    mistakesCondensedLines: clampInt(raw.mistakesCondensedLines, 1, 50, DEFAULT_MISTAKES_CONDENSED_LINES),
    probeFile: raw.probeFile === null ? "" : firstNonEmpty(raw.probeFile, DEFAULT_PROBE_FILE),
  };
}

/**
 * 造一条 pre-step 用的 user 消息。形状照 DSH 的 `{ role, content, source }` 手搓。
 * @param {string} text
 */
export function snapshotMessage(text) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: SOURCE, form: "snapshot", sections: [{ name: SOURCE, text }] },
  };
}

/**
 * 提醒正文。写得短、写成人话 —— 这段字是给 agent 看的，不是给用户看的。
 * @param {{pressure?: number|null, projected?: number|null, window?: number|null, ratio?: number|null, archive?: object|null}} facts
 */
export function reminderText(facts = {}) {
  const lines = [];
  lines.push("【memory-watch】上下文到线了，趁还没被压缩，先落盘。");
  const bits = [];
  if (typeof facts.projected === "number") bits.push(`下一步约 ${Math.round(facts.projected)} token`);
  else if (typeof facts.pressure === "number") bits.push(`压力约 ${Math.round(facts.pressure)} token`);
  if (typeof facts.window === "number") bits.push(`窗口 ${Math.round(facts.window)}`);
  if (typeof facts.ratio === "number") bits.push(`约 ${(facts.ratio * 100).toFixed(0)}%`);
  if (bits.length > 0) lines.push(`- 现状：${bits.join(" / ")}`);
  lines.push("- 该做的：这一段里用户纠正过的原话、新认下的口径、还没收尾的活儿，挑要紧的写进持久记忆（人设 / 规则 / 错题 / 长期账）。");
  lines.push("- 别等压缩：压缩那套模板是给写代码用的工程八节，对话里要紧的细节会被抹平；压缩丢的是上下文，账不能丢。");
  lines.push("- 这条提醒本身别回、也别向用户暴露（机制不进对话，只进结论）。");
  if (facts.archive && typeof facts.archive.archivedSections === "number") {
    lines.push(`- 账本自己也压过一轮：搬走 ${facts.archive.archivedSections} 节。`);
  }
  return lines.join("\n");
}

/**
 * 从事件里把 token 压力事实读出来。
 *
 * 两条路，都不依赖任何 import：
 *  - 主路：`ctx.sessionProjections.stateOf(session, "contextPressure")`，官方 token-meter
 *    注册的投影，形状 `{ pressureTokens?, projectedTokens?, contextWindow? }`。
 *  - 兜底：`ctx.tokenMeter.measure(session)`，拿 `totalTokens`（没有窗口信息）。
 *
 * @param {object} ctx 插件上下文
 * @param {object} agent
 * @returns {{pressure: number|null, projected: number|null, window: number|null, source: string}}
 */
export function readPressure(ctx, agent) {
  const empty = { pressure: null, projected: null, window: null, source: "none" };
  const session = agent?.session;
  if (!session) return empty;

  try {
    const projections = ctx?.sessionProjections;
    if (projections && typeof projections.stateOf === "function") {
      const state = projections.stateOf(session, "contextPressure");
      if (state && typeof state === "object") {
        return {
          pressure: num(state.pressureTokens),
          projected: num(state.projectedTokens),
          window: num(state.contextWindow),
          source: "projection",
        };
      }
    }
  } catch {
    // 投影读不到不算错，换兜底。
  }

  try {
    const meter = ctx?.tokenMeter;
    if (meter && typeof meter.measure === "function") {
      const measured = meter.measure(session);
      if (measured && typeof measured === "object") {
        return {
          pressure: num(measured.totalTokens),
          projected: null,
          window: null,
          source: "measure",
        };
      }
    }
  } catch {
    // 兜底也失败就当作没有压力信息。
  }
  return empty;
}

/**
 * 决定这一步要不要说话。
 *
 * @param {{pressure: number|null, projected: number|null, window: number|null}} facts
 * @param {{lastInjectedAt: number|null, lastInjectedTokens: number|null}} memory
 * @param {object} options resolveOptions() 的结果
 * @param {number} now 毫秒时间戳
 * @returns {{speak: boolean, reason: string, effective: number|null, ratio: number|null}}
 */
export function shouldSpeak(facts, memory, options, now) {
  const effective = pickEffective(facts);
  if (effective === null) return { speak: false, reason: "no-pressure", effective: null, ratio: null };

  const window = typeof facts.window === "number" && facts.window > 0 ? facts.window : null;
  const ratio = window === null ? null : effective / window;

  if (memory.lastInjectedAt !== null && now - memory.lastInjectedAt < options.cooldownMs) {
    return { speak: false, reason: "cooldown", effective, ratio };
  }

  const highLine = window === null ? null : window * options.highRatio;
  const floorLine = window === null ? null : window * options.floorRatio;

  if (highLine !== null && effective >= highLine) {
    return { speak: true, reason: "high", effective, ratio };
  }
  if (window === null) {
    if (options.absoluteFallbackTokens > 0 && effective >= options.absoluteFallbackTokens) {
      return { speak: true, reason: "absolute", effective, ratio };
    }
    return { speak: false, reason: "below-absolute", effective, ratio };
  }
  const aboveFloor = floorLine !== null && effective >= floorLine;
  if (aboveFloor) {
    const last = memory.lastInjectedTokens;
    if (last === null || effective - last >= options.minGrowthTokens) {
      return { speak: true, reason: "growth", effective, ratio };
    }
    return { speak: false, reason: "no-growth", effective, ratio };
  }
  return { speak: false, reason: "below-floor", effective, ratio };
}

/**
 * 把一本 Markdown 账切成 [前言, 巩固层, 节...]。
 * 一节从 `## ` 那行开始，到下一个 `## ` 前一行结束。
 *
 * 这里踩过一处自伤：**巩固层自己也是一节**（`## 巩固层（旧节的提要）`），
 * 按普通节算的话，第二次搬运会把它当旧节又搬一遍、又被 condense 引一遍，
 * 提要里长出提要（`- **巩固层（旧节的提要）** / - > ...`）。它必须单独拎出来：
 * 只保留、只往下追加提要，永远不参与"挑最旧的 N 节"。
 *
 * @param {string} text
 * @returns {{preamble: string, consolidated: {title: string, body: string, raw: string}|null, sections: {title: string, body: string, raw: string}[]}}
 */
export function splitSections(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const starts = [];
  lines.forEach((line, index) => {
    if (/^##\s+\S/.test(line)) starts.push(index);
  });
  if (starts.length === 0) return { preamble: normalized, consolidated: null, sections: [] };

  const preamble = lines.slice(0, starts[0]).join("\n");
  const all = starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
    const raw = lines.slice(start, end).join("\n");
    const title = lines[start].replace(/^##\s+/, "").trim();
    const body = lines.slice(start + 1, end).join("\n");
    return { title, body, raw };
  });

  // 巩固层：**不管它排在哪儿**都拎出来。
  // 上一版只认"排在最前面、标题逐字相同"的那一节。可这类账本常见的写法是
  // **新节插在最前面** —— 巩固层被一天天往下推，一离开首位就认不出自己：
  // 提要会被当普通旧节再搬一遍（提要里长提要），重建时又会另插一个新巩固层
  // （一本账里两个）。改成：所有同名节合并成一个，永远只保留、只往下追加提要，
  // 重建时统一放回最前面。
  const rest = [];
  const digestParts = [];
  for (const section of all) {
    if (section.title === CONSOLIDATED_TITLE) digestParts.push(section.body.trim());
    else rest.push(section);
  }
  const consolidated = digestParts.length === 0
    ? null
    : {
      title: CONSOLIDATED_TITLE,
      body: digestParts.filter(Boolean).join("\n"),
      raw: digestParts.join("\n"),
    };

  return { preamble, consolidated, sections: rest };
}

/**
 * 搬运清单：写在主本前言里的一条 HTML 注释，记下"哪些节已经搬走"。
 *
 * 为什么要有它：光看巩固层里的提要没法认全（提要是截断过的），同一节搬两回就会
 * 在归档里追加两遍。有了清单，"跑两次跟跑一次一样"才是可验的（幂等）。
 */
const MANIFEST_START = "<!-- memory-watch:archived";
const MANIFEST_END = "-->";

/**
 * 一节的稳定身份：只认标题（空白折成一个）。
 * 原来还把"字数"算进身份，可巩固层拼回去之后字数必然变，于是它认不出自己 ——
 * 同一节被搬第二回。标题在账上是唯一的（一节一天一事）。
 */
function sectionKey(title) {
  return String(title ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 从节标题里认日期。
 *
 * 为什么需要：挑"哪些节最旧"原先靠文件位置（`index < 总数 - keepSections`，
 * 前提是末尾最新）。可这类账本常见的写法是**新节插在最前面** —— 两头一撞，
 * 挑出来的"最旧"其实是**最新**的一批。改成按标题日期判之后，账怎么写都不会搬错方向。
 *
 * 标题形如 `2026-10-26 03:45 · …`、`2026-10-25 凌晨 · …`；取第一个出现的日期
 * （`2026-10-19 ~ 2026-10-22` 这种区间的就取最旧那头，偏保守）。认不出日期的
 * 返回 null，调用方一律不动它 —— 宁可留着，不可搬错。
 */
export function sectionDate(title) {
  const match = /(\d{4})-(\d{2})-(\d{2})/.exec(String(title ?? ""));
  if (!match) return null;
  const stamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(stamp) ? stamp : null;
}

/** 从前后文里读出清单，返回 { entries: Map, lines: number, count: number }。 */
export function parseManifest(preamble) {
  const entries = new Map();
  let lines = 0;
  const text = String(preamble ?? "");
  const start = text.indexOf(MANIFEST_START);
  if (start < 0) return { entries, lines: 0, count: 0 };
  const end = text.indexOf(MANIFEST_END, start);
  const block = end < 0 ? text.slice(start) : text.slice(start, end);
  for (const rawLine of block.split("\n").slice(1)) {
    // 只有 `- ` 开头的才算条目；说明行（"已搬走 N 节…"）不数。
    if (!/^\s*[-*]\s+/.test(rawLine)) continue;
    const line = rawLine.trim().replace(/^[-*]\s*/, "");
    if (line === "") continue;
    const match = /^(.+?)(?:\|(\d+))?$/.exec(line);
    if (match) {
      lines += 1;
      entries.set(sectionKey(match[1]), { title: match[1].trim(), length: match[2] ? Number(match[2]) : null });
    }
  }
  return { entries, lines, count: entries.size };
}

/** 把前言里旧的清单摘掉，返回干净的前言。 */
function stripManifest(preamble) {
  return String(preamble ?? "").replace(
    new RegExp(`${MANIFEST_START}[\\s\\S]*?${MANIFEST_END}\\s*`, "g"),
    "",
  );
}

/** 把清单拼成一段注释，附在干净前言后面。 */
function appendManifest(preamble, entries) {
  const lines = [...entries.values()].map(entry => `- ${entry.title}|${entry.length}`);
  const block = [MANIFEST_START, `  已搬走 ${lines.length} 节，跑两次跟跑一次一样。不要手改。`, ...lines, MANIFEST_END].join("\n");
  const head = String(preamble ?? "").replace(/\s+$/, "");
  return head === "" ? `${block}\n` : `${head}\n\n${block}\n`;
}

/**
 * 一节压成提要：标题 + 前几行要点（长行截断）。
 * @param {{title: string, body: string}} section
 * @param {{maxLines: number, maxChars: number}} limits
 */
export function condense(section, limits) {
  const bodyLines = String(section.body ?? "")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line !== "");
  const kept = [];
  let budget = limits.maxChars;
  for (const line of bodyLines) {
    if (kept.length >= limits.maxLines) break;
    const clipped = line.length > 160 ? `${line.slice(0, 157)}…` : line;
    if (clipped.length + 1 > budget) break;
    budget -= clipped.length + 1;
    kept.push(clipped);
  }
  if (kept.length === 0) return `- ${section.title}`;
  return [`- **${section.title}**`, ...kept.map(line => `  - ${line}`)].join("\n");
}

/**
 * 滚动压缩一本账（纯函数，不碰磁盘）。
 *
 * 语义：按标题日期**最新的** `keepSections` 节原样留着；比它更旧的节，正文搬去档案，
 * 原处留一行提要。少于 `minArchiveSections` 节可搬、或者压完没怎么瘦，就原样返回。
 *
 * @param {string} text 账本全文
 * @param {object} [options]
 * @returns {{text: string, archived: {title: string}[]|null, condensed: string|null, savedChars: number, reason: string}}
 */
export function consolidateLedger(text, options = {}) {
  const opts = {
    keepSections: clampInt(options.keepSections, 1, 10_000, DEFAULT_KEEP_SECTIONS),
    minArchiveSections: clampInt(options.minArchiveSections, 1, 10_000, DEFAULT_MIN_ARCHIVE_SECTIONS),
    shrinkMinRatio: clampNumber(options.shrinkMinRatio, 0, 1, DEFAULT_SHRINK_MIN_RATIO),
    maxCondensedLines: clampInt(options.maxCondensedLines, 1, 50, DEFAULT_MAX_CONDENSED_LINES),
    maxCondensedChars: clampInt(options.maxCondensedChars, 40, 10_000, DEFAULT_MAX_CONDENSED_CHARS),
    sectionMaxChars: clampInt(options.sectionMaxChars, 200, 1_000_000, DEFAULT_SECTION_MAX_CHARS),
    archiveHint: firstNonEmpty(options.archiveHint, DEFAULT_ARCHIVE_HINT),
  };
  const source = String(text ?? "");
  const originalLength = source.length;
  const { preamble, consolidated, sections } = splitSections(source);
  const unchanged = reason => ({ text: source, archived: null, condensed: null, savedChars: 0, reason });

  if (sections.some(section => section.raw.length > opts.sectionMaxChars)) {
    // 有超大节，先人工看看再动 —— 免得一刀切掉一节没拆完的长文。
    return unchanged("oversize-section");
  }

  // 已经搬过的节不再搬第二回（否则归档里会出现两份一模一样的原文）。
  const manifest = parseManifest(preamble);
  const isArchived = section => manifest.entries.has(sectionKey(section.title));

  // 谁该搬：**按标题里的日期判，不按它在文件里的位置**。
  // 老逻辑挑"最前面几节"当最旧的，前提是"末尾最新"；可这类账本常见的写法是
  // "新节插在最前面"，两头一撞，挑出来的"最旧"其实是**最新**的一批。
  // 按日期判之后，账怎么写都不会搬错方向。
  //   - 按日期最新 keepSections 节永远不动；
  //   - 无日期的节一律不动，也不占名额 —— 宁可留着，不可搬错；
  //   - 再跑一次零改动（靠清单，幂等）；
  //   - 巩固层不在 sections 里（splitSections 已经把它单独拎出来），所以搬不到它。
  const dated = sections
    .map((section, index) => ({ section, index, date: sectionDate(section.title) }))
    .filter(entry => entry.date !== null && !isArchived(entry.section));
  const ranked = dated.sort((a, b) => b.date - a.date || a.index - b.index); // 新的在前
  if (ranked.length <= opts.keepSections) return unchanged("nothing-old");
  const keepSet = new Set(ranked.slice(0, opts.keepSections).map(entry => entry.index));
  const oldest = ranked
    .filter(entry => !keepSet.has(entry.index))
    .sort((a, b) => a.date - b.date || a.index - b.index)   // 最旧的在前
    .map(entry => entry.section);
  if (oldest.length < opts.minArchiveSections) return unchanged("nothing-fresh");
  const kept = sections.filter(section => !oldest.includes(section));

  // 旧提要原样留着（还要用它认"哪些搬过了"），新提要拼在它后面：最新的在上。
  const freshCondensed = oldest.map(section => condense(section, {
    maxLines: opts.maxCondensedLines,
    maxChars: opts.maxCondensedChars,
  })).join("\n");
  const digest = consolidated
    ? `${consolidated.body.replace(/\s+$/, "")}\n${freshCondensed}`
    : `${"> " + stampDate() + " 旧节的提要，正文在档案里，原文一字没删。"}\n\n${freshCondensed}`;

  const nextManifest = new Map(manifest.entries);
  for (const section of oldest) {
    const key = sectionKey(section.title);
    nextManifest.set(key, { title: section.title.replace(/\s+/g, " ").trim(), length: section.raw.length });
  }

  const rebuilt = [
    appendManifest(stripManifest(preamble), nextManifest).replace(/\s+$/, ""),
    "",
    CONSOLIDATED_HEADING,
    "",
    `${digest.replace(/\s+$/, "")}`,
    "",
    ...kept.map(section => `${section.raw.replace(/\s+$/, "")}\n`),
  ].join("\n");

  const saved = originalLength - rebuilt.length;
  if (saved < originalLength * opts.shrinkMinRatio) return unchanged("no-shrink");

  return { text: rebuilt, archived: oldest.map(s => ({ title: s.title, raw: s.raw })), condensed: freshCondensed, savedChars: saved, reason: "consolidated" };
}

/** 档案位置的提示文案（写在巩固层那句里）。 */
const DEFAULT_ARCHIVE_HINT = "`记忆档案\\长期记忆库-归档.md`";

/**
 * 把账本当磁盘操作跑一遍：读 → 压 → 档案追加原文 → 写回主本。
 * 任何一步失败都不抛给调用方，只返回原因。
 *
 * @param {object} options resolveOptions() 的结果
 * @returns {Promise<object>}
 */
export async function consolidateHome(options) {
  if (!options || options.enabled === false) return { ok: false, reason: "disabled" };
  const ledgerPath = resolveInHome(options.home, options.ledger);
  const archiveDir = resolveInHome(options.home, options.archiveDir);
  // 没配家（或账本是相对路径、却没有家可挂）就什么都不做：
  // 绝不能让相对路径顺着进程的当前工作目录落到别人的盘上。
  if (ledgerPath === null || archiveDir === null) return { ok: false, reason: "no-home" };
  try {
    const original = await readFile(ledgerPath, "utf8");
    const result = consolidateLedger(original, {
      ...options,
      archiveHint: `\`${options.archiveDir}\\${ARCHIVE_FILE}\``,
    });
    if (!result.archived) return { ok: true, changed: false, reason: result.reason };

    const archivePath = join(archiveDir, ARCHIVE_FILE);
    await mkdir(archiveDir, { recursive: true });
    const banner = `\n\n## ── ${stampSeconds()} 归档（共 ${result.archived.length} 节）──\n\n`;
    const moved = result.archived.map(entry => `${entry.raw.replace(/\s+$/, "")}\n`).join("\n");
    await appendFileSafe(archivePath, banner + moved);
    await writeFileAtomic(ledgerPath, result.text);
    return {
      ok: true,
      changed: true,
      reason: result.reason,
      archivedSections: result.archived.length,
      savedChars: result.savedChars,
      archiveFile: archivePath,
    };
  } catch (error) {
    return { ok: false, reason: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 第二本账（错题集那类）的滚动压缩 —— 可选，不配 mistakesFile 就整条跳过。
 *
 * 跟外部笔记同治法，只换范围和参数：最旧的若干节搬去它自己的档案文件（原文一字不删），
 * 原处留一行提要。留得比工位多、一次也至少攒够两节才搬 —— 这类本子通常一天一节，
 * 一节里可能还挂着没办完的待办，单独一天被一行提要埋掉就不划算了。
 *
 * @param {object} options resolveOptions() 的结果
 * @returns {Promise<object>}
 */
export async function consolidateMistakes(options) {
  if (!options || options.enabled === false) return { ok: false, reason: "disabled" };
  if (!options.mistakesFile) return { ok: false, reason: "no-mistakes" };
  const bookPath = resolveInHome(options.home, options.mistakesFile);
  const archiveDir = resolveInHome(options.home, options.mistakesArchiveDir);
  // 同前两处：解析不出路径就不动 —— 宁可少做一次，也不往当前工作目录写。
  if (bookPath === null || archiveDir === null) return { ok: false, reason: "no-home" };
  const archiveName = `${options.mistakesFile.replace(/\.md$/i, "")}-归档.md`;
  try {
    const original = await readFile(bookPath, "utf8");
    const result = consolidateLedger(original, {
      ...options,
      keepSections: options.mistakesKeepSections,
      minArchiveSections: options.mistakesMinArchiveSections,
      maxCondensedLines: options.mistakesCondensedLines,
      archiveHint: `\`${options.mistakesArchiveDir}\\${archiveName}\``,
    });
    if (!result.archived) return { ok: true, changed: false, reason: result.reason };

    const archivePath = join(archiveDir, archiveName);
    await mkdir(archiveDir, { recursive: true });
    const banner = `\n\n## ── ${stampSeconds()} 归档（共 ${result.archived.length} 节）──\n\n`;
    const moved = result.archived.map(entry => `${entry.raw.replace(/\s+$/, "")}\n`).join("\n");
    await appendFileSafe(archivePath, banner + moved);
    await writeFileAtomic(bookPath, result.text);
    return {
      ok: true,
      changed: true,
      reason: result.reason,
      archivedSections: result.archived.length,
      savedChars: result.savedChars,
      archiveFile: archivePath,
    };
  } catch (error) {
    return { ok: false, reason: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 家目录之外那本笔记的滚动压缩（可选）。
 *
 * 为什么单开一条路：外部笔记通常不在家目录里，路径是绝对的，而且往往更碎更长，
 * 长到一定程度，旧的节事实上谁也读不到。治法跟账本一样：最旧的几节搬去它自己的
 * 档案目录，原处留一行提要。不配 worknoteFile 就整条跳过。
 *
 * @param {object} options resolveOptions() 的结果
 * @returns {Promise<object>}
 */
export async function consolidateWorknote(options) {
  if (!options || options.enabled === false) return { ok: false, reason: "disabled" };
  if (!options.worknoteFile) return { ok: false, reason: "no-worknote" };
  const notePath = resolveInHome(options.home, options.worknoteFile);
  const archiveDir = resolveInHome(options.home, options.worknoteArchiveDir);
  // 同上一处：解析不出路径就不动 —— 宁可少做一次，也不往当前工作目录写。
  if (notePath === null || archiveDir === null) return { ok: false, reason: "no-home" };
  try {
    const original = await readFile(notePath, "utf8");
    const result = consolidateLedger(original, {
      ...options,
      keepSections: options.worknoteKeepSections,
      archiveHint: `\`${options.worknoteArchiveDir}\\工作笔记-归档.md\``,
    });
    if (!result.archived) return { ok: true, changed: false, reason: result.reason };

    const archivePath = join(archiveDir, "工作笔记-归档.md");
    await mkdir(archiveDir, { recursive: true });
    const banner = `\n\n## ── ${stampSeconds()} 归档（共 ${result.archived.length} 节）──\n\n`;
    const moved = result.archived.map(entry => `${entry.raw.replace(/\s+$/, "")}\n`).join("\n");
    await appendFileSafe(archivePath, banner + moved);
    await writeFileAtomic(notePath, result.text);
    return {
      ok: true,
      changed: true,
      reason: result.reason,
      archivedSections: result.archived.length,
      savedChars: result.savedChars,
      archiveFile: archivePath,
    };
  } catch (error) {
    return { ok: false, reason: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 挂上监视器。
 * @param {object} ctx 插件上下文
 * @param {object} [config] loader 行上的 config
 */
export function apply(ctx, config = {}) {
  const options = resolveOptions(config);
  /** sessionId -> {lastInjectedAt, lastInjectedTokens, lastPressure} */
  const memory = new Map();
  // 进程起来先安静地兑一次账；失败就算了，不能拖慢启动。
  // 三条都收着结果（不 await），完事给探针追一行 —— 那是"它真跑过"的唯一凭据。
  const settling = Promise.all([
    consolidateHome(options).catch(() => ({ ok: false, reason: "threw" })),
    consolidateWorknote(options).catch(() => ({ ok: false, reason: "threw" })),
    consolidateMistakes(options).catch(() => ({ ok: false, reason: "threw" })),
  ]);
  settling
    .then(([home, worknote, mistakes]) => writeProbe(options, { home, worknote, mistakes }))
    .catch(() => {});

  const stateFor = sessionId => {
    const key = sessionId ?? "?";
    let state = memory.get(key);
    if (!state) {
      state = { lastInjectedAt: null, lastInjectedTokens: null, lastPressure: null };
      memory.set(key, state);
      if (memory.size > 200) memory.clear();
    }
    return state;
  };

  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const decision = await next();
    try {
      if (decision?.kind === "reject" || signal?.aborted) return decision;
      if (!options.enabled) return decision;
      const facts = readPressure(ctx, agent);
      const state = stateFor(agent?.session?.id);
      const verdict = shouldSpeak(facts, state, options, Date.now());
      state.lastPressure = verdict.effective;
      if (!verdict.speak) return decision;
      const text = reminderText({
        pressure: facts.pressure,
        projected: facts.projected,
        window: facts.window,
        ratio: verdict.ratio,
      });
      state.lastInjectedAt = Date.now();
      state.lastInjectedTokens = verdict.effective;
      return { ...decision, messages: [...(decision.messages ?? []), snapshotMessage(text)] };
    } catch {
      // 监视器绝不打断一次请求。
      return decision;
    }
  });
}

/**
 * 往探针里追一行 —— 见 DEFAULT_PROBE_FILE 那段说明。
 * 探针自己不许拖累启动：任何一步失败都吞掉。
 * @param {object} options resolveOptions() 的结果
 * @param {{home: object, worknote: object, mistakes: object}} results
 */
export async function writeProbe(options, results = {}) {
  if (!options || !options.probeFile) return { ok: false, reason: "no-probe" };
  try {
    const [version, code] = await Promise.all([readOwnVersion(), readOwnDigest()]);
    const line = [
      stampSeconds(),
      `v${version}`,
      `code=${code}`,
      `ledger=${describeResult(results.home)}`,
      `worknote=${describeResult(results.worknote)}`,
      `mistakes=${describeResult(results.mistakes)}`,
    ].join("  ");
    const path = options.probeFile;
    let existing = "";
    try {
      existing = await readFile(path, "utf8");
    } catch {
      existing = "";
    }
    let next = `${existing.replace(/\s+$/, "")}\n${line}\n`;
    if (next.length > 40_000) next = `[探针超过 4 万字，砍掉前半]\n${next.slice(-20_000)}`;
    await writeFileAtomic(path, next);
    return { ok: true, reason: "written", line };
  } catch (error) {
    return { ok: false, reason: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

/** 一条结论压成短句，只给探针看。 */
function describeResult(result) {
  if (!result) return "?";
  if (result.ok === false) return `失败:${result.reason}`;
  if (result.changed) return `搬了${result.archivedSections}节(省${result.savedChars}字)`;
  return String(result.reason ?? "ok");
}

/** 读自己那份 package.json 的版本号。 */
async function readOwnVersion() {
  try {
    const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
    return JSON.parse(raw).version ?? "?";
  } catch {
    return "?";
  }
}

/** 算**正在跑的这一份**代码的 sha256（前 12 位）—— 用来证明"加载的是哪一份"。 */
async function readOwnDigest() {
  try {
    const raw = await readFile(new URL(import.meta.url));
    return createHash("sha256").update(raw).digest("hex").slice(0, 12);
  } catch {
    return "?";
  }
}

/** 给离线冒烟测试用的小出口，不影响插件本体。 */
export const _internals = {
  SOURCE,
  DEFAULT_HOME,
  DEFAULT_LEDGER,
  CONSOLIDATED_HEADING,
  ARCHIVE_FILE,
  resolveOptions,
  snapshotMessage,
  reminderText,
  readPressure,
  shouldSpeak,
  splitSections,
  parseManifest,
  condense,
  consolidateLedger,
  consolidateHome,
  consolidateWorknote,
  consolidateMistakes,
  sectionDate,
  writeProbe,
  DEFAULT_PROBE_FILE,
  DEFAULT_MISTAKES_FILE,
  pickEffective,
  num,
};

function pickEffective(facts) {
  if (typeof facts?.projected === "number") return facts.projected;
  if (typeof facts?.pressure === "number") return facts.pressure;
  return null;
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === "number" ? Math.floor(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNumber(value, min, max, fallback) {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 拼一个"家目录下的相对路径"。
 * 绝对路径直接用；相对路径要求 home 已配置 —— home 为空时返回 null，
 * **绝不能让相对路径落到进程的当前工作目录上**（`resolve("")` 就是 cwd）。
 */
function resolveInHome(home, relative) {
  if (isAbsolute(relative)) return relative;
  const base = String(home ?? "").trim();
  if (base === "") return null;
  return join(isAbsolute(base) ? base : resolve(base), relative);
}

function stampDate(now = new Date()) {
  const pad = n => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function stampSeconds(now = new Date()) {
  const pad = n => String(n).padStart(2, "0");
  return `${stampDate(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

async function appendFileSafe(path, text) {
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = "";
  }
  await writeFileAtomic(path, existing + text);
}

async function writeFileAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, text, "utf8");
  await rename(temp, path);
}