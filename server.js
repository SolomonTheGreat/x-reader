// server.js — X Reader 后端（Zeabur 兼容版）
// 数据源：twitterapi.io / TTS：火山引擎
// 存储：内存 Map（无原生依赖，Zeabur 秒起）
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cron = require('node-cron');
const fetch = require('node-fetch');

// ---------- 配置 ----------
const PORT = process.env.PORT || 3000;
const VOLC_APP_ID = process.env.VOLC_APP_ID || '';
const VOLC_ACCESS_TOKEN = process.env.VOLC_ACCESS_TOKEN || '';
const VOLC_CLUSTER = process.env.VOLC_CLUSTER || 'volcano_tts';
const VOLC_VOICE_TYPE = process.env.VOLC_VOICE_TYPE || 'BV700_V2_streaming';
const TWITTERAPI_KEY = process.env.TWITTERAPI_KEY || '';
const SUBSCRIPTIONS = (process.env.SUBSCRIPTIONS || 'TaoRay,dontbesilent,karpathy,naval')
  .split(',')
  .map(s => s.trim().replace(/^@/, ''))
  .filter(Boolean);
const FETCH_INTERVAL_MINUTES = parseInt(process.env.FETCH_INTERVAL_MINUTES || '60', 10);
const INCLUDE_REPLIES = process.env.INCLUDE_REPLIES === '1';
const MAX_TWEETS = parseInt(process.env.MAX_TWEETS || '5000', 10); // 内存里最多保留多少条

// 打开 App 触发抓取的节流阈值（分钟）：距离上次抓取超过 N 分钟才真去抓，避免连点狂抓
const OPEN_FETCH_THROTTLE_MIN = parseInt(process.env.OPEN_FETCH_THROTTLE_MIN || '20', 10);
// 每天定时抓取的 cron 表达式（默认 07:30，服务器时区）
const DAILY_CRON = process.env.DAILY_CRON || '30 7 * * *';
// 服务器时区（Zeabur 东京容器默认 UTC，需要 +8 得到北京时间早晨 7:30）
const CRON_TZ = process.env.CRON_TZ || 'Asia/Shanghai';

// ---------- 持久化存储 ----------
// tweets: Map<id, { id, username, author, content, link, pub_date, fetched_at }>
// 已听状态由前端 localStorage 管理，服务端不存
// 磁盘持久化：Zeabur 挂载 /data 卷，写 tweets.json；本地开发写在项目目录
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const DB_FILE = path.join(DATA_DIR, 'tweets.json');

const tweetsStore = new Map();
let lastFetchAt = 0;   // 上次抓取时间（时间戳，ms）
let fetchingNow = false; // 防止并发抓取

// 启动时从磁盘恢复
function loadFromDisk() {
  try {
    if (!fs.existsSync(DB_FILE)) return;
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const obj = JSON.parse(raw);
    (obj.tweets || []).forEach(t => tweetsStore.set(t.id, t));
    lastFetchAt = obj.lastFetchAt || 0;
    console.log(`[persistence] 从磁盘加载 ${tweetsStore.size} 条推文 · ${DB_FILE}`);
  } catch (e) {
    console.error('[persistence] 加载失败（忽略，从空开始）:', e.message);
  }
}

// 保存到磁盘（节流，避免频繁 IO）
let saveTimer = null;
function saveToDisk() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const obj = {
        savedAt: Date.now(),
        lastFetchAt,
        tweets: [...tweetsStore.values()],
      };
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, DB_FILE); // 原子替换
      console.log(`[persistence] 已保存 ${obj.tweets.length} 条推文到 ${DB_FILE}`);
    } catch (e) {
      console.error('[persistence] 保存失败:', e.message);
    }
  }, 2000); // 2 秒节流：一批 insert 完成后统一写盘
}

function insertTweet(tw) {
  if (tweetsStore.has(tw.id)) return false;
  tweetsStore.set(tw.id, tw);
  // 超出上限时删除最老的
  if (tweetsStore.size > MAX_TWEETS) {
    const oldest = [...tweetsStore.entries()]
      .sort((a, b) => (a[1].pub_date || 0) - (b[1].pub_date || 0))[0];
    if (oldest) tweetsStore.delete(oldest[0]);
  }
  saveToDisk();
  return true;
}

function listTweets() {
  // 返回全部推文，按时间倒序（前端做筛选、排序、分页）
  return [...tweetsStore.values()]
    .sort((a, b) => (b.pub_date || 0) - (a.pub_date || 0));
}

