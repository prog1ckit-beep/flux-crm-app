/* fan-device.js — единый JS-слой движка ФАН (FanDevice v1).
 * Вживляется движком (Android/iOS/Windows) в верхнюю страницу CRM и сам попадает в same-origin рамки.
 * В обычном браузере работает как web-fallback (ограниченно). Файл идемпотентен: повторный запуск ничего не ломает.
 * Контракт: docs/SPEC-FANDEVICE-v1.md. Код в ООП (закон владельца).
 */
(function (global) {
  'use strict';
  var VERSION = '1.0.11';

  if (global.FanDevice && global.FanDevice.version === VERSION && global.FanDevice._isTop === (global.top === global)) {
    return; // уже вживлён в это окно
  }

  // ---------- ошибки ----------
  function FanDeviceError(code, message, cmd) {
    var e = Error.call(this, message || code);
    this.name = 'FanDeviceError';
    this.code = code;
    this.cmd = cmd || null;
    this.message = message || code;
    this.stack = e.stack;
  }
  FanDeviceError.prototype = Object.create(Error.prototype);
  FanDeviceError.prototype.constructor = FanDeviceError;

  // ---------- транспорты ----------
  /** Транспорт: одна функция call(requestJson) → строка JSON | Promise<строка JSON> | объект. */
  function NativeTransport(fanNative) { this.fanNative = fanNative; }
  NativeTransport.prototype.kind = 'native';
  NativeTransport.prototype.call = function (json) { return this.fanNative.call(json); };

  /** iOS: webkit.messageHandlers.FanNative.postMessage — ответа нет, всё приходит через _deliver. */
  function WebKitTransport(handler) { this.handler = handler; }
  WebKitTransport.prototype.kind = 'webkit';
  WebKitTransport.prototype.call = function (json) {
    this.handler.postMessage(json);
    return '{"ok":true,"pending":true}';
  };

  function detectTransport(g) {
    if (g.FanNative && typeof g.FanNative.call === 'function') return new NativeTransport(g.FanNative);
    var wk = g.webkit && g.webkit.messageHandlers && g.webkit.messageHandlers.FanNative;
    if (wk && typeof wk.postMessage === 'function') return new WebKitTransport(wk);
    return null;
  }

  // ---------- ожидание ответов ----------
  function PendingCalls() { this.map = {}; this.seq = 0; this.salt = Math.random().toString(36).slice(2, 8); }
  PendingCalls.prototype.nextId = function () { this.seq += 1; return this.salt + '-' + this.seq; };
  PendingCalls.prototype.add = function (id, cmd, resolve, reject) { this.map[id] = { cmd: cmd, resolve: resolve, reject: reject }; };
  PendingCalls.prototype.take = function (id) { var p = this.map[id]; delete this.map[id]; return p || null; };
  PendingCalls.prototype.size = function () { return Object.keys(this.map).length; };

  // ---------- события ----------
  function EventBus() { this.handlers = {}; }
  EventBus.prototype.on = function (name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); return fn; };
  EventBus.prototype.off = function (name, fn) {
    var list = this.handlers[name] || [];
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  EventBus.prototype.emit = function (name, data) {
    var list = (this.handlers[name] || []).slice();
    for (var i = 0; i < list.length; i++) {
      try { list[i](data); } catch (e) { if (global.console) console.error('FanDevice event ' + name, e); }
    }
    return list.length;
  };

  // ---------- кодировки ----------
  var Bytes = {
    toBase64: function (u8) {
      if (typeof u8 === 'string') return u8;
      if (global.Buffer) return global.Buffer.from(u8).toString('base64');
      var s = '';
      for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
      return global.btoa(s);
    },
    fromBase64: function (b64) {
      if (global.Buffer) return new Uint8Array(global.Buffer.from(b64, 'base64'));
      var bin = global.atob(b64), u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8;
    },
    blobToBase64: function (blob) {
      return new Promise(function (resolve, reject) {
        var r = new global.FileReader();
        r.onerror = function () { reject(new FanDeviceError('failed', 'FileReader')); };
        r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
        r.readAsDataURL(blob);
      });
    }
  };

  // ---------- web-fallback (обычный браузер) ----------
  function WebFallback(g) { this.g = g; }
  WebFallback.prototype.features = function () {
    var g = this.g, f = ['settings.get', 'app.open', 'files.save', 'camera.photo'];
    if (g.document) f.push('notify.alert', 'notify.toast');
    if (g.navigator && g.navigator.mediaDevices && g.navigator.mediaDevices.enumerateDevices) f.push('camera.list');
    if (g.BarcodeDetector) f.push('camera.scan');
    if (g.Notification) f.push('notify.show');
    if (g.navigator && g.navigator.clipboard) f.push('clipboard.read', 'clipboard.write');
    if (g.navigator && g.navigator.share) f.push('files.share');
    return f;
  };
  WebFallback.prototype.info = function () {
    var ua = (this.g.navigator && this.g.navigator.userAgent) || '';
    return {
      platform: /Android/i.test(ua) ? 'android' : /iPhone|iPad/i.test(ua) ? 'ios' : /Windows/i.test(ua) ? 'windows' : 'web',
      engine: 'browser', version: VERSION, deviceId: null, model: null, features: this.features()
    };
  };
  WebFallback.prototype.call = function (cmd, args) {
    var self = this, g = this.g;
    args = args || {};
    switch (cmd) {
      case 'info': return Promise.resolve(this.info());
      case 'settings.get': return Promise.resolve({ serverUrl: g.location ? g.location.origin : null });
      case 'app.open': g.open(args.url, '_blank', 'noopener'); return Promise.resolve({});
      case 'clipboard.read': return g.navigator.clipboard.readText().then(function (t) { return { text: t }; });
      case 'clipboard.write': return g.navigator.clipboard.writeText(String(args.text || '')).then(function () { return {}; });
      case 'notify.show': return this.notify(args);
      case 'notify.alert': return this.alert(args);
      case 'notify.toast': return this.toast(args);
      case 'camera.photo': return this.photo(args);
      case 'camera.scan': return this.scan(args);
      case 'camera.list': return this.cameras();
      case 'files.save': return this.save(args);
      case 'files.share':
        if (!g.navigator.share) return Promise.reject(new FanDeviceError('unsupported', 'navigator.share', cmd));
        return g.navigator.share({ title: args.name, text: args.text }).then(function () { return {}; });
      default:
        return Promise.reject(new FanDeviceError('unsupported', 'нет в браузере: ' + cmd, cmd));
    }
  };
  WebFallback.prototype.notify = function (args) {
    var g = this.g, N = g.Notification;
    if (!N) return Promise.reject(new FanDeviceError('unsupported', 'Notification', 'notify.show'));
    var show = function () {
      var n = new N(args.title || 'Flux CRM', { body: args.body || '', tag: args.tag });
      if (args.url) n.onclick = function () { g.location.href = args.url; };
      return {};
    };
    if (N.permission === 'granted') return Promise.resolve(show());
    return N.requestPermission().then(function (p) {
      if (p !== 'granted') throw new FanDeviceError('denied', 'уведомления запрещены', 'notify.show');
      return show();
    });
  };
  /** Сообщение на весь экран поверх страницы (там, где движок не умеет поверх всех окон: Android/iOS/браузер). */
  WebFallback.prototype.alert = function (args) {
    var doc = this.g.document;
    if (!doc || !doc.body) return Promise.reject(new FanDeviceError('unsupported', 'нет document', 'notify.alert'));
    return new Promise(function (resolve) {
      var box = doc.createElement('div');
      box.setAttribute('style', 'position:fixed;inset:0;z-index:2147483001;background:#111318;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;font:20px/1.4 system-ui,sans-serif');
      var h = doc.createElement('div'); h.textContent = args.title || 'Flux CRM'; h.setAttribute('style', 'font-size:34px;font-weight:700;margin-bottom:16px;color:#ff4fa3');
      var b = doc.createElement('div'); b.textContent = args.body || ''; b.setAttribute('style', 'max-width:720px;white-space:pre-wrap');
      var btn = doc.createElement('button'); btn.textContent = args.button || 'Закрыть';
      btn.setAttribute('style', 'margin-top:28px;font-size:20px;padding:14px 32px;border:0;border-radius:10px;background:#ff4fa3;color:#fff');
      box.appendChild(h); box.appendChild(b); box.appendChild(btn); doc.body.appendChild(box);
      var timer = null;
      var close = function (how) { if (!box.parentNode) return; clearTimeout(timer); box.remove(); resolve({ closed: how }); };
      btn.onclick = function () { close('button'); };
      if (args.seconds > 0) timer = setTimeout(function () { close('timeout'); }, args.seconds * 1000);
    });
  };
  /** Список камер через браузер (enumerateDevices): подписи появляются после разрешения — просим видео и сразу отпускаем. */
  WebFallback.prototype.cameras = function () {
    var md = this.g.navigator && this.g.navigator.mediaDevices;
    if (!md || !md.enumerateDevices) return Promise.reject(new FanDeviceError('unsupported', 'mediaDevices', 'camera.list'));
    var stop = function (s) { if (s) s.getTracks().forEach(function (t) { t.stop(); }); };
    var grab = md.getUserMedia ? md.getUserMedia({ video: true }).catch(function () { return null; }) : Promise.resolve(null);
    return grab.then(function (stream) {
      return md.enumerateDevices().then(function (list) {
        stop(stream);
        var cams = list.filter(function (d) { return d.kind === 'videoinput'; }).map(function (d, i) {
          var l = d.label || ('Камера ' + (i + 1));
          var facing = /back|rear|environment|задн/i.test(l) ? 'back' : /front|user|face|фронт/i.test(l) ? 'front' : 'unknown';
          return { id: d.deviceId, label: l, facing: facing };
        });
        return { cameras: cams };
      });
    });
  };
  /** Всплывающее уведомление в самой странице (снизу справа, звук через WebAudio) — Android/iOS/браузер; Windows делает нативно. */
  WebFallback.prototype.chime = function () {
    var g = this.g, AC = g.AudioContext || g.webkitAudioContext;
    if (!AC) return;
    try {
      var ctx = new AC(), t0 = ctx.currentTime;
      [[880, 0, 0.16], [1320, 0.16, 0.42]].forEach(function (n) {
        var o = ctx.createOscillator(), gn = ctx.createGain();
        o.type = 'sine'; o.frequency.value = n[0];
        gn.gain.setValueAtTime(0.0001, t0 + n[1]); gn.gain.exponentialRampToValueAtTime(0.5, t0 + n[1] + 0.01); gn.gain.exponentialRampToValueAtTime(0.0001, t0 + n[1] + n[2]);
        o.connect(gn); gn.connect(ctx.destination); o.start(t0 + n[1]); o.stop(t0 + n[1] + n[2] + 0.05);
      });
      setTimeout(function () { ctx.close(); }, 1200);
    } catch (e) { /* без звука */ }
  };
  WebFallback.prototype.toast = function (args) {
    var g = this.g, doc = g.document, self = this;
    if (!doc || !doc.body) return Promise.reject(new FanDeviceError('unsupported', 'нет document', 'notify.toast'));
    var host = doc.getElementById('fan-toasts');
    if (!host) { host = doc.createElement('div'); host.id = 'fan-toasts'; host.setAttribute('style', 'position:fixed;right:12px;bottom:12px;z-index:2147483000;display:flex;flex-direction:column-reverse;gap:8px;max-width:min(360px,92vw)'); doc.body.appendChild(host); }
    return new Promise(function (resolve) {
      var t = doc.createElement('div');
      t.setAttribute('style', 'background:#1b1e27;color:#e8e8ee;border:1px solid #383838;border-left:4px solid #ff3fb4;border-radius:12px;padding:12px 30px 12px 12px;box-shadow:0 10px 30px rgba(0,0,0,.55);font:14px/1.4 system-ui,sans-serif;cursor:pointer;position:relative;transform:translateY(120%);transition:transform .28s cubic-bezier(.2,.8,.2,1),opacity .22s');
      var h = doc.createElement('div'); h.textContent = args.title || 'Flux CRM'; h.setAttribute('style', 'font-weight:700;margin-bottom:2px');
      var b = doc.createElement('div'); b.textContent = args.body || ''; b.setAttribute('style', 'color:#c9cbd6;white-space:pre-wrap;word-break:break-word');
      var x = doc.createElement('div'); x.textContent = '✕'; x.setAttribute('style', 'position:absolute;top:6px;right:10px;color:#8a8fa3;font-size:16px');
      t.appendChild(h); t.appendChild(b); t.appendChild(x); host.appendChild(t);
      g.requestAnimationFrame(function () { t.style.transform = 'translateY(0)'; });
      var done = false, timer = null;
      var close = function (how) { if (done) return; done = true; clearTimeout(timer); t.style.opacity = '0'; t.style.transform = 'translateY(120%)'; setTimeout(function () { t.remove(); }, 250); resolve({ closed: how }); };
      t.addEventListener('click', function () { close('click'); if (args.url) g.location.href = args.url; });
      x.addEventListener('click', function (e) { e.stopPropagation(); close('x'); });
      if (args.sound !== false) self.chime();
      var s = args.seconds == null ? 6 : Number(args.seconds) || 0;
      if (s > 0) timer = setTimeout(function () { close('timeout'); }, s * 1000);
    });
  };
  WebFallback.prototype.pickFile = function (accept, capture) {
    var doc = this.g.document;
    return new Promise(function (resolve, reject) {
      var input = doc.createElement('input');
      input.type = 'file'; input.accept = accept; if (capture) input.capture = capture;
      input.style.display = 'none';
      input.onchange = function () { var f = input.files && input.files[0]; input.remove(); f ? resolve(f) : reject(new FanDeviceError('cancelled', 'файл не выбран')); };
      doc.body.appendChild(input);
      input.click();
    });
  };
  WebFallback.prototype.photo = function (args) {
    var g = this.g;
    return this.pickFile('image/*', args.front ? 'user' : 'environment').then(function (file) {
      return Bytes.blobToBase64(file).then(function (b64) {
        var dataUrl = 'data:' + (file.type || 'image/jpeg') + ';base64,' + b64;
        return new Promise(function (resolve) {
          var img = new g.Image();
          img.onload = function () { resolve({ dataUrl: dataUrl, mime: file.type || 'image/jpeg', width: img.naturalWidth, height: img.naturalHeight }); };
          img.onerror = function () { resolve({ dataUrl: dataUrl, mime: file.type || 'image/jpeg', width: 0, height: 0 }); };
          img.src = dataUrl;
        });
      });
    });
  };
  WebFallback.prototype.scan = function (args) {
    var g = this.g, doc = g.document;
    if (!g.BarcodeDetector) return Promise.reject(new FanDeviceError('unsupported', 'BarcodeDetector', 'camera.scan'));
    var formats = (args.formats && args.formats.length && args.formats.indexOf('any') < 0) ? args.formats : null;
    var map = { qr: 'qr_code', ean13: 'ean_13', ean8: 'ean_8', code128: 'code_128', code39: 'code_39', upc: 'upc_a', datamatrix: 'data_matrix', pdf417: 'pdf417' };
    var detector = new g.BarcodeDetector(formats ? { formats: formats.map(function (f) { return map[f] || f; }) } : undefined);
    return g.navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(function (stream) {
      return new Promise(function (resolve, reject) {
        var box = doc.createElement('div');
        box.setAttribute('style', 'position:fixed;inset:0;background:#000;z-index:2147483000;display:flex;flex-direction:column');
        var video = doc.createElement('video');
        video.setAttribute('style', 'flex:1;width:100%;object-fit:cover'); video.playsInline = true; video.muted = true; video.srcObject = stream;
        var btn = doc.createElement('button');
        btn.textContent = 'Отмена'; btn.setAttribute('style', 'font-size:18px;padding:14px;background:#222;color:#fff;border:0');
        box.appendChild(video); box.appendChild(btn); doc.body.appendChild(box);
        var done = false, timer = null;
        var finish = function (err, res) {
          if (done) return; done = true;
          clearInterval(timer);
          stream.getTracks().forEach(function (t) { t.stop(); });
          box.remove();
          err ? reject(err) : resolve(res);
        };
        btn.onclick = function () { finish(new FanDeviceError('cancelled', 'отменено', 'camera.scan')); };
        video.play().then(function () {
          timer = setInterval(function () {
            detector.detect(video).then(function (codes) {
              if (codes && codes.length) finish(null, { text: codes[0].rawValue, format: codes[0].format });
            }).catch(function () {});
          }, 150);
        }).catch(function (e) { finish(new FanDeviceError('failed', String(e), 'camera.scan')); });
      });
    }, function (e) { throw new FanDeviceError('denied', String(e), 'camera.scan'); });
  };
  WebFallback.prototype.save = function (args) {
    var doc = this.g.document, a = doc.createElement('a');
    a.href = 'data:' + (args.mime || 'application/octet-stream') + ';base64,' + args.base64;
    a.download = args.name || 'file'; a.style.display = 'none';
    doc.body.appendChild(a); a.click(); a.remove();
    return Promise.resolve({});
  };

  // ---------- главный объект ----------
  function FanDevice(g, transport, fallback) {
    var self = this;
    this.g = g;
    this.version = VERSION;
    this.transport = transport;
    this.fallback = fallback;
    this.native = !!transport;
    this._isTop = (g.top === g);
    this._pending = new PendingCalls();
    this._bus = new EventBus();
    this._info = null;
    this.ready = this.call('info').then(function (info) { self._info = info; return info; }, function (e) {
      self._info = { platform: 'web', engine: 'broken', version: VERSION, features: [] };
      throw e;
    });
    this.camera = {
      photo: function (a) { return self.call('camera.photo', a || {}); },
      scan: function (a) { return self.call('camera.scan', a || {}); },
      list: function () { return self.call('camera.list', {}); }
    };
    this.push = { register: function () { return self.call('push.register', {}); } };
    this.notify = {
      show: function (a) { return self.call('notify.show', a || {}); },
      alert: function (a) { return self.call('notify.alert', a || {}); },
      toast: function (a) { return self.call('notify.toast', a || {}); }
    };
    this.clipboard = {
      read: function () { return self.call('clipboard.read', {}).then(function (r) { return r.text; }); },
      write: function (text) { return self.call('clipboard.write', { text: String(text) }); }
    };
    this.app = {
      keepAwake: function (on) { return self.call('app.keepAwake', { on: !!on }); },
      haptic: function (kind) { return self.call('app.haptic', { kind: kind || 'light' }); },
      badge: function (count) { return self.call('app.badge', { count: count | 0 }); },
      open: function (url) { return self.call('app.open', { url: String(url) }); },
      update: function (a) { return self.call('app.update', a || {}); }
    };
    this.print = {
      tcp: function (a) {
        a = a || {};
        return self.call('print.tcp', { host: a.host, port: a.port || 9100, base64: a.bytes ? Bytes.toBase64(a.bytes) : a.base64 });
      },
      list: function () { return self.call('print.list', {}); },
      html: function (a) { return self.call('print.html', a || {}); }
    };
    this.files = {
      save: function (a) {
        a = a || {};
        var b64 = a.blob ? Bytes.blobToBase64(a.blob) : Promise.resolve(a.base64);
        return b64.then(function (v) { return self.call('files.save', { name: a.name, base64: v, mime: a.mime || (a.blob && a.blob.type) || 'application/octet-stream' }); });
      },
      share: function (a) { return self.call('files.share', a || {}); }
    };
    this.point = {
      enable: function (on) { return self.call('point.enable', { on: !!on }); },
      status: function () { return self.call('point.status', {}); }
    };
    this.settings = {
      get: function () { return self.call('settings.get', {}); },
      open: function () { return self.call('settings.open', {}); }
    };
  }

  FanDevice.prototype.Error = FanDeviceError;
  FanDevice.prototype.bytes = Bytes;

  /** Команды, которые shim умеет сам, если нативный слой ответил unsupported (Windows: камера через getUserMedia). */
  FanDevice.FALLBACKABLE = ['camera.photo', 'camera.scan', 'camera.list', 'notify.show', 'notify.alert', 'notify.toast', 'clipboard.read', 'clipboard.write', 'files.save', 'files.share', 'app.open'];

  FanDevice.prototype._fallbackHas = function (feature) {
    return FanDevice.FALLBACKABLE.indexOf(feature) >= 0 && this.fallback.features().indexOf(feature) >= 0;
  };
  FanDevice.prototype.has = function (feature) {
    var f = this._info && this._info.features;
    if (f && f.indexOf(feature) >= 0) return true;
    return !!this.transport && this._fallbackHas(feature);
  };
  FanDevice.prototype.info = function () { return this._info; };
  FanDevice.prototype.on = function (name, fn) { return this._bus.on(name, fn); };
  FanDevice.prototype.off = function (name, fn) { this._bus.off(name, fn); };

  /** Любая команда контракта. */
  FanDevice.prototype.call = function (cmd, args) {
    var self = this;
    if (!cmd || typeof cmd !== 'string') return Promise.reject(new FanDeviceError('bad_args', 'cmd', cmd));
    if (!this.transport) return this.fallback.call(cmd, args || {});
    return this._native(cmd, args).catch(function (e) {
      if (e && e.code === 'unsupported' && self._fallbackHas(cmd)) return self.fallback.call(cmd, args || {});
      throw e;
    });
  };

  FanDevice.prototype._native = function (cmd, args) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var id = self._pending.nextId();
      self._pending.add(id, cmd, resolve, reject);
      var raw;
      try {
        raw = self.transport.call(JSON.stringify({ id: id, cmd: cmd, args: args || {} }));
      } catch (e) {
        self._pending.take(id);
        reject(new FanDeviceError('failed', String(e && e.message || e), cmd));
        return;
      }
      Promise.resolve(raw).then(function (res) {
        self._settle(id, self._parse(res));
      }, function (e) {
        var p = self._pending.take(id);
        if (p) p.reject(new FanDeviceError('failed', String(e && e.message || e), cmd));
      });
    });
  };

  FanDevice.prototype._parse = function (res) {
    if (res == null) return { ok: true, pending: true };
    if (typeof res === 'string') {
      if (!res) return { ok: true, pending: true };
      try { return JSON.parse(res); } catch (e) { return { ok: false, error: { code: 'failed', message: 'bad json from native: ' + res.slice(0, 80) } }; }
    }
    return res;
  };

  /** Ответ на запрос (сразу из call или позже из _deliver). */
  FanDevice.prototype._settle = function (id, msg) {
    if (!msg || msg.pending) return false;
    var p = this._pending.take(id);
    if (!p) return false;
    if (msg.ok) p.resolve(msg.result === undefined ? {} : msg.result);
    else {
      var err = msg.error || {};
      p.reject(new FanDeviceError(err.code || 'failed', err.message || err.code || 'ошибка движка', p.cmd));
    }
    return true;
  };

  /** Точка входа для нативного слоя: ответы и события. Принимает строку JSON или объект. */
  FanDevice.prototype._deliver = function (msg) {
    if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return false; } }
    if (!msg) return false;
    if (msg.event) { return this._bus.emit(msg.event, msg.data || {}) >= 0; }
    if (msg.id) return this._settle(msg.id, msg);
    return false;
  };

  /** Один объект на все same-origin рамки: кладём себя в каждую (закон «один механизм»). */
  FanDevice.prototype._watchFrames = function () {
    var self = this, g = this.g, doc = g.document;
    if (!doc || !this._isTop || this._frameTimer) return;
    var install = function () {
      var frames = doc.getElementsByTagName('iframe');
      for (var i = 0; i < frames.length; i++) {
        try {
          var cw = frames[i].contentWindow;
          if (cw && cw.FanDevice !== self) cw.FanDevice = self;
        } catch (e) { /* чужой origin — не наш */ }
      }
    };
    this._frameTimer = g.setInterval(install, 250);
    install();
  };

  // ---------- сборка ----------
  var transport = detectTransport(global);
  var device = new FanDevice(global, transport, new WebFallback(global));
  device.FanDevice = FanDevice;
  if (global.document && global.top === global) device._watchFrames();
  global.FanDevice = device;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { FanDevice: FanDevice, FanDeviceError: FanDeviceError, WebFallback: WebFallback, NativeTransport: NativeTransport, WebKitTransport: WebKitTransport, detectTransport: detectTransport, Bytes: Bytes, VERSION: VERSION };
  }
})(typeof window !== 'undefined' ? window : globalThis);
