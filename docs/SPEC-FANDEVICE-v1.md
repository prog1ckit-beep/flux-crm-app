# FanDevice v1 — контракт нативного движка ФАН

Слово владельца 2026-09-28: «не для продажи, для внутреннего пользования; нативные приложения-движки для работы
с CRM в режиме только сервера: вместо браузера — продвинутый нативный движок для устройства, чтобы можно было
подключаться к камере и управлять нативными инструментами данного устройства».

## 1. Что такое движок

Движок (`fan-dvizhok`) — нативное приложение на Android / iOS / Windows, внутри которого один WebView с CRM
платформы ФАН (Hub2). Своего содержимого у движка нет: всё (CRM, приложения в рамке `crm_embed`, стили, логика)
приходит с сервера. Движок добавляет только то, чего у браузера нет или что он спрашивает у человека:

- доступ к камере, микрофону, геолокации, уведомлениям для адреса сервера — без диалогов браузера;
- сканер штрих-кодов/QR нативным сканером устройства;
- нативные push (FCM / APNs) и системные уведомления с переходом в нужный раздел CRM;
- печать на сетевые принтеры (TSC/ESC-POS по TCP 9100), список принтеров Windows;
- буфер обмена, вибрация, «не гасить экран», сохранение и «поделиться» файлом;
- на Windows дополнительно: Web Serial / Web Bluetooth / Web USB (весы CAS, сканеры, принтеры) без диалога выбора.

Законы платформы сохраняются: CRM = оболочка, приложения только внутри рамки, права и настройки в ядре CRM.
У движка **нет** своих пользователей, токенов, базы и логики: вход — cookie CRM, как в браузере.

## 2. Три слоя — один механизм

```
страница CRM / приложение в рамке
        │  window.FanDevice.*   (высокоуровневый API, одинаков везде)
        ▼
web/fan-device.js  — ОДИН файл, вживляется движком в верхнюю страницу и в same-origin рамки
        │  FanNative.call(json) / FanDevice._deliver(json)   (транспорт, 2 функции)
        ▼
нативный слой: Android Kotlin (addJavascriptInterface) · iOS Swift (WKScriptMessageHandler) · Windows Electron (preload)
```

Правило «один механизм»: команды, их имена, аргументы и ответы совпадают на всех платформах. Платформа, которая
чего-то не умеет, отвечает `unsupported`, а `FanDevice.has()` заранее говорит «нет». Никаких платформенных
ветвлений в коде приложений CRM.

## 3. Транспорт (нативный слой → shim)

Движок предоставляет в **верхней** странице объект `window.FanNative` с одной функцией:

| платформа | `FanNative.call(requestJson)` | доставка ответов/событий |
|---|---|---|
| Android | Java-интерфейс `addJavascriptInterface(FanBridge, "FanNative")`, синхронно возвращает строку JSON | `webView.evaluateJavascript("window.FanDevice._deliver(<json>)")` |
| iOS | `window.webkit.messageHandlers.FanNative.postMessage(json)` (shim оборачивает в `FanNative.call`, возвращает `{"ok":true,"pending":true}`) | `webView.evaluateJavaScript("window.FanDevice._deliver(<json>)")` |
| Windows | preload: `contextBridge.exposeInMainWorld('FanNative', {call: json => ipcRenderer.invoke('fan:call', json)})` — возвращает Promise<string> | `webContents.send('fan:deliver', json)` → preload → `FanDevice._deliver` |

Запрос: `{"id":"<строка>","cmd":"<имя команды>","args":{...}}`.

Ответ (синхронно из `call` или позже через `_deliver`):
`{"id":"…","ok":true,"result":…}` · `{"id":"…","ok":false,"error":{"code":"unsupported|denied|cancelled|failed|bad_args","message":"…"}}`
· промежуточный `{"id":"…","ok":true,"pending":true}` — ответ придёт через `_deliver`.

Событие от движка: `{"event":"<имя>","data":{...}}` через `_deliver`.

Нативная сторона обязана: отвечать на **каждый** запрос ровно один раз; вызывать `_deliver` только в верхней странице;
переживать перезагрузку страницы (незавершённые запросы после навигации просто теряются — shim сам их не ждёт).

## 4. Команды v1

