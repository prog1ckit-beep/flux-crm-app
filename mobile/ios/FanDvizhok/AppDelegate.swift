import UIKit
import UserNotifications

@main
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var window: UIWindow?
    /// Ожидающий ответ на push.register (APNs отдаёт токен асинхронно через делегат).
    var pushRegisterWaiters: [(Result<[String: Any], CommandError>) -> Void] = []
    weak var engine: EngineViewController?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        let w = UIWindow(frame: UIScreen.main.bounds)
        let vc = EngineViewController()
        engine = vc
        w.rootViewController = vc
        w.makeKeyAndVisible()
        window = w
        return true
    }

    // MARK: APNs
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        pushRegisterWaiters.forEach { $0(.success(["type": "apns", "token": token])) }
        pushRegisterWaiters.removeAll()
        engine?.deliver(["event": "push.token", "data": ["type": "apns", "token": token]])
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        pushRegisterWaiters.forEach { $0(.failure(CommandError(.failed, error.localizedDescription))) }
        pushRegisterWaiters.removeAll()
    }

    // MARK: уведомления
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let c = notification.request.content
        engine?.deliver(["event": "push", "data": ["title": c.title, "body": c.body, "data": c.userInfo]])
        completionHandler([.banner, .sound, .list])
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        engine?.openFromNotification(url: info["url"] as? String, data: info)
        completionHandler()
    }
}
