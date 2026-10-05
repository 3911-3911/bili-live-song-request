// mods/bili-live-song-request/index.cjs
//
// B站直播弹幕点歌 — main 入口（Node，运行在 Electron 主进程）。
//
// 职责：
//   1. B站连接：buvid3 / WBI 签名 / 房间号解析 / getDanmuInfo / 弹幕 WebSocket
//      （认证、心跳、brotli/zlib 帧解压、DANMU_MSG 解析、匿名用户 CRC32 反查）。
//      —— 移植自分支版 electron/biliLiveApi.cjs，把 `ws` 依赖换成手写的
//      RFC6455 最小客户端（node:tls），`protobufjs` 换成手写的 dm_v2 解码器，
//      使模组目录零第三方依赖。
//   2. Stage API 桥：读取 userData/config.json 里的 token 与端口，代理
//      /stage/player/search|play|queue 请求，让 client 通过 rpc 驱动宿主播放。
//   3. 事件队列：连接状态与弹幕事件入队，由 client 轮询取走。
//
// 指令解析、权限、队列语义都在 client（见 client.mjs）；这里只做网络与身份。

'use strict';

const tls = require('node:tls');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const BILI_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BILI_ORIGIN = 'https://live.bilibili.com';
const BILI_HOME = 'https://www.bilibili.com/';

const FULL_HEADERS = {
    'User-Agent': BILI_USER_AGENT,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Origin': BILI_ORIGIN,
    'Referer': BILI_ORIGIN + '/',
    'sec-fetch-site': 'same-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
};

const HEADER_SIZE = 16;
const OP_HEARTBEAT = 2;
const OP_MESSAGE = 5;
const OP_AUTH = 7;
const OP_AUTH_REPLY = 8;
const PROTO_ZLIB = 2;
const PROTO_BROTLI = 3;
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 30_000;
const MAX_QUEUED_EVENTS = 400;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const log = (...args) => {
    try {
        console.log('[BiliLiveMod]', ...args);
    } catch (_err) {
        // ignore
    }
};

const fetchText = async (url, { headers = {} } = {}) => {
    const res = await fetch(url, { headers: { ...FULL_HEADERS, ...headers } });
    if (!res.ok) {
        throw new Error(`Bilibili request failed (${res.status})`);
    }
    return res;
};

const fetchJson = async (url, { headers = {} } = {}) => {
    const res = await fetchText(url, { headers });
    return res.json();
};

// ---------------------------------------------------------------------------
// WBI 签名（https://github.com/SocialSisterYi/bilibili-API-collect）
// ---------------------------------------------------------------------------

const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 36, 25, 24, 11, 44, 26, 4, 20, 48, 40, 30, 6, 51, 16, 55,
    7, 52, 1, 22, 21, 34, 17, 57, 59, 0, 56, 54, 60, 61, 63, 62,
];

const md5 = (value) => crypto.createHash('md5').update(value, 'utf8').digest('hex');

const getMixinKey = (orig) => {
    let out = '';
    for (let i = 0; i < 32; i += 1) {
        out += orig.charAt(MIXIN_KEY_ENC_TAB[i]);
    }
    return out;
};

const encodeWbi = (params, imgKey, subKey) => {
    const mixinKey = getMixinKey(imgKey + subKey);
    const wts = Math.floor(Date.now() / 1000);
    const all = { ...params, wts };
    const filterValue = (v) => String(v).replace(/[!'()*]/g, '');
    const query = Object.keys(all)
        .sort()
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(filterValue(all[k]))}`)
        .join('&');
    return `${query}&w_rid=${md5(query + mixinKey)}`;
};

let cachedBuvid3 = '';
let wbiKeys = null; // { imgKey, subKey }

// 服务器在访问首页时下发的 buvid3 比 finger/spi 的值更容易通过弹幕风控。
const ensureBuvid3 = async () => {
    if (cachedBuvid3) {
        return cachedBuvid3;
    }
    try {
        const res = await fetch(BILI_HOME, { headers: { 'User-Agent': BILI_USER_AGENT } });
        const setCookies = typeof res.headers.getSetCookie === 'function'
            ? res.headers.getSetCookie()
            : [];
        for (const cookie of setCookies) {
            const match = cookie.match(/buvid3=([^;]+)/);
            if (match) {
                cachedBuvid3 = match[1];
                log('obtained server buvid3:', cachedBuvid3.slice(0, 12) + '...');
                return cachedBuvid3;
            }
        }
    } catch (error) {
        log('failed to obtain server buvid3:', error.message);
    }
    try {
        const data = await fetchJson('https://api.bilibili.com/x/frontend/finger/spi', { headers: {} });
        if (data && data.data && data.data.b_3) {
            cachedBuvid3 = data.data.b_3;
            return cachedBuvid3;
        }
    } catch (_err) {
        // ignore
    }
    return '';
};

const ensureWbiKeys = async (cookie) => {
    if (wbiKeys) {
        return wbiKeys;
    }
    const data = await fetchJson('https://api.bilibili.com/x/web-interface/nav', {
        headers: cookie ? { Cookie: cookie } : {},
    });
    const wbiImg = data && data.data && data.data.wbi_img;
    if (!wbiImg || !wbiImg.img_url || !wbiImg.sub_url) {
        throw new Error('Failed to fetch Bilibili WBI keys.');
    }
    const imgKey = wbiImg.img_url.slice(wbiImg.img_url.lastIndexOf('/') + 1).split('.')[0];
    const subKey = wbiImg.sub_url.slice(wbiImg.sub_url.lastIndexOf('/') + 1).split('.')[0];
    wbiKeys = { imgKey, subKey };
    return wbiKeys;
};

const buildCookie = (sessdata, buvid3) => {
    const parts = [];
    if (buvid3) parts.push(`buvid3=${buvid3}`);
    if (sessdata) parts.push(`SESSDATA=${sessdata}`);
    return parts.join('; ');
};

// ---------------------------------------------------------------------------
// 房间与弹幕服务器解析
// ---------------------------------------------------------------------------

// 短号先经 room_init 解析成真实房间号；短号连接即使认证成功也收不到真实房间的消息。
const resolveRoomInfo = async (roomId) => {
    const encodedRoomId = encodeURIComponent(roomId);
    try {
        const data = await fetchJson(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodedRoomId}`);
        const resolvedRoomId = Number(data && data.data && data.data.room_id);
        if (data && data.code === 0 && Number.isSafeInteger(resolvedRoomId) && resolvedRoomId > 0) {
            const anchorUid = Number(data.data.uid) || 0;
            return { realRoomId: resolvedRoomId, anchorUid };
        }
    } catch (error) {
        log('room_init resolve failed, falling back to live page:', error.message);
    }
    try {
        const res = await fetchText(`${BILI_ORIGIN}/${encodedRoomId}`, {
            headers: { Referer: `${BILI_ORIGIN}/${roomId}`, 'User-Agent': BILI_USER_AGENT },
        });
        const html = await res.text();
        const match = html.match(/"room_id"\s*:\s*(\d+)/);
        if (match) {
            return { realRoomId: Number(match[1]), anchorUid: 0 };
        }
    } catch (error) {
        log('live-page room resolve failed, falling back to input:', error.message);
    }
    const asNumber = Number(roomId);
    return { realRoomId: Number.isFinite(asNumber) ? asNumber : roomId, anchorUid: 0 };
};

const resolveUid = async (cookie) => {
    if (!cookie) return 0;
    try {
        const data = await fetchJson('https://api.bilibili.com/x/web-interface/nav', {
            headers: { Cookie: cookie },
        });
        if (data && data.code === 0 && data.data && data.data.isLogin) {
            return data.data.mid || 0;
        }
    } catch (_err) {
        // 未登录 — 匿名 (uid 0)
    }
    return 0;
};

const getDanmuInfo = async (realRoomId, cookie) => {
    await ensureWbiKeys(cookie);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const query = encodeWbi({ id: realRoomId, type: 0 }, wbiKeys.imgKey, wbiKeys.subKey);
        const url = `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`;
        const data = await fetchJson(url, { headers: { Cookie: cookie } });
        if (data && data.code === 0 && data.data) {
            const host = data.data.host_list && data.data.host_list[0];
            if (!host) {
                throw new Error('No Bilibili danmu host available.');
            }
            const port = host.wss_port || 443;
            const wssUrl = port === 443 ? `wss://${host.host}/sub` : `wss://${host.host}:${port}/sub`;
            return { token: data.data.token || '', wssUrl };
        }
        // -352 = 风控 / WBI 签名错误：刷新密钥后重试一次。
        if (data && data.code === -352) {
            log('getDanmuInfo -352, refreshing WBI keys (attempt', attempt + 1, ')');
            wbiKeys = null;
            try {
                await ensureWbiKeys(cookie);
            } catch (_err) {
                // 下一轮循环会暴露错误
            }
            continue;
        }
        throw new Error((data && data.message) || `getDanmuInfo failed (code ${data && data.code})`);
    }
    throw new Error('B站风控校验失败 (-352)。请在模组设置中填入 SESSDATA（登录 Cookie）后重试。');
};

