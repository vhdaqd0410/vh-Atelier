"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchRecommendedAlbums = void 0;
const request_1 = require("../../modules/utils/request");
const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
/**
 * 获取推荐专辑列表
 * @param type 推荐类型: recent, newest, random, frequent
 * @param size 获取数量
 */
const fetchRecommendedAlbums = async (type, size = 20) => {
    let payload = {
        comm: { ct: 24, cv: 0 }
    };
    // 每个地区的抓取量：按请求总量分摊到 6 个地区。
    // 原来固定写死 num=5/10（合计约 30 条），客户端滚动一页就见底；
    // 现在按 size 动态分配，让推荐池能支撑多页翻页。
    const perArea = Math.max(5, Math.ceil((size || 20) / 6));
    if (type === 'recent') {
        // [最新上架] 6个地区每个地区前 perArea 个组合
        for (let i = 1; i <= 6; i++) {
            payload[`area_${i}`] = {
                module: 'newalbum.NewAlbumServer',
                method: 'get_new_album_info',
                param: { area: i, start: 0, num: perArea },
            };
        }
    }
    else if (type === 'random') {
        // [随机推荐] area 1-6 随机抽取和组合
        for (let i = 1; i <= 6; i++) {
            payload[`area_${i}`] = {
                module: 'newalbum.NewAlbumServer',
                method: 'get_new_album_info',
                param: { area: i, start: 0, num: perArea },
            };
        }
    }
    else {
        return [];
    }
    try {
        const url = new URL(MUSICU_URL);
        url.searchParams.set('format', 'json');
        url.searchParams.set('data', JSON.stringify(payload));
        // 重试：QQ 推荐接口冷启动/瞬时抖动可能返回空 {}，重试几次可恢复
        let body = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0)
                await new Promise(r => setTimeout(r, 500 * attempt));
            body = (await (0, request_1.httpFetch)(url.toString()).promise).body;
            const hasData = [1, 2, 3, 4, 5, 6].some(i => body?.[`area_${i}`]?.data?.albums?.length);
            if (hasData)
                break;
        }
        let rawList = [];
        // 提取组合结果 (area_1 到 area_6)
        for (let i = 1; i <= 6; i++) {
            const key = `area_${i}`;
            if (body[key]?.data?.albums) {
                rawList.push(...body[key].data.albums);
            }
        }
        // 如果没有多区域数据(兼容旧逻辑或降级情况)
        if (rawList.length === 0) {
            if (body.new_album) {
                rawList = body.new_album.data?.albums || [];
            }
            else if (body.rank) {
                rawList = body.rank.data?.list || [];
            }
        }
        // 针对 random 类型进行打乱，并按请求数量截取
        // （不再固定 30 条，否则客户端滚动一页就到底）
        if (type === 'random') {
            rawList.sort(() => Math.random() - 0.5);
            rawList = rawList.slice(0, size);
        }
        else if (type === 'recent') {
            rawList = rawList.slice(0, size);
        }
        return rawList.map(item => {
            const mid = item.mid || item.album_mid;
            const name = item.name || item.album_name;
            const artist = (item.singers || []).map((s) => s.name).join('、') || item.singer_name || '未知歌手';
            return {
                id: `alb_tx_${mid}`,
                name: name,
                title: name,
                album: name,
                artist: artist,
                artistId: `artist_${artist}`,
                isDir: true,
                coverArt: `alb_tx_${mid}`,
                songCount: 10,
                duration: 3000,
                created: new Date().toISOString(),
                playCount: 0
            };
        });
    }
    catch (e) {
        console.error('[专辑推荐] 获取出错:', e);
        return [];
    }
};
exports.fetchRecommendedAlbums = fetchRecommendedAlbums;
