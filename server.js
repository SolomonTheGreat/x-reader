// server.js — X Reader 后端（Zeabur 兼容版）
// 数据源：twitterapi.io / TTS：火山引擎
// 存储：内存 Map（无原生依赖，Zeabur 秒起）
'use strict';

const express = require('express');
const path = require('path');
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
const MAX_TWEETS = 500; // 内存里最多保留多少条

// ---------- 内存存储 ----------
// tweets: Map<id, { id, username, author, content, link, pub_date, fetched_at }>
// 已听状态由前端 localStorage 管理，服务端不存
const tweetsStore = new Map();

function insertTweet(tw) {
  if (tweetsStore.has(tw.id)) return false;
  tweetsStore.set(tw.id, tw);
  // 超出上限时删除最老的
  if (tweetsStore.size > MAX_TWEETS) {
    const oldest = [...tweetsStore.entries()]
      .sort((a, b) => (a[1].pub_date || 0) - (b[1].pub_date || 0))[0];
    if (oldest) tweetsStore.delete(oldest[0]);
  }
  return true;
}

function listTweets() {
  return [...tweetsStore.values()]
    .sort((a, b) => (b.pub_date || 0) - (a.pub_date || 0))
    .slice(0, 200);
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
  return (data.data && data.data.tweets) || data.tweets || [];
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
        if (added) inserted++;
      }
      results.push({ username, ok: true, inserted, total: tweets.length });
    } catch (e) {
      results.push({ username, ok: false, error: e.message });
    }
  }
  console.log('[fetchAll]', new Date().toISOString(), JSON.stringify(results), '| store=', tweetsStore.size);
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

// 全量返回，已听状态由前端 localStorage 判断
app.get('/api/feed', (req, res) => {
  res.json({
    ok: true,
    count: tweetsStore.size,
    subscriptions: SUBSCRIPTIONS,
    tweets: listTweets(),
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
  const result = await fetchAll();
  res.json({ ok: true, result, store_size: tweetsStore.size });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    total: tweetsStore.size,
    subscriptions: SUBSCRIPTIONS,
    has_twitterapi_key: !!TWITTERAPI_KEY,
    has_volc_key: !!(VOLC_APP_ID && VOLC_ACCESS_TOKEN),
    node_version: process.version,
  });
});

app.listen(PORT, () => {
  console.log(`[x-reader] listening on :${PORT}`);
  console.log(`[x-reader] subscriptions: ${SUBSCRIPTIONS.join(', ')}`);
  console.log(`[x-reader] fetch interval: ${FETCH_INTERVAL_MINUTES} min`);
  console.log(`[x-reader] include replies: ${INCLUDE_REPLIES}`);
  console.log(`[x-reader] node: ${process.version}`);
  fetchAll().catch(e => console.error('[initial fetch]', e));
  cron.schedule(`*/${FETCH_INTERVAL_MINUTES} * * * *`, () => {
    fetchAll().catch(e => console.error('[cron]', e));
  });
});
