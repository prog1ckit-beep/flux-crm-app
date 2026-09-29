import UIKit
import WebKit
import AVFoundation

/// Движок: один WKWebView с CRM, мост FanNative (WKScriptMessageHandler), вживление fan-device.js, разрешения для адреса сервера.
final class EngineViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, Host,
                                  UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    let settings = Settings()
    var viewController: UIViewController { self }
    private var web: WKWebView!
    private lazy var router = CommandRouter(host: self)
    private var loadedUrl: String?
    private var photoDone: Done?
    private var photoQuality = 80

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.067, green: 0.075, blue: 0.094, alpha: 1)
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.websiteDataStore = .default()                  // cookie CRM живут между запусками
        cfg.applicationNameForUserAgent = "FanDvizhok/1.0"
        let ucc = cfg.userContentController
        ucc.add(self, name: "FanNative")
        if let path = Bundle.main.path(forResource: "fan-device", ofType: "js"), let shim = try? String(contentsOfFile: path) {
            ucc.addUserScript(WKUserScript(source: shim, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        web = WKWebView(frame: view.bounds, configuration: cfg)
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        web.navigationDelegate = self; web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        view.addSubview(web)
        (UIApplication.shared.delegate as? AppDelegate)?.engine = self
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.onResume() }
        NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.deliver(["event": "pause", "data": [:]]) }
        loadServer()
    }

    private func onResume() {
        if loadedUrl != settings.serverUrl { loadServer() } else { deliver(["event": "resume", "data": [:]]) }
    }

    // MARK: Host
    func deliver(_ msg: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: msg), let json = String(data: data, encoding: .utf8),
              let quoted = try? JSONSerialization.data(withJSONObject: [json]), let q = String(data: quoted, encoding: .utf8) else { return }
        let arg = String(q.dropFirst().dropLast())   // "[\"…\"]" → "\"…\""
        DispatchQueue.main.async { self.web.evaluateJavaScript("window.FanDevice&&window.FanDevice._deliver(\(arg))", completionHandler: nil) }
    }
    func loadServer() {
        let url = settings.serverUrl
        guard !url.isEmpty, let u = URL(string: url + "/crm#welcome") else { return openSettings() }   // заставка CRM
        loadedUrl = url
        web.load(URLRequest(url: u))
    }
    func openSettings() { present(UINavigationController(rootViewController: SettingsViewController(settings: settings)), animated: true) }
    func takePhoto(front: Bool, quality: Int, done: @escaping Done) {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else { return done(.failure(CommandError(.unsupported, "камеры нет"))) }
        photoDone?(.failure(CommandError(.cancelled, "новый снимок"))); photoDone = done; photoQuality = quality
        let p = UIImagePickerController()
        p.sourceType = .camera; p.cameraDevice = front ? .front : .rear; p.delegate = self
        present(p, animated: true)
    }
    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        let done = photoDone; photoDone = nil
        guard let img = info[.originalImage] as? UIImage, let jpeg = img.jpegData(compressionQuality: CGFloat(photoQuality) / 100) else { return done?(.failure(CommandError(.failed, "jpeg"))) ?? () }
        done?(.success(["dataUrl": "data:image/jpeg;base64," + jpeg.base64EncodedString(), "mime": "image/jpeg", "width": Int(img.size.width * img.scale), "height": Int(img.size.height * img.scale)]))
    }
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true); photoDone?(.failure(CommandError(.cancelled, "отменено"))); photoDone = nil
    }
    func scan(formats: [String], done: @escaping Done) {
        AVCaptureDevice.requestAccess(for: .video) { ok in
            DispatchQueue.main.async {
                guard ok else { return done(.failure(CommandError(.denied, "камера запрещена"))) }
                self.present(ScannerViewController(formats: formats, done: done), animated: true)
            }
        }
    }
    func registerPush(done: @escaping Done) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { ok, _ in
            DispatchQueue.main.async {
                guard ok, let app = UIApplication.shared.delegate as? AppDelegate else { return done(.failure(CommandError(.denied, "уведомления запрещены"))) }
                app.pushRegisterWaiters.append(done)
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }
    func openFromNotification(url: String?, data: [AnyHashable: Any]) {
        if let u = url, settings.isAllowed(url: u), let U = URL(string: u) { loadedUrl = settings.serverUrl; web.load(URLRequest(url: U)) }
        deliver(["event": "push.open", "data": ["url": url ?? "", "data": data.reduce(into: [String: Any]()) { if let k = $1.key as? String { $0[k] = $1.value } }]])
    }

    // MARK: транспорт FanNative
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let json = message.body as? String, let data = json.data(using: .utf8),
              let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        let id = req["id"] as? String ?? ""
        let cmd = req["cmd"] as? String ?? ""
        let args = req["args"] as? [String: Any] ?? [:]
        let url = message.frameInfo.request.url?.absoluteString
        guard settings.isAllowed(url: url) || Settings.isInternal(url) else {
            return deliver(["id": id, "ok": false, "error": ["code": "denied", "message": "чужой origin: \(Settings.origin(url) ?? "?")"]])
        }
        if cmd == "info" { return deliver(["id": id, "ok": true, "result": router.info()]) }
        router.run(cmd, args) { r in
            switch r {
            case .success(let res): self.deliver(["id": id, "ok": true, "result": res])
            case .failure(let e): self.deliver(["id": id, "ok": false, "error": ["code": e.code.rawValue, "message": e.message]])
            }
        }
    }

    // MARK: навигация и разрешения
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url?.absoluteString
        if settings.isAllowed(url: url) || Settings.isInternal(url) || url?.hasPrefix("about:") == true { return decisionHandler(.allow) }
        if let u = action.request.url, action.targetFrame?.isMainFrame != false { UIApplication.shared.open(u); return decisionHandler(.cancel) }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = action.request.url {
            if settings.isAllowed(url: u.absoluteString) { _ = webView.load(URLRequest(url: u)) } else { UIApplication.shared.open(u) }
        }
        return nil
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { showOffline(error) }
    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let o = origin.port > 0 ? "\(origin.protocol)://\(origin.host):\(origin.port)" : "\(origin.protocol)://\(origin.host)"
        decisionHandler(settings.allowedOrigins().contains(o) ? .grant : .deny)
    }

    private func showOffline(_ error: Error) {
        guard let p = Bundle.main.url(forResource: "offline", withExtension: "html") else { return }
        var c = URLComponents(url: p, resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "url", value: loadedUrl ?? ""), URLQueryItem(name: "err", value: error.localizedDescription)]
        web.loadFileURL(c.url!, allowingReadAccessTo: p.deletingLastPathComponent())
    }
}
