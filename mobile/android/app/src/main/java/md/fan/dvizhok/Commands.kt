package md.fan.dvizhok

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.MediaStore
import android.util.Base64
import android.view.WindowManager
import androidx.core.content.FileProvider
import com.google.firebase.messaging.FirebaseMessaging
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Executors

/** Ошибка команды: code из контракта (unsupported | denied | cancelled | failed | bad_args). */
class CommandError(val code: String, message: String) : Exception(message)

/** Что нужно командам от Activity (реализует MainActivity). */
interface Host {
    val activity: Activity
    val settings: Settings
    fun deliver(msg: JSONObject)
    fun loadServer()
    fun openSettings()
    fun takePhoto(front: Boolean, quality: Int, done: (Result<JSONObject>) -> Unit)
}

/** Одна команда контракта. Отвечает ровно один раз через done. */
interface Command {
    fun run(args: JSONObject, host: Host, done: (Result<JSONObject>) -> Unit)
}

/** Синхронная по сути команда — обёртка, чтобы не писать done руками. */
abstract class SyncCommand : Command {
    abstract fun exec(args: JSONObject, host: Host): JSONObject
    override fun run(args: JSONObject, host: Host, done: (Result<JSONObject>) -> Unit) {
        done(runCatching { exec(args, host) })
    }
}

class CommandRouter(private val host: Host) {
    private val io = Executors.newCachedThreadPool()
    private val main = Handler(Looper.getMainLooper())

    private val table: Map<String, Command> = mapOf(
        "settings.get" to object : SyncCommand() { override fun exec(args: JSONObject, host: Host) = JSONObject().put("serverUrl", host.settings.serverUrl) },
        "settings.open" to object : SyncCommand() { override fun exec(args: JSONObject, host: Host): JSONObject { host.openSettings(); return JSONObject() } },
        "app.reload" to object : SyncCommand() { override fun exec(args: JSONObject, host: Host): JSONObject { host.loadServer(); return JSONObject() } },
        "camera.photo" to PhotoCommand(),
        "camera.scan" to ScanCommand(),
        "push.register" to PushCommand(),
        "notify.show" to object : SyncCommand() {
            override fun exec(args: JSONObject, host: Host): JSONObject {
                Notifier(host.activity).show(args.optString("title", "ФАН"), args.optString("body", ""), args.optString("url", null), args.optString("tag", null))
                return JSONObject()
            }
        },
        "clipboard.read" to object : SyncCommand() {
            override fun exec(args: JSONObject, host: Host): JSONObject {
                val cm = host.activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val text = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(host.activity)?.toString() ?: ""
                return JSONObject().put("text", text)
            }
        },
        "clipboard.write" to object : SyncCommand() {
            override fun exec(args: JSONObject, host: Host): JSONObject {
                val cm = host.activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("ФАН", args.optString("text", "")))
                return JSONObject()
            }
        },
        "app.keepAwake" to object : SyncCommand() {
            override fun exec(args: JSONObject, host: Host): JSONObject {
                val w = host.activity.window
                if (args.optBoolean("on")) w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) else w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                return JSONObject()
            }
        },
        "app.haptic" to object : SyncCommand() {
            override fun exec(args: JSONObject, host: Host): JSONObject {
                val ms = when (args.optString("kind", "light")) { "heavy", "error" -> 80L; "medium", "success" -> 40L; else -> 15L }
                val vib = if (Build.VERSION.SDK_INT >= 31) (host.activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
                          else @Suppress("DEPRECATION") host.activity.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
                vib.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
                return JSONObject()
            }
        },
        "app.open" to object : SyncCommand() {
            override fun exec(args: JSONObject, host: Host): JSONObject {
                val url = args.optString("url", "")
                if (!url.startsWith("http://") && !url.startsWith("https://")) throw CommandError("bad_args", "url")
                host.activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                return JSONObject()
            }
        },
        "print.tcp" to PrintTcpCommand(io, main),
        "files.save" to FilesSaveCommand(),
        "files.share" to FilesShareCommand()
    )

    fun features(): List<String> = listOf("info") + table.keys.filter { it != "app.reload" }

    fun info(): JSONObject = JSONObject()
        .put("platform", "android").put("engine", "fan-dvizhok").put("version", BuildConfig.VERSION_NAME)
        .put("deviceId", host.settings.deviceId).put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
        .put("features", JSONArray(features()))

    /** Только на главном потоке. */
    fun run(cmd: String, args: JSONObject, done: (Result<JSONObject>) -> Unit) {
        val c = table[cmd] ?: return done(Result.failure(CommandError("unsupported", cmd)))
        try { c.run(args, host, done) } catch (e: Exception) { done(Result.failure(e)) }
    }
}

// ---------- камера ----------
class PhotoCommand : Command {
    override fun run(args: JSONObject, host: Host, done: (Result<JSONObject>) -> Unit) =
        host.takePhoto(args.optBoolean("front", false), args.optInt("quality", 80).coerceIn(10, 100), done)
}