const resolveDanmu = async (roomId, sessdata) => {
    const trimmedRoom = String(roomId || '').trim();
    const trimmedSessdata = (sessdata && String(sessdata).trim()) || '';
    if (!trimmedRoom) {
        throw new Error('Room id is required.');
    }

    const buvid3 = await ensureBuvid3();
    const cookie = buildCookie(trimmedSessdata, buvid3);
    const { realRoomId, anchorUid } = await resolveRoomInfo(trimmedRoom);
    const uid = await resolveUid(cookie);
    log(`resolved room ${trimmedRoom} -> real ${realRoomId}, uid ${uid}`);
    const { token, wssUrl } = await getDanmuInfo(realRoomId, cookie);
    log('getDanmuInfo ok, token length', token.length);
    return { wssUrl, token, uid, realRoomId, anchorUid, buvid: buvid3 };
};

// ---------------------------------------------------------------------------
// dm_v2 protobuf（手写最小解码器，替代 protobufjs）
// ---------------------------------------------------------------------------

// 只解码 Folia 需要的字段：
//   Dm    { 5: midHash(string), 6: content(string), 20: user(User) }
//   User  { 1: uid(varint), 2: name(string), 11: medal(Medal) }
//   Medal { 1: level(varint), 2: name(string), 9: privilege(varint) }
const decodeDmV2Message = (buf) => {
    const readVarint = (offset) => {
        let value = 0;
        let shift = 0;
        for (;;) {
            if (offset >= buf.length) throw new Error('varint out of range');
            const byte = buf[offset];
            offset += 1;
            value += (byte & 0x7f) * Math.pow(2, shift);
            if ((byte & 0x80) === 0) return [value, offset];
            shift += 7;
            if (shift > 63) throw new Error('varint too long');
        }
    };

    const fields = [];
    let offset = 0;
    while (offset < buf.length) {
        let tag;
        [tag, offset] = readVarint(offset);
        const fieldNumber = Math.floor(tag / 8);
        const wireType = tag % 8;
        if (wireType === 0) {
            let value;
            [value, offset] = readVarint(offset);
            fields.push({ fieldNumber, value });
        } else if (wireType === 2) {
            let length;
            [length, offset] = readVarint(offset);
            if (offset + length > buf.length) throw new Error('length-delimited out of range');
            fields.push({ fieldNumber, bytes: buf.subarray(offset, offset + length) });
            offset += length;
        } else if (wireType === 5) {
            if (offset + 4 > buf.length) throw new Error('fixed32 out of range');
            fields.push({ fieldNumber, bytes: buf.subarray(offset, offset + 4) });
            offset += 4;
        } else if (wireType === 1) {
            if (offset + 8 > buf.length) throw new Error('fixed64 out of range');
            fields.push({ fieldNumber, bytes: buf.subarray(offset, offset + 8) });
            offset += 8;
        } else {
            throw new Error(`unsupported wire type ${wireType}`);
        }
    }
    return fields;
};

const decodeDmV2 = (base64Payload) => {
    if (typeof base64Payload !== 'string' || !base64Payload.trim()) return null;
    try {
        const buf = Buffer.from(base64Payload, 'base64');
        const dmFields = decodeDmV2Message(buf);

        const pick = (fields, fieldNumber) => fields.filter((field) => field.fieldNumber === fieldNumber);
        const pickVarint = (fields, fieldNumber) => {
            const entry = pick(fields, fieldNumber).find((field) => field.value !== undefined);
            return entry ? Number(entry.value) : undefined;
        };
        const pickString = (fields, fieldNumber) => {
            const entry = pick(fields, fieldNumber).find((field) => field.bytes !== undefined);
            return entry ? entry.bytes.toString('utf8') : undefined;
        };

        const userFieldsBytes = pick(dmFields, 20).find((field) => field.bytes !== undefined);
        const userFields = userFieldsBytes ? decodeDmV2Message(userFieldsBytes.bytes) : [];

        const medalFieldsBytes = pick(userFields, 11).find((field) => field.bytes !== undefined);
        const medalFields = medalFieldsBytes ? decodeDmV2Message(medalFieldsBytes.bytes) : [];

        return {
            content: pickString(dmFields, 6) ?? '',
            userHash: pickString(dmFields, 5) ?? '',
            uid: pickVarint(userFields, 1) || 0,
            uname: (pickString(userFields, 2) ?? '').trim(),
            guardLevel: pickVarint(medalFields, 9) || 0,
            medalName: (pickString(medalFields, 2) ?? '').trim(),
            medalLevel: pickVarint(medalFields, 1) || 0,
        };
    } catch (_error) {
        return null;
    }
};

// ---------------------------------------------------------------------------
// 匿名用户 CRC32 反查（uid 哈希 -> 卡片名）
// ---------------------------------------------------------------------------

const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    return crc >>> 0;
});
const CRC32_INDEX_BY_TOP_BYTE = new Uint16Array(256);
CRC32_TABLE.forEach((value, index) => {
    CRC32_INDEX_BY_TOP_BYTE[value >>> 24] = index;
});

const updateCrc32State = (state, charCode) => (
    ((state >>> 8) ^ CRC32_TABLE[(state ^ charCode) & 0xff]) >>> 0
);

const reverseCrc32Digit = (nextState, charCode) => {
    const tableIndex = CRC32_INDEX_BY_TOP_BYTE[nextState >>> 24];
    const shiftedState = (nextState ^ CRC32_TABLE[tableIndex]) >>> 0;
    if ((shiftedState >>> 24) !== 0) return null;
    const previousState = ((shiftedState << 8) | (tableIndex ^ charCode)) >>> 0;
    return updateCrc32State(previousState, charCode) === nextState ? previousState : null;
};

// 折半搜索反推 CRC32 哈希对应的十进制 UID 候选；多个 UID 可能碰撞，调用方需逐个验证。
const crackBiliUidHashCandidates = (hash) => {
    if (!/^[0-9a-f]{8}$/i.test(hash)) return [];
    const targetState = (Number.parseInt(hash, 16) ^ 0xffffffff) >>> 0;
    const candidates = [];

    for (let length = 1; length <= 10; length += 1) {
        const prefixLength = Math.ceil(length / 2);
        const suffixLength = length - prefixLength;
        const prefixesByState = new Map();
        const prefixStart = prefixLength === 1 ? 1 : 10 ** (prefixLength - 1);
        const prefixEnd = 10 ** prefixLength;

        for (let value = prefixStart; value < prefixEnd; value += 1) {
            const prefix = String(value);
            let state = 0xffffffff;
            for (const char of prefix) {
                state = updateCrc32State(state, char.charCodeAt(0));
            }
            const prefixes = prefixesByState.get(state);
            if (prefixes) prefixes.push(prefix);
            else prefixesByState.set(state, [prefix]);
        }

        const suffixEnd = 10 ** suffixLength;
        for (let value = 0; value < suffixEnd; value += 1) {
            const suffix = suffixLength ? String(value).padStart(suffixLength, '0') : '';
            let state = targetState;
            for (let index = suffix.length - 1; index >= 0 && state !== null; index -= 1) {
                state = reverseCrc32Digit(state, suffix.charCodeAt(index));
            }
            if (state === null) continue;
            const prefixes = prefixesByState.get(state) || [];
            prefixes.forEach((prefix) => candidates.push(prefix + suffix));
        }
    }
    return candidates;
};

const matchesMaskedBiliName = (name, maskedName) => {
    if (!maskedName.includes('*')) return name === maskedName;
    const escapedParts = maskedName
        .split(/\*+/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`^${escapedParts.join('.*')}$`, 'u').test(name);
};

const biliUserNameCache = new Map();
const biliUserNameRequests = new Map();
const biliAnonymousUserCache = new Map();
const biliAnonymousUserRequests = new Map();

const resolveBiliUserCardName = async (uid) => {
    const cached = biliUserNameCache.get(uid);
    if (cached) return cached;

    let request = biliUserNameRequests.get(uid);
    if (!request) {
        request = fetchJson(`https://api.bilibili.com/x/web-interface/card?mid=${uid}`, {
            headers: { Referer: `${BILI_ORIGIN}/` },
        }).then((data) => {
            const name = data?.code === 0 && typeof data.data?.card?.name === 'string'
                ? data.data.card.name.trim()
                : '';
            if (name) biliUserNameCache.set(uid, name);
            return name;
        }).catch((error) => {
            log('user card lookup failed for uid', uid, error.message);
            return '';
        }).finally(() => {
            biliUserNameRequests.delete(uid);
        });
        biliUserNameRequests.set(uid, request);
    }
    return request;
};

