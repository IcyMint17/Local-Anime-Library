# 本地番剧媒体库管理器 — 设计文档

日期：2026-10-05
状态：已定稿，进入实现

## 1. 目标

把硬盘上按「字幕组原始命名」堆放的番剧文件，整理成一个可视化番剧库：自动扫描、自动识别番剧、拉取元数据、生成海报墙，并支持手动记录观看进度。

真实数据源为 `E:\Videos\Anime`，共 23 个文件夹、约 340 个视频文件。

## 2. 已确认的决策

| 编号 | 决策 | 结论 |
| --- | --- | --- |
| Q1 | 运行形式 | **先做本地 Web 应用**（Node 后端 + 浏览器界面），架构上预留桌面打包；后续再套 Electron/Tauri 外壳 |
| Q2 | 元数据来源 | **Bangumi（bgm.tv）**，数据源做成可替换的一层，元数据全部落地本地缓存 |
| Q3 | 观看记录粒度 | **精确到每一集**；整部番的「未看/观看中/已看完」由集进度自动推导 |
| Q4 | 库位置 | `E:\Videos\Anime`（只读扫描，不移动、不重命名用户的文件） |
| Q5 | 第一版范围 | 核心闭环 + **手动纠错**（重新搜索、手动绑定、起始集号偏移）+ **点击播放**（系统默认播放器）。不含目录实时监控 |

## 3. 非目标（明确不做）

- 不移动、不重命名、不删除用户的任何文件。
- 不做 BT 下载、不做在线播放、不刮削弹幕。
- 不做实时目录监控（留给后续版本）。
- 不在第一版追求「一个文件夹拆成多个 Bangumi 条目」的完全自动拆分，遇到时用手动纠错兜底。

## 4. 用户库的真实形态（实测）

```
E:\Videos\Anime\<番剧文件夹>\<字幕组发布文件夹>\<视频文件>
```

存在以下变体与难点：

1. **文件夹名是中文，文件名常是日文罗马音**，两者都可能缺失对方的信息。
   例：`孤独摇滚！` 文件夹里的文件名也是中文，没有罗马音；`ATRI - My Dear Moments` 则只有罗马音。
2. **一个文件夹装两季**：`为美好的世界献上祝福` 同时含 Konosuba S2（10 集）与 S3（11 集）。
3. **绝对集号**：`Re：… 第四季 丧失篇` 的文件是第 67–76 集，而不是 01–10。
4. **一个文件夹跨两季**：`无职转生 第二季` 含 25 集（Bangumi 拆成「第二季 13 集 + 第2部分 12 集」）。
5. **特别篇混在正片里**：`孤独摇滚！` 共 60 个视频，其中 12 个正片、48 个特典 / 歌曲欣赏；`BanG Dream! It's MyGO!!!!!` 含 NCOP/NCED。
6. **剧场版无集号**：`摇曳露营`、`中二病也要谈恋爱剧场版`、`超时空辉夜姬！` 各只有 1 个视频。
7. **空文件夹**：`Re：… 第四季 夺还篇` 没有任何视频（Bangumi 上该条目存在，id=633836）。
8. **同目录夹带非视频文件**：字体（ttf/otf/ttc）、字幕（ass）、压缩包（7z/zip/rar）、扫描图（jpg）、CD 音轨（flac/cue/log）。

## 5. 匹配策略（基于真机探针验证）

用 23 个真实名称对 Bangumi 搜索接口做过完整探针，结论：

- **中文文件夹名首条命中率极高**（23 例中 22 例首条即正确条目）。
- **纯罗马音搜索不可靠**：`CHUUNIBYOU DEMO KOI GA SHITAI` 只搜到 `中二病也要谈恋爱！Lite`；`GOCHUUMON WA USAGI DESUKA BLOOM` 完全搜不到 BLOOM。
- 因此：**以文件夹名为主查询，文件名解析出的标题作补充查询，再对候选打分。**

打分维度（加权）：

1. **名称相似度** — 归一化（转小写、全角转半角、去标点空格、去 `！？` 等尾巴）后，与条目的 `name` 和 `name_cn` 分别比对取高者。
2. **季数一致性** — 从文件夹/文件名解析出的季数与条目标题中解析出的季数是否一致。
3. **集数一致性** — 本地正片集数与条目 `eps` 的接近程度。
4. **媒介类型** — 剧场版文件夹（无集号、只有 1 个文件、名字含 Movie/剧场版）优先匹配 `eps == 1` 的条目。
5. **条目质量** — 有播出日期、有评分人数、rank 靠前者加分。

判定：

