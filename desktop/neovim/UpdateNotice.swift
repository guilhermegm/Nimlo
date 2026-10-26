import AppKit

final class UpdateNotice: NSView {
  let message = NSTextField(labelWithString: "")
  let button = NSButton(title: "Download update…", target: nil, action: nil)
  var onOpen: (() -> Void)?
  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.backgroundColor = NSColor(rgb: 0x25352d).cgColor
    message.font = .systemFont(ofSize: 12, weight: .medium)
    message.textColor = NSColor(rgb: 0xd6e8c8)
    message.lineBreakMode = .byTruncatingTail
    message.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    button.target = self; button.action = #selector(open)
    button.bezelStyle = .rounded; button.controlSize = .small
    button.toolTip = "Open the official release page. Quit Nimlo before replacing its app bundle."
    button.setAccessibilityLabel("Download Nimlo update")
    let row = NSStackView(views: [message, NSView(), button])
    row.alignment = .centerY; row.spacing = 12; row.translatesAutoresizingMaskIntoConstraints = false
    addSubview(row)
    NSLayoutConstraint.activate([
      row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
      row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
      row.centerYAnchor.constraint(equalTo: centerYAnchor),
      button.widthAnchor.constraint(greaterThanOrEqualToConstant: 130),
    ])
    setAccessibilityRole(.group)
    setAccessibilityLabel("Nimlo update available")
    isHidden = true
  }
  required init?(coder: NSCoder) { fatalError() }
  func display(_ offer: NimloUpdateOffer?) {
    message.stringValue = offer.map { "Nimlo \($0.version.text) is available" } ?? ""
    isHidden = offer == nil
  }
  @objc private func open() { onOpen?() }
}
