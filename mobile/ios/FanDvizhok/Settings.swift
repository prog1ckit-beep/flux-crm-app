import Foundation

/// Настройки движка: адрес сервера, дополнительные адреса, id устройства.
final class Settings {
    static let internalOrigin = "fan-internal://app"
    private let d = UserDefaults.standard

    var serverUrl: String {
        get { (d.string(forKey: "serverUrl") ?? "").trimmingCharacters(in: .whitespaces).trimmingTrailingSlash() }
        set { d.set(newValue.trimmingCharacters(in: .whitespaces).trimmingTrailingSlash(), forKey: "serverUrl") }
    }
    var allowHosts: String {
        get { d.string(forKey: "allowHosts") ?? "" }
        set { d.set(newValue, forKey: "allowHosts") }
    }
    var deviceId: String {
        if let v = d.string(forKey: "deviceId") { return v }
        let v = UUID().uuidString
        d.set(v, forKey: "deviceId")
        return v
    }

    static func origin(_ url: String?) -> String? {
        guard let s = url, let u = URL(string: s), let scheme = u.scheme, let host = u.host, scheme == "http" || scheme == "https" else { return nil }
        if let p = u.port { return "\(scheme)://\(host):\(p)" }
        return "\(scheme)://\(host)"
    }
    func allowedOrigins() -> [String] {
        var list: [String] = []
        if let o = Settings.origin(serverUrl) { list.append(o) }
        for h in allowHosts.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "\n" }).map({ String($0).trimmingCharacters(in: .whitespaces) }) where !h.isEmpty {
            if let o = Settings.origin(h.contains("://") ? h : "https://\(h)") { list.append(o) }
        }
        return list
    }
    func isAllowed(url: String?) -> Bool {
        guard let o = Settings.origin(url) else { return false }
        return allowedOrigins().contains(o)
    }
    static func isInternal(_ url: String?) -> Bool { url?.hasPrefix("file://") == true }
}

extension String {
    func trimmingTrailingSlash() -> String { var s = self; while s.hasSuffix("/") { s.removeLast() }; return s }
}
