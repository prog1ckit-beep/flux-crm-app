package md.fan.dvizhok

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.lang.ref.WeakReference

/** Движок: один WebView с CRM, мост FanNative, разрешения без диалогов для адреса сервера, вживление fan-device.js. */
class MainActivity : AppCompatActivity(), Host {
    override val activity: Activity get() = this
    override lateinit var settings: Settings
    private lateinit var web: WebView
    private lateinit var bridge: FanBridge
    private lateinit var router: CommandRouter
    private lateinit var assets: WebViewAssetLoader
    private val shim: String by lazy { getAssets().open("fan-device.js").bufferedReader().readText() }
    private var loadedUrl: String? = null

    // --- результаты активити (фото, выбор файла) ---
    private var photoDone: ((Result<JSONObject>) -> Unit)? = null
    private var photoFile: File? = null
    private var photoQuality = 80
    private val photoLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r -> finishPhoto(r.resultCode == Activity.RESULT_OK) }
    private var fileChooser: ValueCallback<Array<Uri>>? = null
    private val fileLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val uris = WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data)
        fileChooser?.onReceiveValue(uris); fileChooser = null
    }
    private var pendingPermission: PermissionRequest? = null
    private val permLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grantWebPermission(pendingPermission); pendingPermission = null }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = Settings(this)
        assets = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web = WebView(this)
        web.setBackgroundColor(0xFF111318.toInt())
        // Android 15 (targetSdk 35) рисует контент под строкой состояния и кнопками. WebView свой padding игнорирует,
        // поэтому отступы под системные панели получает контейнер (скрин владельца 29.09: полоса CRM налезала на часы).
        val root = android.widget.FrameLayout(this).apply { setBackgroundColor(0xFF111318.toInt()); addView(web) }
        setContentView(root)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(root)
        router = CommandRouter(this)
        bridge = FanBridge(this, router)
        setupWebView()
        App.current = WeakReference(this)
        requestRuntimePermissions()
        onBackPressedDispatcher.addCallback(this) {
            if (web.canGoBack()) web.goBack() else { deliver(JSONObject().put("event", "back").put("data", JSONObject())); moveTaskToBack(true) }
        }
        if (!handleIntent(intent)) loadServer()
    }

    private fun setupWebView() {
        web.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true; databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false; allowFileAccess = false
            useWideViewPort = true; loadWithOverviewMode = true; setSupportZoom(false)
            userAgentString = "$userAgentString FanDvizhok/${BuildConfig.VERSION_NAME}"
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        web.addJavascriptInterface(bridge, "FanNative")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = assets.shouldInterceptRequest(request.url)
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (settings.isAllowedUrl(url) || Settings.isInternal(url)) return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) { bridge.currentUrl = url }
            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) { bridge.currentUrl = url }
            override fun onPageCommitVisible(view: WebView, url: String) { inject(url) }
            override fun onPageFinished(view: WebView, url: String) { inject(url) }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showOffline(request.url.toString(), error.description?.toString() ?: "")
            }
            // 502/503 от туннеля или сервера (перезапуск стенда) — своя страница с автоповтором, а не страница Cloudflare
            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: android.webkit.WebResourceResponse) {
                if (request.isForMainFrame && response.statusCode >= 500 && settings.isAllowedUrl(request.url.toString()))
                    showOffline(request.url.toString(), "HTTP ${response.statusCode}")
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                if (!settings.isAllowedUrl(request.origin.toString())) return request.deny()
                val need = runtimePermsFor(request).filter { ContextCompat.checkSelfPermission(this@MainActivity, it) != PackageManager.PERMISSION_GRANTED }
                if (need.isEmpty()) grantWebPermission(request) else { pendingPermission = request; permLauncher.launch(need.toTypedArray()) }
            }
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                callback.invoke(origin, settings.isAllowedOrigin(origin), true)
            }
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileChooser?.onReceiveValue(null); fileChooser = cb
                runCatching { fileLauncher.launch(params.createIntent()) }.onFailure { fileChooser = null; return false }
                return true
            }
            override fun onConsoleMessage(m: ConsoleMessage): Boolean { Log.d("FanWeb", "${m.message()} @${m.lineNumber()}"); return true }
        }
    }

    private fun Settings.isAllowedOrigin(origin: String) = isAllowedUrl(origin.trimEnd('/'))

    /** Какие runtime-разрешения Android нужны ресурсу WebView (камера / микрофон). */
    private fun permsFor(resource: String): List<String> = when (resource) {
        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> listOf(Manifest.permission.CAMERA)
        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> listOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.MODIFY_AUDIO_SETTINGS)
        else -> emptyList()
    }
    private fun runtimePermsFor(r: PermissionRequest): List<String> = r.resources.flatMap { permsFor(it) }.distinct()
    private fun hasPerm(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED
    private fun grantWebPermission(r: PermissionRequest?) {
        r ?: return
        val granted = r.resources.filter { res -> permsFor(res).all { hasPerm(it) } }
        if (granted.isEmpty()) r.deny() else r.grant(granted.toTypedArray())
    }
    private val startPermLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {}
    private fun requestRuntimePermissions() {
        val want = mutableListOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO, Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33) want.add(Manifest.permission.POST_NOTIFICATIONS)
        val need = want.filter { !hasPerm(it) }
        if (need.isNotEmpty()) startPermLauncher.launch(need.toTypedArray())
    }

    /** Вживление fan-device.js в верхнюю страницу (файл идемпотентен, два вызова на страницу — норма). */
    private fun inject(url: String) {
        if (settings.isAllowedUrl(url) || Settings.isInternal(url)) web.evaluateJavascript(shim, null)
    }

    // --- Host ---
    override fun deliver(msg: JSONObject) {
        runOnUiThread { web.evaluateJavascript("window.FanDevice&&window.FanDevice._deliver(${JSONObject.quote(msg.toString())})", null) }
    }
    override fun loadServer() {
        val url = settings.serverUrl
        if (url.isEmpty()) { openSettings(); return }
        loadedUrl = url
        web.loadUrl("$url/crm#welcome")   // заставка CRM, не список лидов (слово владельца 29.09)
    }
    override fun openSettings() { startActivity(Intent(this, SettingsActivity::class.java)) }
    override fun takePhoto(front: Boolean, quality: Int, done: (Result<JSONObject>) -> Unit) {
        photoDone?.invoke(Result.failure(CommandError("cancelled", "новый снимок")))
        photoDone = done; photoQuality = quality
        val f = File(cacheDir, "photo-${System.currentTimeMillis()}.jpg"); photoFile = f
        val uri = FileProvider.getUriForFile(this, "$packageName.files", f)
        // Системная камера: EXTRA_OUTPUT в наш файл; подсказки «фронтальная» понимают камеры Samsung/Google/Xiaomi (не стандарт, но безвредно)
        val intent = Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE).apply {
            putExtra(android.provider.MediaStore.EXTRA_OUTPUT, uri)
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            if (front) {
                putExtra("android.intent.extras.CAMERA_FACING", 1)
                putExtra("android.intent.extras.LENS_FACING_FRONT", 1)
                putExtra("android.intent.extra.USE_FRONT_CAMERA", true)
            }
        }
        runCatching { photoLauncher.launch(intent) }.onFailure { photoDone = null; done(Result.failure(CommandError("failed", it.message ?: "camera"))) }
    }
    private fun finishPhoto(ok: Boolean) {
        val done = photoDone ?: return; photoDone = null
        val f = photoFile ?: return done(Result.failure(CommandError("failed", "file")))
        if (!ok || !f.exists()) return done(Result.failure(CommandError("cancelled", "отменено")))
        Thread {
            val r = runCatching {
                val opts = BitmapFactory.Options().apply { inSampleSize = 2 }
                val bmp = BitmapFactory.decodeFile(f.absolutePath, opts) ?: throw CommandError("failed", "decode")
                val out = ByteArrayOutputStream(); bmp.compress(Bitmap.CompressFormat.JPEG, photoQuality, out)
                f.delete()
                JSONObject().put("dataUrl", "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
                    .put("mime", "image/jpeg").put("width", bmp.width).put("height", bmp.height)
            }
            runOnUiThread { done(r) }
        }.start()
    }

    private fun showOffline(url: String, err: String) {
        web.loadUrl("${Settings.INTERNAL_ORIGIN}/assets/offline.html?url=${Uri.encode(url)}&err=${Uri.encode(err)}")
    }

    /** Уведомление/пуш с url → открыть адрес и сообщить странице. */
    private fun handleIntent(i: Intent?): Boolean {
        i ?: return false
        val url = i.getStringExtra(Notifier.EXTRA_URL) ?: return false
        val data = i.getStringExtra(Notifier.EXTRA_DATA)
        if (settings.isAllowedUrl(url)) { loadedUrl = settings.serverUrl; web.loadUrl(url) } else loadServer()
        deliver(JSONObject().put("event", "push.open").put("data", JSONObject().put("url", url).put("data", data?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject())))
        return true
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); handleIntent(intent) }

    override fun onResume() {
        super.onResume()
        App.current = WeakReference(this)
        if (loadedUrl != settings.serverUrl) loadServer() else deliver(JSONObject().put("event", "resume").put("data", JSONObject()))
    }
    override fun onPause() { super.onPause(); deliver(JSONObject().put("event", "pause").put("data", JSONObject())) }
}
