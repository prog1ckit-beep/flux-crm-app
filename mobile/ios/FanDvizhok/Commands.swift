import UIKit
import Network
import UserNotifications
import AVFoundation

enum ErrorCode: String { case unsupported, denied, cancelled, failed, bad_args }

struct CommandError: Error {
    let code: ErrorCode
    let message: String
    init(_ code: ErrorCode, _ message: String) { self.code = code; self.message = message }
}

typealias Done = (Result<[String: Any], CommandError>) -> Void

/// Что нужно командам от контроллера движка.
protocol Host: AnyObject {
    var settings: Settings { get }
    var viewController: UIViewController { get }
    func deliver(_ msg: [String: Any])
    func loadServer()
    func openSettings()
    func takePhoto(front: Bool, quality: Int, done: @escaping Done)
    func scan(formats: [String], done: @escaping Done)
    func registerPush(done: @escaping Done)
}

protocol Command { func run(_ args: [String: Any], _ host: Host, _ done: @escaping Done) }

/// Синхронная команда: возвращает результат или бросает CommandError.
struct SyncCommand: Command {
    let body: ([String: Any], Host) throws -> [String: Any]
    func run(_ args: [String: Any], _ host: Host, _ done: @escaping Done) {
        do { done(.success(try body(args, host))) }
        catch let e as CommandError { done(.failure(e)) }
        catch { done(.failure(CommandError(.failed, error.localizedDescription))) }
    }
}

final class CommandRouter {
    private unowned let host: Host
    private var table: [String: Command] = [:]

    init(host: Host) {
        self.host = host
        table = [
            "settings.get": SyncCommand { _, h in ["serverUrl": h.settings.serverUrl] },
            "settings.open": SyncCommand { _, h in h.openSettings(); return [:] },
            "app.reload": SyncCommand { _, h in h.loadServer(); return [:] },
            "camera.photo": PhotoCommand(),
            "camera.list": SyncCommand { _, _ in
                let s = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera, .builtInUltraWideCamera, .builtInTelephotoCamera], mediaType: .video, position: .unspecified)
                let cams: [[String: Any]] = s.devices.map { d in
                    let facing = d.position == .front ? "front" : d.position == .back ? "back" : "unknown"
                    let dims = CMVideoFormatDescriptionGetDimensions(d.activeFormat.formatDescription)
                    let mp = (Double(dims.width) * Double(dims.height) / 100000.0).rounded() / 10.0
                    return ["id": d.uniqueID, "facing": facing, "label": d.localizedName, "megapixels": mp, "width": Int(dims.width), "height": Int(dims.height), "flash": d.hasFlash, "zoom": Double(d.activeFormat.videoMaxZoomFactor)]
                }
                return ["cameras": cams]
            },
            "camera.scan": ScanCommand(),
            "push.register": PushCommand(),
            "notify.show": NotifyCommand(),
            "clipboard.read": SyncCommand { _, _ in ["text": UIPasteboard.general.string ?? ""] },
            "clipboard.write": SyncCommand { a, _ in UIPasteboard.general.string = a["text"] as? String ?? ""; return [:] },
            "app.keepAwake": SyncCommand { a, _ in UIApplication.shared.isIdleTimerDisabled = a["on"] as? Bool ?? false; return [:] },
            "app.haptic": SyncCommand { a, _ in Haptics.play(a["kind"] as? String ?? "light"); return [:] },
            "app.badge": SyncCommand { a, _ in UIApplication.shared.applicationIconBadgeNumber = a["count"] as? Int ?? 0; return [:] },
            "app.open": SyncCommand { a, _ in
                guard let s = a["url"] as? String, let u = URL(string: s), ["http", "https"].contains(u.scheme ?? "") else { throw CommandError(.bad_args, "url") }
                UIApplication.shared.open(u); return [:]
            },
            "print.tcp": PrintTcpCommand(),
            "app.update": AppUpdateCommand(),
            "files.save": FilesSaveCommand(),
            "files.share": FilesShareCommand()
        ]
    }

    func features() -> [String] { ["info"] + table.keys.filter { $0 != "app.reload" }.sorted() }

    func info() -> [String: Any] {
        ["platform": "ios", "engine": "fan-dvizhok",
         "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0",
         "deviceId": host.settings.deviceId, "model": UIDevice.current.model, "features": features()]
    }

    func run(_ cmd: String, _ args: [String: Any], _ done: @escaping Done) {
        guard let c = table[cmd] else { return done(.failure(CommandError(.unsupported, cmd))) }
        c.run(args, host, done)
    }
}

// MARK: - команды

struct PhotoCommand: Command {
    func run(_ a: [String: Any], _ h: Host, _ done: @escaping Done) {
        h.takePhoto(front: a["front"] as? Bool ?? false, quality: min(100, max(10, a["quality"] as? Int ?? 80)), done: done)
    }
}

struct ScanCommand: Command {
    func run(_ a: [String: Any], _ h: Host, _ done: @escaping Done) { h.scan(formats: a["formats"] as? [String] ?? [], done: done) }
}

struct PushCommand: Command {
    func run(_ a: [String: Any], _ h: Host, _ done: @escaping Done) { h.registerPush(done: done) }
}

