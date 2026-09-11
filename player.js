/**
 * player.js — Shared Karaoke playback engine
 *
 * Direct port of the playback flow from karaoke-booth.html (classic).
 * Same oncanplay pattern, same YouTube IFrame Player API, same diagnostic
 * error logging — just wrapped in a class so both booths can use it.
 *
 * Window globals exported:
 *   KaraokePlayer    — owns audio/video/canvas/yt-iframe, plays songs
 *   CDGRenderer      — graphics-only CDG renderer driven by a clock fn
 *   SecondScreenSync — receiver helper for the bar/stage display
 *
 * Why a clock function on CDGRenderer?  The original CDG read timing from
 * <audio>.currentTime.  On the second screen the audio is muted and can be
 * autoplay-blocked, freezing currentTime at 0 and leaving the canvas blank.
 * Decoupling the renderer from the media element lets the second screen
 * drive timing from interpolated sync messages instead.
 */
(function () {
  'use strict';

  var SYNC_CHANNEL = 'karaoke-screen-sync';

  // ============================================================
  // Jungle — Web Audio pitch shifter (key change without tempo change).
  // Direct port of Chris Wilson's algorithm via classic karaoke-booth.html
  // lines 2589-2680.  Two crossfaded delay lines ramping in opposite
  // directions; gives a true pitch shift that leaves tempo at 1.0.
  // ============================================================
  var _JUNGLE_DELAY = 0.050, _JUNGLE_FADE = 0.0125, _JUNGLE_BUF = 0.025;

  function _createFadeBuffer(ctx, activeTime, fadeTime) {
    var length1 = activeTime * ctx.sampleRate;
    var length2 = (activeTime - 2 * fadeTime) * ctx.sampleRate;
    var length  = length1 + length2;
    var buf = ctx.createBuffer(1, length, ctx.sampleRate);
    var p = buf.getChannelData(0);
    var fadeLen = fadeTime * ctx.sampleRate;
    var f1 = fadeLen, f2 = length1 - fadeLen;
    for (var i = 0; i < length1; ++i) {
      if (i < f1)       p[i] = Math.sqrt(i / fadeLen);
      else if (i >= f2) p[i] = Math.sqrt(1 - (i - f2) / fadeLen);
      else              p[i] = 1;
    }
    return buf;
  }
  function _createDelayTimeBuffer(ctx, activeTime, fadeTime, shiftUp) {
    var length1 = activeTime * ctx.sampleRate;
    var length  = length1 + (activeTime - 2 * fadeTime) * ctx.sampleRate;
    var buf = ctx.createBuffer(1, length, ctx.sampleRate);
    var p = buf.getChannelData(0);
    for (var i = 0; i < length1; ++i) {
      p[i] = shiftUp ? (length1 - i) / length : i / length1;
    }
    return buf;
  }
  function Jungle(ctx) {
    this.input  = ctx.createGain();
    this.output = ctx.createGain();
    var shiftDown = _createDelayTimeBuffer(ctx, _JUNGLE_BUF, _JUNGLE_FADE, false);
    var shiftUp   = _createDelayTimeBuffer(ctx, _JUNGLE_BUF, _JUNGLE_FADE, true);
    var fadeBuf   = _createFadeBuffer(ctx, _JUNGLE_BUF, _JUNGLE_FADE);
    var m1 = ctx.createBufferSource(), m2 = ctx.createBufferSource();
    var m3 = ctx.createBufferSource(), m4 = ctx.createBufferSource();
    m1.buffer = shiftDown; m2.buffer = shiftDown;
    m3.buffer = shiftUp;   m4.buffer = shiftUp;
    m1.loop = m2.loop = m3.loop = m4.loop = true;
    var mg1 = ctx.createGain(), mg2 = ctx.createGain();
    var mg3 = ctx.createGain(), mg4 = ctx.createGain();
    mg2.gain.value = 0; mg4.gain.value = 0;
    m1.connect(mg1); m2.connect(mg2); m3.connect(mg3); m4.connect(mg4);
    var modG1 = ctx.createGain(), modG2 = ctx.createGain();
    var d1 = ctx.createDelay(), d2 = ctx.createDelay();
    mg1.connect(modG1); mg2.connect(modG2); mg3.connect(modG1); mg4.connect(modG2);
    modG1.connect(d1.delayTime); modG2.connect(d2.delayTime);
    var f1 = ctx.createBufferSource(), f2 = ctx.createBufferSource();
    f1.buffer = fadeBuf; f2.buffer = fadeBuf;
    f1.loop = true; f2.loop = true;
    var mix1 = ctx.createGain(), mix2 = ctx.createGain();
    mix1.gain.value = 0; mix2.gain.value = 0;
    f1.connect(mix1.gain); f2.connect(mix2.gain);
    this.input.connect(d1); this.input.connect(d2);
    d1.connect(mix1); d2.connect(mix2);
    mix1.connect(this.output); mix2.connect(this.output);
    var t  = ctx.currentTime + 0.050;
    var t2 = t + _JUNGLE_BUF - _JUNGLE_FADE;
    m1.start(t);  m3.start(t);  f1.start(t);
    m2.start(t2); m4.start(t2); f2.start(t2);
    this.modG1 = modG1; this.modG2 = modG2;
    this.mg1 = mg1; this.mg2 = mg2; this.mg3 = mg3; this.mg4 = mg4;
    this.setSemitones(0);
  }
  Jungle.prototype._setDelay = function (d) {
    this.modG1.gain.setTargetAtTime(0.5 * d, 0, 0.010);
    this.modG2.gain.setTargetAtTime(0.5 * d, 0, 0.010);
  };
  Jungle.prototype.setSemitones = function (semi) {
    if (!semi) {
      this.mg1.gain.value = this.mg2.gain.value = 0;
      this.mg3.gain.value = this.mg4.gain.value = 0;
      this._setDelay(0);
      return;
    }
    var mult = Math.pow(2, semi / 12) - 1;
    if (mult > 0) {
      this.mg1.gain.value = this.mg2.gain.value = 0;
      this.mg3.gain.value = this.mg4.gain.value = 1;
    } else {
      this.mg1.gain.value = this.mg2.gain.value = 1;
      this.mg3.gain.value = this.mg4.gain.value = 0;
    }
    this._setDelay(_JUNGLE_DELAY * Math.abs(mult));
  };

  // ============================================================
  // CDGRenderer — pure renderer.  Caller supplies clockFn().
  // setTimeout-based instead of requestAnimationFrame so the second
  // screen (rarely focused) doesn't get throttled to ~1Hz.
  // ============================================================
  class CDGRenderer {
    constructor() {
      this.W = 300; this.H = 216;
      this.data = null;
      this.packets = 0;
      this.pos = 0;
      this.colors = new Uint32Array(16);
      this.pixels = new Uint8ClampedArray(this.W * this.H * 4);
      this.indexBuf = new Uint8Array(this.W * this.H);
      this.imageData = null;
      this.transparent = -1;
      this.timerId = null;
      this.running = false;
      this.canvas = null;
      this.ctx = null;
      this.clockFn = null;
      this.audioEl = null;   // optional fallback
    }

    attach(canvas) {
      this.canvas = canvas;
      canvas.width = this.W;
      canvas.height = this.H;
      this.ctx = canvas.getContext('2d');
      this.imageData = new ImageData(this.pixels, this.W, this.H);
    }

    /** Load raw .cdg ArrayBuffer.  audioEl is an optional fallback timing source. */
    load(arrayBuffer, audioEl) {
      this.data = new Uint8Array(arrayBuffer);
      this.packets = Math.floor(this.data.length / 24);
      this.audioEl = audioEl || null;
      this._reset();
      console.log('[CDG] loaded', this.packets, 'packets —',
                  (this.packets / 75).toFixed(1) + 's');
    }

    setClock(fn) { this.clockFn = fn; }

    _reset() {
      this.pos = 0;
      this.transparent = -1;
      this.colors.fill(0);
      this.pixels.fill(0);
      this.indexBuf.fill(0);
    }

    start() {
      this.running = true;
      if (this.timerId) clearTimeout(this.timerId);
      this._tick();
    }

    pause() {
      this.running = false;
      if (this.timerId) { clearTimeout(this.timerId); this.timerId = null; }
    }

    stop() {
      this.pause();
      if (this.canvas) this.canvas.style.display = 'none';
    }

    seek(t) {
      var target = Math.floor(t * 75);
      if (target < this.pos) this._reset();
      while (this.pos < target && this.pos < this.packets) this._processPacket(this.pos++);
      if (this.ctx && this.imageData) this.ctx.putImageData(this.imageData, 0, 0);
    }

    _tick() {
      if (!this.running) return;
      var self = this;
      this.timerId = setTimeout(function () { self._tick(); }, 16);
      if (!this.data) return;
      var t;
      if (this.clockFn) t = this.clockFn();
      else if (this.audioEl) t = this.audioEl.currentTime;
      else return;
      if (t == null || isNaN(t)) return;
      var target = Math.floor(t * 75);
      if (target <= this.pos) return;
      var changed = false;
      while (this.pos < target && this.pos < this.packets) {
        this._processPacket(this.pos++);
        changed = true;
      }
      if (changed && this.ctx && this.imageData) {
        this.ctx.putImageData(this.imageData, 0, 0);
      }
    }

    _processPacket(idx) {
      var o = idx * 24;
      if ((this.data[o] & 0x3F) !== 9) return;
      switch (this.data[o + 1] & 0x3F) {
        case 1:  this._memPreset(o);    break;
        case 2:  this._borderPreset(o); break;
        case 6:  this._tile(o, false);  break;
        case 20: this._scroll(o, false);break;
        case 24: this._scroll(o, true); break;
        case 28: this.transparent = this.data[o + 4] & 0x0F; break;
        case 30: this._loadColors(o, 0);break;
        case 31: this._loadColors(o, 8);break;
        case 38: this._tile(o, true);   break;
      }
    }

    _setPixel(x, y, ci) {
      if (x < 0 || x >= this.W || y < 0 || y >= this.H) return;
      var p = (y * this.W + x) * 4;
      var rgb = this.colors[ci];
      this.pixels[p]     = (rgb >> 16) & 0xFF;
      this.pixels[p + 1] = (rgb >>  8) & 0xFF;
      this.pixels[p + 2] =  rgb        & 0xFF;
      this.pixels[p + 3] = 255;
      this.indexBuf[y * this.W + x] = ci;
    }

    _memPreset(o) {
      if (this.data[o + 5] & 0x0F) return;
      var ci = this.data[o + 4] & 0x0F;
      var rgb = this.colors[ci];
      var r = (rgb >> 16) & 0xFF, g = (rgb >> 8) & 0xFF, b = rgb & 0xFF;
      for (var i = 0; i < this.W * this.H; i++) {
        var p = i * 4;
        this.pixels[p] = r; this.pixels[p + 1] = g;
        this.pixels[p + 2] = b; this.pixels[p + 3] = 255;
        this.indexBuf[i] = ci;
      }
    }

    _borderPreset(o) {
      var ci = this.data[o + 4] & 0x0F;
      for (var y = 0;   y < 12;  y++) for (var x = 0; x < this.W; x++) this._setPixel(x, y, ci);
      for (var y = 204; y < 216; y++) for (var x = 0; x < this.W; x++) this._setPixel(x, y, ci);
      for (var y = 0;   y < this.H; y++) for (var x = 0;   x < 6;   x++) this._setPixel(x, y, ci);
      for (var y = 0;   y < this.H; y++) for (var x = 294; x < 300; x++) this._setPixel(x, y, ci);
    }

    _tile(o, isXOR) {
      var ci0 = this.data[o + 4] & 0x0F;
      var ci1 = this.data[o + 5] & 0x0F;
      var row = this.data[o + 6] & 0x1F;
      var col = this.data[o + 7] & 0x3F;
      var px = col * 6, py = row * 12;
      for (var tRow = 0; tRow < 12; tRow++) {
        var byte = this.data[o + 8 + tRow] & 0x3F;
        for (var tCol = 0; tCol < 6; tCol++) {
          var bit = (byte >> (5 - tCol)) & 1;
          var x = px + tCol, y = py + tRow;
          var ci = isXOR
            ? (this.indexBuf[y * this.W + x] ^ (bit ? ci1 : ci0))
            : (bit ? ci1 : ci0);
          this._setPixel(x, y, ci);
        }
      }
    }

    _loadColors(o, start) {
      for (var i = 0; i < 8; i++) {
        var b1 = this.data[o + 4 + i * 2];
        var b2 = this.data[o + 4 + i * 2 + 1];
        var r4 = (b1 >> 2) & 0x0F;
        var g4 = ((b1 & 0x03) << 2) | ((b2 >> 4) & 0x03);
        var b4 = b2 & 0x0F;
        this.colors[start + i] = ((r4 * 17) << 16) | ((g4 * 17) << 8) | (b4 * 17);
      }
      for (var i2 = 0; i2 < this.W * this.H; i2++) {
        var ci = this.indexBuf[i2];
        if (ci >= start && ci < start + 8) {
          var p = i2 * 4;
          var rgb = this.colors[ci];
          this.pixels[p]     = (rgb >> 16) & 0xFF;
          this.pixels[p + 1] = (rgb >>  8) & 0xFF;
          this.pixels[p + 2] =  rgb        & 0xFF;
          this.pixels[p + 3] = 255;
        }
      }
    }

    _scroll(o, copy) {
      var ci = this.data[o + 4] & 0x0F;
      var hScroll = this.data[o + 5] & 0x3F;
      var vScroll = this.data[o + 6] & 0x3F;
      var hCmd = (hScroll >> 4) & 0x03;
      var vCmd = (vScroll >> 4) & 0x03;
      if (!hCmd && !vCmd) return;
      var dx = hCmd === 1 ? 6 : hCmd === 2 ? -6 : 0;
      var dy = vCmd === 1 ? 12 : vCmd === 2 ? -12 : 0;
      var W = this.W, H = this.H;
      var newPix = new Uint8ClampedArray(this.pixels.length);
      var newIdx = new Uint8Array(this.indexBuf.length);
      var rgb = this.colors[ci];
      var fr = (rgb >> 16) & 0xFF, fg = (rgb >> 8) & 0xFF, fb = rgb & 0xFF;
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          var sx = x - dx, sy = y - dy;
          var di = (y * W + x) * 4;
          if (copy) {
            var sxw = ((sx % W) + W) % W;
            var syh = ((sy % H) + H) % H;
            var si = (syh * W + sxw) * 4;
            newPix[di]=this.pixels[si]; newPix[di+1]=this.pixels[si+1];
            newPix[di+2]=this.pixels[si+2]; newPix[di+3]=255;
            newIdx[y * W + x] = this.indexBuf[syh * W + sxw];
          } else if (sx < 0 || sx >= W || sy < 0 || sy >= H) {
            newPix[di]=fr; newPix[di+1]=fg; newPix[di+2]=fb; newPix[di+3]=255;
            newIdx[y * W + x] = ci;
          } else {
            var si2 = (sy * W + sx) * 4;
            newPix[di]=this.pixels[si2]; newPix[di+1]=this.pixels[si2+1];
            newPix[di+2]=this.pixels[si2+2]; newPix[di+3]=255;
            newIdx[y * W + x] = this.indexBuf[sy * W + sx];
          }
        }
      }
      this.pixels.set(newPix);
      this.indexBuf.set(newIdx);
    }
  }

  // ============================================================
  // KaraokePlayer — direct port of playNext() / createYTPlayer() /
  // restartSong() / skip() from karaoke-booth.html.  Same flow,
  // same oncanplay pattern, same diagnostic error logging.
  // ============================================================
  class KaraokePlayer {
    /**
     * opts: {
     *   videoEl, audioEl, cdgCanvas,
     *   ytContainer    — a DIV that the YT IFrame Player will render into,
     *                    OR an iframe element (we'll wrap a div around it).
     *                    Optional — pass null and YT songs will be no-op.
     *   broadcast      (default true) — open BroadcastChannel for second screen
     *   errorElement   (optional)     — DOM element to display load errors in
     * }
     */
    constructor(opts) {
      this.video      = opts.videoEl     || null;
      this.audio      = opts.audioEl     || null;
      this.cdgCanvas  = opts.cdgCanvas   || null;
      // Accept either ytContainer (preferred — a div) or ytIframe (legacy).
      this.ytContainer= opts.ytContainer || opts.ytIframe || null;
      this.errorEl    = opts.errorElement|| null;

      this.cdg = new CDGRenderer();
      if (this.cdgCanvas) this.cdg.attach(this.cdgCanvas);

      this.currentSong = null;
      this._volume = 1.0;
      this._muted  = false;

      this.handlers = {
        play: [], pause: [], ended: [], error: [],
        timeupdate: [], songchange: [], canplay: [],
        multiplexchange: []
      };

      // Multiplex (vocals on/off) state — see _setupMultiplex below.
      // Detected per-song from filename; reset on each new song.
      this.hasMultiplex = false;
      this._vocalsOn = false;     // false = music-only (instrumental)
      this._audioCtx = null;
      this._mediaSrc = null;       // MediaElementSourceNode (one-shot per element)
      this._mediaSrcEl = null;
      this._gainMusicL = null;
      this._gainMusicR = null;
      this._gainVocalsR = null;
      this._multiplexReady = false;

      // Pitch shifter state (Jungle nodes wired into the video and audio
      // graphs — see _setupVideoPitch / _setupAudioPitch below).  Auto-reset
      // to 0 semitones on each new song so the next user starts in key.
      this._pitchSemitones = 0;
      this._jungleVideo = null;
      this._jungleAudio = null;
      this._audioPitchCtx = null;
      this._audioPitchSrc = null;
      this._audioPitchEl  = null;

      // YT state
      this._ytPlayer = null;
      this._ytPlayerReady = false;
      this._ytApiLoaded = false;

      // Sync to second screen
      this._channel = null;
      if (opts.broadcast !== false) {
        try { this._channel = new BroadcastChannel(SYNC_CHANNEL); } catch (e) {}
      }
      this._syncTimerId = null;
      this._lastSyncSent = 0;
      this._wireMediaEvents();
      this._startSyncLoop();
    }

    on(event, fn) {
      (this.handlers[event] = this.handlers[event] || []).push(fn);
      return this;
    }

    _emit(event /*, ...args */) {
      var args = Array.prototype.slice.call(arguments, 1);
      var list = this.handlers[event] || [];
      for (var i = 0; i < list.length; i++) {
        try { list[i].apply(null, args); }
        catch (e) { console.error('[Player] handler error', event, e); }
      }
    }

    _wireMediaEvents() {
      var self = this;
      function onEnded() {
        console.log('[Player] media ended');
        self._emit('ended', self.currentSong);
      }
      if (this.video) {
        this.video.addEventListener('ended', onEnded);
        this.video.addEventListener('play',  function () { self._emit('play',  self.currentSong); });
        this.video.addEventListener('pause', function () { self._emit('pause', self.currentSong); });
      }
      if (this.audio) {
        this.audio.addEventListener('ended', onEnded);
        this.audio.addEventListener('play',  function () { self._emit('play',  self.currentSong); });
        this.audio.addEventListener('pause', function () { self._emit('pause', self.currentSong); });
      }
    }

    // ── YouTube IFrame Player API setup (ported from createYTPlayer) ─
    _loadYouTubeAPI(cb) {
      if (this._ytApiLoaded || (window.YT && window.YT.Player)) {
        this._ytApiLoaded = true;
        cb();
        return;
      }
      // Combine our callback with any existing one
      var prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (prev) try { prev(); } catch (e) {}
      };
      var s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
      this._ytApiLoaded = true;
      var poll = setInterval(function () {
        if (window.YT && window.YT.Player) { clearInterval(poll); cb(); }
      }, 100);
    }

    _createYTPlayer(videoId) {
      var self = this;
      var container = this.ytContainer;
      if (!container) {
        console.warn('[Player] no YT container; YT playback unavailable');
        this._emit('error', new Error('YouTube not configured'));
        return;
      }
      // If container is an iframe, replace with a div the YT API can hijack.
      if (container.tagName === 'IFRAME') {
        var div = document.createElement('div');
        div.id = container.id || 'kk-yt-host';
        div.style.cssText = container.style.cssText;
        container.replaceWith(div);
        container = div;
        this.ytContainer = div;
      }

      // Reuse existing player if ready
      if (this._ytPlayer && this._ytPlayerReady) {
        try { this._ytPlayer.loadVideoById(videoId); container.style.display = 'block'; return; }
        catch (e) {}
      }
      // Destroy & recreate
      if (this._ytPlayer) {
        try { this._ytPlayer.destroy(); } catch (e) {}
        this._ytPlayer = null;
        this._ytPlayerReady = false;
      }
      // Fresh inner
      container.innerHTML = '<div id="kk-yt-inner"></div>';
      container.style.display = 'block';

      this._loadYouTubeAPI(function () {
        self._ytPlayer = new window.YT.Player('kk-yt-inner', {
          videoId: videoId,
          width: '100%', height: '100%',
          playerVars: { autoplay: 1, rel: 0, modestbranding: 1, controls: 0,
                        disablekb: 1, fs: 0, iv_load_policy: 3 },
          events: {
            onReady: function () {
              self._ytPlayerReady = true;
              try {
                if (self._muted) self._ytPlayer.mute();
                else { self._ytPlayer.unMute(); self._ytPlayer.setVolume(Math.round(self._volume * 100)); }
              } catch (e) {}
              self._emit('play', self.currentSong);
            },
            onStateChange: function (e) {
              // YT.PlayerState: -1=unstarted 0=ENDED 1=playing 2=paused 3=buffering 5=cued
              if (e.data === 0) {
                console.log('[Player] YT ended');
                self._emit('ended', self.currentSong);
              } else if (e.data === 1) {
                self._emit('play', self.currentSong);
              } else if (e.data === 2) {
                self._emit('pause', self.currentSong);
              }
            }
          }
        });
      });
    }

    _hideYT() {
      if (this.ytContainer) this.ytContainer.style.display = 'none';
      // Don't destroy — destroying YT.Player on every song change is slow.
      // Calling stopVideo is enough; loadVideoById will reuse on next YT song.
      if (this._ytPlayer && this._ytPlayerReady) {
        try { this._ytPlayer.stopVideo(); } catch (e) {}
      }
    }

    /**
     * Play a song.  Direct port of playNext() body from karaoke-booth.html.
     * Returns immediately; `play` / `error` events fire asynchronously.
     */
    play(song) {
      if (!song) return Promise.resolve();
      console.log('[Player] play:', song.title || song.filename, '/ type=' + (song.type || '?'),
                  song.cdgFile ? '(+ cdg ' + song.cdgFile + ')' : '');

      this.currentSong = song;
      // Auto-reset pitch on every new song — mirrors v1's skip() behaviour
      // so the next singer doesn't inherit the previous person's key change.
      if (this._pitchSemitones !== 0) this.setPitch(0);
      this._emit('songchange', song);

      var v = this.video, a = this.audio;
      var isYT = !!(song.isYouTube || song.isYt);

      if (isYT) {
        if (v) { v.pause(); v.removeAttribute('src'); v.style.display = 'none'; }
        if (a) { a.pause(); a.removeAttribute('src'); }
        this.cdg.stop();
        if (this.cdgCanvas) this.cdgCanvas.style.display = 'none';
        this._createYTPlayer(song.ytId);
        return Promise.resolve();
      }

      // Hide YT for local songs
      this._hideYT();

      if (!song.filename) {
        var err = new Error('Song has no filename and is not a YouTube track');
        console.warn('[Player]', err.message, song);
        this._emit('error', err);
        return Promise.resolve();
      }

      var isAudioOnly = song.type === 'cdg' || song.type === 'audio';

      if (isAudioOnly) {
        return this._playAudioOnly(song);
      } else {
        return this._playVideo(song);
      }
    }

    // ── Audio-only / CDG path (ported lines 2383-2433 of classic) ────
    _playAudioOnly(song) {
      var self = this;
      var a = this.audio, v = this.video;
      if (!a) {
        this._emit('error', new Error('No audio element configured'));
        return Promise.resolve();
      }
      if (v) { v.pause(); v.removeAttribute('src'); v.style.display = 'none'; }
      // Stop previous CDG renderer
      this.cdg.stop();

      var audioUrl = '/songs/' + encodeURIComponent(song.filename);
      console.log('[Player] loading audio:', audioUrl);

      // Reset event handlers cleanly (classic pattern)
      a.oncanplay = null;
      a.onerror = function () {
        var err = a.error || {};
        var codeMap = { 1:'MEDIA_ERR_ABORTED', 2:'MEDIA_ERR_NETWORK',
                        3:'MEDIA_ERR_DECODE',  4:'MEDIA_ERR_SRC_NOT_SUPPORTED' };
        var diag = 'code=' + (err.code || '?') + ' ' + (codeMap[err.code] || '') +
                   ' | msg=' + (err.message || 'none') +
                   ' | url=' + audioUrl +
                   ' | network=' + a.networkState +
                   ' | ready=' + a.readyState;
        console.error('[Player] audio load error:', diag);
        // HEAD-check the URL so we can tell server/network from codec issues.
        fetch(audioUrl, { method: 'HEAD' })
          .then(function (r) { console.error('[Player] HEAD', r.status, r.statusText, 'ct=' + r.headers.get('content-type')); })
          .catch(function (e) { console.error('[Player] HEAD failed:', e); });
        if (self.errorEl) {
          self.errorEl.style.display = 'flex';
          self.errorEl.innerHTML = 'Failed to load<br><span style="font-size:0.6rem;opacity:0.7">' + diag + '</span>';
        }
        self._emit('error', err);
      };
      a.oncanplay = function () {
        a.oncanplay = null;
        if (self.errorEl) self.errorEl.style.display = 'none';
        a.play().then(function () {
          console.log('[Player] audio playing OK');
          // Wire Jungle pitch shifter for the audio element on first play.
          // Idempotent — if already wired, just re-applies current pitch.
          self._setupAudioPitch(a);
        }).catch(function (e) {
          console.warn('[Player] audio play error:', e);
          setTimeout(function () {
            a.play().catch(function (e2) { console.warn('[Player] audio retry failed:', e2); });
          }, 500);
        });
        self._emit('canplay', song);
      };

      a.src = audioUrl;
      a.muted = false;
      a.volume = this._muted ? 0 : this._volume;
      a.preload = 'auto';
      a.load();

      // Start CDG renderer if applicable (parallel fetch)
      if (song.type === 'cdg' && song.cdgFile) {
        this._loadCDG(song);
      }

      return Promise.resolve();
    }

    // ── Video path (ported lines 2435-2503 of classic) ────────────────
    _playVideo(song) {
      var self = this;
      var v = this.video, a = this.audio;
      if (!v) {
        this._emit('error', new Error('No video element configured'));
        return Promise.resolve();
      }
      if (a) { a.pause(); a.removeAttribute('src'); }
      this.cdg.stop();
      if (this.cdgCanvas) this.cdgCanvas.style.display = 'none';

      // Clear previous video first
      v.pause();
      v.removeAttribute('src');
      v.load();

      var videoUrl = '/songs/' + encodeURIComponent(song.filename);
      console.log('[Player] loading video:', videoUrl);

      v.oncanplay = null;
      v.onstalled = null;
      v.onwaiting = null;
      v.onerror = null;

      v.onerror = function () {
        var err = v.error || {};
        var codeMap = { 1:'MEDIA_ERR_ABORTED', 2:'MEDIA_ERR_NETWORK',
                        3:'MEDIA_ERR_DECODE',  4:'MEDIA_ERR_SRC_NOT_SUPPORTED' };
        var diag = 'code=' + (err.code || '?') + ' ' + (codeMap[err.code] || '') +
                   ' | msg=' + (err.message || 'none') +
                   ' | url=' + videoUrl +
                   ' | network=' + v.networkState +
                   ' | ready=' + v.readyState;
        console.error('[Player] video load error:', diag);
        fetch(videoUrl, { method: 'HEAD' })
          .then(function (r) { console.error('[Player] HEAD', r.status, r.statusText, 'ct=' + r.headers.get('content-type')); })
          .catch(function (e) { console.error('[Player] HEAD failed:', e); });
        if (self.errorEl) {
          self.errorEl.style.display = 'flex';
          self.errorEl.innerHTML = 'Failed to load<br><span style="font-size:0.6rem;opacity:0.7">' + diag + '</span>';
        }
        self._emit('error', err);
      };
      v.onwaiting = function () { console.log('[Player] video waiting for data...'); };
      v.onstalled = function () { console.log('[Player] video stalled'); };
      v.oncanplay = function () {
        v.oncanplay = null;
        if (self.errorEl) self.errorEl.style.display = 'none';
        v.play().then(function () {
          console.log('[Player] video playing OK');
          // Wire the multiplex graph if filename signals it.  Has to wait
          // until oncanplay because createMediaElementSource won't accept
          // an empty/loading element on some Chromium versions.
          self._maybeSetupMultiplex(v, song);
        }).catch(function (e) {
          console.warn('[Player] video play error:', e);
          setTimeout(function () {
            v.play().catch(function (e2) { console.warn('[Player] video retry failed:', e2); });
          }, 500);
        });
        self._emit('canplay', song);
      };

      v.src = videoUrl;
      v.muted = false;
      v.volume = this._muted ? 0 : this._volume;
      v.preload = 'auto';
      v.style.display = 'block';
      v.load();

      return Promise.resolve();
    }

    // ── CDG file fetch + renderer attach (ported lines 2410-2432) ────
    _loadCDG(song) {
      var self = this;
      var cdgUrl = '/songs/' + encodeURIComponent(song.cdgFile);
      var expect = song.cdgFile;
      console.log('[Player] fetching CDG:', cdgUrl);
      fetch(cdgUrl)
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        })
        .then(function (buf) {
          // Bail if song changed mid-fetch
          if (!self.currentSong || self.currentSong.cdgFile !== expect) {
            console.log('[Player] CDG load aborted (song changed)');
            return;
          }
          self.cdg.load(buf, self.audio);
          self.cdg.setClock(function () {
            return self.audio ? self.audio.currentTime : 0;
          });
          if (self.cdgCanvas) self.cdgCanvas.style.display = 'block';
          self.cdg.start();
          console.log('[Player] CDG renderer started');
        })
        .catch(function (e) {
          console.error('[Player] CDG load failed:', e);
          if (self.cdgCanvas) self.cdgCanvas.style.display = 'none';
          self._emit('error', e);
        });
    }

    // ── Transport (ported from restartSong / skip / etc.) ────────────
    pause() {
      console.log('[Player] pause');
      if (this.video) this.video.pause();
      if (this.audio) this.audio.pause();
      this.cdg.pause();
      if (this._ytPlayer && this._ytPlayerReady) {
        try { this._ytPlayer.pauseVideo(); } catch (e) {}
      }
    }

    resume() {
      console.log('[Player] resume');
      var s = this.currentSong;
      if (!s) return;
      if (s.isYouTube || s.isYt) {
        if (this._ytPlayer && this._ytPlayerReady) {
          try { this._ytPlayer.playVideo(); } catch (e) {}
        }
        return;
      }
      var isAudioOnly = s.type === 'cdg' || s.type === 'audio';
      var p = isAudioOnly && this.audio ? this.audio.play()
            : this.video ? this.video.play() : null;
      if (p && p.catch) p.catch(function (e) { console.warn('[Player] resume blocked', e && e.message); });
      if (s.type === 'cdg') this.cdg.start();
    }

    /** Seek (audio/video only — YT seeking via separate API). */
    seek(t) {
      console.log('[Player] seek', t);
      var s = this.currentSong;
      if (!s) return;
      if (s.isYouTube || s.isYt) {
        if (this._ytPlayer && this._ytPlayerReady) {
          try { this._ytPlayer.seekTo(t, true); } catch (e) {}
        }
        return;
      }
      var el = this._activeEl();
      if (el) el.currentTime = t;
      if (s.type === 'cdg') this.cdg.seek(t);
    }

    /** Restart current song from t=0.  Mirrors classic's restartSong(). */
    restart() {
      var s = this.currentSong;
      if (!s) return;
      if (s.isYouTube || s.isYt) {
        if (this._ytPlayer && this._ytPlayerReady) {
          try { this._ytPlayer.seekTo(0, true); this._ytPlayer.playVideo(); } catch (e) {}
        }
        return;
      }
      this.seek(0);
      this.resume();
    }

    /** Stop everything.  Use this when nothing should be playing. */
    stop() {
      console.log('[Player] stop');
      if (this.video) { this.video.pause(); this.video.removeAttribute('src'); this.video.style.display = 'none'; }
      if (this.audio) { this.audio.pause(); this.audio.removeAttribute('src'); }
      this.cdg.stop();
      if (this.cdgCanvas) this.cdgCanvas.style.display = 'none';
      this._hideYT();
      this.currentSong = null;
      if (this._channel) {
        try { this._channel.postMessage({ type: 'stop' }); } catch (e) {}
      }
    }

    setVolume(v) {
      this._volume = Math.max(0, Math.min(1, v));
      if (this.video) this.video.volume = this._muted ? 0 : this._volume;
      if (this.audio) this.audio.volume = this._muted ? 0 : this._volume;
      if (this._ytPlayer && this._ytPlayerReady) {
        try { this._ytPlayer.setVolume(Math.round((this._muted ? 0 : this._volume) * 100)); } catch (e) {}
      }
    }

    setMuted(m) {
      this._muted = !!m;
      this.setVolume(this._volume);
      if (this._ytPlayer && this._ytPlayerReady) {
        try { this._muted ? this._ytPlayer.mute() : this._ytPlayer.unMute(); } catch (e) {}
      }
    }

    _activeEl() {
      var s = this.currentSong;
      if (!s) return null;
      if (s.isYouTube || s.isYt) return null;
      var isAudioOnly = s.type === 'cdg' || s.type === 'audio';
      return isAudioOnly ? this.audio : this.video;
    }

    get currentTime() {
      var s = this.currentSong;
      if (s && (s.isYouTube || s.isYt) && this._ytPlayer && this._ytPlayerReady) {
        try { return this._ytPlayer.getCurrentTime(); } catch (e) { return 0; }
      }
      var e = this._activeEl();
      return e ? e.currentTime : 0;
    }

    get duration() {
      var s = this.currentSong;
      if (s && (s.isYouTube || s.isYt) && this._ytPlayer && this._ytPlayerReady) {
        try { return this._ytPlayer.getDuration(); } catch (e) { return 0; }
      }
      var e = this._activeEl();
      return e ? (e.duration || 0) : 0;
    }

    get paused() {
      var s = this.currentSong;
      if (s && (s.isYouTube || s.isYt) && this._ytPlayer && this._ytPlayerReady) {
        try { return this._ytPlayer.getPlayerState() !== 1; } catch (e) { return true; }
      }
      var e = this._activeEl();
      return e ? e.paused : true;
    }

    // ── Sync loop to second screen ───────────────────────────────────
    _startSyncLoop() {
      if (this._syncTimerId) return;
      var self = this;
      function tick() {
        self._syncTimerId = setTimeout(tick, 100);
        self._broadcast();
      }
      this._syncTimerId = setTimeout(tick, 100);
    }

    // ── Multiplex audio (vocals on/off) ──────────────────────────────
    // Karaoke "multiplex" files have music on the LEFT channel and vocals
    // on the RIGHT.  Default is vocals OFF (music duplicated to both
    // channels).  Toggling vocals on plays the original stereo so the
    // host can demonstrate the song.
    //
    // Caller must ensure the video element has been .play()'d before this
    // runs; createMediaElementSource is fussy about timing in Chromium.
    _maybeSetupMultiplex(videoEl, song) {
      var fn = (song && (song.filename || song.title)) || '';
      var wasMultiplex = this.hasMultiplex;
      this.hasMultiplex = /multiplex/i.test(fn);
      // Reset to vocals OFF on every new song so the host doesn't
      // accidentally start the next track with vocals from the demo.
      this._vocalsOn = false;
      if (wasMultiplex !== this.hasMultiplex || song !== this._lastMultiplexSong) {
        this._emit('multiplexchange', this.hasMultiplex);
        this._lastMultiplexSong = song;
      }
      if (!this.hasMultiplex) {
        // If we'd previously routed through the multiplex graph, just leave
        // gains where they are — the gains for non-multiplex songs default
        // to "stereo passthrough" which is fine.
        return;
      }
      // Build the graph if we haven't already.  MediaElementSource is
      // one-shot per element, so once wired it stays wired.
      if (!this._multiplexReady || this._mediaSrcEl !== videoEl) {
        try {
          if (!this._audioCtx) {
            this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          }
          this._audioCtx.resume().catch(function () {});
          if (this._mediaSrcEl !== videoEl) {
            // Different element — can't rewire.  Bail; user is on a
            // different media element this session.
            if (this._multiplexReady) return;
            this._mediaSrc   = this._audioCtx.createMediaElementSource(videoEl);
            this._mediaSrcEl = videoEl;
          }
          var splitter = this._audioCtx.createChannelSplitter(2);
          var merger   = this._audioCtx.createChannelMerger(2);
          this._gainMusicL  = this._audioCtx.createGain();
          this._gainMusicR  = this._audioCtx.createGain();
          this._gainVocalsR = this._audioCtx.createGain();
          // Pitch shifter (Jungle) sits between the source and the splitter
          // so key changes apply to BOTH the music and vocals channels.
          try {
            this._jungleVideo = new Jungle(this._audioCtx);
            this._mediaSrc.connect(this._jungleVideo.input);
            this._jungleVideo.output.connect(splitter);
            console.log('[Player] Jungle (video) installed');
          } catch (jerr) {
            console.warn('[Player] Jungle init failed; pitch shift will not work on video:', jerr);
            this._jungleVideo = null;
            this._mediaSrc.connect(splitter);
          }
          // Music (ch 0) → left always
          splitter.connect(this._gainMusicL,  0, 0);
          this._gainMusicL.connect(merger, 0, 0);
          // Music (ch 0) → right when vocals OFF
          splitter.connect(this._gainMusicR,  0, 0);
          this._gainMusicR.connect(merger, 0, 1);
          // Vocals (ch 1) → right when vocals ON
          splitter.connect(this._gainVocalsR, 1, 0);
          this._gainVocalsR.connect(merger, 0, 1);
          merger.connect(this._audioCtx.destination);
          this._multiplexReady = true;
          console.log('[Player] multiplex graph wired (L=music, R=vocals)');
        } catch (e) {
          console.warn('[Player] multiplex setup failed:', e);
          return;
        }
      }
      this._applyVocalGains();
    }

    _applyVocalGains() {
      if (!this._gainMusicL) return;
      var on = this._vocalsOn;
      this._gainMusicL.gain.value  = 1;
      this._gainMusicR.gain.value  = on ? 0 : 1;   // music → right when vocals off
      this._gainVocalsR.gain.value = on ? 1 : 0;   // vocals → right when vocals on
    }

    /** Set vocals on/off for multiplex tracks.  No-op if not a multiplex song. */
    setVocalsOn(on) {
      this._vocalsOn = !!on;
      console.log('[Player] vocals', this._vocalsOn ? 'ON' : 'OFF');
      this._applyVocalGains();
    }

    get vocalsOn() { return this._vocalsOn; }

    /**
     * Set pitch in semitones (e.g. -12 to +12).  Drives the Jungle pitch
     * shifter that's wired into the video graph (and the audio pitch graph
     * once that's set up via _setupAudioPitch).  Tempo stays at 1.0.
     */
    setPitch(semi) {
      semi = Number(semi) || 0;
      this._pitchSemitones = semi;
      console.log('[Player] pitch =', semi, 'semitones (ratio',
                  Math.pow(2, semi / 12).toFixed(4) + ')');
      try { if (this._jungleVideo) this._jungleVideo.setSemitones(semi); }
      catch (e) { console.warn('[Player] video pitch err:', e); }
      try { if (this._jungleAudio) this._jungleAudio.setSemitones(semi); }
      catch (e) { console.warn('[Player] audio pitch err:', e); }
      // Tempo sanity-check: playbackRate must stay 1.0 for pitch-only shift.
      if (this.video && this.video.src && this.video.playbackRate !== 1.0) this.video.playbackRate = 1.0;
      if (this.audio && this.audio.src && this.audio.playbackRate !== 1.0) this.audio.playbackRate = 1.0;
    }

    get pitch() { return this._pitchSemitones; }

    /**
     * Wire Jungle into the audio element graph.  Used for CDG / audio-only
     * tracks (the video element has its own Jungle in the multiplex graph).
     * createMediaElementSource is one-shot per element, so once wired this
     * stays wired across songs.
     */
    _setupAudioPitch(audioEl) {
      if (!audioEl) return;
      if (this._audioPitchEl === audioEl && this._jungleAudio) {
        // Already wired — just apply current pitch to the existing Jungle.
        try { this._jungleAudio.setSemitones(this._pitchSemitones); } catch (e) {}
        return;
      }
      if (this._audioPitchEl && this._audioPitchEl !== audioEl) {
        // Different element: can't rewire MediaElementSource.
        try { if (this._jungleAudio) this._jungleAudio.setSemitones(this._pitchSemitones); } catch (e) {}
        return;
      }
      try {
        if (!this._audioPitchCtx) {
          this._audioPitchCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        this._audioPitchCtx.resume().catch(function () {});
        this._audioPitchSrc = this._audioPitchCtx.createMediaElementSource(audioEl);
        this._jungleAudio = new Jungle(this._audioPitchCtx);
        this._audioPitchSrc.connect(this._jungleAudio.input);
        this._jungleAudio.output.connect(this._audioPitchCtx.destination);
        this._audioPitchEl = audioEl;
        try { this._jungleAudio.setSemitones(this._pitchSemitones); } catch (e) {}
        console.log('[Player] Jungle (audio) installed on <audio>');
      } catch (e) {
        console.warn('[Player] _setupAudioPitch failed; CDG/MP3 pitch will not work:', e);
      }
    }

    _broadcast() {
      if (!this._channel || !this.currentSong) return;
      try {
        var s = this.currentSong;
        if (s.isYouTube || s.isYt) {
          this._channel.postMessage({
            type: 'sync', isYouTube: true,
            ytId: s.ytId, title: s.title, artist: s.artist
          });
          return;
        }
        var el = this._activeEl();
        if (!el) return;
        var msg = {
          type: 'sync', isYouTube: false,
          time: el.currentTime,
          paused: el.paused,
          rate: el.playbackRate,
          src: '/songs/' + encodeURIComponent(s.filename),
          songType: s.type || 'video',
          title: s.title, artist: s.artist,
          ts: performance.now()
        };
        if (s.cdgFile) msg.cdgFile = s.cdgFile;
        this._channel.postMessage(msg);
      } catch (e) { /* channel closed */ }
    }
  }

  // ============================================================
  // SecondScreenSync — receiver side.  Drives a muted <audio> for
  // any seek-back-during-pause edge cases, but the CDG renderer is
  // driven from interpolated sync time so it works even when the
  // muted <audio> is autoplay-blocked.
  // ============================================================
  class SecondScreenSync {
    constructor(opts) {
      this.video     = opts.videoEl;
      this.audio     = opts.audioEl;
      this.cdgCanvas = opts.cdgCanvas;
      this.yt        = opts.ytIframe || null;
      this.onIdle    = opts.onIdle  || null;
      this.onPlay    = opts.onPlay  || null;

      this.cdg = new CDGRenderer();
      if (this.cdgCanvas) this.cdg.attach(this.cdgCanvas);
      var self = this;
      this.cdg.setClock(function () { return self._estTime(); });

      this.lastSync = null;
      this.lastSyncAt = 0;
      this.currentSrc = null;
      this.currentCdgFile = null;
      this.currentYtId = null;

      this.channel = null;
      try { this.channel = new BroadcastChannel(SYNC_CHANNEL); } catch (e) {}
      if (this.channel) this.channel.onmessage = function (e) { self.handle(e.data); };
      window.addEventListener('message', function (e) {
        if (e.data && e.data.type) self.handle(e.data);
      });
    }

    _estTime() {
      var s = this.lastSync;
      if (!s) return 0;
      var rate = s.rate || 1;
      var elapsed = (performance.now() - this.lastSyncAt) / 1000;
      return s.time + (s.paused ? 0 : elapsed * rate);
    }

    handle(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'sync') return this._sync(msg);
      if (msg.type === 'stop') return this.stop();
    }

    _sync(msg) {
      this.lastSync = msg;
      this.lastSyncAt = performance.now();

      if (msg.isYouTube) return this._syncYT(msg);
      if (msg.songType === 'cdg' && msg.cdgFile) return this._syncCDG(msg);
      this._syncVideoOrAudio(msg);
    }

    _syncYT(msg) {
      this._stopLocalMedia();
      if (msg.ytId !== this.currentYtId && this.yt) {
        this.currentYtId = msg.ytId;
        this.yt.src = 'https://www.youtube.com/embed/' + msg.ytId
          + '?autoplay=1&rel=0&modestbranding=1&mute=1&controls=0';
        this.yt.style.display = 'block';
      }
      if (this.onPlay) this.onPlay(msg);
    }

    _syncCDG(msg) {
      if (msg.src !== this.currentSrc || msg.cdgFile !== this.currentCdgFile) {
        this.currentSrc = msg.src;
        this.currentCdgFile = msg.cdgFile;
        this.currentYtId = null;
        if (this.yt) { this.yt.src = ''; this.yt.style.display = 'none'; }
        if (this.video) { this.video.pause(); this.video.removeAttribute('src'); this.video.style.display = 'none'; }

        if (this.audio) {
          this.audio.muted = true;
          this.audio.preload = 'auto';
          this.audio.src = msg.src;
          var aud = this.audio;
          aud.load();
          aud.oncanplay = function () {
            aud.oncanplay = null;
            try { aud.currentTime = msg.time || 0; } catch (e) {}
            aud.play().then(function () {
              console.log('[2nd] muted audio playing');
            }).catch(function (e) {
              console.warn('[2nd] muted audio play blocked (CDG still works via clock):', e && e.message);
            });
          };
        }

        var url = '/songs/' + encodeURIComponent(msg.cdgFile);
        var expect = msg.cdgFile;
        var self = this;
        console.log('[2nd] fetching CDG:', url);
        fetch(url)
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.arrayBuffer();
          })
          .then(function (buf) {
            if (self.currentCdgFile !== expect) return;
            self.cdg.load(buf);
            if (self.cdgCanvas) self.cdgCanvas.style.display = 'block';
            self.cdg.start();
            console.log('[2nd] CDG renderer started (clock-driven)');
            if (self.onPlay) self.onPlay(msg);
          })
          .catch(function (e) {
            console.error('[2nd] CDG load failed:', e);
            if (self.cdgCanvas) self.cdgCanvas.style.display = 'none';
          });
      }
    }

    _syncVideoOrAudio(msg) {
      var isAudio = msg.songType === 'audio'
                 || (msg.src && /\.(mp3|wav|ogg|m4a|flac|aac|wma)$/i.test(msg.src));
      if (isAudio) {
        this._stopVideoCDG();
        this.currentSrc = msg.src; this.currentCdgFile = null;
        if (this.onPlay) this.onPlay(msg);
        return;
      }
      if (msg.src !== this.currentSrc && this.video) {
        this.currentSrc = msg.src; this.currentCdgFile = null;
        if (this.audio) { this.audio.pause(); this.audio.removeAttribute('src'); }
        this.cdg.stop();
        if (this.cdgCanvas) this.cdgCanvas.style.display = 'none';
        if (this.yt) { this.yt.src = ''; this.yt.style.display = 'none'; }
        var v = this.video;
        v.style.display = 'block';
        v.muted = true;
        v.preload = 'auto';
        v.src = msg.src;
        v.load();
        v.oncanplay = function () {
          v.oncanplay = null;
          try { v.currentTime = msg.time || 0; } catch (e) {}
          v.play().catch(function (e) {
            console.warn('[2nd] video play blocked:', e && e.message);
          });
        };
        if (this.onPlay) this.onPlay(msg);
      } else if (this.video) {
        var rate = msg.rate || 1;
        var est = msg.time + (msg.paused ? 0 : (performance.now() - this.lastSyncAt) / 1000 * rate);
        var drift = this.video.currentTime - est;
        var ad = Math.abs(drift);
        if (ad >= 0.3) { this.video.currentTime = est; this.video.playbackRate = rate; }
        else if (ad >= 0.05) {
          var corr = Math.min(0.05, ad * 0.2);
          this.video.playbackRate = drift > 0 ? rate - corr : rate + corr;
        } else if (this.video.playbackRate !== rate) this.video.playbackRate = rate;
        if (msg.paused && !this.video.paused) this.video.pause();
        else if (!msg.paused && this.video.paused) this.video.play().catch(function () {});
      }
    }

    _stopLocalMedia() {
      if (this.video) { this.video.pause(); this.video.removeAttribute('src'); this.video.style.display = 'none'; }
      if (this.audio) { this.audio.pause(); this.audio.removeAttribute('src'); }
      this.cdg.stop();
      if (this.cdgCanvas) this.cdgCanvas.style.display = 'none';
      this.currentSrc = null; this.currentCdgFile = null;
    }

    _stopVideoCDG() {
      if (this.video) { this.video.pause(); this.video.removeAttribute('src'); this.video.style.display = 'none'; }
      this.cdg.stop();
      if (this.cdgCanvas) this.cdgCanvas.style.display = 'none';
    }

    stop() {
      this._stopLocalMedia();
      if (this.yt) { this.yt.src = ''; this.yt.style.display = 'none'; }
      this.currentYtId = null;
      this.lastSync = null;
      if (this.onIdle) this.onIdle();
    }
  }

  window.KaraokePlayer    = KaraokePlayer;
  window.CDGRenderer      = CDGRenderer;
  window.SecondScreenSync = SecondScreenSync;
})();
