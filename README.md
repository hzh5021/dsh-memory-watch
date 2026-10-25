# dsh-memory-watch

在上下文被压缩之前提醒会话把要紧的先落盘，并给一本按 `## ` 分节的 Markdown 账本做确定性的滚动压缩。

## 它做什么

宿主自带的压缩会在压力到线时把最旧的一段摘要成一条 `<compacted-summary>`。那套模板是按写代码的口味做的（文件路径 / 错误与修复 / 下一步），拿它压对话里的偏好和取舍，出来常常只剩一句「用户偏好简短回复」，要紧的地方全丢；它的 token 计数又用「每 token 四字符」的启发式，对中文明显低估，于是压缩可能不打招呼就来。

这个插件不做第二套压缩，只做三件更靠前的事：

一是**盯压力、递话**。挂在 `agent/pre-step`，量当前会话的 token 压力；到线了就在这一轮开口之前把一句提醒塞进消息里——该落盘了，别等压缩把这段抹平。注入走 pre-step，图的是当场可见。

二是**顺手兑账**。长期账本只长不缩，插件提供一个纯函数的滚动压缩：最旧的若干节，正文搬去档案目录（冻结不删），原处留一行提要（日期 + 标题 + 前几行要点）。**哪一节最旧按标题里的日期判，不按它在文件里的位置**——这类账本常见的写法是「新节插在最前面」，按位置挑会把最新的一批搬走。不做语义总结、不调模型，全是确定性字符串处理。可以同时管三本：家目录里的那本账（`ledger`）、家目录之外的一本笔记（`worknoteFile`）、以及「一天一节、一节底下是若干条」的第二本（`mistakesFile`）。

三是**留一行脚印**（可选，配了 `probeFile` 才写）。每次启动往那个文件追一行：版本、**正在跑的那份代码自己的 sha256**、三本账各自跑了什么结论。这个插件沉默干活、出事也吞，于是「它到底跑没跑」从账面上看不出来；本地插件又常见源目录与 profile 副本两份、改了源目录而跑的是副本。有了 `code=` 那一段，这两件事都不用猜。

默认 `home` 是空的：不配它，插件只做提醒，一次磁盘动作都不做。

## 装

```
dsh plugin add hzh5021/dsh-memory-watch
```

手工四步：

1. 把包放进 `~/.dsh/plugins/dsh-memory-watch/`。
2. profile 的 `package.json` 里 `dependencies` 加一条（本机口径：`"dsh-memory-watch": "file:../../plugins/dsh-memory-watch"`），并在 profile 的 `node_modules/` 下留一个同名联接。
3. 同一份 `package.json` 的 `dsh.profile.bundles` 里加上 `"dsh-memory-watch"`。
4. 重启 DSH。

插件行由本包自己的 `cordis.patch.yml` 插进 profile 花名册；profile 的 `cordis.yml` 是生成物，不要手改。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `home` | `""` | 账本所在目录；空 = 不碰磁盘（也可用环境变量 `DSH_MEMORY_WATCH_HOME`） |
| `ledger` | `"长期记忆库.md"` | `home` 下的相对路径，那本按 `## ` 分节的账 |
| `archiveDir` | `"记忆档案"` | `home` 下的相对路径，搬走的原文落这儿 |
| `enabled` | `true` | `false` = 提醒和磁盘动作一起停 |
| `highRatio` | `0.7` | 占窗口这个比例就直接提醒（0.05–1） |
| `floorRatio` | `0.45` | 低于它完全不打扰（0–1） |
| `minGrowthTokens` | `24000` | 两次提醒之间至少要长这么多（0–5,000,000） |
| `cooldownMs` | `300000` | 两次提醒之间的最小间隔，毫秒（0–24 小时） |
| `absoluteFallbackTokens` | `90000` | 拿不到窗口信息时的绝对兜底线；0 = 关掉（0–50,000,000） |
| `keepSections` | `12` | 压账时最新的这么多节原样留着（1–10000） |
| `minArchiveSections` | `6` | 可搬的旧节少于这个数就不动（1–10000） |
| `shrinkMinRatio` | `0.05` | 压完没瘦够这个比例就原样返回（0–1） |
| `maxCondensedLines` | `3` | 一条提要最多几行（1–50） |
| `maxCondensedChars` | `600` | 一条提要最多多少字符（40–10000） |
| `sectionMaxChars` | `20000` | 单节超过这个长度就整本不动，交人工看（200–1,000,000） |
| `worknoteFile` | `""` | 家目录之外的另一本笔记（绝对路径）；`null` = 不管它 |
| `worknoteArchiveDir` | `""` | 那本笔记的档案目录（相对 `home` 解析） |
| `worknoteKeepSections` | `20` | 那本笔记留最新多少节不动（1–10000） |
| `mistakesFile` | `"错题集.md"` | 第二本账（一天一节、一节底下是若干条）；`null` = 不管它 |
| `mistakesArchiveDir` | `"记忆档案"` | 第二本账的档案目录（相对 `home` 解析） |
| `mistakesKeepSections` | `8` | 第二本账留最新多少节不动（1–10000） |
| `mistakesMinArchiveSections` | `2` | 它可搬的旧节少于这个数就不动（1–10000） |
| `mistakesCondensedLines` | `6` | 它一节留几行提要（1–50） |
| `probeFile` | `""` | 启动探针写到哪儿；空 = 不写。建议放工作区，别放账本目录 |

`archiveDir` / `worknoteArchiveDir` 用相对 `home` 的路径，写绝对路径也认。

```yaml
- id: memory-watch
  name: dsh-memory-watch
  config:
    home: /path/to/your/notes
    ledger: ledger.md
    archiveDir: archive
    highRatio: 0.7
```

## 怎么工作