// 匿名 DANMU_MSG 的 uid=0 但保留 CRC32(真实 uid)；解出全部碰撞候选后
// 用卡片名与打码昵称匹配，选出真实身份。
const resolveBiliDanmuUser = async (uid, userHash, fallbackName) => {
    if (Number.isSafeInteger(uid) && uid > 0) {
        const resolvedName = /\*{2,}/.test(fallbackName)
            ? await resolveBiliUserCardName(uid)
            : fallbackName;
        return { uid, name: resolvedName || fallbackName };
    }
    if (!/^[0-9a-f]{8}$/i.test(userHash) || !/\*{2,}/.test(fallbackName)) {
        return { uid: 0, name: fallbackName };
    }

    const normalizedHash = userHash.toLowerCase();
    const cached = biliAnonymousUserCache.get(normalizedHash);
    if (cached) return cached;

    let request = biliAnonymousUserRequests.get(normalizedHash);
    if (!request) {
        request = (async () => {
            const candidates = crackBiliUidHashCandidates(normalizedHash);
            for (const candidate of candidates) {
                const candidateUid = Number(candidate);
                if (!Number.isSafeInteger(candidateUid) || candidateUid <= 0) continue;
                const name = await resolveBiliUserCardName(candidateUid);
                if (name && matchesMaskedBiliName(name, fallbackName)) {
                    const identity = { uid: candidateUid, name };
                    biliAnonymousUserCache.set(normalizedHash, identity);
                    return identity;
                }
            }
            return { uid: 0, name: fallbackName };
        })().finally(() => {
            biliAnonymousUserRequests.delete(normalizedHash);
        });
        biliAnonymousUserRequests.set(normalizedHash, request);
    }
    return request;
};

// ---------------------------------------------------------------------------
// 弹幕载荷字段提取（新旧行混用）
// ---------------------------------------------------------------------------

const parseDanmuObject = (value) => {
    let payload = value;
    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch (_err) {
            return null;
        }
    }
    return payload && typeof payload === 'object' ? payload : null;
};

const readDanmuUserName = (value) => {
    const payload = parseDanmuObject(value);
    if (!payload) return '';

    const candidates = [
        payload.user?.base?.name,
        payload.user?.name,
        payload.base?.name,
        payload.uname,
        payload.user_name,
    ];
    const names = candidates
        .filter((candidate) => typeof candidate === 'string' && candidate.trim())
        .map((candidate) => candidate.trim());
    const nestedName = payload.extra !== undefined ? readDanmuUserName(payload.extra) : '';
    return names.find((name) => !/\*{2,}/.test(name)) || nestedName || names[0] || '';
};

const readDanmuUserId = (value) => {
    const payload = parseDanmuObject(value);
    if (!payload) return 0;
    const candidates = [
        payload.user?.base?.uid,
        payload.user?.uid,
        payload.base?.uid,
        payload.uid,
        payload.mid,
    ];
    const uid = candidates
        .map((candidate) => Number(candidate))
        .find((candidate) => Number.isSafeInteger(candidate) && candidate > 0);
    return uid || (payload.extra !== undefined ? readDanmuUserId(payload.extra) : 0);
};

const readDanmuUserHash = (value) => {
    const payload = parseDanmuObject(value);
    if (!payload) return '';
    const candidates = [
        payload.user_hash,
        payload.userHash,
        payload.mid_hash,
        payload.midHash,
        payload.user?.base?.user_hash,
        payload.user?.base?.userHash,
        payload.user?.user_hash,
        payload.user?.userHash,
    ];
    const hash = candidates.find((candidate) => typeof candidate === 'string' && /^[0-9a-f]{8}$/i.test(candidate.trim()));
    return hash?.trim() || (payload.extra !== undefined ? readDanmuUserHash(payload.extra) : '');
};

// 新版匿名包把可恢复的 user hash（有时连同 UID）从旧数组挪进了 info[0][15].extra。
const extractDanmuUserName = (parsed, info) => {
    const infoExtension = Array.isArray(info[0]) ? info[0][15] : undefined;
    const extensionName = readDanmuUserName(infoExtension)
        || readDanmuUserName(parsed.data)
        || readDanmuUserName(parsed);
    if (extensionName) return extensionName;

    return Array.isArray(info[2]) && typeof info[2][1] === 'string'
        ? info[2][1]
        : '';
};

const extractDanmuExtendedIdentity = (parsed, info) => {
    const infoExtension = Array.isArray(info[0]) ? info[0][15] : undefined;
    const sources = [infoExtension, parsed.data, parsed];
    return {
        uid: sources.map(readDanmuUserId).find((uid) => uid > 0) || 0,
        userHash: sources.map(readDanmuUserHash).find(Boolean) || '',
    };
};

const extractDanmuPrivileges = (parsed, info, dmV2) => {
    const legacyMedal = Array.isArray(info[3]) ? info[3] : [];
    const data = parsed && typeof parsed.data === 'object' ? parsed.data : {};
    const user = data && typeof data.user === 'object' ? data.user : {};
    const medal = user.medal || user.fans_medal || data.fans_medal || data.medal || {};
    const guardLevel = Number(
        dmV2?.guardLevel
        ?? user.guard_level
        ?? user.guard?.level
        ?? data.guard_level
        ?? legacyMedal[10]
        ?? 0,
    ) || 0;
    const medalName = String(dmV2?.medalName ?? medal.name ?? medal.medal_name ?? legacyMedal[1] ?? '').trim();
    const medalLevel = Number(dmV2?.medalLevel ?? medal.level ?? medal.medal_level ?? legacyMedal[0] ?? 0) || 0;
    return { guardLevel, medalName, medalLevel };
};

// ---------------------------------------------------------------------------
// 手写 WebSocket 客户端（RFC6455 最小实现，wss via node:tls）
// ---------------------------------------------------------------------------

class MiniWebSocket {
    constructor(url, { headers = {}, onOpen, onMessage, onClose, onError } = {}) {
        this.url = new URL(url);
        this.extraHeaders = headers;
        this.onOpen = onOpen || (() => {});
        this.onMessage = onMessage || (() => {});
        this.onClose = onClose || (() => {});
        this.onError = onError || (() => {});

        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.upgraded = false;
        this.closed = false;
        this.fragmentOpcode = -1;
        this.fragmentParts = [];
    }

    connect() {
        const port = Number(this.url.port) || 443;
        const key = crypto.randomBytes(16).toString('base64');
        const socket = tls.connect(
            { host: this.url.hostname, port, servername: this.url.hostname },
            () => {
                const target = this.url.pathname + this.url.search;
                const headerLines = [
                    `GET ${target} HTTP/1.1`,
                    `Host: ${this.url.hostname}:${port}`,
                    'Upgrade: websocket',
                    'Connection: Upgrade',
                    `Sec-WebSocket-Key: ${key}`,
                    'Sec-WebSocket-Version: 13',
                ];
                for (const [name, value] of Object.entries(this.extraHeaders)) {
                    headerLines.push(`${name}: ${value}`);
                }
                headerLines.push('', '');
                socket.write(headerLines.join('\r\n'));
            },
        );
        this.socket = socket;

        socket.on('data', (chunk) => this.handleData(chunk));
        socket.on('error', (error) => {
            if (this.closed) return;
            this.onError(error);
        });
        socket.on('close', () => {
            if (this.closed) return;
            this.closed = true;
            this.onClose();
        });
        socket.on('end', () => {
            if (this.closed) return;
            this.closed = true;
            this.onClose();
        });
    }

