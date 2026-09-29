'use strict';
// Тесты общего слоя fan-device.js на фальшивых транспортах (node --test tests/).
const test = require('node:test');
const assert = require('node:assert/strict');
const { FanDevice, FanDeviceError, WebFallback, NativeTransport, WebKitTransport, detectTransport, Bytes } = require('../web/fan-device.js');

/** Фальшивый нативный слой: часть команд отвечает сразу, часть — позже через _deliver. */
class FakeNative {
  constructor(opts = {}) { this.async = !!opts.async; this.requests = []; this.device = null; this.features = opts.features || ['info', 'clipboard.read', 'camera.scan']; }
  call(json) {
    const req = JSON.parse(json);
    this.requests.push(req);
    const reply = this.answer(req);
    if (this.async) { setTimeout(() => this.device._deliver(JSON.stringify(reply)), 1); return '{"ok":true,"pending":true}'; }
    return JSON.stringify(reply);
  }
  answer(req) {
    switch (req.cmd) {
      case 'info': return { id: req.id, ok: true, result: { platform: 'android', engine: 'fan-dvizhok', version: '1', features: this.features } };
      case 'clipboard.read': return { id: req.id, ok: true, result: { text: 'привет' } };
      case 'camera.scan': return { id: req.id, ok: true, result: { text: '4840000000001', format: 'ean13' } };
      case 'print.tcp': return { id: req.id, ok: true, result: { sent: Bytes.fromBase64(req.args.base64).length } };
      case 'boom': return { id: req.id, ok: false, error: { code: 'failed', message: 'сломалось' } };
      default: return { id: req.id, ok: false, error: { code: 'unsupported', message: req.cmd } };
    }
  }
}

function makeDevice(fake) {
  const g = { top: null };
  const dev = new FanDevice(g, new NativeTransport(fake), new WebFallback(g));
  fake.device = dev;
  return dev;
}

for (const mode of [{ async: false }, { async: true }]) {
  const label = mode.async ? 'асинхронный (pending + _deliver)' : 'синхронный';
  test(`info/ready/has — ${label}`, async () => {
    const dev = makeDevice(new FakeNative(mode));
    const info = await dev.ready;
    assert.equal(info.platform, 'android');
    assert.equal(dev.native, true);
    assert.equal(dev.has('camera.scan'), true);
    assert.equal(dev.has('print.list'), false);
  });

  test(`команды через пространства имён — ${label}`, async () => {
    const fake = new FakeNative(mode);
    const dev = makeDevice(fake);
    await dev.ready;
    assert.equal(await dev.clipboard.read(), 'привет');
    assert.deepEqual(await dev.camera.scan({ formats: ['ean13'] }), { text: '4840000000001', format: 'ean13' });
    const sent = await dev.print.tcp({ host: '192.168.88.50', bytes: new Uint8Array([0x1b, 0x40, 0x0a]) });
    assert.deepEqual(sent, { sent: 3 });
    const req = fake.requests.find(r => r.cmd === 'print.tcp');
    assert.equal(req.args.port, 9100);
    assert.equal(req.args.base64, 'G0AK');
    assert.equal(dev._pending.size(), 0, 'ожиданий не осталось');
  });

  test(`ошибки движка становятся FanDeviceError — ${label}`, async () => {
    const dev = makeDevice(new FakeNative(mode));
    await dev.ready;
    await assert.rejects(dev.call('boom'), e => e instanceof FanDeviceError && e.code === 'failed' && e.cmd === 'boom' && /сломалось/.test(e.message));
    await assert.rejects(dev.print.list(), e => e.code === 'unsupported' && e.cmd === 'print.list');
    assert.equal(dev._pending.size(), 0);
  });
}

test('события: on/off/_deliver строкой и объектом', async () => {
  const dev = makeDevice(new FakeNative());
  const got = [];
  const fn = d => got.push(d);
  dev.on('push', fn);
  assert.equal(dev._deliver('{"event":"push","data":{"title":"Задача"}}'), true);
  assert.equal(dev._deliver({ event: 'push', data: { title: 'Ещё' } }), true);
  dev.off('push', fn);
  dev._deliver({ event: 'push', data: { title: 'мимо' } });
  assert.deepEqual(got.map(d => d.title), ['Задача', 'Ещё']);
  assert.equal(dev._deliver('не json'), false);
  assert.equal(dev._deliver({ id: 'нет-такого', ok: true }), false, 'ответ на неизвестный id игнорируется');
});

