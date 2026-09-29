import UIKit
import AVFoundation

/// Нативный сканер штрих-кодов/QR (AVCaptureMetadataOutput): полноэкранная камера + «Отмена».
final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let session = AVCaptureSession()
    private let formats: [String]
    private let done: Done
    private var finished = false

    private static let map: [String: AVMetadataObject.ObjectType] = [
        "qr": .qr, "ean13": .ean13, "ean8": .ean8, "code128": .code128, "code39": .code39, "upc": .upce, "datamatrix": .dataMatrix, "pdf417": .pdf417
    ]

    init(formats: [String], done: @escaping Done) {
        self.formats = formats; self.done = done
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device) else {
            return finish(.failure(CommandError(.failed, "камера недоступна")))
        }
        session.addInput(input)
        let out = AVCaptureMetadataOutput()
        session.addOutput(out)
        out.setMetadataObjectsDelegate(self, queue: .main)
        let wanted = formats.compactMap { ScannerViewController.map[$0] }
        out.metadataObjectTypes = wanted.isEmpty ? out.availableMetadataObjectTypes : wanted.filter { out.availableMetadataObjectTypes.contains($0) }
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.frame = view.bounds; preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)

        let cancel = UIButton(type: .system)
        cancel.setTitle("Отмена", for: .normal)
        cancel.titleLabel?.font = .systemFont(ofSize: 18)
        cancel.tintColor = .white; cancel.backgroundColor = UIColor(white: 0.13, alpha: 1)
        cancel.frame = CGRect(x: 0, y: view.bounds.height - 90, width: view.bounds.width, height: 90)
        cancel.autoresizingMask = [.flexibleWidth, .flexibleTopMargin]
        cancel.addTarget(self, action: #selector(onCancel), for: .touchUpInside)
        view.addSubview(cancel)
        DispatchQueue.global().async { self.session.startRunning() }
    }

    @objc private func onCancel() { finish(.failure(CommandError(.cancelled, "отменено"))) }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let o = objects.first as? AVMetadataMachineReadableCodeObject, let text = o.stringValue else { return }
        let name = ScannerViewController.map.first { $0.value == o.type }?.key ?? o.type.rawValue
        Haptics.play("success")
        finish(.success(["text": text, "format": name]))
    }

    private func finish(_ r: Result<[String: Any], CommandError>) {
        guard !finished else { return }
        finished = true
        session.stopRunning()
        dismiss(animated: true) { self.done(r) }
    }
}
