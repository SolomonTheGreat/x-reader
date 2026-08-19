// server.js — X Reader 后端
// 数据源：twitterapi.io（原 Nitter 方案已废弃）
'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');
const fetch = require('node-fetch');
const Database = require('better-sqlite3');

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

// ---------- 数据库 ----------
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS tweets (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    author TEXT,
    content TEXT NOT NULL,
    link TEXT,
    pub_date INTEGER,
    fetched_at INTEGER,
    listened INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_listened ON tweets(listened, pub_date DESC);
`);

const insertTweet = db.prepare(`
  INSERT OR IGNORE INTO tweets (id, username, author, content, link, pub_date, fetched_at)
  VALUES (@id, @username, @author, @content, @link, @pub_date, @fetched_at)
`);
const listUnheard = db.prepare(`
  SELECT id, username, author, content, link, pub_date
  FROM tweets WHERE listened = 0
  ORDER BY pub_date DESC LIMIT 100
`);
const listAll = db.prepare(`
  SELECT id, username, author, content, link, pub_date, listened
  FROM tweets ORDER BY pub_date DESC LIMIT 100
`);
const markListenedStmt = db.prepare(`UPDATE tweets SET listened = 1 WHERE id = ?`);
const markAllListenedStmt = db.prepare(`UPDATE tweets SET listened = 1`);
const resetAllStmt = db.prepare(`UPDATE tweets SET listened = 0`);

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

async function fetchUserTweets(username) {
  const url = `https://api.twitterapi.io/twitter/user/last_tweets?userName=${encodeURIComponent(username)}&includeReplies=${INCLUDE_REPLIES ? 'true' : 'false'}`;
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
  // 实际结构：{ status, code, msg, data: { pin_tweet, tweets: [...] } }
  // 但文档说是 { tweets: [...] } —— 两种都兼容
  const tweets = (data.data && data.data.tweets) || data.tweets || [];
  return tweets;
}

async function fetchAll() {
  if (!TWITTERAPI_KEY) {
    console.error('[fetchAll] TWITTERAPI_KEY 未配置，跳过');
    return [];
  }
  const results = [];
  for (const username of SUBSCRIPTIONS) {
    try {
      const tweets = await fetchUserTweets(username);
      let inserted = 0;
      for (const tw of tweets) {
        // 跳过转推（除非你想要）——转推的 text 常是空的
        if (tw.retweeted_tweet && !tw.text) continue;
        const text = cleanTweetText(tw.text);
        if (!text || text.length < 3) continue;
        const authorName = (tw.author && (tw.author.name || tw.author.userName)) || username;
        const pubDate = tw.createdAt ? Date.parse(tw.createdAt) : Date.now();
        const info = insertTweet.run({
          id: `${username}_${tw.id}`,
          username,
          author: authorName,
          content: text,
          link: tw.url || `https://x.com/${username}/status/${tw.id}`,
          pub_date: isNaN(pubDate) ? Date.now() : pubDate,
          fetched_at: Date.now(),
        });
        if (info.changes) inserted++;
      }
      results.push({ username, ok: true, inserted, total: tweets.length });
    } catch (e) {
      results.push({ username, ok: false, error: e.message });
    }
  }
  console.log('[fetchAll]', new Date().toISOString(), JSON.stringify(results));
  return results;
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

app.get('/api/feed', (req, res) => {
  const showAll = req.query.all === '1';
  const rows = showAll ? listAll.all() : listUnheard.all();
  res.json({ ok: true, count: rows.length, subscriptions: SUBSCRIPTIONS, tweets: rows });
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
    console.error('[tts]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/mark', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  markListenedStmt.run(id);
  res.json({ ok: true });
});

app.post('/api/mark-all', (req, res) => {
  markAllListenedStmt.run();
  res.json({ ok: true });
});

app.post('/api/reset', (req, res) => {
  resetAllStmt.run();
  res.json({ ok: true });
});

app.post('/api/fetch-now', async (req, res) => {
  const result = await fetchAll();
  res.json({ ok: true, result });
});

app.get('/api/health', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS n FROM tweets').get().n;
  const unheard = db.prepare('SELECT COUNT(*) AS n FROM tweets WHERE listened=0').get().n;
  res.json({
    ok: true,
    total, unheard,
    subscriptions: SUBSCRIPTIONS,
    has_twitterapi_key: !!TWITTERAPI_KEY,
    has_volc_key: !!(VOLC_APP_ID && VOLC_ACCESS_TOKEN),
  });
});

app.listen(PORT, () => {
  console.log(`[x-reader] listening on :${PORT}`);
  console.log(`[x-reader] subscriptions: ${SUBSCRIPTIONS.join(', ')}`);
  console.log(`[x-reader] fetch interval: ${FETCH_INTERVAL_MINUTES} min`);
  console.log(`[x-reader] include replies: ${INCLUDE_REPLIES}`);
  fetchAll().catch(e => console.error('[initial fetch]', e));
  cron.schedule(`*/${FETCH_INTERVAL_MINUTES} * * * *`, () => {
    fetchAll().catch(e => console.error('[cron]', e));
  });
});
