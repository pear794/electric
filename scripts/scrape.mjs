#!/usr/bin/env node
/**
 * 电费监控抓取脚本（无第三方依赖，Node 18+，可直接跑在 GitHub Actions 上）
 *
 * 数据源：辰域智控系统（cnyiot.com）服务器端渲染的充值页。
 * 该页 URL 带上表号 mid 即可返回最新的剩余电量 / 剩余金额 / 综合费用，
 * 无需登录、无需 Cookie，是最稳定、零成本的抓取方式。
 *
 * 用法：node scripts/scrape.mjs
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_FILE = join(ROOT, "data", "electricity.json");

// 表号：既可以从配置文件读，也可以直接在这里改。
const METER_NO = process.env.METER_NO || "19500908264";
const PAY_URL = `http://www.wap.cnyiot.com/nat/pay.aspx?mid=${METER_NO}`;

/** 数据文件中抓取不到时抛错，让 GitHub Actions 看到红色失败。 */
function die(msg) {
  console.error(`[scrape] 抓取失败：${msg}`);
  process.exit(1);
}

/** 在标签与关键字之间做宽松匹配，返回 <label ...>数值</label> 的内容。 */
function grabValue(html, keyword, unitHint = null) {
  // 关键字出现位置
  const idx = html.indexOf(keyword);
  if (idx === -1) return null;
  const tail = html.slice(idx);
  // 紧跟其后的第一个带数值的 label
  const labelM = tail.match(/<label[^>]*>\s*([\d.]+)\s*<\/label>/);
  if (!labelM) return null;
  const num = labelM[1];
  if (unitHint) {
    // 校验后面确实跟着该单位，避免抓到错误字段
    const after = tail.slice(labelM.index + labelM[0].length, labelM.index + labelM[0].length + 40);
    if (!after.includes(unitHint)) return null;
  }
  return num;
}

async function fetchPage() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(PAY_URL, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parse(html) {
  const remainingKwh = grabValue(html, "剩余电量", "kWh");
  const remainingMoney = grabValue(html, "剩余金额", "元");
  const price = grabValue(html, "综合费用", "元/kWh");

  // 表名：关键字中间被 &ensp; 实体隔开，先把实体替换成空格再匹配
  const norm = html.replace(/&ensp;/g, " ").replace(/&nbsp;/g, " ");
  const nameM = norm.match(/表\s*名\s*称\s*:\s*[\s\S]*?<label[^>]*>([^<]+)<\/label>/);
  const meterName = nameM ? nameM[1].trim() : null;

  const idM = html.match(/<label id="metid"[^>]*>\s*([^<]+)\s*<\/label>/);
  const meterNo = idM ? idM[1].trim() : null;

  if (!remainingKwh || !remainingMoney) {
    // 页面结构可能变化或有反爬，报错并附上片段便于排查
    const snippet = html.slice(0, 400).replace(/\s+/g, " ");
    die(`无法解析余额字段（页面结构变化？）。页面片段：${snippet}`);
  }

  return {
    remainingKwh: Number(remainingKwh),
    remainingMoney: Number(remainingMoney),
    price: price ? Number(price) : 1,
    meterName,
    meterNo,
  };
}

/** 当前北京时间 YYYY-MM-DD 与 HH:MM。 */
function beijingNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

async function main() {
  const html = await fetchPage();
  const reading = parse(html);
  const now = beijingNow();

  let store = { meterNo: "", meterName: "", pricePerKwh: 1, records: [] };
  if (existsSync(DATA_FILE)) {
    try {
      const raw = await readFile(DATA_FILE, "utf8");
      store = JSON.parse(raw.replace(/^\uFEFF/, ""));
    } catch {
      store = { meterNo: "", meterName: "", pricePerKwh: 1, records: [] };
    }
  }
  store.meterNo = reading.meterNo || store.meterNo || METER_NO;
  store.meterName = reading.meterName || store.meterName || "";
  store.pricePerKwh = reading.price || store.pricePerKwh || 1;

  const records = Array.isArray(store.records) ? store.records : [];
  const prev = records.length ? records[records.length - 1] : null;

  const today = { date: now.date, time: now.time };

  // 消费量：对比上一条记录。若电量/金额下降则是正常消耗；若上升则是充了值。
  let consumedKwh = 0;
  let consumedCost = 0;
  let recharged = false;
  let topup = 0;

  if (prev && prev.date !== today.date) {
    const dropKwh = round2(prev.remainingKwh - reading.remainingKwh);
    const dropMoney = round2(prev.remainingMoney - reading.remainingMoney);
    if (dropKwh > 0) {
      consumedKwh = dropKwh;
      consumedCost = round2(consumedKwh * store.pricePerKwh);
    } else {
      // 电量上升：昨天到今天的读数被充值影响了
      recharged = true;
      topup = round2(dropMoney > 0 ? 0 : -dropMoney);
    }
  }

  const record = {
    date: today.date,
    time: today.time,
    remainingKwh: reading.remainingKwh,
    remainingMoney: reading.remainingMoney,
    consumedKwh: round2(consumedKwh),
    consumedCost: round2(consumedCost),
    recharged,
    topup: round2(topup),
  };

  // 同一天重复运行则更新该条，否则追加
  const last = records[records.length - 1];
  if (last && last.date === record.date) {
    records[records.length - 1] = record;
  } else {
    records.push(record);
  }

  store.records = records;
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(store, null, 2) + "\n", "utf8");

  console.log("[scrape] 本次抓取成功：");
  console.log("  表名:", store.meterName);
  console.log("  表号:", store.meterNo);
  console.log("  单价:", store.pricePerKwh, "元/kWh");
  console.log("  剩余电量:", reading.remainingKwh, "kWh");
  console.log("  剩余金额:", reading.remainingMoney, "元");
  console.log("  时间:", record.date, record.time);
  console.log(
    "  当日消耗:",
    consumedKwh,
    "kWh /",
    consumedCost,
    "元" + (recharged ? "（检测到充值，电量被充值影响）" : "")
  );
  console.log("  记录总数:", records.length);
}

main().catch((e) => die(e.message));
