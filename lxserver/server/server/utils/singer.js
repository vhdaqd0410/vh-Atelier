"use strict";
/**
 * 歌手信息助手
 * 支持从 TX (QQ音乐) 和 WY (网易云音乐) 源获取歌手详细信息
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeName = normalizeName;
exports.nameSimilarity = nameSimilarity;
exports.getSingerMid = getSingerMid;
exports.getSingerPic = getSingerPic;
exports.getOrderedSingerSources = getOrderedSingerSources;
exports.getSingerDetail = getSingerDetail;
exports.resolveSingerSources = resolveSingerSources;
// @ts-ignore
const index_js_1 = __importDefault(require("../../modules/utils/musicSdk/index.js"));
const zhConvert_1 = require("./zhConvert.js");
const musicSdk = index_js_1.default;
const singerCache = new Map();
// 失败短缓存：音源搜索接口抖动时避免被连环重打（连环失败还会把自己打进限流）。
// 命中后 60s 内直接返回 null，过期自动重试。
const failCache = new Map();
const FAIL_TTL = 60 * 1000;
/** 名称归一：去空白/常见标点/全半角干扰 + 小写。简繁差异("黄霄云"↔"黄霄雲")交给相似度兜底 */
function normalizeName(name) {
    return String(name || '')
        .replace(/[\s\u3000·・.。,，、\-—_()（）[\]【】'"“”‘’]/g, '')
        .toLowerCase();
}
/**
 * 名字相似度(0~1)：以较长串为分母统计较短串字符的命中率（允许乱序），
 * 用于替代 "name === singerName" 的严格相等——简繁/别名/后缀("黄霄云" vs "黄霄雲的人")都能给出分数。
 */
function nameSimilarity(a, b) {
    const x = normalizeName(a);
    const y = normalizeName(b);
    if (!x || !y)
        return 0;
    if (x === y)
        return 1;
    const short = x.length <= y.length ? x : y;
    const long = x.length <= y.length ? y : x;
    if (long.includes(short))
        return short.length / long.length;
    const chars = long.split('');
    const used = new Array(chars.length).fill(false);
    let hit = 0;
    for (const ch of short) {
        const idx = chars.findIndex((c, i) => !used[i] && c === ch);
        if (idx >= 0) {
            used[idx] = true;
            hit++;
        }
    }
    return hit / long.length;
}
/** 从候选列表里挑最贴近搜索词的歌手；完全相同优先，其次相似度最高，最后退回第一条 */
function pickBestSinger(list, name) {
    if (!Array.isArray(list) || list.length === 0)
        return null;
    const target = normalizeName(name);
    let best = list[0];
    let bestScore = -1;
    for (const item of list) {
        const n = String(item?.name || '');
        let score = nameSimilarity(name, n);
        if (target && normalizeName(n) === target)
            score += 1; // 归一后完全相等，最高优先
        if (score > bestScore) {
            bestScore = score;
            best = item;
        }
    }
    return { item: best, score: bestScore };
}
/** 取配置里的源顺序，过滤掉压根没实现歌手搜索的源 */
function resolveSourcePriority(sourcePriority) {
    let configured = sourcePriority;
    if (!configured || !configured.length) {
        configured = global.lx?.config?.['singer.sourcePriority'];
    }
    const list = Array.isArray(configured) && configured.length ? [...configured] : ['tx', 'wy'];
    const seen = new Set();
    return list.filter(s => {
        if (!s || seen.has(s))
            return false;
        seen.add(s);
        return Boolean(musicSdk[s]?.extendSearch?.searchSinger);
    });
}
/**
 * 根据歌手名称检索其在指定源或最优源的 MID
 */
async function getSingerMid(singerName, sourcePriority) {
    const detail = await getSingerDetail(singerName, sourcePriority);
    return detail?.mid || null;
}
/**
 * 获取歌手照片链接
 */
async function getSingerPic(singerName, sourcePriority) {
    const detail = await getSingerDetail(singerName, sourcePriority);
    return detail?.pic || null;
}
/**
 * 在单个源上寻址歌手（纯查询，不处理缓存；串行/并发两种策略共用）
 */
async function resolveSingerFromSource(singerName, source) {
    const started = Date.now();
    const sdk = musicSdk[source];
    if (!sdk?.extendSearch?.searchSinger)
        return null;
    // [新增] 简繁变体补搜：音源对异体字命中差（"黄霄雲" ↔ "黄霄云"），两种字形都试一轮
    let singerList = [];
    for (const kw of (0, zhConvert_1.buildQueryVariants)(singerName)) {
        const searchResult = await sdk.extendSearch.searchSinger(kw, 1, 5);
        const list = searchResult?.list || [];
        if (list.length)
            singerList = singerList.concat(list);
        if (singerList.length >= 5)
            break;
    }
    const elapsed = Date.now() - started;
    if (singerList.length === 0) {
        console.warn(`[歌手服务] ${source} 搜索歌手「${singerName}」返回 0 条 (${elapsed}ms)`);
        return null;
    }
    const picked = pickBestSinger(singerList, singerName);
    const matched = picked?.item;
    const mid = matched ? String(matched.mid || matched.id || '') : '';
    if (!mid) {
        console.warn(`[歌手服务] ${source} 搜索歌手「${singerName}」命中 ${singerList.length} 条但候选无可用 mid`);
        return null;
    }
    console.log(`[歌手服务] ${source} 寻址「${singerName}」→「${matched.name}」(mid=${mid}, 相似度=${(picked?.score ?? 0).toFixed(2)}, 候选=${singerList.length}, ${elapsed}ms)`);
    let desc = matched.alias?.[0] || '';
    let pic = matched.picUrl || matched.img || matched.avatar || '';
    if (sdk.extendDetail?.getArtistDetail) {
        const detail = await sdk.extendDetail.getArtistDetail(mid).catch(() => null);
        if (detail) {
            desc = detail.desc || desc;
            pic = detail.avatar || detail.pic || pic;
        }
    }
    // 兜底补全头像 (TX 特有规则)
    if (!pic && source === 'tx' && mid) {
        pic = `https://y.gtimg.cn/music/photo_new/T001R500x500M000${mid}.jpg`;
    }
    return {
        name: singerName,
        matchedName: matched.name || singerName,
        mid,
        source: source,
        pic,
        desc,
    };
}
/** 单个源的缓存 key（多源查询与串行查询共用同一份缓存，避免重复打接口） */
function singleSourceKey(singerName, source) {
    return `${singerName}_${source}`;
}
/**
 * 取生效的歌手源顺序：遵守 singer.sourcePriority，并剔除未实现 searchSinger 的源
 */
function getOrderedSingerSources(sourcePriority) {
    return resolveSourcePriority(sourcePriority);
}
/**
 * 获取歌手详细信息（串行按优先级：高优先级源命中就不再请求后续源，省调用）
 * @param singerName 歌手名
 * @param sourcePriority 优选顺序，默认从全局配置获取
 */
async function getSingerDetail(singerName, sourcePriority) {
    const priority = getOrderedSingerSources(sourcePriority);
    const groupKey = `${singerName}_${priority.join('_')}`;
    const cached = singerCache.get(groupKey);
    if (cached)
        return cached;
    const failedAt = failCache.get(groupKey);
    if (failedAt && Date.now() - failedAt < FAIL_TTL) {
        return null;
    }
    if (!priority.length) {
        console.warn(`[歌手服务] 歌手「${singerName}」寻址失败：没有任何可用源实现了 searchSinger`);
        return null;
    }
    for (const source of priority) {
        const key = singleSourceKey(singerName, source);
        const cachedOne = singerCache.get(key);
        if (cachedOne)
            return cachedOne;
        const FailedAt = failCache.get(key);
        if (FailedAt && Date.now() - FailedAt < FAIL_TTL)
            continue;
        const started = Date.now();
        try {
            const detail = await resolveSingerFromSource(singerName, source);
            if (detail) {
                singerCache.set(key, detail);
                failCache.delete(key);
                return detail;
            }
            failCache.set(key, Date.now());
        }
        catch (err) {
            console.warn(`[歌手服务] 从 ${source} 获取歌手 [${singerName}] 失败 (${Date.now() - started}ms):`, err?.message || err);
            failCache.set(key, Date.now());
            continue;
        }
    }
    failCache.set(groupKey, Date.now());
    console.warn(`[歌手服务] 歌手「${singerName}」在 ${priority.join('/')} 均寻址失败，${FAIL_TTL / 1000}s 内不再重试`);
    return null;
}
/**
 * 按 singer.sourcePriority 解析出所有参与源上的命中（并发），返回顺序即优先级顺序。
 * 用于跨源合并歌手页的专辑/歌曲——每个源有自己的 mid，不能混用，
 * 只有拿到各自平台的 mid 才能抓到对应平台的完整专辑与热门歌曲。
 */
async function resolveSingerSources(singerName, sourcePriority) {
    const priority = getOrderedSingerSources(sourcePriority);
    if (!priority.length)
        return [];
    const settled = await Promise.all(priority.map(async (source) => {
        const key = singleSourceKey(singerName, source);
        const cached = singerCache.get(key);
        if (cached)
            return cached;
        const failedAt = failCache.get(key);
        if (failedAt && Date.now() - failedAt < FAIL_TTL)
            return null;
        try {
            const detail = await resolveSingerFromSource(singerName, source);
            if (detail) {
                singerCache.set(key, detail);
                failCache.delete(key);
            }
            else {
                failCache.set(key, Date.now());
            }
            return detail;
        }
        catch (err) {
            console.warn(`[歌手服务] 跨源解析 ${source} 歌手 [${singerName}] 失败:`, err?.message || err);
            failCache.set(key, Date.now());
            return null;
        }
    }));
    return settled.filter(Boolean);
}
