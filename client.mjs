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
        lastDanmu: null,             // { text, uname, matched, ts }
        lastResult: null,            // { uname, keyword, title?, status, ts }
        currentIsViewerRequest: false,
    };

    const listeners = new Set();
    const notify = () => {
        listeners.forEach((listener) => {
            try {
                listener();
            } catch (_err) {
                // 单个面板渲染失败不影响其他订阅者
            }
        });
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
        try {
            const queueStatus = await folium.rpc.call('stage', { op: 'queueStatus' });
            const items = queueStatus?.data?.queue?.items || [];
            const match = items.find((entry) => Number(entry.id) === item.songId);
            if (match && match.queueItemId) {
                await folium.rpc.call('stage', { op: 'queue', action: 'remove', queueItemId: match.queueItemId });
            }
        } catch (error) {
            folium.log.warn('remove request from queue failed:', error);
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
                { value: 'play', label: { 'zh-CN': '立即播放', en: 'Play now' } },
                { value: 'queue', label: { 'zh-CN': '加入队列', en: 'Append to queue' } },
            ], group: { 'zh-CN': '播放', en: 'Playback' } },
            { key: 'skipIdlePlaylist', type: 'boolean', defaultValue: true, label: { 'zh-CN': '空闲歌单让位', en: 'Skip idle playlist' }, description: { 'zh-CN': '无点歌排队时，新请求立即打断歌单歌曲', en: 'With no pending requests, a new request interrupts idle playlist songs' }, group: { 'zh-CN': '播放', en: 'Playback' } },
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
    // ------------------------------------------------------------------

    const stageSearch = async (query, limit) => {
        const result = await folium.rpc.call('stage', { op: 'search', query, limit });
        if (!result || !result.ok) {
            throw new Error(result?.error || 'Stage search failed');
        }
        const songs = result.data?.songs || [];
        return songs.filter((song) => Number.isInteger(song.songId) && song.songId > 0);
    };

    const stagePlayNow = async (songId, remainingSongIds) => {
        const result = await folium.rpc.call('stage', { op: 'play', songId, appendToQueue: false });
        if (!result || !result.ok) {
            throw new Error(result?.error || 'Stage play failed');
        }
        // 立即播放会把队列替换为这一首；把其余待播请求重新接回队尾。
        if (remainingSongIds.length > 0) {
            try {
                await folium.rpc.call('stage', { op: 'queue', action: 'append', songIds: remainingSongIds });
            } catch (error) {
                folium.log.warn('re-append pending requests failed:', error);
            }
        }
    };

    const stageAppend = async (songId) => {
        const result = await folium.rpc.call('stage', { op: 'queue', action: 'append', songIds: [songId] });
        if (!result || !result.ok) {
            throw new Error(result?.error || 'Stage queue append failed');
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
        const wantPlayNow = values.playMode === 'play'
            || !hasCurrent
            || (values.skipIdlePlaylist
                && !state.currentIsViewerRequest
                && state.requests.length === 0);

        let applied = null;
        let lastError = null;
        for (const candidate of candidates.slice(0, 3)) {
            if (isSongAlreadyActive(candidate.songId)) {
                setLastResult(uname, keyword, 'error', candidate.title);
                toast(L(`「${candidate.title}」已在播放或排队`, `"${candidate.title}" is already playing or queued`), 'info');
                return;
            }
            try {
                if (wantPlayNow) {
                    const remaining = state.requests
                        .filter((item) => item.status !== 'playing' && item.songId !== candidate.songId)
                        .map((item) => item.songId);
                    await stagePlayNow(candidate.songId, remaining);
                } else {
                    await stageAppend(candidate.songId);
                }
                applied = candidate;
                break;
            } catch (error) {
                lastError = error;
                folium.log.warn('apply candidate failed:', candidate.songId, error);
            }
        }

        if (!applied) {
            setLastResult(uname, keyword, 'error');
            toast(L(`点歌入队失败：${lastError ? lastError.message : '未知错误'}`, `Song request failed: ${lastError ? lastError.message : 'unknown error'}`), 'error');
            return;
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
            try {
                folium.playback.next();
                if (current) {
                    state.requests = state.requests.filter((item) => item.id !== current.id);
                }
                state.currentIsViewerRequest = false;
                setLastResult(danmu.uname, '切歌', 'skipped', current?.title);
                notify();
                persistSoon();
            } catch (error) {
                folium.log.warn('skip failed:', error);
            }
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
        const songId = event?.song?.id ? Number(event.song.id) : null;
        if (songId === null) {
            state.currentIsViewerRequest = false;
            return;
        }
        const index = state.requests.findIndex((item) => item.songId === songId);
        if (index >= 0) {
            // 匹配到的请求开始播放；位于它之前的请求都已唱完，移除。
            state.requests = state.requests
                .slice(index)
                .map((item, i) => ({ ...item, status: i === 0 ? 'playing' : 'queued' }));
            state.currentIsViewerRequest = true;
        } else {
            state.currentIsViewerRequest = false;
            // 上一首播完（换成了非点歌歌曲）时，清掉已完成的请求。
            state.requests = state.requests.filter((item) => item.status !== 'playing');
        }
        notify();
        persistSoon();
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
                try {
                    folium.playback.next();
                } catch (error) {
                    folium.log.warn('skip failed:', error);
                }
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
                const rows = [...playing, ...queued.map((item, index) => ({ item, number: index + 1 }))];

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
            const unsubscribeTheme = ctx.subscribe(() => applyTheme(ctx.getTheme()));
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
    if (isMainContext) {
        void restore();
        disposers.push(folium.events.on('playback.songChanged', onSongChanged));
        pollTimer = setInterval(() => {
            void poll();
        }, 600);

        const values = settingsSection.params.get();
        if (values.autoConnect && String(values.roomId || '').trim()) {
            void runConnect().catch((error) => folium.log.warn('auto connect failed:', error));
        }
    }

    return () => {
        if (pollTimer) clearInterval(pollTimer);
        if (persistTimer) clearTimeout(persistTimer);
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
