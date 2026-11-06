/**
 * vh-Atelier · DaVinci Resolve 版 · 轻量波形组件
 *
 * 用途：人声分离结果、语音克隆结果等「结果音频」的试听 + 波形 + 拖拽到时间线。
 * 不依赖 WaveSurfer：直接用 Web Audio 解码算峰值画 canvas，轻、快、无外部实例。
 *
 * 用法：
 *   vhWave.mount(containerEl, filePath, { height, color, onDrag });
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

  /**
   * 把 IPC 返回值解析成 ArrayBuffer。
   * sys:readAudioBuffer 返回 { bytes, sizeBytes }，其中 bytes 是 Buffer
   * （经 contextBridge 变成 Uint8Array）。这里把各种可能形态都兜住。
   */
  function toArrayBuffer(resp) {
    var d = (resp && resp.data !== undefined) ? resp.data : resp;
    if (!d) return null;
    var b = (d.bytes !== undefined) ? d.bytes
          : (d.buffer !== undefined ? d.buffer : d);
    if (!b) return null;
    if (b instanceof ArrayBuffer) return b;
    // TypedArray / Buffer：按自身窗口切出独立的 ArrayBuffer
    if (b.buffer instanceof ArrayBuffer) {
      return b.buffer.slice(b.byteOffset || 0, (b.byteOffset || 0) + (b.byteLength || b.length || 0));
    }
    if (Array.isArray(b)) return new Uint8Array(b).buffer;
    if (typeof b === 'string') {
      try {
        var bin = atob(b);
        var u8 = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return u8.buffer;
      } catch (e) { return null; }
    }
    return null;
  }

  /**
   * 把波形组件挂到 host 元素里。
   * @param {HTMLElement} host 容器（会被清空）
   * @param {string} filePath 音频绝对路径
   * @param {object} opts { height, color, bg, onDrag }
   */
  function mount(host, filePath, opts) {
    opts = opts || {};
    if (!host) return { destroy: function () {} };
    host.innerHTML = '';

    var height = opts.height || 56;
    var color = opts.color || '#7fd68b';
    var bg = opts.bg || '#1c1c1c';

    var wrap = h('div', 'display:flex;align-items:center;gap:8px;width:100%;');
    var play = h('button', 'flex:0 0 auto;width:30px;height:30px;border-radius:50%;border:none;'
      + 'background:#2f4a34;color:#9fe0a8;cursor:pointer;font-size:13px;line-height:1;', '▶');
    play.type = 'button';
    play.title = '试听';
    var canvas = h('canvas', 'flex:1 1 auto;min-width:0;height:' + height + 'px;background:' + bg
      + ';border-radius:5px;cursor:pointer;display:block;');
    canvas.width = 600;
    canvas.height = height * 2;   // 2x 便于清晰
    canvas.style.height = height + 'px';
    var time = h('span', 'flex:0 0 auto;font-size:10.5px;color:#8a8a8a;'
      + 'font-variant-numeric:tabular-nums;min-width:64px;text-align:right;', '0:00 / 0:00');
    var dragHint = h('span', 'flex:0 0 auto;font-size:10.5px;color:#6a6a6a;cursor:grab;', '⠿');

    wrap.appendChild(play);
    wrap.appendChild(canvas);
    wrap.appendChild(time);
    wrap.appendChild(dragHint);
    host.appendChild(wrap);

    var ctx = canvas.getContext('2d');
    var peaks = null;
    var audio = null;
    var url = null;
    var playing = false;

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
      // 播放进度线
      if (progress != null) {
        ctx.fillStyle = '#ffd76a';
        ctx.fillRect(Math.min(W - 1, progress * W), 0, 1.5, H);
      }
    }

    function setIco() {
      play.textContent = playing ? '⏸' : '▶';
      play.style.background = playing ? '#4a3a2f' : '#2f4a34';
      play.style.color = playing ? '#ffd76a' : '#9fe0a8';
    }

    function onTime() {
      if (!audio) return;
      var d = audio.duration || 0, c = audio.currentTime || 0;
      time.textContent = fmtSec(c) + ' / ' + fmtSec(d);
      draw(d ? c / d : 0);
    }

    // 1) 画个占位
    draw(null);

    // 2) 读数 → 解码 → 算峰值
    (function load() {
      if (!window.vhHost || !window.vhHost.readAudioBuffer) return;
      window.vhHost.readAudioBuffer(filePath).then(function (r) {
        var ab = toArrayBuffer(r);
        if (!ab) return;
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        var ac = new AC();
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
          // 顺带把播放时长显示出来
          time.textContent = '0:00 / ' + fmtSec(audioBuf.duration);
          try { ac.close(); } catch (e) {}
        }, function () { /* 解码失败保持占位 */ });
      }).catch(function () { /* 忽略 */ });
    })();

    // 3) 播放（用 blob URL，dataURL 对 wav 太长会被拒）
    function ensureAudio() {
      if (audio) return Promise.resolve(audio);
      return window.vhHost.readAudioBuffer(filePath).then(function (r) {
        var ab = toArrayBuffer(r);
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
          .catch(function (e) { console.warn('[wave] play', e); });
      }).catch(function (e) { console.warn('[wave]', e); });
    });

    canvas.addEventListener('click', function (e) {
      if (!audio || !audio.duration) return;
      var r = canvas.getBoundingClientRect();
      audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * audio.duration;
      onTime();
    });

    // 4) 拖拽到时间线
    wrap.draggable = true;
    wrap.addEventListener('dragstart', function (e) {
      e.preventDefault();
      if (window.vhHost && window.vhHost.startDrag) {
        window.vhHost.startDrag(filePath);
        if (opts.onDrag) opts.onDrag();
      }
    });
    dragHint.addEventListener('mousedown', function () {
      if (window.vhHost && window.vhHost.startDrag) window.vhHost.startDrag(filePath);
    });

    return {
      destroy: function () {
        try { if (audio) audio.pause(); } catch (e) {}
        if (url) { try { URL.revokeObjectURL(url); } catch (e) {} }
        host.innerHTML = '';
      }
    };
  }

  window.vhWave = { mount: mount };
})();
