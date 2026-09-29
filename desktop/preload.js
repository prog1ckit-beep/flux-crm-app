'use strict';
/* Транспорт FanNative для Windows-движка: одна функция call(json) → Promise<строка JSON>.
 * Ответы и события приходят из главного процесса через executeJavaScript(FanDevice._deliver) — здесь их нет.
 * Плюс сканер-клавиатура (USB «wedge»): быстрая пачка символов + Enter → событие scan. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('FanNative', {
  call: json => ipcRenderer.invoke('fan:call', String(json))
});

class WedgeScanner {
  constructor(win) { this.buf = ''; this.last = 0; this.win = win; this.gapMs = 60; this.minLen = 4; }
  install() { this.win.addEventListener('keydown', e => this.onKey(e), true); }
  onKey(e) {
    const now = Date.now();
    if (now - this.last > this.gapMs) this.buf = '';
    this.last = now;
    if (e.key === 'Enter') {
      if (this.buf.length >= this.minLen) ipcRenderer.send('fan:scan', { text: this.buf, format: 'wedge' });
      this.buf = '';
    } else if (e.key.length === 1) this.buf += e.key;
  }
}
if (window.top === window) new WedgeScanner(window).install();