/** Сканер штрих-кодов Google (play-services-code-scanner): своё UI, разрешение на камеру не нужно. */
class ScanCommand : Command {
    private val formats = mapOf(
        "qr" to Barcode.FORMAT_QR_CODE, "ean13" to Barcode.FORMAT_EAN_13, "ean8" to Barcode.FORMAT_EAN_8,
        "code128" to Barcode.FORMAT_CODE_128, "code39" to Barcode.FORMAT_CODE_39, "upc" to Barcode.FORMAT_UPC_A,
        "datamatrix" to Barcode.FORMAT_DATA_MATRIX, "pdf417" to Barcode.FORMAT_PDF417
    )
    private val names = formats.entries.associate { (k, v) -> v to k }

    override fun run(args: JSONObject, host: Host, done: (Result<JSONObject>) -> Unit) {
        val wanted = args.optJSONArray("formats")?.let { arr -> (0 until arr.length()).mapNotNull { formats[arr.optString(it)] } } ?: emptyList()
        val opts = GmsBarcodeScannerOptions.Builder().apply {
            if (wanted.isEmpty()) setBarcodeFormats(Barcode.FORMAT_ALL_FORMATS)
            else setBarcodeFormats(wanted.first(), *wanted.drop(1).toIntArray())
            enableAutoZoom()
        }.build()
        GmsBarcodeScanning.getClient(host.activity, opts).startScan()
            .addOnSuccessListener { b -> done(Result.success(JSONObject().put("text", b.rawValue ?: "").put("format", names[b.format] ?: "unknown"))) }
            .addOnCanceledListener { done(Result.failure(CommandError("cancelled", "отменено"))) }
            .addOnFailureListener { e -> done(Result.failure(CommandError("failed", e.message ?: "scanner"))) }
    }
}

// ---------- push ----------
class PushCommand : Command {
    override fun run(args: JSONObject, host: Host, done: (Result<JSONObject>) -> Unit) {
        if (!BuildConfig.HAS_FIREBASE) return done(Result.success(JSONObject().put("type", "none")))
        try {
            FirebaseMessaging.getInstance().token
                .addOnSuccessListener { t -> done(Result.success(JSONObject().put("type", "fcm").put("token", t))) }
                .addOnFailureListener { e -> done(Result.failure(CommandError("failed", e.message ?: "fcm"))) }
        } catch (e: Exception) {
            done(Result.success(JSONObject().put("type", "none")))
        }
    }
}

// ---------- печать по TCP (TSPL / ESC-POS, порт 9100) ----------
class PrintTcpCommand(private val io: java.util.concurrent.ExecutorService, private val main: Handler) : Command {
    override fun run(args: JSONObject, host: Host, done: (Result<JSONObject>) -> Unit) {
        val hostName = args.optString("host", "")
        val port = args.optInt("port", 9100)
        val bytes = runCatching { Base64.decode(args.optString("base64", ""), Base64.DEFAULT) }.getOrElse { return done(Result.failure(CommandError("bad_args", "base64"))) }
        if (!isPrivate(hostName)) return done(Result.failure(CommandError("denied", "печать только в частную сеть")))
        io.execute {
            val r = runCatching {
                Socket().use { s ->
                    s.connect(InetSocketAddress(hostName, port), 5000)
                    s.getOutputStream().write(bytes); s.getOutputStream().flush()
                }
                JSONObject().put("sent", bytes.size)
            }.recoverCatching { throw CommandError("failed", it.message ?: "socket") }
            main.post { done(r) }
        }
    }

    companion object {
        fun isPrivate(host: String): Boolean {
            val p = host.split('.').mapNotNull { it.toIntOrNull() }
            if (p.size != 4) return host == "localhost"
            val (a, b) = p
            return a == 10 || a == 127 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 100 && b in 64..127)
        }
    }
}

// ---------- файлы ----------
class FilesSaveCommand : SyncCommand() {
    override fun exec(args: JSONObject, host: Host): JSONObject {
        val name = File(args.optString("name", "file")).name
        val mime = args.optString("mime", "application/octet-stream")
        val bytes = Base64.decode(args.optString("base64", ""), Base64.DEFAULT)
        val ctx = host.activity
        if (Build.VERSION.SDK_INT >= 29) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name); put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            }
            val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw CommandError("failed", "MediaStore")
            ctx.contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
            return JSONObject().put("path", uri.toString())
        }
        val f = File(ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), name)
        f.writeBytes(bytes)
        return JSONObject().put("path", f.absolutePath)
    }
}

class FilesShareCommand : SyncCommand() {
    override fun exec(args: JSONObject, host: Host): JSONObject {
        val ctx = host.activity
        val intent = Intent(Intent.ACTION_SEND)
        val b64 = args.optString("base64", "")
        if (b64.isNotEmpty()) {
            val dir = File(ctx.cacheDir, "share").apply { mkdirs() }
            val f = File(dir, File(args.optString("name", "file")).name)
            f.writeBytes(Base64.decode(b64, Base64.DEFAULT))
            val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f)
            intent.type = args.optString("mime", "application/octet-stream")
            intent.putExtra(Intent.EXTRA_STREAM, uri)
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } else intent.type = "text/plain"
        args.optString("text", "").takeIf { it.isNotEmpty() }?.let { intent.putExtra(Intent.EXTRA_TEXT, it) }
        ctx.startActivity(Intent.createChooser(intent, args.optString("name", "Поделиться")))
        return JSONObject()
    }
}
