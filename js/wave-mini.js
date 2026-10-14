/**
 * vh-Atelier · Premiere Pro 版 · 轻量波形组件
 *
 * 移植自达芬奇版（vh-Atelier-Resolve/com.vh.atelier/js/wave-mini.js）。
 * 用途：语音克隆抓取的「参考音频」试听 + 波形 + 播放进度，以及结果音频。
 * 设计：不依赖 WaveSurfer，纯 Web Audio 解码算峰值 + canvas 绘制，轻、快、无全局实例。
 *       与达芬奇版的差别仅在读取实现——PR 侧无 Electron IPC，改用 XHR file:// 取 ArrayBuffer。
 *
 * 用法：
 *   vhWave.mount(containerEl, filePath, { height, color });
 * 返回 { destroy() }。
 */
(function () {
    'use strict';

    function h(tag, css, text) {
        var e = document.createElement(tag);
        if (css) e.style.cssText = css;
        if (text != null) e.textContent = text;
        return e;
    }
    function fmtSec(s) {
        s = Math.max(0, Math.floor(Number(s) || 0));
        return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
    }

    // 读取音频文件为 ArrayBuffer。优先用宿主注入的 __vhReadAudioBlob，
    // 否则自带 XHR。返回 Promise<ArrayBuffer>。
    function readArrayBuffer(filePath) {
        return new Promise(function (resolve, reject) {
            if (typeof window.__vhReadAudioBlob === 'function') {
                window.__vhReadAudioBlob(filePath, function (err, blob) {
                    if (err || !blob) { reject(err || new Error('读取为空')); return; }
                    var fr = new FileReader();
                    fr.onload = function () { resolve(fr.result); };
                    fr.onerror = function () { reject(new Error('转 ArrayBuffer 失败')); };
                    fr.readAsArrayBuffer(blob);
                });
                return;
            }
            try {
                var xhr = new XMLHttpRequest();
                xhr.open('GET', 'file:///' + String(filePath).replace(/\\/g, '/'), true);
                xhr.responseType = 'arraybuffer';
                xhr.onload = function () {
                    if (xhr.status === 0 || xhr.status === 200) resolve(xhr.response);
                    else reject(new Error('读取失败 HTTP ' + xhr.status));
                };
                xhr.onerror = function () { reject(new Error('无法读取音频文件')); };
                xhr.send();
            } catch (e) { reject(e); }
        });
    }

    /**
     * 把波形组件挂到 host 元素里。
     * @param {HTMLElement} host 容器（会被清空）
     * @param {string} filePath 音频绝对路径
     * @param {object} opts { height, color, bg, onDestroy }
     */
    function mount(host, filePath, opts) {
        opts = opts || {};
        if (!host) return { destroy: function () {} };
        host.innerHTML = '';

        var height = opts.height || 48;
        var color = opts.color || '#a07bf7';      // 默认走 PR 主题紫
        var bg = opts.bg || '#1c1c1c';

        var wrap = h('div', 'display:flex;align-items:center;gap:8px;width:100%;');
        var play = h('button', 'flex:0 0 auto;width:28px;height:28px;border-radius:50%;border:none;'
            + 'background:#3a2f4a;color:#c9b6ff;cursor:pointer;font-size:12px;line-height:1;', '\u25b6');
        play.type = 'button';
        play.title = '试听';
        var canvas = h('canvas', 'flex:1 1 auto;min-width:0;height:' + height + 'px;background:' + bg
            + ';border-radius:5px;cursor:pointer;display:block;');
        canvas.width = 600;
        canvas.height = height * 2;   // 2x 便于清晰
        var time = h('span', 'flex:0 0 auto;font-size:10.5px;color:#8a8a8a;'
            + 'font-variant-numeric:tabular-nums;min-width:62px;text-align:right;', '--:-- / --:--');

        wrap.appendChild(play);
        wrap.appendChild(canvas);
        wrap.appendChild(time);
        host.appendChild(wrap);

        var ctx = canvas.getContext('2d');
        var peaks = null;
        var audio = null;
        var url = null;
        var playing = false;
        var ac = null;

        function draw(progress) {
            var W = canvas.width, H = canvas.height;
            ctx.clearRect(0, 0, W, H);
            if (!peaks || !peaks.length) {
                ctx.fillStyle = '#333';
                ctx.fillRect(0, H / 2 - 1, W, 2);
                return;
            }
            var mid = H / 2;
            var step = W / peaks.length;
            for (var i = 0; i < peaks.length; i++) {
                var v = peaks[i];
                var bh = Math.max(2, v * (H * 0.86));
                var x = i * step;
                var played = progress != null && (x / W) <= progress;
                ctx.fillStyle = played ? color : '#4a4a4a';
                ctx.fillRect(x, mid - bh / 2, Math.max(1, step * 0.8), bh);
            }
            if (progress != null) {
                ctx.fillStyle = '#ffd76a';
                ctx.fillRect(Math.min(W - 1, progress * W), 0, 1.5, H);
            }
        }

        function setIco() {
            play.textContent = playing ? '\u23f8' : '\u25b6';
            play.style.background = playing ? '#4a3a2f' : '#3a2f4a';
            play.style.color = playing ? '#ffd76a' : '#c9b6ff';
        }

        function onTime() {
            if (!audio) return;
            var d = audio.duration || 0, c = audio.currentTime || 0;
            time.textContent = fmtSec(c) + ' / ' + fmtSec(d);
            draw(d ? c / d : 0);
        }

        draw(null);   // 占位

        // 解码 → 算峰值
        readArrayBuffer(filePath).then(function (ab) {
            if (!ab) return;
            var AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            ac = new AC();
            ac.decodeAudioData(ab.slice(0), function (audioBuf) {
                var ch = audioBuf.getChannelData(0);
                var N = 600;
                var block = Math.floor(ch.length / N) || 1;
                var out = new Float32Array(N);
                var max = 0;
                for (var i = 0; i < N; i++) {
                    var s = i * block, peak = 0;
                    for (var j = 0; j < block; j += 8) {
                        var v = Math.abs(ch[s + j] || 0);
                        if (v > peak) peak = v;
                    }
                    out[i] = peak;
                    if (peak > max) max = peak;
                }
                if (max > 0) for (var k = 0; k < N; k++) out[k] = out[k] / max;
                peaks = out;
                draw(null);
                time.textContent = '0:00 / ' + fmtSec(audioBuf.duration);
                try { ac.close(); } catch (e) {}
                ac = null;
            }, function () { /* 解码失败保持占位 */ });
        }).catch(function () { /* 忽略 */ });

        function ensureAudio() {
            if (audio) return Promise.resolve(audio);
            return readArrayBuffer(filePath).then(function (ab) {
                if (!ab) throw new Error('读取音频失败');
                var mime = /\.mp3$/i.test(filePath) ? 'audio/mpeg'
                    : /\.m4a$/i.test(filePath) ? 'audio/mp4' : 'audio/wav';
                url = URL.createObjectURL(new Blob([ab], { type: mime }));
                audio = new Audio(url);
                audio.addEventListener('timeupdate', onTime);
                audio.addEventListener('ended', function () { playing = false; setIco(); onTime(); });
                audio.addEventListener('loadedmetadata', onTime);
                return audio;
            });
        }

        play.addEventListener('click', function () {
            ensureAudio().then(function (a) {
                if (playing) { a.pause(); playing = false; setIco(); return; }
                a.play().then(function () { playing = true; setIco(); })
                    .catch(function (e) { console.warn('[vhWave] play', e); });
            }).catch(function (e) { console.warn('[vhWave]', e); });
        });

        canvas.addEventListener('click', function (e) {
            if (!audio || !audio.duration) return;
            var r = canvas.getBoundingClientRect();
            audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * audio.duration;
            onTime();
        });

        return {
            destroy: function () {
                try { if (audio) { audio.pause(); } } catch (e) {}
                if (url) { try { URL.revokeObjectURL(url); } catch (e) {} }
                if (ac) { try { ac.close(); } catch (e) {} }
                host.innerHTML = '';
                if (opts.onDestroy) { try { opts.onDestroy(); } catch (e) {} }
            }
        };
    }

    window.vhWave = { mount: mount };
})();
