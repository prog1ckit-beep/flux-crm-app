package md.fan.dvizhok

import android.content.Context
import android.net.Uri
import java.util.UUID

/** Настройки движка: адрес сервера, дополнительные адреса, id устройства. Секретов нет. */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("fan-dvizhok", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString("serverUrl", "")!!.trim().trimEnd('/')
        set(v) = prefs.edit().putString("serverUrl", v.trim().trimEnd('/')).apply()

    var allowHosts: String
        get() = prefs.getString("allowHosts", "")!!
        set(v) = prefs.edit().putString("allowHosts", v).apply()

    val deviceId: String
        get() {
            val v = prefs.getString("deviceId", null)
            if (v != null) return v
            val fresh = UUID.randomUUID().toString()
            prefs.edit().putString("deviceId", fresh).apply()
            return fresh
        }

    fun serverOrigin(): String? = origin(serverUrl)

    fun allowedOrigins(): List<String> {
        val list = mutableListOf<String>()
        serverOrigin()?.let { list.add(it) }
        allowHosts.split(',', ' ', '\n').map { it.trim() }.filter { it.isNotEmpty() }.forEach { h ->
            origin(if (h.contains("://")) h else "https://$h")?.let { list.add(it) }
        }
        return list
    }

    fun isAllowedUrl(url: String?): Boolean {
        val o = origin(url) ?: return false
        return allowedOrigins().contains(o)
    }

    companion object {
        const val INTERNAL_ORIGIN = "https://appassets.androidplatform.net"

        fun origin(url: String?): String? {
            if (url.isNullOrBlank()) return null
            val u = Uri.parse(url)
            val scheme = u.scheme ?: return null
            val host = u.host ?: return null
            if (scheme != "http" && scheme != "https") return null
            return if (u.port > 0) "$scheme://$host:${u.port}" else "$scheme://$host"
        }

        fun isInternal(url: String?): Boolean = url != null && url.startsWith(INTERNAL_ORIGIN)
    }
}
