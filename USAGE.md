# X Reader 日常使用手册

> 通勤路上戴耳机自动朗读 X 推文的 iOS PWA · 2026-08-19 上线

---

## 🎯 你现在拥有什么

| 项 | 地址/信息 |
|---|---|
| **线上服务** | https://x-reader.zeabur.app |
| **iPhone 打开** | 主屏幕图标"X Reader"（Safari 添加的） |
| **代码仓库** | https://github.com/SolomonTheGreat/x-reader |
| **本地代码** | `/Users/vikkiliang/CodeBuddy/daily/x-reader/` |
| **部署平台** | Zeabur · Tencent Tokyo 2C2GB · $3/月 · 到期 2026/9/19 |
| **推文来源** | twitterapi.io · 已充值 $10 · 预计撑 7 个月 |
| **朗读引擎** | 火山引擎豆包 TTS · 免费 3 个月 · 每天 100 万字符 |
| **订阅博主** | @TaoRay / @dontbesilent / @karpathy / @naval |

---

## 🌅 日常使用（不用做任何事）

### 自动抓取的三个时机
1. **每天早上 7:30**（北京时间）—— 定时抓一次，你出门就有新的
2. **你打开 App** —— 20 分钟节流，你多次打开也只会抓一次
3. **Zeabur 服务重启** —— 罕见，会自动抓一次初始化

### 你要做的
只需要：**打开主屏幕图标 → 戴耳机 → 出门**。

**注意**：一定要从主屏幕图标点开，不能从 Safari 打开——只有主屏幕图标进入才是"全屏 App 模式"，才支持锁屏播放。

---

## 🎧 界面功能速查

### 顶部工具栏（4 个按钮，横向可滑）
| 按钮 | 作用 |
|---|---|
| ▶ 全部播放 | 当前列表连续播放（用当前筛选和顺序） |
| ↻ 刷新 | 手动拉一次列表（可能会顺手触发抓取） |
| 显示全部 / 只看未听 | 切换是否显示已听过的推文 |
| 🕒 最新在前 / 🕒 最早在前 / 🔀 随机顺序 | 三态循环切换播放顺序 |

### 博主筛选 chips（第二排）
- 点 `@karpathy` → 只看 karpathy 的推文
- 点 `全部` 恢复
- **筛选状态会记住**，下次打开保持

### 底部播放器
- ⏮ 上一条 · ▶/⏸ 播放暂停 · ⏭ 下一条
- **倍速滑杆** 0.5x - 3.0x（步进 0.1，声音不变尖）
- **倍速状态会记住**，下次打开保持
- 锁屏后可用**耳机线控**暂停/切换

### 已听记忆
- 播放完自动标记已听（下次打开就不再出现在"未听"列表）
- 手动点"✓ 标已听"也行
- **已听记录存在 iPhone 本地**（换手机就没了，同一 iPhone 内永久保留）

---

## 🛠 我要改点东西怎么办

### 换 X 订阅博主
1. 打开 Zeabur → 项目 → x-reader → **环境变量**
2. 找 `SUBSCRIPTIONS`，改成新的博主用户名（不带 @、逗号分隔）
   - 例：`SUBSCRIPTIONS=karpathy,naval,paulg,ycombinator,sama`
3. 保存 → 服务自动重启 → App 里刷新一次

### 调抓取时间
- 变量 `DAILY_CRON`（cron 表达式，默认 `30 7 * * *` = 每天 7:30）
- 变量 `CRON_TZ`（时区，默认 `Asia/Shanghai`）
- 想改 6:00 抓：`DAILY_CRON=0 6 * * *`

### 调节流阈值
- 变量 `OPEN_FETCH_THROTTLE_MIN`（默认 20 = 20 分钟内不重复抓）
- 想更省钱：改成 60（1 小时才允许抓一次，一天最多 24 次全量抓）

### 换 TTS 音色
- 变量 `VOLC_VOICE_TYPE`
- 备选（都是 `volcano_tts` cluster 已开通的免费音色）：
  - `BV700_V2_streaming` ⭐ 当前 · 通用女声 V2
  - `BV700_streaming` 通用女声 V1
  - `BV701_streaming` 通用男声
  - `BV705_streaming` 甜美女声
  - `BV407_streaming` 悦耳男声
  - `BV406_streaming` 情感男声
  - `BV119_streaming` 主播女声
  - `BV002_streaming` 标准女声

