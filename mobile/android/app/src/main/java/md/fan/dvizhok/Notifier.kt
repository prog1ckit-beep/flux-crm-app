package md.fan.dvizhok

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/** Системные уведомления: тап открывает движок на нужном адресе CRM (extra "url"). */
class Notifier(private val ctx: Context) {
    companion object {
        const val CHANNEL = "fan"
        const val EXTRA_URL = "url"
        const val EXTRA_DATA = "data"
        fun ensureChannel(ctx: Context) {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL) == null)
                nm.createNotificationChannel(NotificationChannel(CHANNEL, ctx.getString(R.string.notif_channel), NotificationManager.IMPORTANCE_HIGH))
        }
    }

    fun show(title: String, body: String, url: String?, tag: String?, data: String? = null) {
        ensureChannel(ctx)
        val intent = Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            url?.let { putExtra(EXTRA_URL, it) }
            data?.let { putExtra(EXTRA_DATA, it) }
        }
        val pi = PendingIntent.getActivity(ctx, (tag ?: title).hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify).setContentTitle(title).setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH).setAutoCancel(true).setContentIntent(pi).build()
        try { NotificationManagerCompat.from(ctx).notify(tag ?: "fan", (tag ?: System.currentTimeMillis().toString()).hashCode(), n) }
        catch (e: SecurityException) { throw CommandError("denied", "уведомления запрещены") }
    }
}
