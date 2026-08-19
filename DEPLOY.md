# X Reader 部署一步步教程

> 目标：让你能在自己 iPhone 上戴耳机听 X 推文。
> 时间预算：**20-30 分钟**（一次性，之后每次改代码 push 一下 3 分钟自动上线）。

---

## 全流程一图

```
① 本地跑起来验证（5 分钟）
    ↓
② 建 GitHub 仓库（3 分钟）
    ↓
③ Zeabur 从 GitHub 部署（5 分钟）
    ↓
④ 在 Zeabur 填火山环境变量（2 分钟）
    ↓
⑤ Zeabur 分配域名（1 分钟）
    ↓
⑥ iPhone Safari 打开 + 加到主屏幕（1 分钟）
    ↓
⑦ 戴耳机测试 ✓
```

---

## 步骤 ① · 本地跑起来验证

### 打开终端，执行：

```bash
cd /Users/vikkiliang/CodeBuddy/daily/x-reader
npm install
```

（等 30 秒装完依赖）

### 复制环境变量：

```bash
cp .env.example .env
```

`.env` 里已经预填了你的火山 Key，可以直接用。

**如果想改订阅的 X 博主**，编辑 `.env` 里的 `SUBSCRIPTIONS=` 那行，用逗号分隔用户名（不带 @）。

### 启动服务：

```bash
# 加载环境变量启动（macOS/Linux）
export $(cat .env | xargs) && node server.js
```

看到这样的输出就是成功了：

```
[x-reader] listening on :3000
[x-reader] subscriptions: elonmusk, sama, paulg, naval
[x-reader] fetch interval: 60 min
[fetchAll] 2026-08-19T... [{"username":"elonmusk","ok":true,...}]
```

### 浏览器测试

打开 http://localhost:3000

- 应该能看到界面
- 可能一开始队列是空的（Nitter 抓取要几秒），**等 30 秒后刷新一下**
- 点某条推文的 "▶ 播放" 按钮，正常应该能听到火山合成的语音

**如果本地测试失败**（比如 Nitter 全挂、TTS 报错），把控制台报错发我，我修。

**如果本地测试成功** → 按 `Ctrl+C` 停掉服务，进入步骤 ②。

---

## 步骤 ② · 建 GitHub 仓库

### 2.1 在 GitHub 建仓库

浏览器打开：https://github.com/new

- **Repository name**: `x-reader`
- **Public / Private**: 建议 **Private**（虽然 Key 在环境变量里不会暴露，Private 更保险）
- 其他都不勾（不初始化 README，我们已经有了）
- 点绿色 "Create repository"

### 2.2 把本地代码 push 上去

回到终端，在 `x-reader` 目录：

```bash
cd /Users/vikkiliang/CodeBuddy/daily/x-reader
git init
git add .
git commit -m "init x-reader"
git branch -M main
# 下面这行把 YOUR_GITHUB_USERNAME 换成你自己的 GitHub 用户名
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/x-reader.git
git push -u origin main
```

**如果 push 时报错**（比如要密码），需要配 GitHub Personal Access Token 或 SSH key。到这一步卡住的话截图报错发我。

---

## 步骤 ③ · Zeabur 从 GitHub 部署

### 3.1 打开 Zeabur

浏览器打开：https://zeabur.com/dashboard

用你已有的账号登录。

### 3.2 创建项目

- 点 **"Create Project"**
- 项目名随便：`x-reader`
- 选一个 Region：**Hong Kong** 或 **Singapore**（离国内近，Nitter 抓取和你 iPhone 访问都快）

### 3.3 添加服务

- 项目页里点 **"Add Service"** → **"Deploy from GitHub"**
- 授权 Zeabur 访问你的 GitHub（如果没授权过）
- 选刚才建的 `x-reader` 仓库
- Branch：`main`
- 点 "Deploy"

Zeabur 会自动识别 `zeabur.json`，开始 build。**看着日志跑完 `npm install`**，大概 1-2 分钟。

---

## 步骤 ④ · 填火山环境变量

Build 完之后，服务会启动**但会报错**（因为环境变量还没配）。

### 4.1 进入服务配置

- 点刚才部署的服务
- 顶部找 **"Variables"** 或 **"环境变量"** 标签

### 4.2 添加以下变量（一条条加）