- 最高分 ≥ 阈值 **且** 与第二名差距 ≥ 阈值 → 自动绑定，`match_state = 'auto'`。
- 否则 `match_state = 'unmatched'`，但保留前 10 个候选，供界面「重新匹配」使用。
- 用户手动绑定后 `match_state = 'manual'`，之后重新扫描不再覆盖。

季数别名表（从标题中识别季数）：

| 标记 | 季数 |
| --- | --- |
| `S2` / `第二季` / `第2期` / `II` / `2nd Season` / `Repeat` | 2 |
| `S3` / `第三季` / `第3期` / `III` / `3rd Season` / `Nonstop` / `BLOOM` | 3 |
| `S4` / `第四季` / `IV` / `4th Season` | 4 |
| `第N部分` / `第Nクール` | 视为「同季的第 N 个部分」，不单独作为季数 |

## 6. 技术选型

| 方面 | 选择 | 理由 |
| --- | --- | --- |
| 运行时 | Node.js ≥ 22（实测 v24.19） | 已装，内置 `node:sqlite`、`fetch`、`node:test` |
| 依赖 | **零 npm 依赖** | 离线可用、后续打包 Electron/Tauri 体积小、不会被原生模块编译卡住 |
| 数据库 | SQLite（`node:sqlite`） | Node 24 内置，无需编译 |
| HTTP | `node:http` 自建静态服务 + JSON API | 无框架 |
| 前端 | 原生 HTML/CSS/JS，无构建步骤 | 改完刷新即可；打包时直接当静态资源 |
| 测试 | `node --test` | 内置 |

**代理**：本机通过 `127.0.0.1:7892`（Clash 类）出网，Node 默认不使用系统代理。
因此自建 HTTP 客户端实现 `CONNECT` 隧道，代理来源优先级：
`config.proxy` → 环境变量 `HTTPS_PROXY`/`HTTP_PROXY` → Windows 注册表 `Internet Settings` → 探测常见本地端口（7890/7891/7892/10809/1080/8080）。

## 7. 架构

```
src/
  main.js              入口：读配置、建库、起服务、开浏览器
  config.js            配置读写、代理自动探测
  net/http.js          支持代理隧道的 JSON 客户端 + 限流 + 重试
  db/schema.js         SQLite 建表
  db/repo.js           所有数据库读写
  scan/walk.js         递归遍历 + 视频扩展名过滤 + 忽略规则
  scan/parse.js        文件名/文件夹名解析 → 季、集、类型
  scan/group.js        按（番剧文件夹，季）分组，处理一文件夹多季
  scan/pipeline.js     扫描 → 分组 → 匹配 → 落库 的编排
  meta/bangumi.js      Bangumi 客户端（搜索、条目、剧集列表）
  meta/matcher.js      候选打分与自动绑定
  meta/covers.js       封面下载与本地缓存
  playback/open.js     用系统默认播放器打开文件
  api/routes.js        REST 路由
public/                前端静态资源
test/                  node:test 测试
data/                  library.db + covers/（不进版本库）
```

分层原则：`scan/*` 与 `meta/*` 不依赖 HTTP 层，可单独测试；`db/repo.js` 是唯一写数据库的地方；`api/routes.js` 只做参数校验与编排。

## 8. 数据模型

```sql
-- 一部番 = 一个 Bangumi 条目（或一个未识别的本地文件夹）
series(
  id INTEGER PK,
  bangumi_id INTEGER UNIQUE NULL,     -- NULL = 未识别
  title_cn TEXT, title_orig TEXT, title_jp TEXT,
  summary TEXT, air_date TEXT, eps_total INTEGER,
  cover_url TEXT, cover_path TEXT, rating REAL, rating_count INTEGER,
  source_folder TEXT,                 -- 来源本地文件夹
  match_state TEXT,                   -- auto | manual | unmatched
  match_score REAL,
  created_at TEXT, updated_at TEXT
)

-- 本地文件
files(
  id INTEGER PK,
  series_id INTEGER,
  path TEXT UNIQUE, name TEXT, ext TEXT, size INTEGER, mtime TEXT,
  kind TEXT,                          -- episode | special | movie
  season INTEGER, ep_number INTEGER, -- 解析出的季与集（可空）
  ep_label TEXT,                      -- 原始集号文本，如 "67"
  confidence REAL
)

-- Bangumi 官方剧集列表
episodes(
  id INTEGER PK,
  series_id INTEGER, number INTEGER, sort INTEGER,
  title TEXT, title_cn TEXT, air_date TEXT,
  UNIQUE(series_id, number)
)

-- 观看记录：一项一个键，避免两处状态不同步
watch_marks(
  series_id INTEGER, item_key TEXT,   -- "ep:3" | "sp:file-12" | "movie"
  watched INTEGER, watched_at TEXT,
  PRIMARY KEY(series_id, item_key)
)

-- 未自动匹配时保留的候选，供手动纠错
match_candidates(
  series_id INTEGER, bangumi_id INTEGER, score REAL, payload TEXT,
  PRIMARY KEY(series_id, bangumi_id)
)

scan_runs(id INTEGER PK, started_at TEXT, finished_at TEXT,
          files_seen INTEGER, added INTEGER, removed INTEGER,
          matched INTEGER, unmatched INTEGER)
```