| cmd | args | result | Android | iOS | Windows |
|---|---|---|---|---|---|
| `info` | — | `{platform, engine, version, deviceId, model, features:[…]}` | ✓ | ✓ | ✓ |
| `settings.get` | — | `{serverUrl}` | ✓ | ✓ | ✓ |
| `settings.open` | — | `{}` — открыть нативный экран настроек (адрес сервера, QR) | ✓ | ✓ | ✓ |
| `camera.photo` | `{quality?:0..100, front?:bool}` | `{dataUrl, mime, width, height}` | ✓ | ✓ | web-fallback |
| `camera.list` | — | `{cameras:[{id, facing:"back"|"front"|"external"|"unknown", label, megapixels?, width?, height?, flash?, zoom?}]}` | ✓ Camera2 | ✓ AVCapture | web-fallback (`enumerateDevices`) |
| `camera.scan` | `{formats?:["qr","ean13","code128",…]}` | `{text, format}` | ✓ (Google code scanner) | ✓ (Vision) | web-fallback (`BarcodeDetector`, иначе unsupported) |
| `push.register` | — | `{type:"fcm"|"apns"|"webpush"|"none", token?}` | fcm при `google-services.json` | apns | webpush (используй FanPush) |
| `notify.show` | `{title, body?, url?, tag?}` | `{}` — системное уведомление; тап открывает `url` в движке | ✓ | ✓ | ✓ |
| `notify.alert` | `{title, body?, button?, seconds?}` | `{closed}` — сообщение на ВЕСЬ экран; Windows — отдельное окно поверх всех программ | overlay в странице (shim) | overlay в странице (shim) | ✓ нативное окно |
| `notify.toast` | `{title, body?, url?, seconds?:6, sound?:true}` | `{closed}` — всплывающее снизу справа со звуком, как в Telegram; клик → `url` | в странице (shim) | в странице (shim) | ✓ окно поверх всех программ |
| `clipboard.read` | — | `{text}` | ✓ | ✓ | ✓ |
| `clipboard.write` | `{text}` | `{}` | ✓ | ✓ | ✓ |
| `app.keepAwake` | `{on:bool}` | `{}` | ✓ | ✓ | ✓ |
| `app.haptic` | `{kind?:"light"|"medium"|"heavy"|"success"|"error"}` | `{}` | ✓ | ✓ | unsupported |
| `app.badge` | `{count}` | `{}` | unsupported | ✓ | ✓ (taskbar) |
| `app.open` | `{url}` — открыть адрес во внешнем браузере/приложении | `{}` | ✓ | ✓ | ✓ |
| `app.window` | `{url?}` — открыть адрес CRM (по умолчанию заставка `/crm#welcome`) в ОТДЕЛЬНОМ окне приложения; чужие адреса — `denied` | `{windows:<сколько окон CRM открыто>}` | unsupported | unsupported | ✓ |
| `app.update` | `{manifest}` — адрес JSON `{android:{version,url},windows:{…},ios:{…}}` (CRM: `/api/method/crm_dvizhok.api.releases`) | `{updating:bool, version, current, url?, manual?}` — если новее: Android скачивает APK и открывает установщик; Windows скачивает EXE, запускает его и закрывается; iOS — `manual:true` + url | ✓ | manual | ✓ |
| `point.enable` | `{on}` — точка печати: опрос заданий CRM (`crm_dvizhok.api.point_poll` каждые 3 с под cookie сессии) + автозапуск при входе | `{enabled, deviceId, printed, errors, lastPoll, lastError}` | unsupported | unsupported | ✓ |
| `point.status` | — | то же | unsupported | unsupported | ✓ |
| `print.tcp` | `{host, port?:9100, base64}` — сырые байты (TSPL/ESC-POS) | `{sent:<байт>}` | ✓ | ✓ | ✓ |
| `print.list` | — | `{printers:[{name, isDefault}]}` | unsupported | unsupported | ✓ |
| `print.html` | `{printer?, html, silent?:true}` | `{}` | unsupported | unsupported | ✓ |
| `files.save` | `{name, base64, mime}` | `{path?}` — в «Загрузки» | ✓ | ✓ (файлы приложения) | ✓ |
| `files.share` | `{name?, base64?, mime?, text?}` | `{}` | ✓ | ✓ | unsupported |

Форматы `camera.scan`: `qr`, `ean13`, `ean8`, `code128`, `code39`, `upc`, `datamatrix`, `pdf417`, `any` (по умолчанию).

Веб-API, которые движок просто **разрешает** (команды не нужны): `getUserMedia` (камера/микрофон),
`navigator.geolocation`, `Notification` (Windows), `navigator.serial` / `bluetooth` / `usb` (Windows: движок сам
выбирает устройство по правилу из настроек вместо диалога), `<input type=file capture>`, `window.open` → внешний браузер.

