package md.fan.dvizhok

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * Транспорт FanNative (docs/SPEC-FANDEVICE-v1.md §3): window.FanNative.call(json) → строка JSON.
 * `info` отвечает сразу, остальное — pending + FanDevice._deliver с главного потока.
 * Вызовы приходят на JS-поток WebView, поэтому текущий адрес страницы кэшируется из UI-потока.
 */
class FanBridge(private val host: Host, private val router: CommandRouter) {
    @Volatile var currentUrl: String? = null
    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun call(json: String): String {
        val req = runCatching { JSONObject(json) }.getOrElse { return error(null, "bad_args", "json") }
        val id = req.optString("id", "")
        val cmd = req.optString("cmd", "")
        val args = req.optJSONObject("args") ?: JSONObject()
        val url = currentUrl
        if (!host.settings.isAllowedUrl(url) && !Settings.isInternal(url)) return error(id, "denied", "чужой origin: ${Settings.origin(url)}")
        if (cmd == "info") return ok(id, router.info())
        main.post {
            router.run(cmd, args) { r ->
                val reply = r.fold({ JSONObject(ok(id, it)) }, { e ->
                    val code = (e as? CommandError)?.code ?: "failed"
                    JSONObject(error(id, code, e.message ?: code))
                })
                host.deliver(reply)
            }
        }
        return """{"id":${JSONObject.quote(id)},"ok":true,"pending":true}"""
    }

    private fun ok(id: String, result: JSONObject) = JSONObject().put("id", id).put("ok", true).put("result", result).toString()
    private fun error(id: String?, code: String, message: String) =
        JSONObject().put("id", id ?: "").put("ok", false).put("error", JSONObject().put("code", code).put("message", message)).toString()
}