### 一次性抓更多历史推文
浏览器打开一次（`pages` 可以是 1-25）：
```
https://x-reader.zeabur.app/api/backfill?pages=10
```
- pages=5 → 每人 100 条 → 花 $0.06
- pages=10 → 每人 200 条 → 花 $0.12
- pages=25 → 每人 500 条 → 花 $0.30

### 想改代码怎么办
```bash
cd /Users/vikkiliang/CodeBuddy/daily/x-reader
# 改文件……
git add . && git commit -m "改了啥" && git push
```
push 后 **Zeabur 会自动重新部署**（1-2 分钟）。

---

## 💰 成本追踪

### 每月开销预估
| 项 | 每月 |
|---|---|
| Zeabur 服务器（东京 2C2GB） | $3 |
| twitterapi.io | 约 $1.5（按日常用量摊）|
| 火山引擎 TTS | ¥0（免费额度内） |
| **合计** | **约 $4.5 ≈ ¥32/月** |

### 查看余额
- **twitterapi.io**：https://twitterapi.io/dashboard → 顶部有余额显示
- **火山引擎**：https://console.volcengine.com/speech/service/8 → 语音合成用量
- **Zeabur**：https://zeabur.com/billing

---

## 🐛 出问题了怎么办

### App 打开是空白
1. Zeabur 服务是否在跑？→ https://zeabur.com/projects → x-reader 服务状态是不是绿灯
2. 服务在跑但没数据？→ 浏览器打开 `https://x-reader.zeabur.app/api/health` 看 `total` 字段
3. total = 0 → 强制抓一次：浏览器打开 `https://x-reader.zeabur.app/api/backfill?pages=1`

### 播放没声音
1. 音量开了吗？（废话但要确认）
2. 浏览器控制台报错？→ Safari 长按刷新按钮 → 开发菜单 → JavaScript 控制台
3. 火山 Key 过期或额度用完？→ 检查 https://console.volcengine.com/speech/service/8

### 锁屏后停了
- **必须**从主屏幕图标进入 App（不是 Safari 里打开的）
- **第一次播放**必须在解锁状态下手动点，之后才能锁屏继续
- 有些系统级低电量模式会停后台音频，检查一下

### Zeabur 服务崩了
1. 服务状态页面看错误信息
2. 常见原因：Node.js 版本升级导致依赖不兼容 → 让我修
3. **数据不会丢**：内存数据丢了没关系，服务重启会自动重新抓一次

---

## 📋 调试 API 手册（备用）

| URL | 作用 |
|---|---|
| GET `/api/health` | 健康检查 + 状态汇总 |
| GET `/api/feed` | 拉当前所有推文（顺便触发一次抓取） |
| POST `/api/fetch-now` | 强制立即抓一次（不管节流） |
| GET `/api/backfill?pages=5` | 历史回填，每人翻 pages 页 |
| POST `/api/tts` `{text}` | 生成音频（内部用） |

用命令行测：
```bash
curl https://x-reader.zeabur.app/api/health
```

---

## 🚀 后续可能的升级路径

一周后回看，如果你真的每天在用：

- **升级到原生 iOS App + TestFlight**：$99/年 Apple 开发者账号，用 Swift 或 Capacitor 打包，装到自己手机 → 未来能分享给朋友装
- **加"离线预下载"**：晚上 WiFi 自动下载明早的推文 + 音频，通勤纯用离线包 → 不消耗流量
- **加内容过滤**：只播长度 > 50 字的推文，跳过"哈哈哈"这种口水推文
- **加"跳过转推"开关**：单独控制是否播被转发的推文（当前已跳过）

如果一周后你没打开几次 → 说明这不是你要的东西，损失 ¥0（只有 $10 twitterapi + $3 Zeabur 服务器）。

---

*搭建日期：2026-08-19 20:00-21:30（1.5 小时从零到线上）*
*搭档：Vikki + AI Assistant*