**状态推导**（不落库，读取时计算）：

- 没有任何 `kind='episode'` 的文件被标记已看 → `未看`
- 部分已看，或全部已看但本地集数 < `eps_total` → `观看中`
- 全部已看且本地集数 ≥ `eps_total` → `已看完`

特别篇与剧场版不计入正片进度。

## 9. HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/library` | 番剧列表（含推导状态、进度、封面） |
| GET | `/api/series/:id` | 详情：元数据 + 剧集表 + 文件表 + 观看记录 |
| POST | `/api/series/:id/watch` | `{itemKey, watched}` 切换观看状态 |
| POST | `/api/series/:id/watch-all` | 一键全看 / 全不看 |
| GET | `/api/series/:id/candidates` | 手动纠错用的候选列表 |
| POST | `/api/series/:id/match` | `{bangumiId, epOffset}` 手动绑定 |
| POST | `/api/series/:id/unmatch` | 解除绑定 |
| GET | `/api/search?q=` | 直接搜 Bangumi |
| POST | `/api/files/:id/play` | 用系统默认播放器打开 |
| POST | `/api/scan` | 触发扫描（SSE 推送进度） |
| GET | `/api/scan/status` | 当前扫描状态 |
| GET/PUT | `/api/settings` | 配置读写（扫描目录、代理等） |
| GET | `/covers/:name` | 本地封面缓存 |

## 10. 界面

- **左栏**：库（全部番剧）/ 未识别 / 设置。
- **顶栏**：搜索框、状态筛选（全部 / 未看 / 观看中 / 已看完）、排序（最近添加 / 评分 / 名称 / 进度）。
- **海报墙**：封面卡片 + 标题 + 进度条 + 状态角标；鼠标悬停显示集数进度。
- **详情页**：大封面、元数据（原名/中文名/播出日期/评分/集数）、操作按钮（一键全看、重新匹配）、剧集列表（每集一个勾选框，标注本地是否有文件）、文件列表（含播放按钮与文件路径）。
- **重新匹配对话框**：关键词搜索 + 候选列表（带封面）+ 起始集号偏移输入 + 绑定按钮。

## 11. 错误处理

- 网络失败：自动重试 3 次（指数退避）；仍失败则保留本地库可正常浏览，界面提示「元数据更新失败，当前显示本地缓存」。
- Bangumi 限流（429）：按 `Retry-After` 退避，并全局限速 1 请求/秒。
- 无中文名条目：`title_cn` 回落为原名。
- 封面下载失败：使用占位图。
- 单条匹配失败不影响整体扫描，扫描报告里单独列出。
- 空文件夹：不作为番剧入库，仅在扫描报告中提及。

## 12. 测试

`node --test`，全部使用真实文件名作为用例：

1. **解析测试** — 覆盖 `- 01`、`[01]`、`01v2`、`S01E03`、`第N集`、Movie、NCOP/NCED/特典/小剧场 等 10+ 种命名。
2. **分组测试** — 「为美好的世界献上祝福」必须拆成 S2/S3 两组；「无职转生 第二季」保持一组。
3. **匹配打分测试** — 用真实探针结果作为固定输入，验证 23 个文件夹的自动匹配结论（离线 fixture，不依赖网络）。
4. **状态推导测试** — 未看 / 观看中 / 已看完 / 特典不计入。
5. **HTTP 客户端测试** — 起一个本地测试服务器验证 JSON、超时、重试。
6. **数据库测试** — 建库、写入、读取、幂等重扫（第二次扫描不产生重复行）。

## 13. 交付物

- 可运行的本地 Web 应用（`start.cmd` 一键启动）
- 设计文档（本文件）
- 测试套件
- `README.md`：如何启动、如何配置代理、如何添加扫描目录

## 14. 后续路线（不在本次范围）

1. 桌面打包（Electron/Tauri 外壳）。
2. 目录实时监控，自动发现新番。
3. 一个文件夹自动拆成多个 Bangumi 条目（处理跨季 / 跨部分）。
4. 接入 AniList 作为兜底数据源。
5. 内置播放器或调用 PotPlayer/MPV 并回传播放进度。