| Key | Value |
|---|---|
| `VOLC_APP_ID` | `9472982371` |
| `VOLC_ACCESS_TOKEN` | `SVohM44VVdKSRa1zdyfWnxqPLV4lB_P8` |
| `VOLC_CLUSTER` | `volcano_tts` |
| `VOLC_VOICE_TYPE` | `zh_female_wanwanxiaohe_moon_bigtts` |
| `SUBSCRIPTIONS` | `elonmusk,sama,paulg,naval` |
| `FETCH_INTERVAL_MINUTES` | `60` |

**添加完点 Save，服务会自动重启。**

### 4.3 验证服务健康

在 "Logs" 或 "日志" 标签能看到：

```
[x-reader] listening on :3000
[x-reader] subscriptions: elonmusk, sama, paulg, naval
[fetchAll] ...
```

看到 `listening on` + `fetchAll` 就 OK。

---

## 步骤 ⑤ · Zeabur 分配域名

### 5.1 生成免费域名

- 服务详情页找 **"Networking"** 或 **"域名"** 标签
- 点 **"Generate Domain"**
- Zeabur 会给你一个类似 `x-reader-abc123.zeabur.app` 的域名
- **复制这个域名**

### 5.2 浏览器测试

用电脑浏览器打开 `https://x-reader-abc123.zeabur.app`

应该能看到和本地一样的界面。点一条推文播放，能听到语音 = 成功。

**如果 TTS 播放失败**，去 Zeabur Logs 看具体报错。

---

## 步骤 ⑥ · iPhone 上加到主屏幕

### 6.1 iPhone Safari 打开

用 **iPhone 上的 Safari**（不能用 Chrome，Chrome 不支持添加到主屏幕）打开：

```
https://x-reader-abc123.zeabur.app
```

（换成你自己的域名）

### 6.2 添加到主屏幕

- 点底部**分享按钮**（方框上箭头）
- 往下滚找 **"添加到主屏幕"** / **"Add to Home Screen"**
- 名字保持 `X Reader`，点 **"添加"**

主屏幕上会出现一个图标，长得像 App。

### 6.3 从主屏幕打开

**重点**：一定要**从主屏幕图标进入**，不能从 Safari 里用。从主屏幕进的才是"全屏 App 模式"，才能锁屏播放。

---

## 步骤 ⑦ · 戴耳机测试

- 戴耳机
- 打开 X Reader
- 点 "▶ 全部播放"
- **听到第一条开始朗读后**，按 iPhone 侧边锁屏键 → 屏幕黑
- 应该能继续听 + 锁屏界面能看到当前推文标题 + 耳机线控暂停/切换有效

**如果锁屏后停了**：iOS 有时候需要"允许后台音频"，重新解锁点一下播放键让它继续。这是 PWA 的限制，不是 bug。

---

## 常见问题

### Q1：本地跑起来了但列表一直是空的
Nitter 镜像在中国大陆访问可能不稳定。等 2-3 分钟再刷。或调 `POST /api/fetch-now` 手动触发：

```bash
curl -X POST http://localhost:3000/api/fetch-now
```

### Q2：TTS 报错 "所有 Nitter 镜像都失败"
把 `server.js` 里的 `NITTER_INSTANCES` 数组加更多镜像（去 https://github.com/zedeus/nitter/wiki/Instances 找）。

### Q3：想换音色
去 https://www.volcengine.com/docs/6561/1257544 查音色 ID，改 `VOLC_VOICE_TYPE` 环境变量，Zeabur 重启即可。

### Q4：想加 / 删订阅博主
改 `SUBSCRIPTIONS` 环境变量，Zeabur 重启即可。

### Q5：每次 git push 后 Zeabur 会自动重新部署吗
会。Zeabur 默认监听 main 分支，push 后自动 rebuild。

---

## 下一步（一周后回看）

按 PRD 里的验证成功标准回答：
- [ ] 有 ≥ 4 天真的戴耳机打开听了
- [ ] 每次听 ≥ 10 分钟
- [ ] 至少 1 次听到"这条推文有意思"
- [ ] 火山 TTS 音质你能接受

≥ 3 条 √ → 值得升级成原生 iOS App 上 TestFlight
< 3 条 √ → 验证失败，损失 ¥0，退出