    handleData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!this.upgraded) {
            const headerEnd = this.buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) return;
            const head = this.buffer.subarray(0, headerEnd).toString('utf8');
            this.buffer = this.buffer.subarray(headerEnd + 4);
            if (!/^HTTP\/1\.1 101/.test(head)) {
                this.closed = true;
                try {
                    this.socket.destroy();
                } catch (_err) {
                    // ignore
                }
                this.onError(new Error(`WebSocket upgrade failed: ${head.split('\r\n')[0]}`));
                this.onClose();
                return;
            }
            this.upgraded = true;
            this.onOpen();
        }
        this.parseFrames();
    }

    parseFrames() {
        for (;;) {
            const frame = this.readFrame();
            if (!frame) return;
            const { opcode, fin, payload } = frame;

            if (opcode === 0x8) {
                this.closed = true;
                try {
                    this.socket.end(this.buildFrame(0x8, Buffer.alloc(0)));
                } catch (_err) {
                    // ignore
                }
                this.onClose();
                return;
            }
            if (opcode === 0x9) {
                this.sendRaw(0xA, payload);
                continue;
            }
            if (opcode === 0xA) continue;

            if (!fin) {
                if (opcode !== 0) this.fragmentOpcode = opcode;
                this.fragmentParts.push(payload);
                continue;
            }
            if (opcode === 0) {
                this.fragmentParts.push(payload);
                const whole = Buffer.concat(this.fragmentParts);
                const wholeOpcode = this.fragmentOpcode;
                this.fragmentParts = [];
                this.fragmentOpcode = -1;
                this.onMessage(wholeOpcode === 0x1 ? whole.toString('utf8') : whole);
                continue;
            }
            this.onMessage(opcode === 0x1 ? payload.toString('utf8') : payload);
        }
    }

    readFrame() {
        const buf = this.buffer;
        if (buf.length < 2) return null;
        const first = buf[0];
        const second = buf[1];
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;

        if (length === 126) {
            if (buf.length < offset + 2) return null;
            length = buf.readUInt16BE(offset);
            offset += 2;
        } else if (length === 127) {
            if (buf.length < offset + 8) return null;
            const high = buf.readUInt32BE(offset);
            const low = buf.readUInt32BE(offset + 4);
            length = high * 0x100000000 + low;
            offset += 8;
        }

        let maskKey = null;
        if (masked) {
            if (buf.length < offset + 4) return null;
            maskKey = buf.subarray(offset, offset + 4);
            offset += 4;
        }
        if (buf.length < offset + length) return null;

        let payload = buf.subarray(offset, offset + length);
        if (maskKey) {
            const unmasked = Buffer.allocUnsafe(length);
            for (let i = 0; i < length; i += 1) {
                unmasked[i] = payload[i] ^ maskKey[i & 3];
            }
            payload = unmasked;
        }
        this.buffer = buf.subarray(offset + length);
        return { fin, opcode, payload };
    }

    buildFrame(opcode, payload) {
        const mask = crypto.randomBytes(4);
        const masked = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i += 1) {
            masked[i] = payload[i] ^ mask[i & 3];
        }

        let header;
        if (payload.length < 126) {
            header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
        } else if (payload.length < 0x10000) {
            header = Buffer.alloc(4);
            header[0] = 0x80 | opcode;
            header[1] = 0x80 | 126;
            header.writeUInt16BE(payload.length, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x80 | opcode;
            header[1] = 0x80 | 127;
            header.writeUInt32BE(Math.floor(payload.length / 0x100000000), 2);
            header.writeUInt32BE(payload.length >>> 0, 6);
        }
        return Buffer.concat([header, mask, masked]);
    }

    sendRaw(opcode, payload) {
        if (!this.socket || this.closed) return;
        try {
            this.socket.write(this.buildFrame(opcode, payload));
        } catch (error) {
            this.onError(error);
        }
    }

    sendText(text) {
        this.sendRaw(0x1, Buffer.from(text, 'utf8'));
    }

    sendBinary(buf) {
        this.sendRaw(0x2, buf);
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        try {
            this.socket.end(this.buildFrame(0x8, Buffer.alloc(0)));
        } catch (_err) {
            // ignore
        }
        try {
            this.socket.destroy();
        } catch (_err) {
            // ignore
        }
    }
}

// ---------------------------------------------------------------------------
// 弹幕控制器
// ---------------------------------------------------------------------------

const buildPacket = (op, bodyStr) => {
    const body = Buffer.from(bodyStr || '', 'utf8');
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32BE(HEADER_SIZE + body.length, 0);
    header.writeUInt16BE(HEADER_SIZE, 4);
    header.writeUInt16BE(1, 6);
    header.writeUInt32BE(op, 8);
    header.writeUInt32BE(1, 12);
    return Buffer.concat([header, body]);
};

class BiliLiveDanmuController {
    constructor(emit) {
        this.emit = emit;
        this.ws = null;
        this.heartbeatTimer = null;
        this.reconnectTimer = null;
        this.running = false;
        this.roomId = '';
        this.sessdata = '';
        this.realRoomId = '';
        this.anchorUid = 0;
        this.attempt = 0;
        this.seenCmds = new Set();
        this.status = 'idle';
        this.detail = '';
    }

    setStatus(status, detail = '') {
        this.status = status;
        this.detail = detail;
        this.emit({ type: 'status', status, detail });
    }

    async start({ roomId, sessdata } = {}) {
        this.stopInternal();
        this.roomId = roomId;
        this.sessdata = sessdata;
        this.running = true;
        this.attempt = 0;
        await this.connect();
    }

    stop() {
        this.running = false;
        this.stopInternal();
        this.setStatus('idle');
    }

    stopInternal() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.clearHeartbeat();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    scheduleReconnect() {
        if (!this.running) return;
        this.attempt += 1;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.attempt - 1), RECONNECT_MAX_MS);
        this.setStatus('reconnecting', `retry in ${Math.round(delay / 1000)}s`);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
        }, delay);
    }

    async connect() {
        if (!this.running) return;

        this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

        let connInfo;
        try {
            connInfo = await resolveDanmu(this.roomId, this.sessdata);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log('resolve failed:', message);
            this.setStatus('error', message);
            this.scheduleReconnect();
            return;
        }

        if (!this.running) return;
        this.realRoomId = connInfo.realRoomId;
        this.anchorUid = connInfo.anchorUid;

        const ws = new MiniWebSocket(connInfo.wssUrl, {
            headers: { Origin: BILI_ORIGIN, 'User-Agent': BILI_USER_AGENT },
            onOpen: () => {
                if (!this.running || this.ws !== ws) return;
                this.sendAuth(connInfo.token, connInfo.uid, connInfo.buvid);
                // 认证后立刻发一次心跳，否则 B站可能停止推送聊天帧。
                ws.sendBinary(buildPacket(OP_HEARTBEAT, '[object Object]'));
                this.startHeartbeat();
            },
            onMessage: (data) => {
                if (this.ws !== ws) return;
                try {
                    this.parseFrames(Buffer.isBuffer(data) ? data : Buffer.from(data));
                } catch (error) {
                    log('frame parse error:', error.message);
                }
            },
            onError: (error) => {
                if (this.ws !== ws) return;
                log('ws error:', error.message);
            },
            onClose: () => {
                if (this.ws !== ws) return;
                log('ws closed');
                this.clearHeartbeat();
                this.ws = null;
                if (this.running) {
                    this.scheduleReconnect();
                }
            },
        });
        this.ws = ws;
        ws.connect();
    }

    sendAuth(token, uid, buvid) {
        if (!this.ws) return;
        const body = JSON.stringify({
            uid,
            roomid: this.realRoomId,
            protover: PROTO_BROTLI,
            buvid: buvid || '',
            platform: 'web',
            type: 2,
            key: token,
        });
        this.ws.sendBinary(buildPacket(OP_AUTH, body));
    }

    startHeartbeat() {
        this.clearHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.ws) {
                this.ws.sendBinary(buildPacket(OP_HEARTBEAT, '[object Object]'));
            }
        }, HEARTBEAT_INTERVAL_MS);
    }

    clearHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    parseFrames(buf) {
        let offset = 0;
        while (offset + HEADER_SIZE <= buf.length) {
            const packetLength = buf.readUInt32BE(offset);
            const headerLength = buf.readUInt16BE(offset + 4) || HEADER_SIZE;
            const protoVersion = buf.readUInt16BE(offset + 6);
            const operation = buf.readUInt32BE(offset + 8);
            if (packetLength < HEADER_SIZE || offset + packetLength > buf.length) break;

            const body = buf.subarray(offset + headerLength, offset + packetLength);

            if (operation === OP_AUTH_REPLY) {
                this.handleAuthReply(body);
            } else if (operation === OP_MESSAGE) {
                if (protoVersion === PROTO_BROTLI || protoVersion === PROTO_ZLIB) {
                    try {
                        const decompressed = protoVersion === PROTO_BROTLI
                            ? zlib.brotliDecompressSync(body)
                            : zlib.inflateSync(body);
                        this.parseFrames(decompressed);
                    } catch (error) {
                        const codec = protoVersion === PROTO_BROTLI ? 'brotli' : 'zlib';
                        log(codec + ' decompress error:', error.message);
                    }
                } else {
                    void this.handleCommand(body.toString('utf8'));
                }
            }

            offset += packetLength;
        }
    }

    handleAuthReply(body) {
        let parsed;
        try {
            parsed = JSON.parse(body.toString('utf8'));
        } catch (_err) {
            log('malformed auth reply');
            this.setStatus('error', 'Malformed Bilibili auth reply.');
            return;
        }
        if (parsed.code === 0) {
            log('auth ok');
            this.attempt = 0;
            this.setStatus('connected');
        } else {
            log('auth rejected, code', parsed.code);
            this.setStatus('error', `Bilibili auth rejected (code ${parsed.code}).`);
            this.scheduleReconnect();
        }
    }

    async handleCommand(rawJson) {
        if (!rawJson) return;
        let parsed;
        try {
            parsed = JSON.parse(rawJson);
        } catch (_err) {
            return;
        }
        const cmd = parsed.cmd || '';
        if (!this.seenCmds.has(cmd)) {
            this.seenCmds.add(cmd);
            log('cmd:', cmd);
        }
        if (!cmd.startsWith('DANMU_MSG')) return;
        const dmV2 = decodeDmV2(parsed.dm_v2);
        const info = Array.isArray(parsed.info) ? parsed.info : [];
        if (info.length === 0 && !dmV2) return;
        const text = dmV2?.content || (typeof info[1] === 'string' ? info[1] : '');
        const parsedUname = dmV2?.uname || extractDanmuUserName(parsed, info);
        const userInfo = Array.isArray(info[2]) ? info[2] : [];
        const extendedIdentity = extractDanmuExtendedIdentity(parsed, info);
        const rawUid = dmV2?.uid || Number(userInfo[0]) || extendedIdentity.uid || 0;
        const userHash = dmV2?.userHash
            || extendedIdentity.userHash
            || (Array.isArray(info[0]) && typeof info[0][7] === 'string' ? info[0][7] : '');
        const isAdmin = Boolean(userInfo[2]);
        const { guardLevel, medalName, medalLevel } = extractDanmuPrivileges(parsed, info, dmV2);
        if (!text) return;
        const resolvedUser = /\*{2,}/.test(parsedUname)
            ? await resolveBiliDanmuUser(rawUid, userHash, parsedUname)
            : { uid: rawUid, name: parsedUname };
        const uid = resolvedUser.uid;
        const uname = resolvedUser.name;
        const isAnchor = uid > 0 && uid === Number(this.anchorUid);
        this.emit({
            type: 'danmu',
            text,
            uname,
            uid,
            isAdmin,
            isAnchor,
            guardLevel,
            medalName,
            medalLevel,
            ts: Date.now(),
        });
    }
}