// ---------- twitterapi.io 抓取 ----------
function cleanTweetText(raw) {
  if (!raw) return '';
  let t = String(raw);
  t = t.replace(/^RT @[\w_]+:\s*/i, '');
  t = t.replace(/https?:\/\/t\.co\/\S+/gi, '');
  t = t.replace(/\bpic\.twitter\.com\/\S+/gi, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

async function fetchUserTweets(username, cursor = '') {
  const url = `https://api.twitterapi.io/twitter/user/last_tweets?userName=${encodeURIComponent(username)}&includeReplies=${INCLUDE_REPLIES ? 'true' : 'false'}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
  const resp = await fetch(url, {
    headers: { 'X-API-Key': TWITTERAPI_KEY },
    timeout: 20000,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const data = await resp.json();
  if (data.status && data.status !== 'success') {
    throw new Error(`API error: ${data.msg || data.message || 'unknown'}`);
  }
  // 实测结构：顶层 { status, code, msg, data: { tweets }, has_next_page, next_cursor }
  // 兼容旧结构：{ tweets, has_next_page, next_cursor }
  const tweets = (data.data && data.data.tweets) || data.tweets || [];
  const hasNextPage = !!(data.has_next_page || (data.data && data.data.has_next_page));
  const nextCursor = data.next_cursor || (data.data && data.data.next_cursor) || '';
  return { tweets, hasNextPage, nextCursor };
}

async function fetchAll(reason = 'unknown', pagesPerUser = 1, opts = {}) {
  const { earlyStop = true } = opts;
  if (!TWITTERAPI_KEY) {
    console.error('[fetchAll] TWITTERAPI_KEY 未配置，跳过');
    return [];
  }
  if (fetchingNow) {
    console.log('[fetchAll] 已有抓取任务在跑，跳过');
    return [];
  }
  fetchingNow = true;
  try {
    const results = [];
    for (const username of SUBSCRIPTIONS) {
      let inserted = 0, totalFetched = 0, pagesUsed = 0;
      let cursor = '';
      try {
        for (let page = 0; page < pagesPerUser; page++) {
          const { tweets, hasNextPage, nextCursor } = await fetchUserTweets(username, cursor);
          pagesUsed++;
          totalFetched += tweets.length;
          let pageInserted = 0;
          for (const tw of tweets) {
            if (tw.retweeted_tweet && !tw.text) continue;
            const text = cleanTweetText(tw.text);
            if (!text || text.length < 3) continue;
            const authorName = (tw.author && (tw.author.name || tw.author.userName)) || username;
            const pubDate = tw.createdAt ? Date.parse(tw.createdAt) : Date.now();
            const added = insertTweet({
              id: `${username}_${tw.id}`,
              username,
              author: authorName,
              content: text,
              link: tw.url || `https://x.com/${username}/status/${tw.id}`,
              pub_date: isNaN(pubDate) ? Date.now() : pubDate,
              fetched_at: Date.now(),
            });
            if (added) { inserted++; pageInserted++; }
          }
          // 增量停止（仅在 earlyStop=true 时启用；backfill 场景禁用，一直翻到 pagesPerUser）
          if (earlyStop && page > 0 && pageInserted === 0) break;
          if (!hasNextPage || !nextCursor) break;
          cursor = nextCursor;
        }
        results.push({ username, ok: true, inserted, totalFetched, pagesUsed });
      } catch (e) {
        results.push({ username, ok: false, error: e.message, pagesUsed });
      }
    }
    lastFetchAt = Date.now();
    saveToDisk(); // 更新 lastFetchAt 也要持久化
    console.log(`[fetchAll:${reason}]`, new Date().toISOString(), JSON.stringify(results), '| store=', tweetsStore.size);
    return results;
  } finally {
    fetchingNow = false;
  }
}

// 打开 App 时的智能抓取：距上次超过阈值才抓
async function maybeFetchOnOpen() {
  const sinceMin = (Date.now() - lastFetchAt) / 60000;
  if (sinceMin < OPEN_FETCH_THROTTLE_MIN) {
    console.log(`[open] 距上次抓取仅 ${sinceMin.toFixed(1)} 分钟，跳过`);
    return { triggered: false, sinceMin };
  }
  console.log(`[open] 距上次抓取 ${sinceMin.toFixed(1)} 分钟，触发抓取`);
  fetchAll('open').catch(e => console.error('[open fetch]', e));
  return { triggered: true, sinceMin };
}

