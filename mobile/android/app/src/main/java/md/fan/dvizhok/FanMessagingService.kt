package md.fan.dvizhok

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/** FCM: пришло сообщение → системное уведомление (тап → url) + событие push в открытый движок. Работает только с google-services.json. */
class FanMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(msg: RemoteMessage) {
        val title = msg.notification?.title ?: msg.data["title"] ?: "ФАН"
        val body = msg.notification?.body ?: msg.data["body"] ?: ""
        val url = msg.data["url"]
        val data = JSONObject(msg.data as Map<*, *>)
        Notifier(this).show(title, body, url, msg.data["tag"], data.toString())
        App.current.get()?.deliver(JSONObject().put("event", "push").put("data", JSONObject().put("title", title).put("body", body).put("data", data)))
    }

    override fun onNewToken(token: String) {
        App.current.get()?.deliver(JSONObject().put("event", "push.token").put("data", JSONObject().put("type", "fcm").put("token", token)))
    }
}
