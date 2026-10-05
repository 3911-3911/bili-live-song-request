# B站点歌台（bili-live-song-request）

[Bilibili](https://live.bilibili.com) 直播弹幕点歌模组，为 [Folia](https://github.com/chthollyphile/folia-major) 音乐播放器打造（[Folium 模组平台](https://github.com/chthollyphile/folia-major/blob/main/mods/README.md)）。

观众在直播间发送「点歌 歌名」，Folia 自动搜索（网易云）并立即播放或加入队列；支持取消、切歌、按序号删除，以及角色权限与限额控制。

移植自 folia-major 的 `feature/bilibili-live-song-request` 分支，改以纯 Folium 模组实现——宿主零改动，`main` 入口承担全部 B站网络协议（零第三方依赖），`client` 入口负责指令、权限与界面。

## 观众指令

| 指令 | 效果 |
| --- | --- |
| `点歌 歌名`（前缀可在设置中改为逗号分隔的多个） | 搜索并立即播放 / 加入队列 |
| `点歌 1460946254` | 长纯数字视为网易云歌曲 ID，直接点播 |
| `取消点歌` | 撤销自己最近一条排队中的请求 |
| `切歌` | 跳过当前一首（房主、房管，或当前歌曲的点歌人可用） |
| `删除 N` | 删除排队列表中第 N 条（房主、房管，或该条的点歌人可用） |

## 安装

### 方式一：拖拽 zip 安装

1. 下载本仓库的 zip 包（Code → Download ZIP，或 Releases 里的附件）
2. 在 Folia 里打开命令面板，执行「模组」命令打开模组面板
3. 把 zip 拖到模组面板上，启用并确认

### 方式二：手动复制

1. 在模组面板右上角点「打开模组目录」（Windows 为 `%APPDATA%\Folia\mods`）
2. 把本仓库的文件（`mod.json`、`index.cjs`、`client.mjs`）复制成该目录下的一个子目录，例如 `bili-live-song-request/`
3. 回到模组面板点「重载」，启用并确认

## 前置条件

1. **桌面版 Folia**（网页版 / PWA 没有模组系统）
2. 「设置 → 实验室」中开启**模组系统**
3. 「设置 → 集成」中开启**舞台模式**（来源保持默认的 **Stage API**）——点歌的搜索与播放经由宿主的本地 Stage API（`127.0.0.1`），这是官方留给外部点歌程序的通道
4. 在模组设置中填写**房间号**，执行「连接点歌台」命令，或开启「启动模组时自动连接」
5. 可选：填写 **SESSDATA**（登录 Cookie）。仅当连接被 B站风控拒绝（-352）时需要

装好后，播放器面板里会出现「点歌台」标签页：连接状态、最新弹幕、最近一次点歌结果与请求队列。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `playback.control` | 「切歌」指令与面板上的切歌按钮（`folium.playback.next()`） |
| `filesystem.data` | 持久化请求队列，重启后恢复排队状态 |

B站连接与搜索全部发生在模组的 `main` 入口（主进程 Node 环境），使用 Node 原生网络能力，不涉及额外权限。模组不会上传任何数据。

## 设置项

连接（房间号、SESSDATA、自动连接）、指令前缀、播放模式（立即播放 / 加入队列、空闲歌单让位）、搜索候选数、限额（队列上限、每人排队上限、冷却、关键词去重窗口）、权限（普通观众 / 舰长 / 房管开关、粉丝牌名称与等级要求）。全部在模组面板展开后的设置区调整。

## OBS 直播覆盖层

在 OBS 里用浏览器源加载模组自带的展示页（Folia 开着且模组启用时自动运行）：

```
http://127.0.0.1:32198/
```

页面复刻原分支版的队列列表 + 播放卡片：玻璃拟态面板、序号徽章、点歌人、进度条与自动滚动。

**舞台动画**：加 `?stage=1` 可把宿主自己的 OBS 歌词页面（32108）以整页 iframe 嵌在本页面底层，一个浏览器源同时获得 歌词动画 + 队列 + 播放卡片：

```
http://127.0.0.1:32198/?stage=1
```

其余 URL 参数：`accent`（主题色，如 `%236ee7ff`）、`speed`（滚动速度 5-120）、`mode`（`loop`/`ping-pong`）、`header=0`（隐藏列表标题）、`listX/listY/listWidth/listHeight`、`cardRight/cardBottom/cardWidth/cardHeight`、`lang=en`。

播放数据优先取宿主 Stage API；舞台会话上下文里 Stage 不报播放态时，自动回退到模组每秒推送的宿主播放快照（无封面，其余信息完整）。

宿主自己的 OBS 页面（`127.0.0.1:32108`）不对模组开放，两者互相独立。

## 已知限制

- **音源为网易云**：搜索与播放经由宿主 Stage API，目前只走网易云；酷狗等多音源支持等待 Folium 的 omni.provider 接口稳定后再补。
- **播放语义**：立即播放会打断当前歌曲，并把「其余点歌 + 原歌单未播部分」按顺序接回队尾，点播结束后自动继续原歌单。
- **OBS 展示页**：由模组自己提供（`127.0.0.1:32198`），队列布局跟随 URL 参数而非应用内设置。

## 开发调试

```bash
git clone https://github.com/3911-3911/bili-live-song-request.git
# 放进 folia-major 仓库的 mods/ 目录（或软链），然后：
cd folia-major
npm install
npm run dev:electron
```

开发版会扫描仓库 `mods/` 目录；改完代码在模组面板点「重载」即可，无需重新确认（开发目录豁免）。

## 许可证

[AGPL-3.0](LICENSE)，随上游 [folia-major](https://github.com/chthollyphile/folia-major)。本模组的协议实现移植自该仓库 `feature/bilibili-live-song-request` 分支。