// ---------------------------------------------------------------------------
// Stage API 桥（读取 electron-store 的 token/端口，代理 HTTP 请求）
// ---------------------------------------------------------------------------

const getUserDataDir = () => {
    try {
        // 模组 main 入口运行在主进程里，能拿到 electron 本体。
        const { app } = require('electron');
        return app.getPath('userData');
    } catch (_err) {
        // 兜底：按平台惯例拼路径。
        const home = process.env.USERPROFILE || process.env.HOME || '';
        if (process.platform === 'win32') {
            return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Folia');
        }
        if (process.platform === 'darwin') {
            return path.join(home, 'Library', 'Application Support', 'Folia');
        }
        return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Folia');
    }
};

const readStageConfig = () => {
    try {
        const configPath = path.join(getUserDataDir(), 'config.json');
        const raw = fs.readFileSync(configPath, 'utf8');
        const store = JSON.parse(raw);
        const port = Number(store.STAGE_API_PORT);
        const obsPort = Number(store.OBS_BROWSER_SOURCE_PORT);
        return {
            ok: true,
            stageEnabled: store.STAGE_MODE_ENABLED === true && store.STAGE_MODE_SOURCE === 'stage-api',
            hasToken: typeof store.STAGE_API_TOKEN === 'string' && store.STAGE_API_TOKEN.length > 0,
            token: typeof store.STAGE_API_TOKEN === 'string' ? store.STAGE_API_TOKEN : '',
            port: Number.isInteger(port) && port > 0 ? port : 32107,
            obsPort: Number.isInteger(obsPort) && obsPort > 0 ? obsPort : 32108,
            obsToken: typeof store.OBS_BROWSER_SOURCE_TOKEN === 'string' ? store.OBS_BROWSER_SOURCE_TOKEN : '',
        };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
};

const stageRequest = (method, pathname, body) => new Promise((resolve) => {
    const config = readStageConfig();
    if (!config.ok) {
        resolve({ ok: false, error: `无法读取宿主配置：${config.error}` });
        return;
    }
    if (!config.hasToken) {
        resolve({ ok: false, error: 'Stage API 未配置 token。请先在 设置 → 集成 中开启舞台模式。', code: 'stage-not-configured' });
        return;
    }

    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const request = http.request(
        {
            host: '127.0.0.1',
            port: config.port,
            path: pathname,
            method,
            headers: {
                Authorization: `Bearer ${config.token}`,
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
            },
            timeout: 10_000,
        },
        (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let data = null;
                try {
                    data = JSON.parse(text);
                } catch (_err) {
                    data = { raw: text };
                }
                resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, data });
            });
        },
    );
    request.on('timeout', () => request.destroy(new Error('Stage API 请求超时')));
    request.on('error', (error) => {
        const message = error.code === 'ECONNREFUSED'
            ? 'Stage API 未监听。请先在 设置 → 集成 中开启舞台模式（Stage API 源）后重试。'
            : error.message;
        resolve({ ok: false, error: message, code: error.code });
    });
    if (payload) request.write(payload);
    request.end();
});

const handleStageOp = async (op) => {
    switch (op.op) {
        case 'status':
            return stageRequest('GET', '/stage/status');
        case 'search':
            return stageRequest('POST', '/stage/player/search', { query: op.query, limit: op.limit });
        case 'play':
            return stageRequest('POST', '/stage/player/play', { songId: op.songId, appendToQueue: op.appendToQueue === true });
        case 'queue':
            return stageRequest('POST', '/stage/player/queue', {
                action: op.action,
                ...(op.songId !== undefined ? { songId: op.songId } : {}),
                ...(op.songIds !== undefined ? { songIds: op.songIds } : {}),
                ...(op.queueItemId !== undefined ? { queueItemId: op.queueItemId } : {}),
            });
        case 'queueStatus':
            return stageRequest('GET', '/stage/player/queue?limit=200');
        case 'queueTail': {
            const offset = Math.max(0, Math.floor(Number(op.offset) || 0));
            return stageRequest('GET', `/stage/player/queue?offset=${offset}&limit=5`);
        }
        case 'playerStatus':
            return stageRequest('GET', '/stage/player/status');
        default:
            return { ok: false, error: `Unknown stage op: ${op && op.op}` };
    }
};

// ---------------------------------------------------------------------------
// 模组入口
// ---------------------------------------------------------------------------

module.exports = function activate(api) {
    const events = [];
    const emit = (event) => {
        events.push(event);
        if (events.length > MAX_QUEUED_EVENTS) {
            events.splice(0, events.length - MAX_QUEUED_EVENTS);
        }
    };
    const controller = new BiliLiveDanmuController(emit);

    api.rpc.handle('start', async ({ roomId, sessdata } = {}) => {
        await controller.start({
            roomId: String(roomId || '').trim(),
            sessdata: (sessdata && String(sessdata).trim()) || '',
        });
        return { ok: true };
    });

    api.rpc.handle('stop', async () => {
        controller.stop();
        return { ok: true };
    });

    api.rpc.handle('getState', async () => ({
        status: controller.status,
        detail: controller.detail,
        roomId: controller.roomId,
        realRoomId: controller.realRoomId,
    }));

    api.rpc.handle('poll', async () => {
        const drained = events.splice(0, events.length);
        return drained;
    });

    api.rpc.handle('stage', async (op) => handleStageOp(op || {}));

    api.rpc.handle('stageConfig', async () => readStageConfig());

    // ------------------------------------------------------------------
    // OBS 展示页：模组自己的本地页面服务（宿主的 OBS 页面 32108 不对模组
    // 开放，这里复刻分支版队列列表 + 播放卡片，数据来自 client 推送的
    // 请求队列与宿主 Stage API 的播放状态/队列）。
    // ------------------------------------------------------------------

    const obsState = {
        connection: 'idle',
        roomId: '',
        requests: [],
        current: null,
        theme: null,
        obs: null,
        pushedAt: 0,
    };

    let obsServer = null;
    let obsServerPort = 0;

    const OBS_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Folia 点歌台</title>
<style>
:root {
  --accent: ACCENT_PLACEHOLDER;
  --accent-soft: ACCENT_SOFT_PLACEHOLDER;
  --surface-strong: rgba(17, 18, 24, 0.82);
  --border: rgba(255, 255, 255, 0.15);
  --text: #f5f5f7;
  --muted: #b9bac4;
  --shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; background: transparent; overflow: hidden;
  font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; color: var(--text); }
#root { position: fixed; inset: 0; z-index: 2; }
#stageFrame { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; z-index: 1; }

.panel { position: absolute; display: flex; flex-direction: column; overflow: hidden;
  z-index: 2;
  border-radius: 26px; border: 1px solid var(--border); background: var(--surface-strong);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); box-shadow: var(--shadow); }

/* ---------- 正在播放卡片 ---------- */
#card { left: CARD_LEFT_PLACEHOLDER; bottom: CARD_BOTTOM_PLACEHOLDER; width: CARD_WIDTH_PLACEHOLDER;
  height: CARD_HEIGHT_PLACEHOLDER; padding: 14px; border-radius: 30px; }
