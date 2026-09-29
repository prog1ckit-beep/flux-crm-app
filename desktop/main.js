'use strict';
/* ФАН движок для Windows (Electron). Всё содержимое — с сервера CRM; здесь только окно, разрешения,
 * нативные команды FanDevice (docs/SPEC-FANDEVICE-v1.md), трей, настройки. Код в ООП. */
const { app, BrowserWindow, session, ipcMain, Notification, clipboard, shell, powerSaveBlocker, Tray, Menu, nativeImage, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const crypto = require('crypto');

const ENGINE = 'fan-dvizhok';
const VERSION = require('./package.json').version;

// ---------- настройки движка ----------
class Settings {
  constructor(file) {
    this.file = file;
    this.data = { serverUrl: '', allowHosts: [], serialMatch: '', fullscreen: false, deviceId: '' };
    this.load();
  }
  load() {
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (e) { /* первый запуск */ }
    if (!this.data.deviceId) { this.data.deviceId = crypto.randomUUID(); this.save(); }
  }
  save(patch) {
    if (patch) Object.assign(this.data, patch);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }
  get serverUrl() { return (this.data.serverUrl || '').trim(); }
  get serverOrigin() { try { return new URL(this.serverUrl).origin; } catch (e) { return null; } }
  /** Origin'ы, которым отвечает FanNative и выдаются разрешения. */
  allowedOrigins() {
    const list = [];
    if (this.serverOrigin) list.push(this.serverOrigin);
    for (const h of this.data.allowHosts || []) { try { list.push(new URL(h.includes('://') ? h : 'https://' + h).origin); } catch (e) { /* мимо */ } }
    return list;
  }
  isAllowedOrigin(origin) { return !!origin && this.allowedOrigins().includes(origin); }
  isAllowedUrl(url) { try { return this.isAllowedOrigin(new URL(url).origin); } catch (e) { return false; } }
}

// ---------- ошибки команд ----------
class CommandError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

// ---------- TCP печать (TSPL/ESC-POS, порт 9100) ----------
class TcpPrinter {
  static isPrivate(host) {
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
    if (!m) return host === 'localhost';
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  send(host, port, bytes) {
    if (!TcpPrinter.isPrivate(host)) return Promise.reject(new CommandError('denied', 'печать только в частную сеть'));
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host, port, timeout: 5000 });
      sock.on('connect', () => sock.end(bytes));
      sock.on('close', () => resolve({ sent: bytes.length }));
      sock.on('timeout', () => { sock.destroy(); reject(new CommandError('failed', 'принтер не ответил: ' + host)); });
      sock.on('error', e => reject(new CommandError('failed', e.message)));
    });
  }
}

