# AGENTS.md — 宿舍电费监控（electric）

面向在本仓库工作的 AI/人类贡献者。**先读本文件，再动手。**

## 项目一句话

宿舍电表余额由腾讯云函数 SCF 每小时抓取 → 写回 `data/electricity.json` → GitHub Pages
自动发布 `index.html` 看板（原生 Canvas 自绘折线/柱状图）。零第三方依赖、零服务器、零成本。

## 目录职责

| 路径 | 职责 |
|---|---|
| `scf/index.js` | **生产抓取端**。腾讯云 SCF（Node 16 + 内置 `http`/`https`）运行，每小时整点触发，抓取 + 计算 + 写回仓库。**生产行为以本文件为准。** |
| `scripts/scrape.mjs` | 历史遗留的本地调试脚本，按天逻辑，与 SCF 不一致。不要把它当生产入口，也不要照抄它的算法。 |
| `index.html` | 纯静态看板，单文件内联 CSS/JS，无构建、无 CDN。 |
| `data/electricity.json` | 数据仓库，由 SCF 自动写入。含 `meterNo` / `meterName` / `pricePerKwh` / `records[]`。 |
| `.github/workflows/electric.yml` | **只做一件事**：main 有 push 时发布 GitHub Pages。这里没有、也不应有抓取任务。 |
| `README.md` / `TENCENT_SCF_SETUP.md` | 部署与说明文档。已知部分内容过时（见"文档陷阱"）。 |

## 常用命令

```bash
# 本地手动抓一次（会直接改写 data/electricity.json！）
npm run scrape

# 语法检查（无测试框架，这是最低限度的校验）
node --check scf/index.js
node --check scripts/scrape.mjs

# 本地预览看板：必须用 HTTP 服务，file:// 下 fetch 会失败
npx serve .          # 或 python -m http.server
```

没有测试、没有 lint、没有构建步骤。不要为此引入打包器或框架，除非明确要求。

## 硬性约束（踩过坑的）

1. **抓取必须走国内 IP。** 目标站点 `http://www.wap.cnyiot.com/nat/pay.aspx?mid=…`
   会拦截境外/机房 IP（返回 405）。**绝不要把抓取移回 GitHub Actions。**
   本地网络（尤其境外出口）跑 `npm run scrape` 也可能 405，这属于预期现象，别据此改代码。

2. **SCF 运行环境是 Node.js 16。** 不要使用 Node 18+ 才有的 API（全局 `fetch`、
   `structuredClone` 等）；继续用 `http`/`https` 内置模块。执行超时上限按 60s 设计。

3. **时间统一按北京时间（UTC+8）**，不要依赖服务器本地时区。现有实现：
   `new Date(Date.now() + 8 * 3600 * 1000)` 后取 ISO 片段。改动时保持这一约定，
   `ts` 字段格式固定为 `YYYY-MM-DD HH:MM`。

4. **数据文件是 SCF 的产物，不是手写文件。** 除非用户明确要求，不要手工改历史记录。
   若必须手改，保持 2 空格缩进、末尾换行、字段顺序，并说明原因。`MAX_RECORDS = 5000`
   的截断行为是刻意设计，改它要说明取舍。

5. **凭据零落地。** `GITHUB_TOKEN` 只存在于 SCF 环境变量；绝不写进代码、文档、日志
   或提交历史。表号与表名属于真实住址信息，**不要新增任何个人信息到仓库**。

6. **看板零依赖。** 不引入 CDN 图表库、不引入前端框架。绘图复用现有的
   `setupCanvas` / `drawLine` / `drawBars` / `computeScale`，样式复用 `:root` 里的 CSS 变量。

7. **抓取频率在腾讯云 SCF 触发器里改，不在 GitHub。** 当前 cron 为 7 段格式
   `0 0 * * * ? *`（每小时整点）。文档里"改 `electric.yml` 的 cron"的说法是错的。

## 数据契约

- `records[]` 递增追加，每条代表一次抓取（约每小时一个点）。
- `remainingKwh` / `remainingMoney`：抓取当时的剩余量，2 位小数。
- `consumedKwh` / `consumedCost`：**与上一条记录的差值**，不是当日累计。
- `recharged` / `topup`：金额上升即判定充值，`topup` 是余额净增量（不是到账面额）。
  已知面额与 0.6% 手续费（`RECHARGE_AMOUNTS` 环境变量，默认 `50,100`），用
  `rechargeNet − topup` 反推该小时真实用电写入 `consumedCost`，并记录
  `rechargeAmount` / `rechargeNet`。匹配不到面额（退费、校正、未配置的面额）时
  该小时消耗为 0，退化为旧行为。`repairRechargeRecords` 会幂等修补历史记录。
- `date` / `time`：本次抓取时间；`ts`：`date + " " + time`，旧记录可能缺失。
- `day`：**费用归属日**，用于处理 00:00 点跨天。当前实现是 `prev.date`，在断档跨天时
  会把数小时消耗错误归到前一天（已知缺陷，见下）。页面用 `r.day || r.date` 兼容旧数据。
- 前端聚合：每小时费用直接取 `consumedCost`，每日费用按 `day` 求和。

## 已知缺陷（改相关代码时顺手修，别复制）

- `scf/index.js` 的 `day` 归属条件过宽：断档跨天或停摆数天后恢复，消耗会全部记到前一天。
- 抓取失败只写日志，无告警；Token 到期后静默停更。页面也没有"数据陈旧"提示。
- 写回 GitHub 无重试，并发/抖动时会丢点（409）。
- `dedupeRecords` 会永久删除间隔 <10 分钟的历史点，而不只是跳过本次写入。
- 页面"平均每日电费"把首日、今日等不完整天算进分母，结果偏低。
- 00:00 点后的"今日电费"卡片实际显示的是前一天累计。
- `README.md` 仍写"每天 22:30 抓取"、`TENCENT_SCF_SETUP.md` 仍写"每天抓取"，
  实际是每小时。`scripts/scrape.mjs` 已过时。

## 文档陷阱

改行为后**必须同步文档**。已知过时点：

- `README.md`：「工作原理」说每天 22:30、「常见配置」让你改 `electric.yml` 的 cron、
  「项目结构」仍把 `scrape.mjs` 列为抓取入口。
- `TENCENT_SCF_SETUP.md`：标题与开头写"每天"，实际每小时。

## 审查/提交习惯

- 数据提交由 SCF 生成（`chore: 更新电费数据 <ts>`），会淹没正常历史；查代码历史用：
  `git log --oneline -- . ':!data/electricity.json'`
- 改动 SCF 代码后，**必须在腾讯云控制台重新粘贴并部署**，否则线上不生效；仓库里的
  `scf/index.js` 只是源码存档，不是部署源。
- `index.html` / 文档改动推送到 main 即自动发布，无需其他操作。
- 默认语言：简体中文（注释、文档、提交信息），代码标识符用英文。
