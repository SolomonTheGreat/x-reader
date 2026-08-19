# X Reader

> 通勤路上戴耳机自动朗读 X（Twitter）关注博主推文的 iOS PWA 应用

## 一句话说明

打开 → 戴耳机 → 走人。App 自动播放我关注的博主未听推文，中英混读。

## 技术栈

- **前端**：Vanilla HTML/JS + PWA（可加到 iOS 主屏幕，锁屏可控）
- **后端**：Node.js + Express + SQLite
- **推文来源**：Nitter RSS 镜像池（免费替代 X 官方 API，避开 $200/月订阅）
- **朗读**：火山引擎豆包 TTS（免费额度 3 个月 × 每天 100 万字符）

## 目录结构

```
x-reader/
├── PRD.md              # 需求文档
├── DEPLOY.md           # 部署一步步教程
├── README.md           # 本文件
├── package.json
├── server.js           # 后端（RSS 抓取 + TTS 代理 + API）
├── zeabur.json         # Zeabur 部署配置
├── .env.example        # 环境变量样例
└── public/             # 前端 PWA
    ├── index.html      # 主界面
    ├── manifest.json   # PWA 清单
    ├── sw.js           # Service Worker
    ├── icon-192.png
    └── icon-512.png
```

## 快速开始

### 本地跑

```bash
cd x-reader
npm install
cp .env.example .env
# 编辑 .env 填火山 Key，或直接用 .env.example 里已有的
node server.js
```

浏览器打开 http://localhost:3000

### 部署到 Zeabur

见 `DEPLOY.md`。

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `VOLC_APP_ID` | 火山应用 ID | 必填 |
| `VOLC_ACCESS_TOKEN` | 火山 Access Token | 必填 |
| `VOLC_CLUSTER` | 火山集群 | `volcano_tts` |
| `VOLC_VOICE_TYPE` | 音色 | `zh_female_wanwanxiaohe_moon_bigtts` |
| `SUBSCRIPTIONS` | X 用户名列表，逗号分隔 | `elonmusk,sama,paulg,naval` |
| `FETCH_INTERVAL_MINUTES` | 抓取周期 | `60` |
| `PORT` | 服务端口 | `3000` |

## 调试用 API

- `GET  /api/health` — 状态 + 未听/已听数量
- `GET  /api/feed` — 未听队列
- `GET  /api/feed?all=1` — 全部推文
- `POST /api/fetch-now` — 手动触发一次抓取
- `POST /api/reset` — 把所有推文重置为"未听"（测试用）
- `POST /api/mark` — 标记单条已听 `{ id }`

## 已知限制

- Nitter 镜像会挂：代码里有 6 个镜像轮询，都挂时那段时间抓不到新的
- iOS PWA 锁屏播放：第一条必须解锁后手动点，后续队列可以锁屏继续
- 只朗读文字：图片视频跳过

## 后续路径

- 若一周使用率高 → 升级成原生 iOS App 上 TestFlight
- 若某些镜像持续挂 → 加更多镜像 or 换成官方 API
