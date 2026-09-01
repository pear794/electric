# 用腾讯云函数 SCF 每天抓取电费（国内 IP，免费）

> 为什么不用 GitHub Actions 抓取：那个电费平台会拦截境外/机房 IP（返回 405）。
> 所以抓取改到**国内 IP** 的腾讯云函数 SCF 来跑，它每天抓取后经 GitHub API 把数据写回仓库，
> GitHub Pages 收到更新后自动重新发布到 `electric.buaili.com`。全程免费、无需本地电脑常开。

---

## 一、先做一个 GitHub 细粒度 Token（SCF 用来往你的仓库写数据）

1. GitHub 右上角头像 → **Settings** → 左侧 **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**。
2. Token **name**：`electric-monitor`；**Expiration**：建议 90 天（到期后在 SCF 换新的即可）。
3. **Repository access**：选 **Only select repositories** → 勾选 `pear794/electric`。
4. **Permissions → Repository permissions**：找到 **Contents**，设为 **Read and write**。
5. 点 **Generate token**，把出现的 token **完整复制**（只显示一次）。这就是下面要填的 `GITHUB_TOKEN`。

---

## 二、创建腾讯云函数 SCF

1. 注册/登录 [腾讯云](https://console.cloud.tencent.com/)（国内手机号 + 实名认证，免费）。
2. 进入 **[云函数 SCF 控制台](https://console.cloud.tencent.com/scf/index)**。
3. 左上角**确认地域选国内**（推荐 **广州** 或 **上海**，国内区域才能访问电费平台）。
4. 点 **新建** → **函数名称**填 `electric-monitor` → **运行环境**选 **Node.js 16.13**（或 18）→ **创建方式**选 **在线编辑** → 按提示创建。

## 三、粘贴函数代码

1. 选中你刚创建的 `electric-monitor` 函数。
2. 打开 **函数代码** 页签，把项目里 `scf/index.js` 的**全部内容**粘贴到 `index.js` 里，覆盖原来的模板代码。
3. 点右上角 **保存**，再点 **部署**。

## 四、配置环境变量

进入 **函数配置** 页签 → 找到 **环境变量** → **添加**，然后**逐条**添加：

| 变量名 | 值 | 说明 |
|---|---|---|
| `GITHUB_TOKEN` | `github_pat_….` | 第一步复制的那串 token（必填） |
| `GITHUB_REPO` | `pear794/electric` | 选填，默认就是这个 |
| `GITHUB_BRANCH` | `main` | 选填，默认 `main` |
| `METER_NO` | `19500908264` | 选填，默认就是你的表号 |

保存后记得**再部署一次**（让环境变量生效）。

## 五、调大超时时间

在 **函数配置** → **执行超时时间**，从默认的 **3 秒**改成 **60 秒**（最关键，网络抓取+写回需要时间）。
**内存**默认 128MB 即可。**网络配置**保持「公网访问」（默认即可，**不要绑 VPC**）。

## 六、创建定时触发器（每天 22:30）

1. 进入 **触发管理** 页签 → **创建触发器**。
2. 触发方式选 **定时触发**；Cron 表达式填：
   ```text
   0 30 22 * * * *
   ```
   （腾讯云 SCF 的 cron 是 7 段：秒 分 时 日 月 星期 年，上面表示每天 22:30:00。）
3. 确认创建。

## 七、先手动测试一次

- **触发管理 → 云函数→ 测试**（或点「运行测试」）手动执行一次。
- 看 **函数日志**，若输出类似
  `{"ok":true,...,"remainingMoney":42.99,...,"records":...}` 说明成功。
- 然后去 GitHub 仓库看 `data/electricity.json` 是否被 SCF 更新了（多了今天的记录）。
  - 更新成功后，GitHub Actions 的 `发布电费看板` 会因 push 自动跑一次并发布 Pages。

## 八、访问

浏览器打开 `https://electric.buaili.com`，应能看到折线图。

---

## 常见问题排查

| 现象 | 原因 / 解决 |
|---|---|
| SCF 日志报 `缺少环境变量 GITHUB_TOKEN` | 第五步环境变量没加或没部署，重加并部署。 |
| SCF 报 `HTTP 405` | 地域选到了境外（如中国香港/新加坡）。改成 **广州/上海** 再部署。 |
| SCF 报 `抓取超时` 或 GitHub API 错误 | 执行超时没调大（第五步），改成 60s。 |
| 日志成功但 GitHub 数据没更新 | Token 的 Contents 权限没勾 **Read and write**，或没选对仓库。 |
| 数据每天都变所以一直有 push → Pages 每次自动发布 | 正常。公开仓库免费，每日一次没问题。 |
| Token 过期 | 到 GitHub 重新生成一个，改 SCF 环境变量 `GITHUB_TOKEN` 再部署。 |

> 说明：`data/electricity.json` 由 SCF 每日写回，GitHub Actions 只负责在 push 后发布页面，
> 所以即使 GitHub 的定时抓取被平台拦截，也不影响整体运行。