**读压力**，两条路都不依赖 import：主路 `ctx.sessionProjections.stateOf(session, "contextPressure")`（宿主 token-meter 注册的投影，形状 `{ pressureTokens, projectedTokens, contextWindow }`）；兜底 `ctx.tokenMeter.measure(session)`，只拿得到 `totalTokens`。

**判定**取有效值（优先 `projectedTokens`，其次 `pressureTokens`）：有窗口时，大于等于 `highRatio × window` 直接提醒；否则在 `floorRatio × window` 以上、且比上次提醒时长了至少 `minGrowthTokens` 才提醒；没有窗口信息时退到 `absoluteFallbackTokens` 兜底。两级都受 `cooldownMs` 防抖。

**注入**：把一条 user 消息追加进这一步的 `messages`（`source.kind = "dsh-memory-watch"`，`form: "snapshot"`），所以当场可见。

**滚动压缩**（纯函数 `consolidateLedger`）：按 `## ` 切节，先把标题逐字等于「巩固层（旧节的提要）」的节全都拎出来——**不管它排在哪儿**。它永远只保留、只往下追加提要：既不参与「挑最旧的 N 节」，也不会被搬走；重建时统一放回最前面。剩下的节按**标题里的日期**排序，最新的 `keepSections` 节原样留着；更旧、又不在搬运清单里的节才搬（认不出日期的节一律不动，也不占名额）。主本前言里有一条 HTML 注释清单，记着哪些节已经搬走，靠它保证幂等：跑两次跟跑一次一样。归档文件是追加写，主本用「写临时文件再 rename」原子替换。

三处踩过的坑：

- 一节的身份只认标题（空白折成一个）。曾经把「字数」也算进身份，可巩固层拼回去之后字数必然变，于是它认不出自己、被搬了第二回。
- 巩固层的标题常量必须和写进文件的那一整行逐字相同（`## 巩固层（旧节的提要）`）。曾经误改成纯标题，拼接处多补一个 `## `，成了 `## ## 巩固层…`，切节认不出自己写的那一节。
- 「最旧」曾经是按文件位置挑的（`index < 总数 - keepSections`），暗含「末尾最新」。可这本账的写法是「新节插在最前面」，两头一撞，挑出来的「最旧」其实是**最新**的一批。现在按标题日期判，怎么写都不会搬错方向。
- 进程起来先安静地兑一次账（`ledger`、`worknoteFile`、`mistakesFile` 各一次），失败就算了，不拖慢启动；三件都跑完才给探针追一行（配了 `probeFile` 才写）。

任何异常都吞掉：监视器绝不打断一次请求。

## 边界

- 默认不碰磁盘：`home` 为空时只有提醒，没有压缩。
- 只认「按 `## ` 分节的 Markdown」，别的格式不动。
- 有超大节（超过 `sectionMaxChars`）就整本不动——免得一刀切掉没拆完的长文。
- 只搬、只提要，不做语义总结：提要就是标题加上节里最前面的几行（超长行截到 160 字符）。
- 依赖宿主提供 `sessionProjections` 或 `tokenMeter`；两个都没有时它安静地什么都不做。
- 探针默认关：不配 `probeFile` 就一个字都不写。
- 只用 Node 内置模块。

## 冒烟测试

```
node test/smoke.mjs
```

不连宿主、不碰真目录：假 ctx 加临时目录，把选项解析、压力判定、切节、按日期判新旧、巩固层合并、清单幂等、三本账各自的搬运与归档、超长节保护、没配 `home` 时不写盘、启动探针这些路径各走一遍（38 条）。

## English

**What it does** — Warns the session to flush what matters before context compaction kicks in (watching `agent/pre-step` pressure), and rolls long-form Markdown ledgers into frozen archives: the oldest `## `-delimited sections move out verbatim, leaving a one-line digest behind. Which section counts as oldest comes from the date in its title, not from where it sits in the file. Up to three books can be managed — the home ledger, a note outside the home directory, and a second day-per-section book. An optional startup probe appends one line per boot: version, this build's own sha256, and each book's outcome. All of it is deterministic string work — no model calls. Disk actions stay off unless you set `home`.

**Install** — `dsh plugin add hzh5021/dsh-memory-watch`, or drop the package into `~/.dsh/plugins/dsh-memory-watch/`, register it in the profile `package.json` (`dependencies` + `dsh.profile.bundles`) and restart DSH.

**Config** — `home` (`""`, or `DSH_MEMORY_WATCH_HOME`), `ledger` (`长期记忆库.md`), `archiveDir` (`记忆档案`), `enabled` (`true`), `highRatio` (`0.7`), `floorRatio` (`0.45`), `minGrowthTokens` (`24000`), `cooldownMs` (`300000`), `absoluteFallbackTokens` (`90000`), `keepSections` (`12`), `minArchiveSections` (`6`), plus the `worknote*` keys for a note outside the home directory, the `mistakes*` keys for a day-per-section book, and `probeFile` (`""`) for the optional startup probe.

**Requirements** — DSH exposing `sessionProjections` or `tokenMeter`; Node 18+; no external dependencies.

**License** — MIT.

## 版本

**0.2.0**

- 多管一本「一天一节」的账（`mistakes*`），跟账本、外部笔记同一套治法。
- 「最旧」改按标题日期判，不再按文件位置 —— 后者在「新节插在最前面」的账上会把最新的一批搬走。
- 巩固层（旧节的提要）不再要求排在第一位：不管在哪儿都认得出，也不会被反复搬、反复引。
- 新增可选的启动探针（`probeFile`）：每次启动记一行，含正在跑的这份代码的 sha256。
- 冒烟测试 29 → 38 条。

**0.1.0** — 第一版：压力提醒 + 一本账的滚动压缩。

MIT 许可。