// ---------- команды FanDevice ----------
class CommandRouter {
  constructor(engine) {
    this.engine = engine;
    this.printer = new TcpPrinter();
    this.awake = null;
    this.table = {
      'info': () => this.info(),
      'settings.get': () => ({ serverUrl: engine.settings.serverUrl }),
      'settings.open': () => { engine.openSettings(); return {}; },
      'settings.save': (a, ctx) => this.settingsSave(a, ctx),
      'app.reload': (a, ctx) => { engine.loadServer(); return {}; },
      'notify.show': a => this.notify(a),
      'clipboard.read': () => ({ text: clipboard.readText() }),
      'clipboard.write': a => { clipboard.writeText(String(a.text || '')); return {}; },
      'app.keepAwake': a => this.keepAwake(!!a.on),
      'app.badge': a => { app.setBadgeCount(Number(a.count) || 0); return {}; },
      'app.open': a => { this.assertUrl(a.url); shell.openExternal(a.url); return {}; },
      'push.register': () => ({ type: 'webpush' }),
      'print.tcp': a => this.printer.send(String(a.host || ''), Number(a.port) || 9100, Buffer.from(String(a.base64 || ''), 'base64')),
      'print.list': () => this.printers(),
      'print.html': a => this.printHtml(a),
      'files.save': a => this.saveFile(a)
    };
  }
  features() { return Object.keys(this.table).filter(k => !['settings.save', 'app.reload'].includes(k)); }
  info() {
    return { platform: 'windows', engine: ENGINE, version: VERSION, deviceId: this.engine.settings.data.deviceId, model: os.hostname(), features: this.features() };
  }
  assertUrl(url) { if (!/^https?:\/\//.test(String(url || ''))) throw new CommandError('bad_args', 'url'); }
  settingsSave(a, ctx) {
    if (!ctx.internal) throw new CommandError('denied', 'только экран настроек');
    const url = String(a.serverUrl || '').trim().replace(/\/+$/, '');
    if (url) this.assertUrl(url);
    this.engine.settings.save({
      serverUrl: url,
      allowHosts: String(a.allowHosts || '').split(/[\s,]+/).filter(Boolean),
      serialMatch: String(a.serialMatch || ''),
      fullscreen: !!a.fullscreen
    });
    if (url) this.engine.loadServer();
    return {};
  }
  notify(a) {
    if (!Notification.isSupported()) throw new CommandError('unsupported', 'Notification');
    const n = new Notification({ title: String(a.title || 'ФАН'), body: String(a.body || ''), silent: false });
    if (a.url) n.on('click', () => this.engine.openUrl(String(a.url)));
    else n.on('click', () => this.engine.show());
    n.show();
    return {};
  }
  keepAwake(on) {
    if (on && this.awake === null) this.awake = powerSaveBlocker.start('prevent-display-sleep');
    if (!on && this.awake !== null) { powerSaveBlocker.stop(this.awake); this.awake = null; }
    return {};
  }
  async printers() {
    const list = await this.engine.win.webContents.getPrintersAsync();
    return { printers: list.map(p => ({ name: p.name, isDefault: !!p.isDefault })) };
  }
  printHtml(a) {
    if (!a.html) throw new CommandError('bad_args', 'html');
    return new Promise((resolve, reject) => {
      const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(String(a.html)));
      w.webContents.once('did-finish-load', () => {
        w.webContents.print({ silent: a.silent !== false, deviceName: a.printer || undefined, printBackground: true }, (ok, reason) => {
          w.destroy();
          ok ? resolve({}) : reject(new CommandError('failed', reason || 'print'));
        });
      });
    });
  }
  saveFile(a) {
    const name = path.basename(String(a.name || 'file')).replace(/[<>:"|?*\\/]/g, '_');
    const dir = app.getPath('downloads');
    let target = path.join(dir, name), n = 1;
    while (fs.existsSync(target)) { const p = path.parse(name); target = path.join(dir, `${p.name} (${n++})${p.ext}`); }
    fs.writeFileSync(target, Buffer.from(String(a.base64 || ''), 'base64'));
    return { path: target };
  }
  async handle(req, ctx) {
    const fn = this.table[req.cmd];
    if (!fn) throw new CommandError('unsupported', req.cmd);
    return fn(req.args || {}, ctx);
  }
}

// ---------- разрешения и устройства (камера, серийный порт, USB, Bluetooth без диалогов) ----------
class Permissions {
  constructor(engine) { this.engine = engine; }
  allowed(origin) { return this.engine.settings.isAllowedOrigin(origin) || this.engine.isInternalOrigin(origin); }
  install(ses) {
    const ok = ['media', 'geolocation', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'serial', 'usb', 'hid', 'bluetooth', 'fullscreen', 'display-capture', 'midi', 'midiSysex'];
    ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(ok.includes(permission) && this.allowed(details.requestingUrl ? new URL(details.requestingUrl).origin : null)));
    ses.setPermissionCheckHandler((wc, permission, origin) => ok.includes(permission) && this.allowed(origin));
    ses.setDevicePermissionHandler(details => this.allowed(details.origin));
    ses.on('select-serial-port', (event, ports, wc, cb) => { event.preventDefault(); cb(this.pick(ports, p => p.portName + ' ' + (p.displayName || ''))); });
    ses.on('select-usb-device', (event, details, cb) => { event.preventDefault(); cb(this.pick(details.deviceList, d => d.productName || '')); });
    ses.on('select-hid-device', (event, details, cb) => { event.preventDefault(); cb(this.pick(details.deviceList, d => d.name || '')); });
  }
  installBluetooth(wc) {
    wc.on('select-bluetooth-device', (event, devices, cb) => { event.preventDefault(); cb(this.pick(devices, d => d.deviceName || '')); });
  }
  /** Правило выбора: подстрока из настроек (serialMatch), иначе первое устройство; пусто — отказ. */
  pick(list, label) {
    if (!list || !list.length) return '';
    const m = (this.engine.settings.data.serialMatch || '').toLowerCase();
    const hit = m ? list.find(d => label(d).toLowerCase().includes(m)) : null;
    const d = hit || list[0];
    return d.portId || d.deviceId || '';
  }
}

// ---------- движок ----------
class Engine {
  constructor() {
    this.settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
    this.router = new CommandRouter(this);
    this.perms = new Permissions(this);
    this.shim = fs.readFileSync(this.shimPath(), 'utf8');
    this.win = null; this.tray = null; this.settingsWin = null;
    this.selftest = process.argv.includes('--selftest');
    this.quitting = false;
  }
  shimPath() {
    const packed = path.join(process.resourcesPath || '', 'web', 'fan-device.js');
    return fs.existsSync(packed) ? packed : path.join(__dirname, '..', 'web', 'fan-device.js');
  }
  uiUrl(name) { return 'file://' + path.join(__dirname, 'ui', name).replace(/\\/g, '/'); }
  isInternalOrigin(origin) { return origin === 'file://' || origin === 'null'; }

  start() {
    this.perms.install(session.defaultSession);
    ipcMain.handle('fan:call', (event, json) => this.onCall(event, json));
    ipcMain.on('fan:scan', (event, data) => { if (this.settings.isAllowedUrl(event.senderFrame.url)) this.deliver({ event: 'scan', data }); });
    this.createWindow();
    if (!this.selftest) this.createTray();
    if (this.selftest) this.runSelftest();
    else if (this.settings.serverUrl) this.loadServer();
    else this.openSettings();
  }
  createWindow() {
    this.win = new BrowserWindow({
      width: 1280, height: 800, show: false, backgroundColor: '#111318', title: 'ФАН',
      autoHideMenuBar: true, fullscreen: !!this.settings.data.fullscreen,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false, spellcheck: false }
    });
    const wc = this.win.webContents;
    this.perms.installBluetooth(wc);
    wc.on('dom-ready', () => this.inject());
    wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => { if (isMainFrame && code !== -3) this.showOffline(url, desc); });
    wc.setWindowOpenHandler(({ url }) => { this.settings.isAllowedUrl(url) ? this.win.loadURL(url) : shell.openExternal(url); return { action: 'deny' }; });
    wc.on('will-navigate', (e, url) => { if (!this.settings.isAllowedUrl(url) && !url.startsWith('file://')) { e.preventDefault(); shell.openExternal(url); } });
    wc.on('page-title-updated', e => e.preventDefault());
    this.win.once('ready-to-show', () => this.win.show());
    this.win.on('close', e => { if (!this.quitting && !this.selftest) { e.preventDefault(); this.win.hide(); } });
    this.win.on('show', () => this.deliver({ event: 'resume', data: {} }));
    this.win.on('hide', () => this.deliver({ event: 'pause', data: {} }));
  }
  createTray() {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'ui', 'icon.png'));
    this.tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    this.tray.setToolTip('ФАН движок');
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть', click: () => this.show() },
      { label: 'Перезагрузить', click: () => this.loadServer() },
      { label: 'Настройки', click: () => this.openSettings() },
      { type: 'separator' },
      { label: 'Выход', click: () => { this.quitting = true; app.quit(); } }
    ]));
    this.tray.on('click', () => this.show());
  }
  show() { if (!this.win) return; this.win.show(); this.win.focus(); }
  inject() { this.win.webContents.executeJavaScript(this.shim, true).catch(() => {}); }
  loadServer() {
    if (!this.settings.serverUrl) { this.openSettings(); return; }
    this.win.loadURL(this.settings.serverUrl);
    this.show();
  }
  openUrl(url) {
    if (this.settings.isAllowedUrl(url)) this.win.loadURL(url); else shell.openExternal(url);
    this.show();
    this.deliver({ event: 'push.open', data: { url } });
  }
  showOffline(url, desc) {
    this.win.loadURL(this.uiUrl('offline.html') + '?url=' + encodeURIComponent(url || '') + '&err=' + encodeURIComponent(desc || ''));
  }
  openSettings() {
    if (this.settingsWin && !this.settingsWin.isDestroyed()) { this.settingsWin.focus(); return; }
    this.settingsWin = new BrowserWindow({
      width: 520, height: 560, title: 'ФАН — настройки движка', parent: this.win, autoHideMenuBar: true, backgroundColor: '#111318',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false }
    });
    this.settingsWin.loadURL(this.uiUrl('settings.html'));
    this.settingsWin.webContents.on('dom-ready', () => this.settingsWin.webContents.executeJavaScript(this.shim, true).catch(() => {}));
  }
  /** Доставка ответов/событий в верхнюю страницу главного окна — единственный путь. */
  deliver(msg) {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.executeJavaScript('window.FanDevice&&window.FanDevice._deliver(' + JSON.stringify(JSON.stringify(msg)) + ')', true).catch(() => {});
  }
  async onCall(event, json) {
    let req;
    try { req = JSON.parse(json); } catch (e) { return JSON.stringify({ ok: false, error: { code: 'bad_args', message: 'json' } }); }
    const origin = (() => { try { return new URL(event.senderFrame.url).origin; } catch (e) { return null; } })();
    const ctx = { internal: this.isInternalOrigin(origin), origin };
    const answer = body => JSON.stringify(Object.assign({ id: req.id }, body));
    if (!ctx.internal && !this.settings.isAllowedOrigin(origin)) return answer({ ok: false, error: { code: 'denied', message: 'чужой origin: ' + origin } });
    try {
      const result = await this.router.handle(req, ctx);
      return answer({ ok: true, result: result === undefined ? {} : result });
    } catch (e) {
      return answer({ ok: false, error: { code: e.code || 'failed', message: e.message || String(e) } });
    }
  }
  /** --selftest: открыть tests/fixtures/selftest.html, дождаться FAN-SELFTEST-OK/FAIL в консоли, выйти с кодом. */
  runSelftest() {
    const page = 'file://' + path.join(__dirname, '..', 'tests', 'fixtures', 'selftest.html').replace(/\\/g, '/');
    const timer = setTimeout(() => { console.error('SELFTEST: таймаут'); app.exit(2); }, 20000);
    this.win.webContents.on('console-message', (e, level, legacyMessage) => {
      const message = String(e && e.message !== undefined ? e.message : legacyMessage);
      console.log('[page]', message);
      if (message.startsWith('FAN-SELFTEST-')) {
        clearTimeout(timer);
        const code = message.startsWith('FAN-SELFTEST-OK') ? 0 : 1;
        const shot = path.join(__dirname, 'selftest.png');
        setTimeout(() => this.win.webContents.capturePage().then(img => { fs.writeFileSync(shot, img.toPNG()); console.log('SELFTEST: снимок ' + shot); })
          .catch(() => {}).then(() => app.exit(code)), 500);
      }
    });
    this.win.loadURL(page);
  }
}

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  const engine = new Engine();
  app.on('second-instance', () => engine.show());
  app.whenReady().then(() => engine.start());
  app.on('window-all-closed', () => { /* живём в трее */ });
  app.on('before-quit', () => { engine.quitting = true; });
}