// ---------- 火山 TTS ----------
async function ttsGenerate(text, voiceType) {
  if (!VOLC_APP_ID || !VOLC_ACCESS_TOKEN) {
    throw new Error('VOLC_APP_ID / VOLC_ACCESS_TOKEN 未配置');
  }
  const reqId = crypto.randomUUID();
  const body = {
    app: { appid: VOLC_APP_ID, token: 'access_token', cluster: VOLC_CLUSTER },
    user: { uid: 'x-reader-user' },
    audio: {
      voice_type: voiceType || VOLC_VOICE_TYPE,
      encoding: 'mp3',
      rate: 24000,
      speed_ratio: 1.0,
      volume_ratio: 1.0,
      pitch_ratio: 1.0,
    },
    request: {
      reqid: reqId,
      text: text.slice(0, 1024),
      text_type: 'plain',
      operation: 'query',
      with_frontend: 1,
      frontend_type: 'unitTson',
    },
  };
  const resp = await fetch('https://openspeech.bytedance.com/api/v1/tts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer;${VOLC_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (data.code !== 3000 || !data.data) {
    throw new Error(`火山 TTS 失败: code=${data.code} msg=${data.message || ''}`);
  }
  return Buffer.from(data.data, 'base64');
}

// ---------- API ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 全量返回，已听状态由前端 localStorage 判断
// 打开 App 时如果距上次抓取超过阈值就顺手触发一次（非阻塞）
app.get('/api/feed', (req, res) => {
  maybeFetchOnOpen(); // fire and forget
  res.json({
    ok: true,
    count: tweetsStore.size,
    subscriptions: SUBSCRIPTIONS,
    tweets: listTweets(),
    last_fetch_at: lastFetchAt,
  });
});

app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ ok: false, error: 'empty text' });
    const audio = await ttsGenerate(text, voice);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(audio);
  } catch (e) {
    console.error('[tts]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 保留这些接口以兼容前端，但服务端不存已听状态
app.post('/api/mark', (req, res) => res.json({ ok: true }));
app.post('/api/mark-all', (req, res) => res.json({ ok: true }));
app.post('/api/reset', (req, res) => res.json({ ok: true }));

app.post('/api/fetch-now', async (req, res) => {
  const result = await fetchAll('manual', 1);
  res.json({ ok: true, result, store_size: tweetsStore.size });
});

// 一次性历史回填：每个博主翻多少页（默认 5 页 = 100 条/人）
// 用法：GET https://x-reader.zeabur.app/api/backfill?pages=5
// 增量停止逻辑：如果某页没抓到新推文，自动停这个用户的翻页
app.get('/api/backfill', async (req, res) => {
  const pages = Math.min(Math.max(parseInt(req.query.pages || '5', 10), 1), 25);
  const result = await fetchAll('backfill', pages, { earlyStop: false });
  res.json({ ok: true, pages_per_user: pages, result, store_size: tweetsStore.size });
});

app.get('/api/health', (req, res) => {
  let diskFileExists = false, diskFileSize = 0;
  try {
    if (fs.existsSync(DB_FILE)) {
      diskFileExists = true;
      diskFileSize = fs.statSync(DB_FILE).size;
    }
  } catch (e) {}
  res.json({
    ok: true,
    total: tweetsStore.size,
    subscriptions: SUBSCRIPTIONS,
    has_twitterapi_key: !!TWITTERAPI_KEY,
    has_volc_key: !!(VOLC_APP_ID && VOLC_ACCESS_TOKEN),
    node_version: process.version,
    last_fetch_at: lastFetchAt ? new Date(lastFetchAt).toISOString() : null,
    daily_cron: DAILY_CRON,
    cron_tz: CRON_TZ,
    open_throttle_min: OPEN_FETCH_THROTTLE_MIN,
    data_dir: DATA_DIR,
    disk_file_exists: diskFileExists,
    disk_file_size_bytes: diskFileSize,
  });
});

app.listen(PORT, () => {
  console.log(`[x-reader] listening on :${PORT}`);
  console.log(`[x-reader] subscriptions: ${SUBSCRIPTIONS.join(', ')}`);
  console.log(`[x-reader] daily cron: ${DAILY_CRON} (${CRON_TZ})`);
  console.log(`[x-reader] open throttle: ${OPEN_FETCH_THROTTLE_MIN} min`);
  console.log(`[x-reader] include replies: ${INCLUDE_REPLIES}`);
  console.log(`[x-reader] node: ${process.version}`);
  console.log(`[x-reader] data dir: ${DATA_DIR}`);
  // 从磁盘恢复
  loadFromDisk();
  // 启动时先抓一次（若磁盘为空，服务重启后立刻有内容）
  fetchAll('startup').catch(e => console.error('[startup fetch]', e));
  // 每天定时抓取（默认北京时间 07:30）
  cron.schedule(DAILY_CRON, () => {
    fetchAll('daily').catch(e => console.error('[daily]', e));
  }, { timezone: CRON_TZ });
});