#card .inner { position: relative; display: flex; gap: 16px; height: 100%; align-items: center; }
#card .cover-bg { position: absolute; inset: -20%; background-size: cover; background-position: center;
  opacity: .14; filter: blur(28px); }
#card .cover { position: relative; height: 100%; aspect-ratio: 1 / 1; flex: none;
  border-radius: 18px; border: 1px solid var(--border); background: var(--accent-soft);
  object-fit: cover; }
#card .cover-placeholder { display: grid; place-items: center; font-size: 34px; color: var(--accent); }
#card .meta { position: relative; min-width: 0; flex: 1; }
#card .label { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600;
  letter-spacing: .18em; text-transform: uppercase; color: var(--accent); margin-bottom: 7px; }
#card .disc { display: inline-block; animation: spin 5s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
#card .title { font-size: 24px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#card .sub { margin-top: 4px; font-size: 16px; color: var(--muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#card .requester { display: inline-flex; align-items: center; gap: 6px; margin-top: 9px;
  font-size: 13px; color: var(--text); background: var(--accent-soft);
  border-radius: 999px; padding: 3px 11px; max-width: 100%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#card .requester svg { flex: none; }
#card .progress { margin-top: 11px; height: 4px; border-radius: 999px; background: rgba(255,255,255,.14);
  overflow: hidden; }
#card .progress > div { height: 100%; width: 0; border-radius: 999px; background: var(--accent); }
#card .time { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted);
  margin-top: 5px; font-variant-numeric: tabular-nums; }

/* ---------- 队列列表（无外框：行卡片自带玻璃底，标题浮于动画之上） ---------- */
#list { position: absolute; display: flex; flex-direction: column; overflow: visible; z-index: 2;
  left: LIST_LEFT_PLACEHOLDER; top: LIST_TOP_PLACEHOLDER; width: LIST_WIDTH_PLACEHOLDER;
  max-height: LIST_HEIGHT_PLACEHOLDER; }
#list header { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 4px 2px 10px; flex: none; text-shadow: 0 2px 14px rgba(0,0,0,.65); }
#list header .heading { display: flex; align-items: center; gap: 10px; min-width: 0; }
#list header .icon-box { width: 36px; height: 36px; flex: none; display: grid; place-items: center;
  border-radius: 14px; background: var(--accent-soft); }
#list header h2 { font-size: 16px; font-weight: 600; letter-spacing: .08em; }
#list header p { font-size: 13px; color: var(--muted); margin-top: 1px; }
#list header .live { width: 9px; height: 9px; border-radius: 999px; background: var(--accent);
  animation: pulse 1.6s ease-in-out infinite; flex: none; }
@keyframes pulse { 50% { opacity: .35; } }
#list .viewport { overflow: hidden; flex: 1; min-height: 0; position: relative; border-radius: 20px; }
#list .track { display: flex; flex-direction: column; gap: 10px; padding: 0 0 4px; will-change: transform; }
.row { display: flex; align-items: center; gap: 12px; border-radius: 20px; border: 1px solid var(--border);
  padding: 10px 12px; background: var(--surface-strong); flex: none;
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); }
.row.emphasized { border-color: var(--accent); }
.preview-divider { font-size: 12px; font-weight: 600; letter-spacing: .12em; color: var(--muted);
  padding: 10px 4px 2px; text-shadow: 0 2px 12px rgba(0,0,0,.7); }
