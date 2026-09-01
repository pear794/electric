# 宿舍电费自动监控（全自动 · 零成本 · 无需常开电脑）

这是一个「每天自动抓取电表余额 → 计算每日消耗 → 网页折线图展示历史趋势」的
**纯 GitHub 方案**：抓取逻辑跑在 GitHub Actions（免费额度，每天定时一次），
网页托管在 GitHub Pages（免费），还能绑定你自己的域名。全程不需要任何自己的服务器，
也不需要在本地电脑常开任何程序。

数据来源：辰域智控系统（cnyiot.com）的服务器端渲染充值页
`http://www.wap.cnyiot.com/nat/pay.aspx?mid=19500908264`。
该页面无需登录、无需 Cookie、只需带上表号 `mid` 即可返回最新余额，是最稳定、零成本的抓取方式
（实测发现该值每次请求都会实时刷新，例如 43.13 → 43.12 → 43.11）。

---

## 一、项目结构

```
electric/
├── .github/workflows/electric.yml   # 定时抓取 + 提交数据 + 发布 Pages
├── scripts/scrape.mjs               # 抓取脚本（无第三方依赖，Node 18+）
├── data/electricity.json            # 数据仓库（每次抓取追加/更新一条记录）
├── index.html                       # 网页看板（原生 Canvas 自绘折线图，无第三方库）
├── CNAME.example                    # 自定义域名模板（复制为 CNAME 并填写你的域名）
├── package.json
└── .gitignore
```

---

## 二、工作原理

1. **每天 22:30（北京时间）**，GitHub Actions 触发 `electric.yml`。
   实际上 GitHub Actions 的 `cron` 用 UTC，所以配置为 `30 14 * * *`（14:30 UTC = 22:30 北京时间）。
2. 脚本 `scrape.mjs` 请求上面的余额页，用正则解析出 剩余电量 / 剩余金额 / 综合费用 / 表名。
3. 把今天的读数追加到 `data/electricity.json`，并**自动算出每日消耗**：
   `当日电费 = 前一日剩余金额 − 当日剩余金额`。
4. 脚本用 `git commit + push` 把数据写回仓库（让仓库保持活跃，避免定时任务被 GitHub 自动停用）。
5. 同一工作流调用 `actions/deploy-pages` 把静态站点发布到 GitHub Pages。
6. `index.html` 在浏览器里 `fetch("./data/electricity.json")`，用**原生 Canvas 自绘**出：
   - **剩余金额走势折线图**（核心）
   - **每日用电费用柱状图**

> 说明：某天若充了值，剩余金额会上升，这时无法靠「余额差值」算出真实消耗，
> 该天会标记为充电（红色柱、消耗计为 0）。想更精确，可把抓取频率改成每小时。

> 说明：整个网页零第三方依赖（不引入 CDN 的图表库，避免在某些网络环境下加载失败），
> 折线图用浏览器原生 Canvas 绘制，任何静态托管都能直接运行。

---

## 三、部署步骤

### 第 1 步：把项目推到 GitHub

新建一个仓库（比如叫 `dorm-electric`，**公开或私有都可以**），然后：

```bash
git init
git add .
git commit -m "init: dorm electricity monitor"
git remote add origin https://github.com/<你的用户名>/dorm-electric.git
git branch -M main
git push -u origin main
```

推送后，工作流会立即跑一次（因为配置了 `on: push`），先抓一次当前余额并部署到默认
`https://<你的用户名>.github.io/dorm-electric/`，你可以先打开确认数据正常。

### 第 2 步：开启 GitHub Pages（Source 设为 "GitHub Actions"）

到仓库 **Settings → Pages**：

- **Build and deployment** → **Source** 选 **GitHub Actions**。

这样 Pages 就交给工作流里的 `deploy-pages` 发布，每次抓取/推送后自动更新。
（如果开发环境选了 "Deploy from a branch" 也能用，但建议用 GitHub Actions 方式。）

### 第 3 步：绑定你自己的域名（可选，但这是你的目标）

① **在仓库根目录把 `CNAME.example` 改名成 `CNAME`**，把里面的 `electric.example.com`
换成你自己的域名（只填一个域名，不要带 `https://`）。例如 `electric.example.com`。

② **在域名服务商处添加 DNS 解析**（两种典型情况选一种）：

| 你想用的域名 | DNS 记录类型 | 主机记录 | 记录值 |
|---|---|---|---|
| 子域名，如 `electric.example.com` | CNAME | `electric` | `<你的用户名>.github.io` |
| 顶级域名，如 `example.com` | A | `@` | `185.199.108.153`（及 154/155/156） |

③ **到仓库 Settings → Pages → Custom domain**，填同一个域名并保存。
GitHub 会校验 DNS；通过后建议勾选 **Enforce HTTPS**。

④ 等待 DNS 生效（几分钟到几小时）。之后访问 `https://electric.example.com` 即可看到看板。

---

## 四、验证与手动触发

- 在仓库 **Actions** 页面可以看到每次运行记录。
- 想立刻抓一次 / 重跑：Actions → 左侧 **电费监控** → **Run workflow**（手动触发）。
- 数据会累积在 `data/electricity.json`；图表每天 22:30 自动多一个点。

---

## 五、常见配置

### 换表号
直接改 `scripts/scrape.mjs` 顶部：
```js
const METER_NO = process.env.METER_NO || "19500908264";
```
或在仓库 **Settings → Secrets and variables → Actions** 里加一个环境变量 `METER_NO`
（无需改代码）。

### 改抓取时间
改 `.github/workflows/electric.yml` 里的 `cron`。cron 是 UTC 时间：
- 22:30 北京 = `30 14 * * *`
- 想每小时一次：`0 * * * *`（UTC），对应北京时间每小时整点。
- 注意 GitHub 对 `cron` 最短间隔是 5 分钟；私有仓库免费额度每月 2000 分钟，每天一次绰绰有余。

### 60 天不活跃自动停用
GitHub 会停用「仓库 60 天无活动」的计划任务。本方案每天都会追加一条记录并提交，
**天然保持仓库活跃**，所以不会触发该限制（前提是电表余额每天有变化或每天正常追加记录）。

---

## 六、说明与边界

- 依赖目标站点页面结构，若辰域智控改版导致解析失败，工作流会标红，方便你发现并更新 `scrape.mjs`。
- 所有代码零第三方依赖，脚本只用 Node 内置模块，稳定、易维护。
- 数据与网页完全解耦：网页是纯静态，数据由每日提交的 JSON 驱动，任何静态托管都能承载。
