import UIKit

/// Нативный экран настроек: адрес сервера (руками или QR), дополнительные адреса.
final class SettingsViewController: UIViewController {
    private let settings: Settings
    private let urlField = UITextField()
    private let hostsField = UITextField()
    private let msg = UILabel()

    init(settings: Settings) { self.settings = settings; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Настройки движка ФАН"
        view.backgroundColor = UIColor(red: 0.067, green: 0.075, blue: 0.094, alpha: 1)
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Сохранить", style: .done, target: self, action: #selector(save))
        let stack = UIStackView(arrangedSubviews: [field(urlField, "Адрес сервера CRM (https://…)", settings.serverUrl),
                                                   field(hostsField, "Дополнительные адреса через запятую", settings.allowHosts),
                                                   button("Сканировать QR с адресом", #selector(scanQr)), msg])
        stack.axis = .vertical; stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 20),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20)
        ])
        msg.textColor = .lightGray; msg.numberOfLines = 0
    }

    private func field(_ f: UITextField, _ placeholder: String, _ value: String) -> UITextField {
        f.placeholder = placeholder; f.text = value; f.borderStyle = .roundedRect
        f.autocapitalizationType = .none; f.autocorrectionType = .no; f.keyboardType = .URL
        return f
    }
    private func button(_ title: String, _ sel: Selector) -> UIButton {
        let b = UIButton(type: .system)
        b.setTitle(title, for: .normal); b.addTarget(self, action: sel, for: .touchUpInside)
        b.backgroundColor = UIColor(red: 1, green: 0.31, blue: 0.64, alpha: 1); b.tintColor = .white
        b.layer.cornerRadius = 8; b.heightAnchor.constraint(equalToConstant: 44).isActive = true
        return b
    }

    @objc private func scanQr() {
        present(ScannerViewController(formats: ["qr"]) { [weak self] r in
            if case .success(let d) = r, let t = d["text"] as? String { t.hasPrefix("http") ? (self?.urlField.text = t) : (self?.msg.text = "В QR не адрес: \(t)") }
        }, animated: true)
    }
    @objc private func save() {
        let v = urlField.text ?? ""
        guard Settings.origin(v) != nil else { msg.text = "Нужен адрес вида https://…"; return }
        settings.serverUrl = v
        settings.allowHosts = hostsField.text ?? ""
        dismiss(animated: true)
    }
}
