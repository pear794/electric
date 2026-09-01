/**
 * 电费监控 —— 腾讯云函数（SCF）抓取与数据写回（每小时一个点）
 *
 * 运行位置：腾讯云 SCF（建议选 广州/上海 等国内区域）。国内 IP 才能抓到电费数据
 * （境外/机房 IP 会被电费平台返回 405 拦截）。
 *
 * 触发方式：定时触发器，每小时整点一次（cron：0 0 * * * ? *）。
 *
 * 需要配置的环境变量（在 SCF 的「函数配置 → 环境变量」里填）：
 *   GITHUB_TOKEN  必填，GitHub 细粒度 Token（仅对该仓库 Contents 读写权限）
 *   GITHUB_REPO   选填，仓库名，默认 pear794/electric
 *   GITHUB_BRANCH 选填，分支，默认 main
 *   METER_NO      选填，表号，默认 19500908264
 */

const http = require("http");
const https = require("https");

const METER_NO = process.env.METER_NO || "19500908264";
const REPO = process.env.GITHUB_REPO || "pear794/electric";
const BRANCH = process.env.GITHUB_BRANCH || "main";
const FILE_PATH = "data/electricity.json"; // 仓库内数据文件路径
const TOKEN = process.env.GITHUB_TOKEN;
const MAX_RECORDS = 5000; // 最多保留近 ~208 天的每小时数据

const CNYIOT_URL = `http://www.wap.cnyiot.com/nat/pay.aspx?mid=${METER_NO}`;

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9",
          "Upgrade-Insecure-Requests": "1",
          Referer: "http://www.wap.cnyiot.com/",
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error("HTTP " + res.statusCode));
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error("抓取超时"));
    });
  });
}

function apiRequest(method, path, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = {
      "User-Agent": "scf-electric-monitor",
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + TOKEN,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (data) headers["Content-Type"] = "application/json";
    const req = https.request(
      "https://api.github.com" + path,
      { method, headers },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json = {};
          try {
            json = JSON.parse(raw || "{}");
          } catch (e) {
            json = { message: raw };
          }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(Object.assign(new Error("GitHub API " + res.statusCode), { status: res.statusCode, body: json }));
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function grabValue(html, key, unitHint) {
  const idx = html.indexOf(key);
  if (idx === -1) return null;
  const tail = html.slice(idx);
  const m = tail.match(/<label[^>]*>\s*([\d.]+)\s*<\/label>/);
  if (!m) return null;
  const after = tail.slice(m.index + m[0].length, m.index + m[0].length + 40);
  if (unitHint && !after.includes(unitHint)) return null;
  return m[1];
}

function parse(html) {
  const remainingKwh = grabValue(html, "剩余电量", "kWh");
  const remainingMoney = grabValue(html, "剩余金额", "元");
  const price = grabValue(html, "综合费用", "元/kWh");
  const norm = html.replace(/&ensp;/g, " ").replace(/&nbsp;/g, " ");
  const nameM = norm.match(/表\s*名\s*称\s*:\s*[\s\S]*?<label[^>]*>([^<]+)<\/label>/);
  const meterName = nameM ? nameM[1].trim() : null;
  const idM = html.match(/<label id="metid"[^>]*>\s*([^<]+)\s*<\/label>/);
  const meterNo = idM ? idM[1].trim() : null;
  if (!remainingKwh || !remainingMoney) throw new Error("无法解析余额字段，页面结构可能变化");
  return {
    remainingKwh: Number(remainingKwh),
    remainingMoney: Number(remainingMoney),
    price: price ? Number(price) : 1,
    meterName,
    meterNo,
  };
}

function beijingNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const iso = d.toISOString();
  return {
    date: iso.slice(0, 10),
    time: iso.slice(11, 16),
    ts: iso.slice(0, 16).replace("T", " "),
  };
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

async function fetchCurrentStore() {
  try {
    const res = await apiRequest("GET", `/repos/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}`);
    const content = Buffer.from(res.content, "base64").toString("utf8");
    return { store: JSON.parse(content.replace(/^\uFEFF/, "")), sha: res.sha };
  } catch (e) {
    if (e.status === 404) return { store: { meterNo: "", meterName: "", pricePerKwh: 1, records: [] }, sha: null };
    throw e;
  }
}

async function main() {
  if (!TOKEN) throw new Error("缺少环境变量 GITHUB_TOKEN");

  const html = await fetchText(CNYIOT_URL);
  const reading = parse(html);
  const now = beijingNow();

  const { store, sha } = await fetchCurrentStore();
  store.meterNo = reading.meterNo || store.meterNo || METER_NO;
  store.meterName = reading.meterName || store.meterName || "";
  store.pricePerKwh = reading.price || store.pricePerKwh || 1;

  let records = Array.isArray(store.records) ? store.records : [];
  const prev = records.length ? records[records.length - 1] : null;

  // 计算自上一小时以来的消耗。若金额/电量上升 -> 判定为充值（到账净值即余额增加量）。
  let consumedKwh = 0;
  let consumedCost = 0;
  let recharged = false;
  let topup = 0;

  if (prev) {
    const deltaMoney = round2(reading.remainingMoney - prev.remainingMoney);
    const deltaKwh = round2(reading.remainingKwh - prev.remainingKwh);
    if (deltaMoney > 0) {
      // 余额上升 = 充值（平台扣手续费后实际到账即余额增加量，如充100到账99.4）
      recharged = true;
      topup = deltaMoney;
    } else {
      consumedKwh = round2(prev.remainingKwh - reading.remainingKwh);
      if (consumedKwh < 0) consumedKwh = 0;
      consumedCost = round2(consumedKwh * store.pricePerKwh);
    }
  }

  const record = {
    date: now.date,
    time: now.time,
    ts: now.ts,
    remainingKwh: reading.remainingKwh,
    remainingMoney: reading.remainingMoney,
    consumedKwh: round2(consumedKwh),
    consumedCost: round2(consumedCost),
    recharged,
    topup: round2(topup),
  };

  const last = records[records.length - 1];
  if (last && last.ts === record.ts) records[records.length - 1] = record;
  else records.push(record);

  if (records.length > MAX_RECORDS) records = records.slice(records.length - MAX_RECORDS);
  store.records = records;

  const content = Buffer.from(JSON.stringify(store, null, 2) + "\n").toString("base64");
  const body = { message: `chore: 更新电费数据 ${now.ts}`, content, branch: BRANCH };
  if (sha) body.sha = sha;

  await apiRequest("PUT", `/repos/${REPO}/contents/${FILE_PATH}`, body);

  return {
    ok: true,
    meterName: store.meterName,
    meterNo: store.meterNo,
    remainingKwh: reading.remainingKwh,
    remainingMoney: reading.remainingMoney,
    consumedKwh,
    consumedCost,
    recharged,
    topup,
    ts: now.ts,
    records: records.length,
  };
}

exports.main_handler = async (event, context) => {
  try {
    const result = await main();
    console.log(JSON.stringify(result));
    return result;
  } catch (e) {
    console.error("[scf-electric] 失败：", e.message);
    throw e;
  }
};