.row.preview { opacity: .6; }
.row.preview .num { background: transparent; border: 1px solid var(--border); color: var(--muted); }
.row .num { width: 36px; height: 36px; flex: none; display: grid; place-items: center;
  border-radius: 12px; background: var(--accent-soft); color: var(--accent);
  font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
.row .info { min-width: 0; flex: 1; }
.row .title { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 8px;
  white-space: nowrap; overflow: hidden; }
.row .title span.name { overflow: hidden; text-overflow: ellipsis; }
.row .badge { flex: none; font-size: 11px; font-weight: 600; letter-spacing: .05em; color: var(--accent);
  background: var(--accent-soft); border-radius: 999px; padding: 2px 9px; }
.row .sub { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-top: 4px; font-size: 13px; color: var(--muted); }
.row .sub .artist { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .sub .by { flex: none; display: inline-flex; align-items: center; gap: 5px; max-width: 46%;
  color: var(--text); background: var(--accent-soft); border-radius: 999px; padding: 2px 10px;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.empty { padding: 10px 16px 6px; font-size: 14px; color: var(--muted); text-shadow: 0 2px 12px rgba(0,0,0,.7);
  background: var(--surface-strong); border-radius: 16px; border: 1px solid var(--border); margin: 4px 0; }
.hidden { display: none !important; }
</style>
</head>
<body>
<div id="root">
  <section id="card" class="panel">
    <div class="inner">
      <div class="cover-bg" id="cardBg"></div>
      <img class="cover" id="cardCover" alt="" crossorigin="anonymous">
      <div class="cover cover-placeholder hidden" id="cardPlaceholder">&#9835;</div>
      <div class="meta">
        <div class="label"><span class="disc">&#10227;</span><span id="cardLabel">正在播放</span></div>
        <div class="title" id="cardTitle">等待点歌…</div>
        <div class="sub" id="cardSub"></div>
        <div class="requester hidden" id="cardRequester"></div>
        <div class="progress"><div id="cardProgress"></div></div>
        <div class="time"><span id="cardTimeNow">0:00</span><span id="cardTimeTotal">0:00</span></div>
      </div>
    </div>
  </section>

  <section id="list">
    <header id="listHeader">
      <div class="heading">
        <div class="icon-box">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="21" x2="3" y1="6" y2="6"/><line x1="21" x2="3" y1="12" y2="12"/><line x1="21" x2="3" y1="18" y2="18"/><line x1="8" x2="8" y1="6" y2="18"/><line x1="14" x2="14" y1="6" y2="18"/></svg>
        </div>
        <div>
          <h2 id="listTitle">点歌队列</h2>
          <p id="listCount">暂无点歌</p>
        </div>
      </div>
      <span class="live"></span>
    </header>
    <div class="viewport"><div class="track" id="track"></div></div>
    <div class="empty hidden" id="emptyRow">队列空闲，发送「点歌 歌名」点歌</div>
  </section>
</div>
<script>
'use strict';
// ---- 配置：URL 参数 > 模组设置（/state 推送）> 默认值 ----
const params = new URLSearchParams(location.search);
const num = (key) => {
  const raw = params.get(key);
  return raw === null || raw === '' ? undefined : Number(raw);
};
const str = (key) => {
  const raw = params.get(key);
  return raw === null || raw === '' ? undefined : raw;
};
const cfg = {
  stageBase: 'http://127.0.0.1:' + (params.get('stagePort') || '__STAGE_PORT__'),
  token: params.get('token') || '__STAGE_TOKEN__',
  embedStageUrl: '__OBS_STAGE_URL__',
};
const defaults = {
  stage: true, speed: 18, mode: 'loop', header: true, accent: null, lang: null,
  listX: 2, listY: 12, listWidth: 432, listHeight: 560,
  cardLeft: 66, cardBottom: 3, cardWidth: 608, cardHeight: 168,
};
const urlOverrides = {
  stage: params.get('stage') === '0' ? false : params.get('stage') === '1' ? true : undefined,
  speed: num('speed'), mode: str('mode'), accent: str('accent'), lang: str('lang'),
  header: params.get('header') === '0' ? false : params.get('header') === '1' ? true : undefined,
  listX: num('listX'), listY: num('listY'), listWidth: num('listWidth'), listHeight: num('listHeight'),
  cardLeft: num('cardLeft'), cardBottom: num('cardBottom'), cardWidth: num('cardWidth'), cardHeight: num('cardHeight'),
};
let modObs = {};
const pick = (key) => {
  if (urlOverrides[key] !== undefined) return urlOverrides[key];
  const fromMod = modObs[key];
  if (fromMod !== undefined && fromMod !== null && fromMod !== '') return fromMod;
  return defaults[key];
};
// 布局/行为设置随 /state 到达或变化时套用（URL 覆盖 > 模组设置 > 默认值）。
let appliedLayoutJson = '';
let stageFrameEl = null;
let currentLang = null;
const applyLayout = () => {
  const layout = {
    stage: pick('stage') === true,
    speed: Math.min(120, Math.max(5, Number(pick('speed')) || 18)),
    mode: pick('mode') === 'ping-pong' ? 'ping-pong' : 'loop',
    header: pick('header') === true,
    lang: pick('lang') === 'en' ? 'en' : 'zh-CN',
    listX: pick('listX'), listY: pick('listY'), listWidth: pick('listWidth'), listHeight: pick('listHeight'),
    cardLeft: pick('cardLeft'), cardBottom: pick('cardBottom'), cardWidth: pick('cardWidth'), cardHeight: pick('cardHeight'),
  };
  const json = JSON.stringify(layout);
  if (json === appliedLayoutJson) return layout;
  appliedLayoutJson = json;

  const list = document.getElementById('list');
  const card = document.getElementById('card');
  list.style.left = layout.listX + '%';
  list.style.top = layout.listY + '%';
  list.style.width = layout.listWidth + 'px';
  list.style.maxHeight = 'min(' + layout.listHeight + 'px, 86vh)';
  card.style.left = layout.cardLeft + '%';
  card.style.bottom = layout.cardBottom + '%';
  card.style.width = layout.cardWidth + 'px';
  card.style.height = layout.cardHeight + 'px';
  document.getElementById('listHeader').classList.toggle('hidden', !layout.header);

  if (layout.stage && cfg.embedStageUrl && !stageFrameEl) {
    stageFrameEl = document.createElement('iframe');
    stageFrameEl.id = 'stageFrame';
    stageFrameEl.src = cfg.embedStageUrl;
    document.body.insertBefore(stageFrameEl, document.body.firstChild);
  } else if (!layout.stage && stageFrameEl) {
    stageFrameEl.remove();
    stageFrameEl = null;
  }

  if (layout.lang !== currentLang) {
    currentLang = layout.lang;
    applyLang(layout.lang);
  }
  return layout;
};
let lastEntriesJson = '';

const T = {
  'zh-CN': {
    nowPlaying: '正在播放', idle: '等待点歌…', queueTitle: '点歌队列',
    none: '暂无点歌', playingBadge: '播放中', empty: '队列空闲，发送「点歌 歌名」点歌',
    count: (n) => '待播 ' + n + ' 首', upNext: '接下来',
  },
  en: {
    nowPlaying: 'NOW PLAYING', idle: 'Waiting for requests…', queueTitle: 'Song Requests',
    none: 'No requests yet', playingBadge: 'Playing', empty: 'Queue is empty — send "song <title>"',
    count: (n) => n + ' pending', upNext: 'Up next',
  },
};
const applyLang = (lang) => {
  const t = T[lang] || T['zh-CN'];
  document.getElementById('cardLabel').textContent = t.nowPlaying;
  document.getElementById('cardTitle').textContent = t.idle;
  document.getElementById('listTitle').textContent = t.queueTitle;
  lastEntriesJson = '';
};
applyLayout();

const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

// ---- 数据拉取：模组自己的 /state（请求队列+点歌人+播放态兜底+主题）+ 宿主 Stage ----
let modState = { connection: 'idle', requests: [], current: null, theme: null };
let stageStatus = null;

// 叠加层 UI 跟随 Folia 应用主题（派生公式与分支版队列展示层一致）。
const hexToRgba = (hex, alpha) => {
  if (typeof hex !== 'string' || hex.charAt(0) !== '#') return hex;
  let body = hex.slice(1);
  if (body.length === 3) body = body.split('').map((ch) => ch + ch).join('');
  if (body.length !== 6) return hex;
  const r = parseInt(body.slice(0, 2), 16);
  const g = parseInt(body.slice(2, 4), 16);
  const b = parseInt(body.slice(4, 6), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
};

let appliedThemeJson = '';
const applyTheme = () => {
  const theme = modState.theme;
  if (!theme) return;
  // 强调色优先级：URL accent > 模组设置 > 应用主题。
  const accentOverride = pick('accent');
  const json = JSON.stringify(theme) + '|' + String(accentOverride || '');
  if (json === appliedThemeJson) return;
  appliedThemeJson = json;
  const daylight = theme.daylight === true;
  const accent = accentOverride || theme.accent || '#6ee7ff';
  const themeAccent = accentOverride || theme.accent || accent;
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--accent', accent);
  rootStyle.setProperty('--accent-soft', hexToRgba(themeAccent, daylight ? 0.14 : 0.2));
  rootStyle.setProperty('--surface-strong', hexToRgba(theme.background || '#111218', daylight ? 0.9 : 0.82));
  rootStyle.setProperty('--border', hexToRgba(themeAccent, daylight ? 0.28 : 0.36));
  rootStyle.setProperty('--text', theme.primary || '#f5f5f7');
  rootStyle.setProperty('--muted', theme.secondary || '#b9bac4');
  rootStyle.setProperty('--shadow', '0 24px 80px ' + hexToRgba(theme.background || '#000000', 0.42));
  if (theme.fontStack) document.body.style.fontFamily = theme.fontStack;
};

const fetchJson = async (url, useAuth) => {
  try {
    const res = await fetch(url, useAuth ? { headers: { Authorization: 'Bearer ' + cfg.token } } : {});
    if (!res.ok) return null;
    return await res.json();
  } catch (_err) { return null; }
};

const pollMod = async () => {
  const data = await fetchJson('/state', false);
  if (data && Array.isArray(data.requests)) modState = data;
  modObs = (modState && modState.obs) || {};
  applyTheme();
  currentLayout = applyLayout();
};
const pollStage = async () => {
  const data = await fetchJson(cfg.stageBase + '/stage/player/status', true);
  if (data && data.current !== undefined) stageStatus = data;
};

const requesterBySong = new Map();
const refreshRequesterMap = () => {
  requesterBySong.clear();
  for (const item of modState.requests || []) {
    requesterBySong.set(Number(item.songId), item.uname || '');
  }
};

// ---- 渲染 ----
const el = (id) => document.getElementById(id);
const userIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

const TT = () => T[currentLang || 'zh-CN'] || T['zh-CN'];

const renderCard = (current, playing) => {
  const cover = current && current.coverUrl ? current.coverUrl : '';
  el('cardBg').style.backgroundImage = cover ? 'url("' + cover + '")' : 'none';
  el('cardCover').src = cover;
  el('cardCover').classList.toggle('hidden', !cover);
  el('cardPlaceholder').classList.toggle('hidden', Boolean(cover));
  el('cardTitle').textContent = current ? current.title : TT().idle;
  const sub = current ? [current.artist, current.album].filter(Boolean).join(' · ') : '';
  el('cardSub').textContent = sub;
  const requester = current ? requesterBySong.get(Number(current.id)) : null;
  el('cardRequester').classList.toggle('hidden', !requester);
  if (requester) el('cardRequester').innerHTML = userIcon + '<span>' + requester + '</span>';
  const duration = current && current.durationMs ? current.durationMs : 0;
  el('cardTimeTotal').textContent = duration ? fmt(duration) : '0:00';
  el('cardLabel').parentElement.style.opacity = playing ? '1' : '.55';
};

const renderList = (entries) => {
  const json = JSON.stringify(entries) + '#' + JSON.stringify(upcoming);
  if (json === lastEntriesJson) return;
  lastEntriesJson = json;
  const track = el('track');
  track.textContent = '';
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'row';
    const num = document.createElement('div');
    num.className = 'num';
    num.textContent = String(entry.position);
    const info = document.createElement('div');
    info.className = 'info';
    const title = document.createElement('div');
    title.className = 'title';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.title;
    title.appendChild(name);
    const sub = document.createElement('div');
    sub.className = 'sub';
    const artist = document.createElement('span');
    artist.className = 'artist';
    artist.textContent = entry.artist || entry.album || '';
    sub.appendChild(artist);
    if (entry.requester) {
      const by = document.createElement('span');
      by.className = 'by';
      by.innerHTML = userIcon + '<span></span>';
      by.lastElementChild.textContent = entry.requester;
      sub.appendChild(by);
    }
    info.appendChild(title);
    info.appendChild(sub);
    row.appendChild(num);
    row.appendChild(info);
    track.appendChild(row);
  }
  // 空闲（无待播点歌）时：预告宿主歌单接下来两首（弱化样式，无序号无点歌人）。
  if (entries.length === 0 && upcoming.length > 0) {
    const divider = document.createElement('div');
    divider.className = 'preview-divider';
    divider.textContent = TT().upNext;
    track.appendChild(divider);
    for (const item of upcoming) {
      const row = document.createElement('div');
      row.className = 'row preview';
      const num = document.createElement('div');
      num.className = 'num';
      num.textContent = '\\u266A';
      const info = document.createElement('div');
      info.className = 'info';
      const title = document.createElement('div');
      title.className = 'title';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = item.title;
      title.appendChild(name);
      const sub = document.createElement('div');
      sub.className = 'sub';
      const artist = document.createElement('span');
      artist.className = 'artist';
      artist.textContent = item.artist || '';
      sub.appendChild(artist);
      info.appendChild(title);
      info.appendChild(sub);
      row.appendChild(num);
      row.appendChild(info);
      track.appendChild(row);
    }
  }
  el('emptyRow').textContent = TT().empty;
  el('emptyRow').classList.toggle('hidden', entries.length > 0 || upcoming.length > 0);
  el('listCount').textContent = entries.length > 0 ? TT().count(entries.length) : TT().none;
};

// 队列列表只显示待播点歌（正在播放交给卡片）。
const buildEntries = () => {
  refreshRequesterMap();
  const entries = [];
  for (const item of (modState.requests || [])) {
    if (item.status === 'playing') continue;
    entries.push({
      title: item.title, artist: item.artist, requester: item.uname || '',
      isPlaying: false, position: entries.length + 1,
    });
  }
  return entries;
};

// 无点歌时预告宿主歌单的接下来两首（节流 5s，仅空闲时查询）。
let upcoming = [];
let upcomingFetchedAt = 0;
let upcomingFetchBusy = false;
const pollUpcoming = async (force) => {
  if (upcomingFetchBusy) return;
  if (!force && performance.now() - upcomingFetchedAt < 5000) return;
  upcomingFetchBusy = true;
  try {
    const head = await fetchJson(cfg.stageBase + '/stage/player/queue?limit=1', true);
    const currentIndex = Number(head && head.queue && head.queue.currentIndex);
    if (!Number.isInteger(currentIndex) || currentIndex < 0) {
      upcoming = [];
      return;
    }
    const windowed = await fetchJson(cfg.stageBase + '/stage/player/queue?offset=' + (currentIndex + 1) + '&limit=2', true);
    const items = (windowed && windowed.queue && windowed.queue.items) || [];
    upcoming = items.slice(0, 2).map((item) => ({ title: item.title, artist: item.artist }));
  } catch (_err) {
    upcoming = [];
  } finally {
    upcomingFetchedAt = performance.now();
    upcomingFetchBusy = false;
  }
};

// ---- 进度条与滚动动画 ----
// 舞台会话上下文里 Stage API 不报播放态，进度信息回退到模组推送的宿主播放快照。
let progressInfo = { positionMs: 0, durationMs: 0, playing: false, anchoredAt: 0 };
const renderProgress = () => {
  const info = progressInfo;
  if (!info.durationMs) { el('cardProgress').style.width = '0'; return; }
  const extrapolated = info.playing
    ? info.positionMs + (performance.now() - info.anchoredAt)
    : info.positionMs;
  const ratio = Math.min(1, Math.max(0, extrapolated / info.durationMs));
  el('cardProgress').style.width = (ratio * 100).toFixed(2) + '%';
  el('cardTimeNow').textContent = fmt(Math.min(extrapolated, info.durationMs));
};

let scrollOffset = 0;
let scrollDirection = 1;
let currentLayout = null;
const stepScroll = (deltaMs) => {
  const viewport = document.querySelector('#list .viewport');
  const track = el('track');
  if (!viewport || !track || track.children.length < 2) return;
  const overflow = track.scrollHeight - viewport.clientHeight;
  if (overflow <= 4) { track.style.transform = 'translateY(0)'; return; }
  const speed = currentLayout ? currentLayout.speed : 18;
  const mode = currentLayout ? currentLayout.mode : 'loop';
  scrollOffset += (deltaMs / 1000) * speed * scrollDirection;
  if (mode === 'loop') {
    if (scrollOffset >= overflow + 12) scrollOffset = -12;
    if (scrollOffset < -12) scrollOffset = overflow + 12;
  } else {
    if (scrollOffset >= overflow) { scrollOffset = overflow; scrollDirection = -1; }
    if (scrollOffset <= 0) { scrollOffset = 0; scrollDirection = 1; }
  }
  track.style.transform = 'translateY(' + (-Math.max(0, scrollOffset)) + 'px)';
};

let lastFrame = performance.now();
const frame = (now) => {
  const delta = now - lastFrame;
  lastFrame = now;
  renderProgress();
  stepScroll(delta);
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);

// ---- 轮询循环 ----
const tick = async () => {
  await Promise.all([pollMod(), pollStage()]);
  const stageCurrent = stageStatus && stageStatus.current ? stageStatus.current : null;
  const fallback = modState.current && modState.current.title ? modState.current : null;
  const current = stageCurrent || (fallback ? {
    title: fallback.title,
    artist: fallback.artist,
    album: '',
    coverUrl: '',
    id: fallback.id,
    durationMs: fallback.duration ? Math.floor(fallback.duration * 1000) : 0,
  } : null);
  const playing = stageCurrent
    ? stageStatus.playerState === 'PLAYING'
    : Boolean(fallback && fallback.state === 'playing');
  renderCard(current, playing);
  progressInfo = {
    positionMs: stageCurrent
      ? (stageStatus.positionMs || 0)
      : Math.floor(((fallback && fallback.position) || 0) * 1000),
    durationMs: current ? current.durationMs || 0 : 0,
    playing,
    anchoredAt: performance.now(),
  };
  renderList(buildEntries());
  if (!modState.requests || modState.requests.every((item) => item.status === 'playing')) {
    void pollUpcoming(false);
  }
};
void tick();
setInterval(() => { void tick(); }, 700);
</script>
</body>
</html>`;

    const renderObsPage = () => {
        const accent = '#6ee7ff';
        const config = readStageConfig();
        const obsStageUrl = config.obsToken
            ? `http://127.0.0.1:${config.obsPort}/obs?obs=1&token=${encodeURIComponent(config.obsToken)}`
            : '';
        return OBS_PAGE_HTML
            .replace(/ACCENT_SOFT_PLACEHOLDER/, accent + '33')
            .replace(/ACCENT_PLACEHOLDER/, accent)
            .replace(/CARD_LEFT_PLACEHOLDER/, '66%')
            .replace(/CARD_BOTTOM_PLACEHOLDER/, '3%')
            .replace(/CARD_WIDTH_PLACEHOLDER/, '608px')
            .replace(/CARD_HEIGHT_PLACEHOLDER/, '168px')
            .replace(/LIST_LEFT_PLACEHOLDER/, '2%')
            .replace(/LIST_TOP_PLACEHOLDER/, '12%')
            .replace(/LIST_WIDTH_PLACEHOLDER/, '432px')
            .replace(/LIST_HEIGHT_PLACEHOLDER/, 'min(560px, calc(100vh - 14vh))')
            .replace(/__STAGE_PORT__/, String(config.port || 32107))
            .replace(/__STAGE_TOKEN__/, config.token || '')
            .replace(/__OBS_STAGE_URL__/, obsStageUrl);
    };

    const startObsServer = async () => {
        if (obsServer) return { ok: true, port: obsServerPort };
        const config = readStageConfig();
        const requestedPort = Number(process.env.FOLIA_BILI_OBS_PORT) || 32198;
        await new Promise((resolve) => {
            obsServer = http.createServer((req, res) => {
                const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
                if (pathname === '/state') {
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({
                        connection: obsState.connection,
                        roomId: obsState.roomId,
                        requests: obsState.requests,
                        current: obsState.current,
                        theme: obsState.theme,
                        obs: obsState.obs,
                        pushedAt: obsState.pushedAt,
                    }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(renderObsPage());
            });
            obsServer.on('error', (error) => {
                log('obs server error:', error.message);
                obsServer = null;
                resolve();
            });
            obsServer.listen(requestedPort, '127.0.0.1', () => {
                obsServerPort = requestedPort;
                log('obs page serving at http://127.0.0.1:' + requestedPort + '/');
                resolve();
            });
        });
        return { ok: Boolean(obsServer), port: obsServerPort, stageEnabled: config.stageEnabled };
    };

    const stopObsServer = () => {
        if (!obsServer) return;
        try {
            obsServer.close();
        } catch (_err) {
            // ignore
        }
        obsServer = null;
        obsServerPort = 0;
    };

    api.rpc.handle('pushObsState', async (payload) => {
        if (payload && typeof payload === 'object') {
            if (typeof payload.connection === 'string') obsState.connection = payload.connection;
            if (typeof payload.roomId === 'string') obsState.roomId = payload.roomId;
            if (Array.isArray(payload.requests)) obsState.requests = payload.requests.slice(0, 100);
            obsState.current = payload.current === undefined ? obsState.current : (payload.current || null);
            obsState.theme = payload.theme === undefined ? obsState.theme : (payload.theme || null);
            obsState.obs = payload.obs === undefined ? obsState.obs : (payload.obs || null);
            obsState.pushedAt = Date.now();
        }
        return { ok: true };
    });

    api.rpc.handle('obsStatus', async () => {
        if (!obsServer) await startObsServer();
        return { ok: Boolean(obsServer), port: obsServerPort };
    });

    void startObsServer();

    api.lifecycle.onDeactivate(() => {
        controller.stop();
        stopObsServer();
    });
};

// 加载器只要求默认导出是函数；这些附加导出仅供离线测试使用。
module.exports.decodeDmV2 = decodeDmV2;
module.exports.MiniWebSocket = MiniWebSocket;
module.exports.crackBiliUidHashCandidates = crackBiliUidHashCandidates;
module.exports.buildPacket = buildPacket;
