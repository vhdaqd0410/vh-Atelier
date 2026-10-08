"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const request_1 = require("../../request");
const index_1 = require("../../index");
const quality_1 = require("./quality");
const getSinger = (singers) => {
    let arr = [];
    singers.forEach(singer => {
        arr.push(singer.name);
    });
    return arr.join('、');
};
exports.default = (songmid) => {
    // [修复] musicu.fcg 现只认 GET + data=URL 编码 JSON（POST 一律返回 {"code":500001}）
    const payload = {
        comm: {
            ct: '19',
            cv: '1859',
            uin: '0',
        },
        req: {
            module: 'music.pf_song_detail_svr',
            method: 'get_song_detail_yqq',
            param: {
                song_type: 0,
                song_mid: songmid,
            },
        },
    };
    // [备用/旧版请求方式 - POST 请求]
    // const requestObj = httpFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    //   method: 'post',
    //   headers: {
    //     'User-Agent': 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)',
    //   },
    //   body: payload,
    // })
    // [当前方式 - GET 请求]
    const requestObj = (0, request_1.httpFetch)(`https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(JSON.stringify(payload))}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)',
        },
    });
    return requestObj.promise.then(({ body }) => {
        // console.log(body)
        if (body.code != 0 || body.req.code != 0)
            return Promise.reject(new Error('获取歌曲信息失败'));
        const item = body.req.data.track_info;
        if (!item.file?.media_mid)
            return null;
        const file = item.file;
        const { types, _types } = (0, quality_1.buildQualitys)(file);
        // types.reverse()
        let albumId = '';
        let albumName = '';
        if (item.album) {
            albumName = item.album.name;
            albumId = item.album.mid;
        }
        return {
            singer: getSinger(item.singer),
            name: item.title,
            albumName,
            albumId,
            source: 'tx',
            interval: (0, index_1.formatPlayTime)(item.interval),
            songId: item.id,
            albumMid: item.album?.mid ?? '',
            strMediaMid: item.file.media_mid,
            songmid: item.mid,
            img: (albumId === '' || albumId === '空')
                ? item.singer?.length ? `https://y.gtimg.cn/music/photo_new/T001R800x800M000${item.singer[0].mid}.jpg` : ''
                : `https://y.gtimg.cn/music/photo_new/T002R800x800M000${albumId}.jpg`,
            types,
            _types,
            typeUrl: {},
        };
    });
};
