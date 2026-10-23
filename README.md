# dsh-memory-watch

在上下文被压缩之前提醒会话把要紧的先落盘，并给一本按 `## ` 分节的 Markdown 账本做确定性的滚动压缩。

## 它做什么

宿主自带的压缩会在压力到线时把最旧的一段摘要成一条 `<compacted-summary>`。那套模板是按写代码的口味做的（文件路径 / 错误与修复 / 下一步），拿它压对话里的偏好和取舍，出来常常只剩一句「用户偏好简短回复」，要紧的地方全丢；它的 token 计数又用「每 token 四字符」的启发式，对中文明显低估，于是压缩可能不打招呼就来。

这个插件不做第二套压缩，只做两件更靠前的事：

一是**盯压力、递话**。挂在 `agent/pre-step`，量当前会话的 token 压力；到线了就在这一轮开口之前把一句提醒塞进消息里——该落盘了，别等压缩把这段抹平。注入走 pre-step，图的是当场可见。

二是**顺手兑账**。长期账本只长不缩，插件提供一个纯函数的滚动压缩：最旧的若干节，正文搬去档案目录（冻结不删），原处留一行提要（日期 + 标题 + 前几行要点）。不做语义总结、不调模型，全是确定性字符串处理。

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

**滚动压缩**（纯函数 `consolidateLedger`）：按 `## ` 切节，先识别一节特殊的「巩固层（旧节的提要）」——它自己也是一节，但永远只保留、只往下追加提要，绝不参与「挑最旧的 N 节」。最新的 `keepSections` 节原样留着；更旧、又不在搬运清单里的节才搬。主本前言里有一条 HTML 注释清单，记着哪些节已经搬走，靠它保证幂等：跑两次跟跑一次一样。归档文件是追加写，主本用「写临时文件再 rename」原子替换。

三处踩过的坑：

- 一节的身份只认标题（空白折成一个）。曾经把「字数」也算进身份，可巩固层拼回去之后字数必然变，于是它认不出自己、被搬了第二回。
- 巩固层的标题常量必须和写进文件的那一整行逐字相同（`## 巩固层（旧节的提要）`）。曾经误改成纯标题，拼接处多补一个 `## `，成了 `## ## 巩固层…`，切节认不出自己写的那一节。
- 进程起来先安静地兑一次账（`ledger` 和 `worknoteFile` 各一次），失败就算了，不拖慢启动。

任何异常都吞掉：监视器绝不打断一次请求。

## 边界

- 默认不碰磁盘：`home` 为空时只有提醒，没有压缩。
- 只认「按 `## ` 分节的 Markdown」，别的格式不动。
- 有超大节（超过 `sectionMaxChars`）就整本不动——免得一刀切掉没拆完的长文。
- 只搬、只提要，不做语义总结：提要就是标题加上节里最前面的几行（超长行截到 160 字符）。
- 依赖宿主提供 `sessionProjections` 或 `tokenMeter`；两个都没有时它安静地什么都不做。
- 只用 Node 内置模块。

## 冒烟测试

```
node test/smoke.mjs
```

不连宿主、不碰真目录：假 ctx 加临时目录，把选项解析、压力判定、切节、清单幂等、搬运与归档、超长节保护、磁盘失败兜底这些路径各走一遍。

## English

**What it does** — Warns the session to flush what matters before context compaction kicks in (watching `agent/pre-step` pressure), and rolls a long-form Markdown ledger into a frozen archive: the oldest `## `-delimited sections move out verbatim, leaving a one-line digest behind. All of it is deterministic string work — no model calls. Disk actions stay off unless you set `home`.

**Install** — `dsh plugin add hzh5021/dsh-memory-watch`, or drop the package into `~/.dsh/plugins/dsh-memory-watch/`, register it in the profile `package.json` (`dependencies` + `dsh.profile.bundles`) and restart DSH.

**Config** — `home` (`""`, or `DSH_MEMORY_WATCH_HOME`), `ledger` (`长期记忆库.md`), `archiveDir` (`记忆档案`), `enabled` (`true`), `highRatio` (`0.7`), `floorRatio` (`0.45`), `minGrowthTokens` (`24000`), `cooldownMs` (`300000`), `absoluteFallbackTokens` (`90000`), `keepSections` (`12`), `minArchiveSections` (`6`), plus the `worknote*` keys for a second ledger outside the home directory.

**Requirements** — DSH exposing `sessionProjections` or `tokenMeter`; Node 18+; no external dependencies.

**License** — MIT.

MIT 许可。