test('транспорт бросил исключение → failed, ожидание снято', async () => {
  const g = { top: null };
  const dev = new FanDevice(g, { call() { throw new Error('bridge down'); } }, new WebFallback(g));
  await assert.rejects(dev.ready, e => e.code === 'failed' && /bridge down/.test(e.message));
  assert.equal(dev._pending.size(), 0);
});

test('транспорт вернул Promise (Electron ipcRenderer.invoke)', async () => {
  const g = { top: null };
  const transport = { call: json => Promise.resolve(JSON.stringify({ id: JSON.parse(json).id, ok: true, result: { platform: 'windows', engine: 'fan-dvizhok', features: ['print.list'] } })) };
  const dev = new FanDevice(g, transport, new WebFallback(g));
  assert.equal((await dev.ready).platform, 'windows');
  assert.equal(dev.has('print.list'), true);
});

test('detectTransport: FanNative → native, webkit → WebKitTransport, ничего → null', () => {
  assert.ok(detectTransport({ FanNative: { call() {} } }) instanceof NativeTransport);
  const posted = [];
  const wk = detectTransport({ webkit: { messageHandlers: { FanNative: { postMessage: m => posted.push(m) } } } });
  assert.ok(wk instanceof WebKitTransport);
  assert.equal(wk.call('{"id":"1"}'), '{"ok":true,"pending":true}');
  assert.deepEqual(posted, ['{"id":"1"}']);
  assert.equal(detectTransport({}), null);
});

test('web-fallback без движка: native=false, info=browser, неизвестная команда → unsupported', async () => {
  const g = { top: null, navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome', clipboard: { readText: async () => 'x' } } };
  const dev = new FanDevice(g, null, new WebFallback(g));
  const info = await dev.ready;
  assert.equal(dev.native, false);
  assert.equal(info.engine, 'browser');
  assert.equal(info.platform, 'windows');
  assert.equal(dev.has('clipboard.read'), true);
  assert.equal(await dev.clipboard.read(), 'x');
  await assert.rejects(dev.print.tcp({ host: '10.0.0.1', base64: 'AA==' }), e => e.code === 'unsupported');
});

test('нативный unsupported → web-способ shim (Windows: clipboard через navigator), has() это учитывает', async () => {
  const fake = new FakeNative({ features: ['print.list'] });
  const g = { top: null, navigator: { userAgent: 'Windows', clipboard: { readText: async () => 'из браузера' } } };
  const dev = new FanDevice(g, new NativeTransport(fake), new WebFallback(g));
  fake.device = dev;
  fake.answer = req => req.cmd === 'info'
    ? { id: req.id, ok: true, result: { platform: 'windows', engine: 'fan-dvizhok', features: ['print.list'] } }
    : { id: req.id, ok: false, error: { code: 'unsupported', message: req.cmd } };
  await dev.ready;
  assert.equal(dev.has('clipboard.read'), true, 'нативно нет, но браузер умеет');
  assert.equal(dev.has('camera.scan'), false, 'BarcodeDetector нет — честно false');
  assert.equal(await dev.clipboard.read(), 'из браузера');
  await assert.rejects(dev.print.tcp({ host: '10.0.0.1', base64: 'AA==' }), e => e.code === 'unsupported', 'не из списка FALLBACKABLE — ошибка как есть');
});

test('Bytes: base64 туда и обратно', () => {
  const u8 = new Uint8Array([0, 1, 2, 250, 255]);
  assert.deepEqual(Array.from(Bytes.fromBase64(Bytes.toBase64(u8))), Array.from(u8));
});

test('файл идемпотентен: повторный require не создаёт второй объект в globalThis', () => {
  const first = globalThis.FanDevice;
  delete require.cache[require.resolve('../web/fan-device.js')];
  require('../web/fan-device.js');
  assert.equal(globalThis.FanDevice, first);
});
