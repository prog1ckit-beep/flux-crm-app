package md.fan.dvizhok

import android.app.Application
import java.lang.ref.WeakReference

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifier.ensureChannel(this)
    }

    companion object {
        /** Текущая MainActivity — для доставки push-событий из FanMessagingService, когда движок открыт. */
        var current: WeakReference<MainActivity> = WeakReference(null)
    }
}