struct NotifyCommand: Command {
    func run(_ a: [String: Any], _ h: Host, _ done: @escaping Done) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { ok, _ in
            guard ok else { return done(.failure(CommandError(.denied, "уведомления запрещены"))) }
            let c = UNMutableNotificationContent()
            c.title = a["title"] as? String ?? "CRM-Express.md"
            c.body = a["body"] as? String ?? ""
            c.sound = .default
            if let url = a["url"] as? String { c.userInfo["url"] = url }
            let id = a["tag"] as? String ?? UUID().uuidString
            center.add(UNNotificationRequest(identifier: id, content: c, trigger: nil)) { err in
                err == nil ? done(.success([:])) : done(.failure(CommandError(.failed, err!.localizedDescription)))
            }
        }
    }
}

/// Сырые байты на принтер (TSPL/ESC-POS) по TCP, только в частную сеть.
struct PrintTcpCommand: Command {
    static func isPrivate(_ host: String) -> Bool {
        let p = host.split(separator: ".").compactMap { Int($0) }
        guard p.count == 4 else { return host == "localhost" }
        let (a, b) = (p[0], p[1])
        return a == 10 || a == 127 || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168) || (a == 100 && (64...127).contains(b))
    }
    func run(_ a: [String: Any], _ h: Host, _ done: @escaping Done) {
        guard let hostName = a["host"] as? String, let b64 = a["base64"] as? String, let bytes = Data(base64Encoded: b64) else { return done(.failure(CommandError(.bad_args, "host/base64"))) }
        guard PrintTcpCommand.isPrivate(hostName) else { return done(.failure(CommandError(.denied, "печать только в частную сеть"))) }
        let port = NWEndpoint.Port(rawValue: UInt16(a["port"] as? Int ?? 9100)) ?? 9100
        let conn = NWConnection(host: NWEndpoint.Host(hostName), port: port, using: .tcp)
        var finished = false
        let finish: (Result<[String: Any], CommandError>) -> Void = { r in
            guard !finished else { return }; finished = true; conn.cancel(); DispatchQueue.main.async { done(r) }
        }
        conn.stateUpdateHandler = { st in
            switch st {
            case .ready:
                conn.send(content: bytes, completion: .contentProcessed { err in
                    err == nil ? finish(.success(["sent": bytes.count])) : finish(.failure(CommandError(.failed, err!.localizedDescription)))
                })
            case .failed(let e): finish(.failure(CommandError(.failed, e.localizedDescription)))
            case .waiting(let e): finish(.failure(CommandError(.failed, e.localizedDescription)))
            default: break
            }
        }
        conn.start(queue: .global())
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) { finish(.failure(CommandError(.failed, "принтер не ответил: \(hostName)"))) }
    }
}

/// iOS без магазина сам себя не переустанавливает: отдаём {manual:true, url} — страница откроет ссылку (Sideloadly/TestFlight).
struct AppUpdateCommand: Command {
    func run(_ a: [String: Any], _ h: Host, _ done: @escaping Done) {
        let current = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        guard let m = a["manifest"] as? String, var comps = URLComponents(string: m) else { return done(.failure(CommandError(.bad_args, "manifest"))) }
        comps.queryItems = (comps.queryItems ?? []) + [URLQueryItem(name: "platform", value: "ios"), URLQueryItem(name: "current", value: current)]
        guard let url = comps.url else { return done(.failure(CommandError(.bad_args, "manifest"))) }
        URLSession.shared.dataTask(with: url) { data, _, err in
            DispatchQueue.main.async {
                guard let d = data, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return done(.failure(CommandError(.failed, err?.localizedDescription ?? "манифест"))) }
                var out: [String: Any] = ["current": current, "updating": false]
                if let rel = j["message"] as? [String: Any], let v = rel["version"] as? String { out["version"] = v; out["manual"] = true; out["url"] = rel["url"] ?? "" }
                done(.success(out))
            }
        }.resume()
    }
}

struct FilesSaveCommand: Command {
    func run(_ a: [String: Any], _ h: Host, _ done: @escaping Done) {
        guard let b64 = a["base64"] as? String, let data = Data(base64Encoded: b64) else { return done(.failure(CommandError(.bad_args, "base64"))) }
        let name = (a["name"] as? String ?? "file").components(separatedBy: "/").last ?? "file"
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let url = dir.appendingPathComponent(name)
        do { try data.write(to: url); done(.success(["path": url.path])) }
        catch { done(.failure(CommandError(.failed, error.localizedDescription))) }
    }
}

struct FilesShareCommand: Command {
    func run(_ a: [String: Any], _ h: Host, _ done: @escaping Done) {
        var items: [Any] = []
        if let t = a["text"] as? String, !t.isEmpty { items.append(t) }
        if let b64 = a["base64"] as? String, let data = Data(base64Encoded: b64) {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent((a["name"] as? String ?? "file").components(separatedBy: "/").last ?? "file")
            try? data.write(to: url)
            items.append(url)
        }
        guard !items.isEmpty else { return done(.failure(CommandError(.bad_args, "нечем делиться"))) }
        let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
        vc.completionWithItemsHandler = { _, _, _, _ in done(.success([:])) }
        vc.popoverPresentationController?.sourceView = h.viewController.view
        h.viewController.present(vc, animated: true)
    }
}

enum Haptics {
    static func play(_ kind: String) {
        switch kind {
        case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
        case "error": UINotificationFeedbackGenerator().notificationOccurred(.error)
        case "heavy": UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        case "medium": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
    }
}