## 5. События

| event | data | когда |
|---|---|---|
| `push` | `{title, body, data}` | нативный push пришёл, приложение открыто |
| `push.open` | `{data, url?}` | человек тапнул push/уведомление (движок сам переходит на `url`, если он задан) |
| `resume` / `pause` | `{}` | приложение вернулось на экран / ушло в фон |
| `back` | `{}` | Android: аппаратная «назад», когда история WebView пуста (иначе движок сам делает `goBack`) |
| `scan` | `{text, format}` | Windows: сканер-клавиатура (по префиксу/суффиксу из настроек) или сканер Android (аппаратный) |

## 6. JS API (`window.FanDevice`)

```js
const dev = window.FanDevice;              // есть везде, где страницу открыл движок (и в рамке)
dev.native                                 // true в движке, false в обычном браузере (тогда работают web-fallback'и)
await dev.ready                            // → info (см. cmd info)
dev.has('camera.scan')                     // true/false по features из info
dev.call('camera.scan', {formats:['qr']})  // низкоуровнево — любая команда
dev.camera.photo({quality:80}) · dev.camera.scan({formats}) · dev.push.register() · dev.notify.show({...})
dev.clipboard.read() · dev.clipboard.write(text) · dev.app.keepAwake(on) · dev.app.haptic(kind) · dev.app.badge(n)
dev.app.open(url) · dev.print.tcp({host,port,bytes|base64}) · dev.print.list() · dev.print.html({html,printer})
dev.files.save({name, blob|base64, mime}) · dev.files.share({...}) · dev.settings.get() · dev.settings.open()
dev.on('push', fn) · dev.off('push', fn)
```

Все методы возвращают Promise. Ошибка — `FanDeviceError {code, message, cmd}`. `unsupported` — обычное дело:
приложение сначала спрашивает `has()`, а не ловит исключение.

Рамка: `fan-device.js` живёт в верхней странице; в same-origin `<iframe>` (рамка `crm_embed`) shim сам кладёт
**тот же объект** `FanDevice` при загрузке рамки. Приложение в рамке обращается к `FanDevice` в момент действия
(нажатие кнопки), а не при разборе `<head>`; если очень рано — `window.FanDevice || window.parent.FanDevice`.

## 7. Что движок обязан делать сам (без команд)

1. **Адрес сервера** хранится в настройках движка (первый запуск → экран настроек: адрес руками или QR с адресом).
   Адрес туннеля меняется, поэтому в код он не зашивается. Экран настроек открывается: при первом запуске,
   при ошибке загрузки (нет сети / 404 / DNS), по команде `settings.open`.
2. **Разрешения** (камера, микрофон, геолокация, уведомления) выдаются автоматически только для origin из настроек.
3. **Cookie** CRM живут между запусками (persist), чтобы не логиниться каждый раз.
4. **Вживление shim**: после загрузки каждой верхней страницы движок выполняет `web/fan-device.js` (из своих ассетов).
   Повторное вживление безопасно (файл идемпотентен).
5. **Внешние ссылки** (другой origin) — во внешний браузер, а не внутри движка. Исключение — адреса из `allowHosts` настроек.
6. **Ошибка загрузки** — своя страница «Сервер недоступен» + кнопка «Настройки» и «Повторить». Не белый экран.
7. **Обновление** движка не требуется при изменении CRM — вся логика на сервере. Версия shim в `info.version`.

## 8. Безопасность (внутреннее использование, но всё же)

- `FanNative` отвечает только страницам origin из настроек (Android: проверка `webView.url` перед выполнением;
  Electron: проверка `event.senderFrame.origin`). Чужой origin получает `denied`.
- Никаких секретов в движке. Push-токен отдаётся странице CRM, которая сама регистрирует его на сервере
  (`raven_notify`, рядом с web-push подпиской FanPush).
- `print.tcp` — только в частные сети (10/8, 172.16/12, 192.168/16, 100.64/10) — принтеры не в интернете.

## 9. Приёмка (закон приёмки — скрины настоящей страницы)

Тестовая страница `tests/fixtures/selftest.html` (в репо) вызывает `info`, `has`, `clipboard`, `notify`, `camera.scan`
и печатает результат. Windows: `npm run selftest` в `desktop/` открывает её и выходит с кодом 0/1.
Android/iOS: открыть страницу через настройки движка, снять скрин. Затем — настоящая CRM под QA (телефон + ПК).
