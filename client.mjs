// mods/bili-live-song-request/client.mjs
//
// B站直播弹幕点歌 — client 入口（渲染进程）。
//
// 职责：指令解析（点歌/取消点歌/切歌/删除 N）、权限与限额、搜索与播放
// （经 rpc 交给 main 的 Stage API 桥，走宿主真实播放流程）、点歌台面板、
// 状态提示与请求队列的持久化。
//
// 与分支版（feature/bilibili-live-song-request）的行为对应：
//   - biliLiveConfig.parseBiliLiveDanmuCommand  -> parseDanmuCommand
//   - biliLiveQueue.*                           -> canRequest / findPending 等纯函数
//   - useBiliLiveSongRequest                    -> processDanmu / resolveAndApply
//   - queue-viewer 展示层                        -> playerPanelTab「点歌台」
//
// 已知差异（mod 形态的能力边界）：
//   - 音源搜索经由宿主 Stage API，目前为网易云；酷狗暂不支持。
//   - OBS 浏览器源覆盖层无法由模组提供（宿主的 OBS 页面不对模组开放）。

export default function activate(folium) {
    const isMainContext = folium.env.context === 'main';
    const isZh = String(navigator.language || '').toLowerCase().startsWith('zh');
    const L = (zh, en) => (isZh ? zh : en);

    // ------------------------------------------------------------------
    // 状态
    // ------------------------------------------------------------------

    const state = {
        connection: 'idle',          // idle | connecting | connected | reconnecting | error
        connectionDetail: '',
        roomId: '',
        requests: [],                // { id, songId, title, artist, uname, uid, keyword, status: 'playing'|'queued', ts }
        playlistTail: [],            // 首条点歌打断时的空闲歌单快照，全部结束后交还
        lastDanmu: null,             // { text, uname, matched, ts }
        lastResult: null,            // { uname, keyword, title?, status, ts }
        currentIsViewerRequest: false,
        playingSince: 0,               // 降级链模式：当前点歌开播时刻（重播/回声判定）
        mode: 'queue',                 // queue = 分支模型（宿主队列重排）；chain = 降级链接播
    };

    const listeners = new Set();

    // 捕获应用当前主题（叠加层 UI 跟随 Folia 原生样式）。
    // 初始值在点歌台面板首次挂载时经 ctx.getTheme() 取得，之后由 theme.changed 维护。
    let latestTheme = null;
    const captureTheme = (theme) => {
        if (!theme || typeof theme !== 'object') return;
        latestTheme = {
            background: theme.backgroundColor || null,
            primary: theme.primaryColor || null,
            secondary: theme.secondaryColor || null,
            accent: theme.accentColor || null,
            fontStack: (() => {
                try {
                    return folium.theme.resolveFontStack(theme) || null;
                } catch (_err) {
                    return null;
                }
            })(),
            daylight: theme.isDaylight === true,
        };
    };

    // 把请求队列与连接状态推给 main 的 OBS 页面服务（节流）。
    // OBS 叠加层设置快照：随 obsState 推送给展示页（URL 参数仍可临时覆盖）。
    const buildObsPayload = () => {
        const values = settingsSection.params.get();
        return {
            stage: values.obsStage === true,
            header: values.obsShowHeader !== false,
            mode: values.obsScrollMode === 'ping-pong' ? 'ping-pong' : 'loop',
            speed: Number(values.obsScrollSpeed) || 18,
            accent: String(values.obsAccent || '').trim() || null,
            lang: values.obsLang === 'en' ? 'en' : 'zh-CN',
            listX: Number(values.obsListX), listY: Number(values.obsListY),
            listWidth: Number(values.obsListWidth), listHeight: Number(values.obsListHeight),
            cardLeft: Number(values.obsCardLeft), cardBottom: Number(values.obsCardBottom),
            cardWidth: Number(values.obsCardWidth), cardHeight: Number(values.obsCardHeight),
        };
    };

    let obsPushTimer = null;
    let obsPushQueued = false;
    const pushObs = () => {
        if (!isMainContext) return;
        if (obsPushTimer) {
            obsPushQueued = true;
            return;
        }
        obsPushTimer = setTimeout(() => {
            obsPushTimer = null;
            // 顺带推送宿主实时播放快照：舞台会话上下文里 Stage API 不报播放态，
            // OBS 页面用它兜底渲染「正在播放」与进度。
            let current = null;
            try {
                const playback = folium.playback.getState();
                if (playback.song) {
                    current = {
                        id: playback.song.id,
                        title: playback.song.title,
                        artist: playback.song.artist,
                        state: playback.state,
                        position: playback.position,
                        duration: playback.duration,
                    };
                }
            } catch (_err) {
                // 播放服务不可用时只推队列
            }
            folium.rpc.call('pushObsState', {
                connection: state.connection,
                roomId: state.roomId,
                current,
                theme: latestTheme,
                obs: buildObsPayload(),
                requests: state.requests.map((item) => ({
                    songId: item.songId,
                    title: item.title,
                    artist: item.artist,
                    uname: item.uname,
                    status: item.status,
                    ts: item.ts,
                })),
            }).then(() => {
                if (obsPushQueued) {
                    obsPushQueued = false;
                    pushObs();
                }
            }).catch(() => {
                // main 侧不可用（停用中）时静默
            });
        }, 400);
    };

    const notify = () => {
        listeners.forEach((listener) => {
            try {
                listener();
            } catch (_err) {
                // 单个面板渲染失败不影响其他订阅者
            }
        });
        pushObs();
    };

    const dedupeMap = new Map();     // keyword -> last accepted ts
    const lastAcceptedAt = new Map(); // requester key -> ts
    const inFlight = new Set();      // 进行中的搜索（keyword:requester）
    const disposers = [];

    // ------------------------------------------------------------------
    // 纯逻辑（移植自分支 biliLiveConfig / biliLiveQueue）
    // ------------------------------------------------------------------

    const extractSongKeyword = (text, keywordsCsv) => {
        const trimmed = text.trim().replace(/^[/／]\s*/, '');
        if (!trimmed) return null;
        const keywords = keywordsCsv
            .split(',')
            .map((kw) => kw.trim())
            .filter(Boolean);
        for (const keyword of keywords) {
            if (trimmed.startsWith(keyword)) {
                const remainder = trimmed.slice(keyword.length).trim();
                if (remainder) {
                    return remainder;
                }
            }
        }
        return null;
    };

    const parseDanmuCommand = (text, keywordsCsv) => {
        const normalized = text.trim().replace(/^[/／]\s*/, '').trim();
        if (normalized === '取消点歌') return { type: 'cancel' };
        if (normalized === '切歌') return { type: 'skip' };
        const deleteMatch = /^删除\s*(\d+)$/.exec(normalized);
        if (deleteMatch) return { type: 'delete', position: Number(deleteMatch[1]) };

        const keyword = extractSongKeyword(text, keywordsCsv);
        return keyword ? { type: 'request', keyword } : null;
    };

    const requesterKey = (danmu) => (danmu.uid > 0 ? `uid:${danmu.uid}` : `name:${danmu.uname}`);
    const isSameRequester = (item, danmu) => (
        danmu.uid > 0 && item.uid > 0
            ? item.uid === danmu.uid
            : item.uname === danmu.uname
    );

    const canRequest = (danmu, values) => {
        if (danmu.isAnchor) return true;
        const roleAllowed = danmu.isAdmin
            ? values.allowAdmins
            : danmu.guardLevel > 0
                ? values.allowGuards
                : values.allowRegularUsers;
        if (roleAllowed) return true;
        const requiredName = String(values.requiredMedalName || '').trim();
        if (!requiredName) return false;
        return danmu.medalName.trim() === requiredName
            && danmu.medalLevel >= values.requiredMedalLevel;
    };

    const isSongAlreadyActive = (songId) => {
        const playing = folium.playback.getState();
        const currentId = playing.song && playing.song.id ? Number(playing.song.id) : null;
        return currentId === songId || state.requests.some((item) => item.songId === songId);
    };

    // 「删除 N」的行号 = 待播请求（不含正在播放的一首）按待播顺序排列后的第 N 项。
    const pendingRequests = () => state.requests.filter((item) => item.status !== 'playing');

    const removeRequest = async (item) => {
        state.requests = state.requests.filter((entry) => entry.id !== item.id);
        let hostQueueEdited = false;
        try {
            const queueStatus = await folium.rpc.call('stage', { op: 'queueStatus' });
            const items = queueStatus?.data?.queue?.items || [];
            const match = items.find((entry) => Number(entry.id) === item.songId);
            if (match && match.queueItemId) {
                const result = await folium.rpc.call('stage', { op: 'queue', action: 'remove', queueItemId: match.queueItemId });
                hostQueueEdited = Boolean(result && result.ok);
            }
        } catch (error) {
            folium.log.warn('remove request from queue failed:', error);
        }
        if (!hostQueueEdited) {
            // 舞台会话上下文里宿主队列不可编辑，只能从点歌台移除；
            // 歌曲仍会照常播放，到下一首自然跳过。
            toast(L('宿主队列暂不可编辑（舞台会话），已仅在点歌台移除', 'Host queue is not editable right now; removed from the request list only'), 'info');
        }
        notify();
        persistSoon();
    };

    // ------------------------------------------------------------------
    // 设置
    // ------------------------------------------------------------------

    const settingsSection = folium.registries.settingsSections.register({
        id: 'main',
        label: { 'zh-CN': '点歌台设置', en: 'Song request settings' },
        description: {
            'zh-CN': '观众在直播间发送指令，宿主自动搜索并播放。需要在 设置 → 集成 中开启「舞台模式」（Stage API 源）。',
            en: 'Viewers send commands in the live room; the host searches and plays. Requires Stage mode (Stage API source) under Settings → Integrations.',
        },
        settings: [
            { key: 'roomId', type: 'text', defaultValue: '', label: { 'zh-CN': '房间号', en: 'Room id' }, description: { 'zh-CN': 'B站直播间房间号（短号或完整号）', en: 'Bilibili live room id (short or full)' }, group: { 'zh-CN': '连接', en: 'Connection' } },
            { key: 'sessdata', type: 'text', defaultValue: '', label: { 'zh-CN': 'SESSDATA（可选）', en: 'SESSDATA (optional)' }, description: { 'zh-CN': '登录 Cookie，风控失败时填写', en: 'Login cookie; fill when risk control rejects' }, group: { 'zh-CN': '连接', en: 'Connection' } },
            { key: 'autoConnect', type: 'boolean', defaultValue: false, label: { 'zh-CN': '启动模组时自动连接', en: 'Auto-connect on activation' }, group: { 'zh-CN': '连接', en: 'Connection' } },
            { key: 'keywords', type: 'text', defaultValue: '点歌', label: { 'zh-CN': '点歌指令前缀', en: 'Command prefixes' }, description: { 'zh-CN': '逗号分隔，例如「点歌,点一首」', en: 'Comma-separated, e.g. "song,play"' }, group: { 'zh-CN': '指令', en: 'Commands' } },
            { key: 'playMode', type: 'select', defaultValue: 'play', label: { 'zh-CN': '播放模式', en: 'Play mode' }, options: [
                { value: 'play', label: { 'zh-CN': '立即播放（打断空闲歌单，绝不打断点歌）', en: 'Play now (cuts in idle playlist only)' } },
                { value: 'queue', label: { 'zh-CN': '等待（空闲歌单播完后接播）', en: 'Wait for the idle playlist' } },
            ], group: { 'zh-CN': '播放', en: 'Playback' } },
            { key: 'searchLimit', type: 'number', defaultValue: 5, min: 1, max: 10, label: { 'zh-CN': '搜索候选数', en: 'Search candidates' }, group: { 'zh-CN': '播放', en: 'Playback' } },
            { key: 'maxQueueSize', type: 'number', defaultValue: 20, min: 1, max: 100, label: { 'zh-CN': '队列上限', en: 'Max queue size' }, group: { 'zh-CN': '限额', en: 'Limits' } },
            { key: 'maxRequestsPerUser', type: 'number', defaultValue: 2, min: 1, max: 10, label: { 'zh-CN': '每人排队上限', en: 'Max per viewer' }, group: { 'zh-CN': '限额', en: 'Limits' } },
            { key: 'cooldownSeconds', type: 'number', defaultValue: -1, min: -1, max: 3600, label: { 'zh-CN': '点歌冷却（秒，-1 关闭）', en: 'Cooldown seconds (-1 off)' }, group: { 'zh-CN': '限额', en: 'Limits' } },
            { key: 'dedupeWindowMs', type: 'number', defaultValue: 8000, min: 0, max: 60000, step: 500, label: { 'zh-CN': '相同关键词去重窗口（毫秒）', en: 'Dedupe window (ms)' }, group: { 'zh-CN': '限额', en: 'Limits' } },
            { key: 'allowRegularUsers', type: 'boolean', defaultValue: true, label: { 'zh-CN': '允许普通观众', en: 'Allow regular viewers' }, group: { 'zh-CN': '权限', en: 'Permissions' } },
            { key: 'allowGuards', type: 'boolean', defaultValue: true, label: { 'zh-CN': '允许舰长', en: 'Allow guards' }, group: { 'zh-CN': '权限', en: 'Permissions' } },
            { key: 'allowAdmins', type: 'boolean', defaultValue: true, label: { 'zh-CN': '允许房管', en: 'Allow admins' }, group: { 'zh-CN': '权限', en: 'Permissions' } },
            { key: 'requiredMedalName', type: 'text', defaultValue: '', label: { 'zh-CN': '要求的粉丝牌名（可选）', en: 'Required fan medal (optional)' }, group: { 'zh-CN': '权限', en: 'Permissions' } },
            { key: 'requiredMedalLevel', type: 'number', defaultValue: 0, min: 0, max: 40, label: { 'zh-CN': '要求的粉丝牌等级', en: 'Required medal level' }, group: { 'zh-CN': '权限', en: 'Permissions' } },
            { key: 'obsStage', type: 'boolean', defaultValue: true, label: { 'zh-CN': '叠加层嵌入舞台动画', en: 'Embed stage animation' }, description: { 'zh-CN': 'OBS 页面底层嵌入宿主歌词页面', en: 'Embed the host lyrics page under the overlay' }, group: { 'zh-CN': 'OBS 叠加层', en: 'OBS overlay' } },
            { key: 'obsShowHeader', type: 'boolean', defaultValue: true, label: { 'zh-CN': '显示队列标题栏', en: 'Show queue header' }, group: { 'zh-CN': 'OBS 叠加层', en: 'OBS overlay' } },
            { key: 'obsScrollMode', type: 'select', defaultValue: 'loop', label: { 'zh-CN': '队列滚动方式', en: 'Queue scroll mode' }, options: [
                { value: 'loop', label: { 'zh-CN': '循环', en: 'Loop' } },
                { value: 'ping-pong', label: { 'zh-CN': '往返', en: 'Ping-pong' } },
            ], group: { 'zh-CN': 'OBS 叠加层', en: 'OBS overlay' } },
            { key: 'obsScrollSpeed', type: 'number', defaultValue: 18, min: 5, max: 120, label: { 'zh-CN': '队列滚动速度', en: 'Scroll speed' }, group: { 'zh-CN': 'OBS 叠加层', en: 'OBS overlay' } },
            { key: 'obsAccent', type: 'text', defaultValue: '', label: { 'zh-CN': '强调色（空 = 跟随主题）', en: 'Accent color (empty = theme)' }, description: { 'zh-CN': '形如 #e8b64c 的十六进制颜色', en: 'Hex color like #e8b64c' }, group: { 'zh-CN': 'OBS 叠加层', en: 'OBS overlay' } },
            { key: 'obsLang', type: 'select', defaultValue: 'zh-CN', label: { 'zh-CN': '叠加层语言', en: 'Overlay language' }, options: [
                { value: 'zh-CN', label: { 'zh-CN': '中文', en: 'Chinese' } },
                { value: 'en', label: { 'zh-CN': 'English', en: 'English' } },
            ], group: { 'zh-CN': 'OBS 叠加层', en: 'OBS overlay' } },
            { key: 'obsListX', type: 'number', defaultValue: 2, min: 0, max: 100, label: { 'zh-CN': '队列水平位置（%）', en: 'Queue X position (%)' }, group: { 'zh-CN': 'OBS 叠加层 · 队列面板', en: 'OBS overlay · Queue panel' } },
            { key: 'obsListY', type: 'number', defaultValue: 12, min: 0, max: 100, label: { 'zh-CN': '队列垂直位置（%）', en: 'Queue Y position (%)' }, group: { 'zh-CN': 'OBS 叠加层 · 队列面板', en: 'OBS overlay · Queue panel' } },
            { key: 'obsListWidth', type: 'number', defaultValue: 432, min: 280, max: 900, label: { 'zh-CN': '队列宽度（px）', en: 'Queue width (px)' }, group: { 'zh-CN': 'OBS 叠加层 · 队列面板', en: 'OBS overlay · Queue panel' } },
            { key: 'obsListHeight', type: 'number', defaultValue: 560, min: 220, max: 900, label: { 'zh-CN': '队列最大高度（px）', en: 'Queue max height (px)' }, group: { 'zh-CN': 'OBS 叠加层 · 队列面板', en: 'OBS overlay · Queue panel' } },
            { key: 'obsCardLeft', type: 'number', defaultValue: 66, min: 0, max: 100, label: { 'zh-CN': '卡片左边距（%）', en: 'Card left position (%)' }, group: { 'zh-CN': 'OBS 叠加层 · 播放卡片', en: 'OBS overlay · Now-playing card' } },
            { key: 'obsCardBottom', type: 'number', defaultValue: 3, min: 0, max: 100, label: { 'zh-CN': '卡片下边距（%）', en: 'Card bottom (%)' }, group: { 'zh-CN': 'OBS 叠加层 · 播放卡片', en: 'OBS overlay · Now-playing card' } },
            { key: 'obsCardWidth', type: 'number', defaultValue: 608, min: 320, max: 1000, label: { 'zh-CN': '卡片宽度（px）', en: 'Card width (px)' }, group: { 'zh-CN': 'OBS 叠加层 · 播放卡片', en: 'OBS overlay · Now-playing card' } },
            { key: 'obsCardHeight', type: 'number', defaultValue: 168, min: 132, max: 400, label: { 'zh-CN': '卡片高度（px，封面随之缩放）', en: 'Card height (px, cover scales)' }, group: { 'zh-CN': 'OBS 叠加层 · 播放卡片', en: 'OBS overlay · Now-playing card' } },
        ],
    });

    // ------------------------------------------------------------------
    // 提示
    // ------------------------------------------------------------------

    const toast = (message, type = 'info') => {
        try {
            folium.ui.toast(message, { type, durationMs: 3200 });
        } catch (_err) {
            // 导出窗口等场景不可用
        }
    };

    const setLastResult = (uname, keyword, status, title) => {
        state.lastResult = { uname, keyword, status, title, ts: Date.now() };
        notify();
    };

    // ------------------------------------------------------------------
    // 搜索与播放（经 main 的 Stage API 桥）
    //
    // 双模式（v1.4 起）：
    // - queue（默认，普通播放上下文）：忠实复刻分支版——新点歌 append 进
    //   宿主队列、move 到点歌区（当前歌之后），立即播放时 select 该项。
    //   宿主持有完整队列 [.., 当前, 点歌..., 歌单剩余]，连播/切歌/循环/FM
    //   全部由宿主原生引擎处理；模组只在 songChanged 时对账：把已唱完的
    //   请求从队列 remove、标记状态。没有轮询守卫，没有跨进程时序假设。
    // - chain（舞台会话上下文降级，宿主拒绝队列编辑）：每次只 play 一首，
    //   由守卫衔接（v1.3 行为），空闲歌单打断前快照、结束后交还。
    // ------------------------------------------------------------------

    const stageQueueStatus = async () => {
        const result = await folium.rpc.call('stage', { op: 'queueStatus' });
        if (!result || !result.ok) return null;
        return result.data || null;
    };

    const stageQueueOp = async (payload) => {
        const result = await folium.rpc.call('stage', { op: 'queue', ...payload });
        if (!result || !result.ok) {
            throw new Error(result?.error || 'Stage queue op failed');
        }
        return result;
    };

    // 分支模型的队列重排。返回 false 表示宿主当前不允许队列编辑
    // （舞台会话等），调用方应降级到链接模式。
    const applyRequestViaQueue = async (songId, wantPlayNow) => {
        const before = await stageQueueStatus();
        const caps = before?.queueCapabilities || {};
        if (!caps.append || !caps.move || (wantPlayNow && !caps.select)) {
            return false;
        }
        await stageQueueOp({ action: 'append', songIds: [songId] });

        const after = await stageQueueStatus();
        if (!after || !after.queue) {
            throw new Error('Queue status unavailable after append.');
        }
        let items = after.queue.items || [];
        let mine = [...items].reverse().find((entry) => Number(entry.id) === songId) || null;
        // 长队列时 items 是窗口视图；刚 append 的歌在队尾，去尾部窗口找。
        if (!mine && Number(after.queue.length) > items.length) {
            const tail = await folium.rpc.call('stage', {
                op: 'queueTail',
                offset: Math.max(0, Number(after.queue.length) - 3),
            });
            const tailItems = tail?.data?.queue?.items || [];
            mine = [...tailItems].reverse().find((entry) => Number(entry.id) === songId) || null;
            if (mine) items = items.concat(tailItems);
        }
        if (!mine || !mine.queueItemId) {
            throw new Error('Appended queue item was not found.');
        }
        // queueItemId 按位置编码（source:id:index），move 之后会变——
        // 后续操作一律用索引。
        const mineIndex = Number(mine.queueItemId.slice(mine.queueItemId.lastIndexOf(':') + 1));
        const currentIndex = Number(after.queue.currentIndex);
        const queueLength = Number(after.queue.length);
        if (!Number.isInteger(mineIndex) || !Number.isInteger(queueLength)) {
            throw new Error('Queue index unavailable after append.');
        }
        const baseIndex = Number.isInteger(currentIndex) && currentIndex >= 0 ? currentIndex : -1;
        const pendingBefore = state.requests.filter((item) => item.status !== 'playing').length;
        const targetIndex = Math.min(
            baseIndex + 1 + (wantPlayNow ? 0 : pendingBefore),
            queueLength - 1,
        );
        if (mineIndex !== targetIndex) {
            await stageQueueOp({ action: 'move', queueItemId: mine.queueItemId, toIndex: targetIndex });
        }
        if (wantPlayNow) {
            await stageQueueOp({ action: 'select', index: targetIndex });
        }
        return true;
    };

    // 已唱完的请求从宿主队列移除（分支版 removeBiliLiveSongsFromQueue 的对应物）。
    const removeSongsFromHostQueue = async (songIds) => {
        if (!songIds || songIds.length === 0) return;
        try {
            const status = await stageQueueStatus();
            const items = status?.queue?.items || [];
            for (const songId of songIds) {
                const match = items.find((entry) => Number(entry.id) === songId);
                if (match && match.queueItemId) {
                    try {
                        await stageQueueOp({ action: 'remove', queueItemId: match.queueItemId });
                    } catch (_err) {
                        // 单项失败不影响其余
                    }
                }
            }
        } catch (_err) {
            // 尽力而为；对账以本地列表为准
        }
    };

    // 分支模型的对账：换歌时标记播放中、清掉已完成的请求（本地 + 宿主队列）。
    const onSongChangedQueueMode = (event) => {
        const songId = event?.song?.id ? Number(event.song.id) : null;
        const match = songId === null ? null : state.requests.find((item) => item.songId === songId);
        if (match) {
            const index = state.requests.indexOf(match);
            const completed = state.requests.slice(0, index);
            state.requests = state.requests.slice(index)
                .map((item, i) => ({ ...item, status: i === 0 ? 'playing' : 'queued' }));
            state.currentIsViewerRequest = true;
            state.playingSince = Date.now();
            if (completed.length > 0) {
                void removeSongsFromHostQueue(completed.map((item) => item.songId));
            }
        } else {
            const playing = state.requests.find((item) => item.status === 'playing');
            if (playing) {
                state.requests = state.requests.filter((item) => item.id !== playing.id);
                void removeSongsFromHostQueue([playing.songId]);
            }
            state.currentIsViewerRequest = false;
        }
        notify();
        persistSoon();
    };

    const stageSearch = async (query, limit) => {
        const result = await folium.rpc.call('stage', { op: 'search', query, limit });
        if (!result || !result.ok) {
            throw new Error(result?.error || 'Stage search failed');
        }
        const songs = result.data?.songs || [];
        return songs.filter((song) => Number.isInteger(song.songId) && song.songId > 0);
    };

    const playSongNow = async (songId) => {
        const result = await folium.rpc.call('stage', { op: 'play', songId, appendToQueue: false });
        if (!result || !result.ok) {
            throw new Error(result?.error || 'Stage play failed');
        }
    };

    // 快照宿主队列中「当前歌之后」的部分（含标题，供交还与展示）。
    const snapshotPlaylistTail = async () => {
        try {
            const playerStatus = await folium.rpc.call('stage', { op: 'playerStatus' });
            const currentQueueItemId = playerStatus?.data?.current?.queueItemId || null;
            const queueStatus = await folium.rpc.call('stage', { op: 'queueStatus' });
            const items = queueStatus?.data?.queue?.items || [];
            const currentIndex = currentQueueItemId
                ? items.findIndex((entry) => entry.queueItemId === currentQueueItemId)
                : -1;
            state.playlistTail = items
                .slice(currentIndex + 1)
                .map((entry) => ({
                    songId: Number(entry.id),
                    title: entry.title || '',
                    artist: entry.artist || '',
                }))
                .filter((item) => Number.isInteger(item.songId) && item.songId > 0)
                .slice(0, 300);
        } catch (_err) {
            state.playlistTail = [];
        }
    };

    // 全部点歌结束后把快照的歌单尾巴交还：从断点那首继续播放，
    // 其余批量接回队列——歌单完整恢复并自动续播。
    const handBackTail = async () => {
        const tail = state.playlistTail;
        state.playlistTail = [];
        if (!tail || tail.length === 0) return;
        try {
            await playSongNow(tail[0].songId);
            if (tail.length > 1) {
                await folium.rpc.call('stage', {
                    op: 'queue',
                    action: 'append',
                    songIds: tail.slice(1).map((item) => item.songId),
                });
            }
        } catch (error) {
            folium.log.warn('hand back playlist tail failed:', error);
            // 兜底：至少把歌单接回队列（不自动续播）
            try {
                await folium.rpc.call('stage', {
                    op: 'queue',
                    action: 'append',
                    songIds: tail.map((item) => item.songId),
                });
            } catch (_err) {
                // 无能为力，等宿主自行恢复
            }
        }
    };

    const resolveAndApply = async (keyword, danmu, values) => {
        const uname = danmu.uname || 'Bilibili';
        setLastResult(uname, keyword, 'searching');

        // 「点歌 1460946254」：长纯数字视为音源歌曲 ID，直接播放。
        let candidates = [];
        if (/^\d{6,}$/.test(keyword)) {
            candidates = [{ songId: Number(keyword), title: keyword, artists: [] }];
        } else {
            try {
                candidates = await stageSearch(keyword, Math.max(values.searchLimit, 3));
            } catch (error) {
                folium.log.warn('search failed:', error);
                setLastResult(uname, keyword, 'error');
                toast(L(`点歌搜索失败：${error.message}`, `Song request search failed: ${error.message}`), 'error');
                return;
            }
        }
        if (candidates.length === 0) {
            setLastResult(uname, keyword, 'notFound');
            toast(L(`没有找到「${keyword}」`, `No result for "${keyword}"`), 'info');
            return;
        }

        const playbackState = folium.playback.getState();
        const hasCurrent = Boolean(playbackState.song) && playbackState.state !== 'stopped';
        // 立即播放只打断空闲歌单，绝不打断正在播放的别人点歌；
        // 等待模式下空闲歌单也照常播完，由守卫在歌唱完后接播。
        const wantPlayNow = !hasCurrent
            || (!state.currentIsViewerRequest && values.playMode === 'play');

        let applied = null;
        let lastError = null;
        for (const candidate of candidates.slice(0, 3)) {
            if (isSongAlreadyActive(candidate.songId)) {
                setLastResult(uname, keyword, 'error', candidate.title);
                toast(L(`「${candidate.title}」已在播放或排队`, `"${candidate.title}" is already playing or queued`), 'info');
                return;
            }
            if (!wantPlayNow && state.mode === 'chain') break;
            try {
                // 首选分支模型：append + move(+select) 重排宿主队列；
                // 宿主不允许队列编辑（舞台会话）时降级为链接模式。
                const viaQueue = state.mode === 'queue'
                    ? await applyRequestViaQueue(candidate.songId, wantPlayNow)
                    : false;
                state.mode = viaQueue ? 'queue' : 'chain';
                if (!viaQueue && wantPlayNow) {
                    if (!(state.playlistTail && state.playlistTail.length)) {
                        await snapshotPlaylistTail();
                    }
                    await playSongNow(candidate.songId);
                    guardLastPlayAt = Date.now();
                    deferredBehindId = null;
                }
                applied = candidate;
                break;
            } catch (error) {
                lastError = error;
                folium.log.warn('apply candidate failed:', candidate.songId, error);
            }
        }

        if (!applied) {
            if (!wantPlayNow) {
                applied = candidates[0];
            } else {
                setLastResult(uname, keyword, 'error');
                toast(L(`点歌播放失败：${lastError ? lastError.message : '未知错误'}`, `Song request failed: ${lastError ? lastError.message : 'unknown error'}`), 'error');
                return;
            }
        }

        // 新请求开始播放时，上一首「播放中」的点歌视为已被接替。
        if (wantPlayNow) {
            state.requests = state.requests.filter((item) => item.status !== 'playing');
        }
        state.requests.push({
            id: `${applied.songId}:${requesterKey(danmu)}:${Date.now()}`,
            songId: applied.songId,
            title: applied.title,
            artist: (applied.artists || []).join(' / '),
            uname,
            uid: danmu.uid || 0,
            keyword,
            status: wantPlayNow ? 'playing' : 'queued',
            ts: Date.now(),
        });
        if (wantPlayNow) {
            state.currentIsViewerRequest = true;
            state.playingSince = Date.now();
        }

        setLastResult(uname, keyword, wantPlayNow ? 'played' : 'queued', applied.title);
        toast(L(
            wantPlayNow ? `正在播放「${applied.title}」（${uname} 点歌）` : `已加入队列「${applied.title}」（${uname} 点歌）`,
            wantPlayNow ? `Playing "${applied.title}" (requested by ${uname})` : `Queued "${applied.title}" (requested by ${uname})`,
        ), 'success');
        notify();
        persistSoon();
    };

    // ------------------------------------------------------------------
    // 队列守卫：点歌永远优先。songChanged 与秒级心跳都会跑——待播点歌
    // 存在而宿主没在放我们的歌时（播完切走、歌单/FM/舞台会话抢跑、
    // 停播），直接再 play 下一首点歌；全部结束后把快照的歌单交还。
    // ------------------------------------------------------------------

    const guardFailures = new Map();   // songId -> 连续播放失败次数
    let guardBusy = false;
    let guardLastPlayAt = 0;
    let deferredBehindId = null;       // 等待模式下正在让位的空闲歌曲 id
    let guardSeenId = null;            // 守卫上次看到的宿主当前歌（换歌 = 真实过渡）

    const playNextPending = async () => {
        if (guardBusy) return;
        const pending = state.requests.filter((item) => item.status !== 'playing');
        if (pending.length === 0) return;
        const next = pending[0];
        guardBusy = true;
        try {
            // 首次真正接播前快照空闲歌单（之后交还）；打断的是点歌时快照自然为空。
            if (!(state.playlistTail && state.playlistTail.length)) {
                await snapshotPlaylistTail();
            }
            await playSongNow(next.songId);
            guardLastPlayAt = Date.now();
            guardFailures.delete(next.songId);
            deferredBehindId = null;
            // 上一首播放中的点歌已被接替
            state.requests = state.requests.filter((item) => item.status !== 'playing');
            state.requests = state.requests.map((item) => (
                item.songId === next.songId ? { ...item, status: 'playing' } : item
            ));
            state.currentIsViewerRequest = true;
            state.playingSince = Date.now();
            notify();
            persistSoon();
        } catch (error) {
            folium.log.warn('guard play failed:', next.songId, error);
            const strikes = (guardFailures.get(next.songId) || 0) + 1;
            guardFailures.set(next.songId, strikes);
            if (strikes >= 2) {
                state.requests = state.requests.filter((item) => item.songId !== next.songId);
                toast(L(`「${next.title}」无法播放，已跳过`, `"${next.title}" could not be played; skipped`), 'error');
                notify();
                persistSoon();
                setTimeout(() => {
                    void playNextPending();
                }, 800);
            }
        } finally {
            guardBusy = false;
        }
    };

    // 当前点歌已播完：收尾，有排队就接播下一首，没有就交还空闲歌单。
    const finishPlayingAndAdvance = () => {
        const playing = state.requests.find((item) => item.status === 'playing');
        if (playing) {
            state.requests = state.requests.filter((item) => item.id !== playing.id);
            state.currentIsViewerRequest = false;
            state.playingSince = 0;
            notify();
            persistSoon();
        }
        const pending = state.requests.filter((item) => item.status !== 'playing');
        if (pending.length > 0) {
            void playNextPending();
        } else {
            void handBackTail();
        }
    };

    let stoppedTicks = 0;

    const guardQueue = () => {
        if (!isMainContext) return;
        const pending = state.requests.filter((item) => item.status !== 'playing');
        const playing = state.requests.find((item) => item.status === 'playing');
        let currentId = null;
        let playerState = 'stopped';
        try {
            const playbackState = folium.playback.getState();
            playerState = playbackState.state;
            currentId = playbackState.song && playbackState.song.id ? Number(playbackState.song.id) : null;
        } catch (_err) {
            return;
        }

        // 停播监视：宿主队列耗尽后停在 stopped（不再换歌），连续两拍确认后收尾。
        if (playing && playerState === 'stopped') {
            stoppedTicks += 1;
            if (stoppedTicks >= 2) {
                stoppedTicks = 0;
                finishPlayingAndAdvance();
            }
            return;
        }
        stoppedTicks = 0;

        if (pending.length === 0) {
            if (playing && currentId !== null && currentId !== playing.songId) {
                // 最后一首点歌结束，宿主已切走：收尾并交还空闲歌单
                finishPlayingAndAdvance();
            }
            return;
        }

        // 正在放我们的点歌：不动（排队中的等这一首结束）
        if (playing && currentId === playing.songId) return;

        // 宿主自然播到了下一首点歌（防御分支，正常不会发生）
        if (currentId === pending[0].songId) {
            state.requests = state.requests.filter((item) => item.status !== 'playing');
            state.requests = state.requests.map((item) => (
                item.songId === currentId ? { ...item, status: 'playing' } : item
            ));
            state.currentIsViewerRequest = true;
            notify();
            persistSoon();
            return;
        }

        const hasCurrent = currentId !== null && playerState !== 'stopped';
        const isTransition = currentId !== guardSeenId;
        guardSeenId = currentId;

        if (hasCurrent && settingsSection.params.get().playMode !== 'play') {
            // 等待模式：在当前这首（空闲歌单的歌）后面排队；
            // 它唱完（songChanged 换歌）时立刻接播点歌。
            if (deferredBehindId !== currentId) {
                if (deferredBehindId !== null) {
                    deferredBehindId = null;
                    void playNextPending();
                    return;
                }
                deferredBehindId = currentId;
            }
            return;
        }

        // 宿主空闲 / 立即模式被歌单或 FM 抢跑 → 强制播放下一首点歌。
        // 换歌是真实过渡，立即接播；其余情况带冷却，避免与渲染器
        // 状态滞后互相追逐。
        if (isTransition || Date.now() - guardLastPlayAt > 2500) {
            void playNextPending();
        }
    };

    // 切歌：分支模型下队列已排好，宿主原生 next() 自然切到下一首点歌；
    // 降级链模式直接接播下一首点歌；没有点歌时交给宿主。
    const skipCurrent = () => {
        const pending = state.requests.filter((item) => item.status !== 'playing');
        if (state.mode === 'queue') {
            try {
                folium.playback.next();
            } catch (error) {
                folium.log.warn('skip failed:', error);
            }
            return;
        }
        if (pending.length > 0) {
            state.requests = state.requests.filter((item) => item.status !== 'playing');
            guardLastPlayAt = 0;
            void playNextPending();
            return;
        }
        state.requests = state.requests.filter((item) => item.status !== 'playing');
        state.currentIsViewerRequest = false;
        notify();
        persistSoon();
        try {
            folium.playback.next();
        } catch (error) {
            folium.log.warn('skip failed:', error);
        }
    };

    // ------------------------------------------------------------------
    // 弹幕处理
    // ------------------------------------------------------------------

    const processDanmu = async (danmu, values) => {
        const command = parseDanmuCommand(danmu.text, values.keywords || '点歌');
        const matched = Boolean(command);
        state.lastDanmu = { text: danmu.text, uname: danmu.uname, matched, ts: danmu.ts };
        if (!command) {
            notify();
            return;
        }
        notify();

        if (command.type === 'request') {
            const uname = danmu.uname || 'Bilibili';
            if (!canRequest(danmu, values)) {
                setLastResult(uname, command.keyword, 'permissionDenied');
                return;
            }
            if (state.requests.length >= values.maxQueueSize) {
                setLastResult(uname, command.keyword, 'queueFull');
                return;
            }
            const userCount = state.requests.filter((item) => isSameRequester(item, danmu)).length;
            if (userCount >= values.maxRequestsPerUser) {
                setLastResult(uname, command.keyword, 'userLimit');
                return;
            }
            if (values.cooldownSeconds >= 0) {
                const last = lastAcceptedAt.get(requesterKey(danmu));
                if (last !== undefined && Date.now() - last < values.cooldownSeconds * 1000) {
                    setLastResult(uname, command.keyword, 'cooldown');
                    return;
                }
            }
            if (values.dedupeWindowMs > 0) {
                const last = dedupeMap.get(command.keyword);
                if (last !== undefined && Date.now() - last < values.dedupeWindowMs) {
                    return;
                }
            }
            const flightKey = `${command.keyword}:${requesterKey(danmu)}`;
            if (inFlight.has(flightKey)) return;
            inFlight.add(flightKey);
            try {
                dedupeMap.set(command.keyword, Date.now());
                lastAcceptedAt.set(requesterKey(danmu), Date.now());
                await resolveAndApply(command.keyword, danmu, values);
            } finally {
                inFlight.delete(flightKey);
            }
            return;
        }

        if (command.type === 'cancel') {
            const own = [...state.requests]
                .reverse()
                .find((item) => item.status === 'queued' && isSameRequester(item, danmu));
            if (own) {
                await removeRequest(own);
                setLastResult(danmu.uname, '', 'cancelled', own.title);
            }
            return;
        }

        if (command.type === 'delete') {
            const pending = pendingRequests();
            const target = pending[command.position - 1];
            if (!target) return;
            const allowed = danmu.isAdmin || danmu.isAnchor || isSameRequester(target, danmu);
            if (!allowed) {
                setLastResult(danmu.uname, `删除 ${command.position}`, 'permissionDenied');
                return;
            }
            await removeRequest(target);
            setLastResult(danmu.uname, `删除 ${command.position}`, 'deleted', target.title);
            return;
        }

        if (command.type === 'skip') {
            const current = state.requests.find((item) => item.status === 'playing');
            const allowed = danmu.isAdmin
                || danmu.isAnchor
                || Boolean(current && isSameRequester(current, danmu));
            if (!allowed) {
                setLastResult(danmu.uname, '切歌', 'permissionDenied');
                return;
            }
            skipCurrent();
            setLastResult(danmu.uname, '切歌', 'skipped', current?.title);
        }
    };

    // ------------------------------------------------------------------
    // 轮询 main 的事件队列
    // ------------------------------------------------------------------

    let polling = false;
    const poll = async () => {
        if (polling) return;
        polling = true;
        try {
            const events = await folium.rpc.call('poll');
            if (Array.isArray(events) && events.length > 0) {
                const values = settingsSection.params.get();
                for (const event of events) {
                    if (event.type === 'status') {
                        state.connection = event.status;
                        state.connectionDetail = event.detail || '';
                        notify();
                    } else if (event.type === 'danmu') {
                        await processDanmu(event, values);
                    }
                }
            }
        } catch (error) {
            // main 不可用（禁用过程中）时安静退出
            folium.log.warn('poll failed:', error);
        } finally {
            polling = false;
        }
    };

    // ------------------------------------------------------------------
    // 播放事件对账
    // ------------------------------------------------------------------

    const onSongChanged = (event) => {
        if (state.mode === 'queue') {
            // 分支模型：宿主原生引擎驱动衔接，这里只做对账清理。
            onSongChangedQueueMode(event);
            return;
        }
        const songId = event?.song?.id ? Number(event.song.id) : null;
        const playing = state.requests.find((item) => item.status === 'playing');
        if (playing && songId === playing.songId) {
            // 同一首歌再次开始。两种可能：宿主循环模式的重播（这首歌已经完整
            // 播过一轮，应推进）——或者只是我们自己播放调用的跨进程回声（事件
            // 晚于播放标记到达，忽略）。用开播后经过的时间区分：回声在秒级内，
            // 真重播至少要超过半个歌曲时长。
            let duration = 0;
            try {
                duration = folium.playback.getState().duration || 0;
            } catch (_err) {
                duration = 0;
            }
            const elapsed = Date.now() - (state.playingSince || 0);
            if (elapsed > Math.max(5000, duration * 500)) {
                finishPlayingAndAdvance();
            }
            return;
        }
        guardQueue();
    };

    // ------------------------------------------------------------------
    // 持久化
    // ------------------------------------------------------------------

    let persistTimer = null;
    const persistSoon = () => {
        if (persistTimer) return;
        persistTimer = setTimeout(() => {
            persistTimer = null;
            folium.storage.set('state', {
                requests: state.requests.slice(-50),
                savedAt: Date.now(),
            }).catch(() => {
                // 持久化失败不致命
            });
        }, 1000);
    };

    const restore = async () => {
        try {
            const saved = await folium.storage.get('state');
            if (saved && Array.isArray(saved.requests)) {
                state.requests = saved.requests
                    .filter((item) => item && Number.isInteger(item.songId))
                    .map((item) => ({ ...item, status: 'queued' }));
                notify();
            }
        } catch (_err) {
            // 无存档
        }
    };

    // ------------------------------------------------------------------
    // 面板标签页：点歌台
    // ------------------------------------------------------------------

    const statusText = () => {
        switch (state.connection) {
            case 'connected': return L('已连接', 'Connected');
            case 'connecting': return L('连接中…', 'Connecting…');
            case 'reconnecting': return L('重连中…', 'Reconnecting…');
            case 'error': return L('连接失败', 'Error');
            default: return L('未连接', 'Not connected');
        }
    };

    const resultText = () => {
        const last = state.lastResult;
        if (!last) return '';
        const title = last.title ? `「${last.title}」` : `「${last.keyword}」`;
        switch (last.status) {
            case 'searching': return L(`${last.uname}：搜索 ${title}…`, `${last.uname}: searching ${title}…`);
            case 'played': return L(`${last.uname} 点歌 ${title}，正在播放`, `${last.uname} requested ${title}, playing`);
            case 'queued': return L(`${last.uname} 点歌 ${title}，已入队`, `${last.uname} requested ${title}, queued`);
            case 'notFound': return L(`${last.uname} 点歌 ${title}，未找到`, `${last.uname} requested ${title}, not found`);
            case 'queueFull': return L(`${last.uname} 点歌失败：队列已满`, `${last.uname}: queue is full`);
            case 'userLimit': return L(`${last.uname} 点歌失败：排队过多`, `${last.uname}: per-viewer limit reached`);
            case 'permissionDenied': return L(`${last.uname} 没有点歌权限`, `${last.uname}: not allowed to request`);
            case 'cooldown': return L(`${last.uname} 点歌冷却中`, `${last.uname}: cooldown`);
            case 'cancelled': return L(`${last.uname} 取消了 ${title}`, `${last.uname} cancelled ${title}`);
            case 'deleted': return L(`${last.uname} 删除了 ${title}`, `${last.uname} deleted ${title}`);
            case 'skipped': return L(`${last.uname} 切歌`, `${last.uname} skipped`);
            case 'error': return L(`${last.uname} 点歌 ${title} 失败`, `${last.uname}: request ${title} failed`);
            default: return '';
        }
    };

    const panelTab = folium.registries.playerPanelTabs.register({
        id: 'console',
        label: { 'zh-CN': '点歌台', en: 'Song requests' },
        order: 520,
        mount(container, ctx) {
            const theme = ctx.getTheme();
            captureTheme(theme);
            const root = document.createElement('div');
            root.style.cssText = 'display:flex;flex-direction:column;gap:10px;height:100%;min-height:0;font-family:var(--folium-font);';
            container.appendChild(root);

            const statusRow = document.createElement('div');
            statusRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
            const dot = document.createElement('span');
            dot.style.cssText = 'width:10px;height:10px;border-radius:9999px;flex:none;';
            const statusLabel = document.createElement('span');
            statusLabel.style.cssText = 'font-size:13px;font-weight:600;';
            const roomLabel = document.createElement('span');
            roomLabel.style.cssText = 'font-size:12px;opacity:.7;margin-left:auto;';
            statusRow.append(dot, statusLabel, roomLabel);
            root.appendChild(statusRow);

            const danmuRow = document.createElement('div');
            danmuRow.style.cssText = 'font-size:12px;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            root.appendChild(danmuRow);

            const resultRow = document.createElement('div');
            resultRow.style.cssText = 'font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            root.appendChild(resultRow);

            const list = document.createElement('div');
            list.style.cssText = 'flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:6px;';
            root.appendChild(list);

            const actions = document.createElement('div');
            actions.style.cssText = 'display:flex;gap:8px;';
            const skipButton = document.createElement('button');
            skipButton.textContent = L('切歌', 'Skip');
            const clearButton = document.createElement('button');
            clearButton.textContent = L('清空排队', 'Clear queue');
            for (const button of [skipButton, clearButton]) {
                button.style.cssText = `flex:1;padding:6px 10px;border-radius:8px;border:1px solid ${theme.primaryColor}33;background:transparent;color:inherit;font-size:12px;cursor:pointer;`;
            }
            actions.append(skipButton, clearButton);
            root.appendChild(actions);

            skipButton.addEventListener('click', () => {
                skipCurrent();
            });
            clearButton.addEventListener('click', async () => {
                const queued = pendingRequests();
                for (const item of queued) {
                    await removeRequest(item);
                }
                toast(L('已清空点歌队列', 'Request queue cleared'), 'success');
            });

            const applyTheme = (nextTheme) => {
                const primary = nextTheme.primaryColor || '#e6e6e6';
                const dim = nextTheme.secondaryColor || primary;
                statusLabel.style.color = primary;
                resultRow.style.color = primary;
                dot.style.background = state.connection === 'connected' ? '#22c55e'
                    : state.connection === 'error' ? '#ef4444'
                        : dim;
                for (const button of [skipButton, clearButton]) {
                    button.style.borderColor = `${primary}33`;
                }
            };

            const render = () => {
                statusLabel.textContent = statusText() + (state.connectionDetail ? ` · ${state.connectionDetail}` : '');
                roomLabel.textContent = state.roomId ? `${L('房间', 'Room')} ${state.roomId}` : '';
                dot.style.background = state.connection === 'connected' ? '#22c55e'
                    : state.connection === 'error' ? '#ef4444'
                        : (ctx.getTheme().secondaryColor || '#999');
                danmuRow.textContent = state.lastDanmu
                    ? `${L('最新弹幕', 'Latest')}${state.lastDanmu.matched ? ' ● ' : ' · '}${state.lastDanmu.uname}：${state.lastDanmu.text}`
                    : L('等待弹幕…', 'Waiting for danmaku…');
                resultRow.textContent = resultText();

                list.textContent = '';
                const playing = state.requests.filter((item) => item.status === 'playing');
                const queued = state.requests.filter((item) => item.status !== 'playing');
                const rows = [
                    ...playing.map((item) => ({ item, number: null })),
                    ...queued.map((item, index) => ({ item, number: index + 1 })),
                ];

                if (rows.length === 0) {
                    const empty = document.createElement('div');
                    empty.style.cssText = 'font-size:12px;opacity:.6;padding:8px 0;';
                    empty.textContent = L('队列为空。观众发送「点歌 歌名」即可点歌。', 'Queue is empty. Viewers send "song <title>" to request.');
                    list.appendChild(empty);
                    return;
                }

                const theme2 = ctx.getTheme();
                for (const row of rows) {
                    const isPlaying = row.item.status === 'playing';
                    const rowEl = document.createElement('div');
                    rowEl.style.cssText = `display:flex;align-items:baseline;gap:8px;padding:7px 9px;border-radius:8px;font-size:12px;background:${theme2.backgroundColor}22;`;
                    const number = document.createElement('span');
                    number.style.cssText = `flex:none;min-width:1.4em;font-weight:700;color:${isPlaying ? '#22c55e' : theme2.secondaryColor || '#999'};`;
                    number.textContent = isPlaying ? '▶' : String(row.number);
                    const title = document.createElement('span');
                    title.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                    title.textContent = `${row.item.title}${row.item.artist ? ` — ${row.item.artist}` : ''}`;
                    const requester = document.createElement('span');
                    requester.style.cssText = 'flex:none;opacity:.7;max-width:9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                    requester.textContent = row.item.uname;
                    rowEl.append(number, title, requester);
                    list.appendChild(rowEl);
                }
            };

            listeners.add(render);
            applyTheme(theme);
            render();
            const unsubscribeTheme = ctx.subscribe(() => {
                applyTheme(ctx.getTheme());
                captureTheme(ctx.getTheme());
                pushObs();
            });
            return () => {
                listeners.delete(render);
                unsubscribeTheme();
            };
        },
    });

    // ------------------------------------------------------------------
    // 命令
    // ------------------------------------------------------------------

    const runConnect = async () => {
        const values = settingsSection.params.get();
        if (!String(values.roomId || '').trim()) {
            return { message: L('请先在模组设置中填写房间号', 'Set a room id in the mod settings first') };
        }
        const stageConfig = await folium.rpc.call('stageConfig');
        if (stageConfig && stageConfig.ok && !stageConfig.stageEnabled) {
            toast(L('提示：请先在 设置 → 集成 中开启舞台模式（Stage API 源）', 'Hint: enable Stage mode (Stage API source) under Settings → Integrations first'), 'info');
        }
        await folium.rpc.call('start', { roomId: values.roomId, sessdata: values.sessdata });
        state.roomId = String(values.roomId);
        notify();
        return { message: L(`正在连接房间 ${values.roomId}…`, `Connecting to room ${values.roomId}…`) };
    };

    folium.registries.commands.register({
        id: 'connect',
        label: { 'zh-CN': '连接点歌台', en: 'Connect song request' },
        description: { 'zh-CN': '按设置中的房间号连接 B站弹幕', en: 'Connect to the Bilibili danmaku stream' },
        keywords: ['bili', 'danmu', '点歌'],
        run: runConnect,
    });

    folium.registries.commands.register({
        id: 'disconnect',
        label: { 'zh-CN': '断开点歌台', en: 'Disconnect song request' },
        keywords: ['bili', 'danmu', '点歌'],
        run: async () => {
            await folium.rpc.call('stop');
            state.connection = 'idle';
            state.connectionDetail = '';
            notify();
            return { message: L('已断开', 'Disconnected') };
        },
    });

    folium.registries.commands.register({
        id: 'open-panel',
        label: { 'zh-CN': '打开点歌台面板', en: 'Open song request panel' },
        keywords: ['bili', 'danmu', '点歌'],
        run: async () => {
            folium.ui.openPlayerPanel('console');
            return { message: L('已打开点歌台', 'Opened') };
        },
    });

    // ------------------------------------------------------------------
    // 启动
    // ------------------------------------------------------------------

    let pollTimer = null;
    let livePushTimer = null;
    if (isMainContext) {
        void restore();
        disposers.push(folium.events.on('playback.songChanged', onSongChanged));
        disposers.push(folium.events.on('theme.changed', (event) => {
            captureTheme(event && event.theme);
            pushObs();
        }));
        pollTimer = setInterval(() => {
            void poll();
        }, 600);
        // 确保 main 侧 OBS 页面服务在运行，并做一次初始推送。
        folium.rpc.call('obsStatus').catch(() => {});
        notify();
        // 设置面板里改 OBS 叠加层参数时实时推给展示页。
        disposers.push(settingsSection.params.subscribe(() => pushObs()));
        // 每秒：降级链模式跑队列守卫；播放中刷新 OBS 进度快照。
        livePushTimer = setInterval(() => {
            try {
                if (state.mode === 'chain') {
                    guardQueue();
                }
                if (folium.playback.getState().state === 'playing') {
                    pushObs();
                }
            } catch (_err) {
                // 播放服务不可用时跳过
            }
        }, 1000);

        const values = settingsSection.params.get();
        if (values.autoConnect && String(values.roomId || '').trim()) {
            void runConnect().catch((error) => folium.log.warn('auto connect failed:', error));
        }
    }

    return () => {
        if (pollTimer) clearInterval(pollTimer);
        if (livePushTimer) clearInterval(livePushTimer);
        if (persistTimer) clearTimeout(persistTimer);
        if (obsPushTimer) clearTimeout(obsPushTimer);
        disposers.forEach((dispose) => {
            try {
                dispose();
            } catch (_err) {
                // ignore
            }
        });
        listeners.clear();
        if (isMainContext) {
            folium.rpc.call('stop').catch(() => {
                // main 侧可能已在停用
            });
        }
    };
}
