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
  const existing = tweetsStore.get(tw.id);
  if (existing) {
    // twitterapi.io 的列表接口有时先返回 140 字截断版，后续可能返回更完整的
    // 只要新正文更长，就更新磁盘里的旧记录
    if ((tw.content || '').length > (existing.content || '').length) {
      tweetsStore.set(tw.id, { ...existing, ...tw });
      saveToDisk();
    }
    return false;
  }
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
  // 转推前缀 "RT @username: " 去掉（朗读时不需要听这个）
  t = t.replace(/^RT @[\w_]+:\s*/i, '');
  // 去 t.co 短链
  t = t.replace(/https?:\/\/t\.co\/\S+/gi, '');
  // pic.twitter.com 换成图片标记
  t = t.replace(/\bpic\.twitter\.com\/\S+/gi, '');
  // 归并空白
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

// 从推文对象里提取"最完整"的正文
// 优先级：retweeted_tweet.text > text（如果 text 被 RT 截断） > quoted_tweet.text 拼接
function extractFullText(tw) {
  // 1) 纯转推 RT：主 text 是 "RT @xxx: 前140字…" 截断的，完整文在 retweeted_tweet.text
  if (tw.retweeted_tweet && tw.retweeted_tweet.text) {
    const rtAuthor = (tw.retweeted_tweet.author && tw.retweeted_tweet.author.userName) || '';
    const prefix = rtAuthor ? `转发 @${rtAuthor}：` : '转发：';
    return prefix + cleanTweetText(tw.retweeted_tweet.text);
  }
  // 2) 引用推文（自己有话说 + 引用了别人）
  if (tw.quoted_tweet && tw.quoted_tweet.text) {
    const myText = cleanTweetText(tw.text || '');
    const qAuthor = (tw.quoted_tweet.author && tw.quoted_tweet.author.userName) || '';
    const qText = cleanTweetText(tw.quoted_tweet.text);
    const qPrefix = qAuthor ? `引用 @${qAuthor}：` : '引用：';
    return (myText ? myText + '。' : '') + qPrefix + qText;
  }
  // 3) 普通推文
  return cleanTweetText(tw.text || '');
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
  const { earlyStop = true, users = null } = opts;
  const targetUsers = users && users.length ? users : SUBSCRIPTIONS;
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
    for (const username of targetUsers) {
      let inserted = 0, totalFetched = 0, pagesUsed = 0;
      let cursor = '';
      try {
        for (let page = 0; page < pagesPerUser; page++) {
          const { tweets, hasNextPage, nextCursor } = await fetchUserTweets(username, cursor);
          pagesUsed++;
          totalFetched += tweets.length;
          let pageInserted = 0;
          for (const tw of tweets) {
            const text = extractFullText(tw);
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
// 当前火山普通 TTS 对单次文本长度的实际上限约 300 字符。
// 留安全余量按 240 个 Unicode 字符切段，避免中文/emoji 按 UTF-16 计数时越界。
const TTS_CHUNK_MAX_CHARS = 240;

function splitTextForTTS(text, maxChars = TTS_CHUNK_MAX_CHARS) {
  const chars = Array.from(String(text || '').trim());
  const chunks = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + maxChars, chars.length);
    if (end < chars.length) {
      // 优先在句号/问号/感叹号/换行/逗号处切，听感更自然
      const window = chars.slice(start, end).join('');
      const candidates = ['。', '！', '？', '.', '!', '?', '\n', '；', ';', '，', ','];
      let best = -1;
      for (const mark of candidates) best = Math.max(best, window.lastIndexOf(mark));
      if (best >= Math.floor(maxChars * 0.55)) end = start + best + 1;
    }
    const chunk = chars.slice(start, end).join('').trim();
    if (chunk) chunks.push(chunk);
    start = end;
  }
  return chunks;
}

async function ttsGenerateChunk(text, voiceType) {
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
      text,
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

function isVolcTtsLenError(err) {
  const msg = String(err && err.message || '');
  return /code\s*=\s*3010/i.test(msg)
    || /max\s*len/i.test(msg)
    || /length/i.test(msg);
}

async function ttsGenerateChunkWithFallback(text, voiceType, depth = 0) {
  const clean = String(text || '').trim();
  if (!clean) return Buffer.alloc(0);

  try {
    return await ttsGenerateChunk(clean, voiceType);
  } catch (e) {
    const tooLong = isVolcTtsLenError(e);
    const charLen = Array.from(clean).length;
    // 仅在长度相关错误时自动递归二分；防止无限递归，且过短文本直接抛错
    if (!tooLong || depth >= 6 || charLen <= 20) throw e;

    const splitAt = Math.floor(charLen / 2);
    const chars = Array.from(clean);
    const left = chars.slice(0, splitAt).join('');
    const right = chars.slice(splitAt).join('');
    const leftBuf = await ttsGenerateChunkWithFallback(left, voiceType, depth + 1);
    const rightBuf = await ttsGenerateChunkWithFallback(right, voiceType, depth + 1);
    return Buffer.concat([leftBuf, rightBuf]);
  }
}

async function ttsGenerate(text, voiceType) {
  const chunks = splitTextForTTS(text);
  if (!chunks.length) throw new Error('empty text');
  const buffers = [];
  // 顺序生成并拼接 MP3 帧；浏览器会把它当作一段连续音频播放
  for (const chunk of chunks) {
    buffers.push(await ttsGenerateChunkWithFallback(chunk, voiceType));
  }
  return Buffer.concat(buffers);
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

// 批量 TTS：把多条推文用停顿符拼成一段大音频，前端播放一个 mp3 = iOS 认为一段连续音频
// 这是绕开 iOS PWA 锁屏挂起 JS 的核心方案
app.post('/api/tts-batch', async (req, res) => {
  try {
    const { texts, voice } = req.body || {};
    if (!Array.isArray(texts) || !texts.length) return res.status(400).json({ ok: false, error: 'empty texts' });
    // 用中文句号 + 换行拼接，火山会自然停顿 0.5-1 秒
    // 单次上限 1024 字符（火山限制），前端应保证 batch 内总字符 < 1000
    const merged = texts
      .map(t => (t || '').trim().replace(/[。！？.!?]+$/, ''))
      .filter(Boolean)
      .join('。……。');
    if (!merged) return res.status(400).json({ ok: false, error: 'all empty' });
    // ttsGenerate 内部会自动按 240 字切段，长推文/批量推文不会再触发 max len 报错
    const audio = await ttsGenerate(merged, voice);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Batch-Count', String(texts.length));
    res.send(audio);
  } catch (e) {
    console.error('[tts-batch]', e.message);
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
  const users = req.query.users
    ? req.query.users.split(',').map(s => s.trim()).filter(Boolean)
    : null;
  const result = await fetchAll('backfill', pages, { earlyStop: false, users });
  res.json({ ok: true, pages_per_user: pages, targeted_users: users || SUBSCRIPTIONS, result, store_size: tweetsStore.size });
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
