import AppKit
import QuartzCore
import WebKit

final class ToolbarButton: NSButton {
  let label: String
  var compact = false {
    didSet {
      invalidateIntrinsicContentSize()
      needsDisplay = true
    }
  }
  private var hovered = false
  private var tracking: NSTrackingArea?
  init(_ title: String, symbol: String? = nil, target: AnyObject?, action: Selector?) {
    label = title
    super.init(frame: .zero)
    self.title = title
    self.target = target
    self.action = action
    if let symbol { image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }
    font = .systemFont(ofSize: 12, weight: .medium)
    isBordered = false
    setButtonType(.momentaryChange)
    setAccessibilityLabel(title)
    toolTip = title
    setContentCompressionResistancePriority(.required, for: .horizontal)
  }
  required init?(coder: NSCoder) { fatalError() }
  override var intrinsicContentSize: NSSize {
    let text = compact && image != nil ? "" : label
    let width = (text as NSString).size(withAttributes: [.font: font!]).width
    return NSSize(
      width: max(30, ceil(width) + (image == nil ? 18 : text.isEmpty ? 30 : 41)), height: 30)
  }
  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let tracking { removeTrackingArea(tracking) }
    let area = NSTrackingArea(
      rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
    addTrackingArea(area)
    tracking = area
  }
  override func mouseEntered(with event: NSEvent) {
    hovered = true
    needsDisplay = true
  }
  override func mouseExited(with event: NSEvent) {
    hovered = false
    needsDisplay = true
  }
  override var state: NSControl.StateValue { didSet { needsDisplay = true } }
  override func draw(_ dirtyRect: NSRect) {
    let active = state == .on
    let tint = NSColor(rgb: active ? 0xc6e3ad : 0xc5cdd8).withAlphaComponent(isEnabled ? 1 : 0.45)
    if active || hovered || cell?.isHighlighted == true {
      NSColor(rgb: active ? 0x303c32 : 0x303944).setFill()
      NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 6, yRadius: 6).fill()
    }
    let text = compact && image != nil ? "" : label
    let size = (text as NSString).size(withAttributes: [.font: font!])
    let group = size.width + (image == nil ? 0 : text.isEmpty ? 14 : 21)
    var x = (bounds.width - group) / 2
    if let image {
      let symbol = image.withSymbolConfiguration(.init(paletteColors: [tint])) ?? image
      symbol.draw(
        in: NSRect(x: x, y: (bounds.height - 14) / 2, width: 14, height: 14), from: .zero,
        operation: .sourceOver, fraction: isEnabled ? 1 : 0.45, respectFlipped: true, hints: nil)
      x += text.isEmpty ? 14 : 21
    }
    (text as NSString).draw(
      at: NSPoint(x: x, y: (bounds.height - size.height) / 2),
      withAttributes: [.font: font!, .foregroundColor: tint])
    if window?.firstResponder === self {
      NSColor(rgb: 0xa7cc8e).setStroke()
      NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 6, yRadius: 6).stroke()
    }
  }
}

final class EditorModeControl: NSView {
  weak var target: AnyObject?
  var action: Selector?
  var isEnabled = true {
    didSet {
      edit.isEnabled = isEnabled
      vim.isEnabled = isEnabled
    }
  }
  var selectedSegment = 0 {
    didSet {
      edit.state = selectedSegment == 0 ? .on : .off
      vim.state = selectedSegment == 1 ? .on : .off
      edit.setAccessibilityValue(NSNumber(value: selectedSegment == 0))
      vim.setAccessibilityValue(NSNumber(value: selectedSegment == 1))
    }
  }
  private lazy var edit = ToolbarButton("Edit", target: self, action: #selector(chooseEdit))
  private lazy var vim = ToolbarButton("Vim", target: self, action: #selector(chooseVim))
  override var intrinsicContentSize: NSSize { NSSize(width: 94, height: 30) }
  override init(frame: NSRect) {
    super.init(frame: frame)
    for button in [edit, vim] {
      button.setButtonType(.momentaryChange)
      button.setAccessibilityRole(.radioButton)
      button.image = nil
      button.translatesAutoresizingMaskIntoConstraints = false
      addSubview(button)
    }
    edit.toolTip = "Standard editing"
    vim.toolTip = "Vim navigation and commands"
    edit.state = .on
    edit.setAccessibilityValue(NSNumber(value: true))
    vim.setAccessibilityValue(NSNumber(value: false))
    setAccessibilityRole(.group)
    setAccessibilityLabel("Editing mode")
    NSLayoutConstraint.activate([
      edit.leadingAnchor.constraint(equalTo: leadingAnchor),
      edit.topAnchor.constraint(equalTo: topAnchor),
      edit.bottomAnchor.constraint(equalTo: bottomAnchor),
      vim.leadingAnchor.constraint(equalTo: edit.trailingAnchor, constant: 2),
      vim.trailingAnchor.constraint(equalTo: trailingAnchor),
      vim.topAnchor.constraint(equalTo: topAnchor),
      vim.bottomAnchor.constraint(equalTo: bottomAnchor),
      edit.widthAnchor.constraint(equalTo: vim.widthAnchor),
      widthAnchor.constraint(equalToConstant: 94), heightAnchor.constraint(equalToConstant: 30),
    ])
  }
  required init?(coder: NSCoder) { fatalError() }
  @objc private func chooseEdit() { select(0) }
  @objc private func chooseVim() { select(1) }
  private func select(_ index: Int) {
    selectedSegment = index
    if let action { NSApp.sendAction(action, to: target, from: self) }
  }
}

// The native editor remains below a transparent, single WebView. Its rectangular
// opening follows the original workspace's AI and terminal layout.
final class EditorWorkspace: NSView {
  let source = NSView()
  private let dim = NSView()
  var modal = false { didSet { dim.isHidden = !modal } }
  var sourceRect: NSRect? { didSet { needsLayout = true } }
  override var isFlipped: Bool { true }
  override init(frame: NSRect) {
    super.init(frame: frame)
    addSubview(source)
    dim.wantsLayer = true
    dim.layer?.backgroundColor = NSColor(rgb: 0x080b0f).withAlphaComponent(0.65).cgColor
    dim.isHidden = true
    addSubview(dim)
  }
  required init?(coder: NSCoder) { fatalError() }
  override func setFrameSize(_ size: NSSize) {
    super.setFrameSize(size)
    needsLayout = true
  }
  override func layout() {
    super.layout()
    source.frame = (sourceRect ?? bounds).intersection(bounds)
    dim.frame = source.frame
  }
}

final class WorkspaceWebView: WKWebView {
  var editorRect = NSRect.zero { didSet { updateMask() } }
  var overlays: [NSRect] = [] { didSet { updateMask() } }
  var blocksEditor = true
  override var isOpaque: Bool { false }
  private func viewRect(_ rect: NSRect) -> NSRect {
    NSRect(
      x: rect.minX, y: isFlipped ? rect.minY : bounds.height - rect.maxY, width: rect.width,
      height: rect.height)
  }
  private func updateMask() {
    wantsLayer = true
    guard !bounds.isEmpty else { return }
    let path = CGMutablePath()
    path.addRect(bounds)
    let hole = viewRect(editorRect)
    path.move(to: CGPoint(x: hole.minX, y: hole.minY))
    path.addLine(to: CGPoint(x: hole.minX, y: hole.maxY))
    path.addLine(to: CGPoint(x: hole.maxX, y: hole.maxY))
    path.addLine(to: CGPoint(x: hole.maxX, y: hole.minY))
    path.closeSubpath()
    for overlay in overlays { path.addRect(viewRect(overlay)) }
    let mask = CAShapeLayer()
    mask.frame = bounds
    mask.path = path
    mask.fillRule = .nonZero
    layer?.mask = mask
  }
  override func layout() {
    super.layout()
    updateMask()
  }
  override func hitTest(_ point: NSPoint) -> NSView? {
    let local = convert(point, from: superview)
    let cssPoint = NSPoint(x: local.x, y: isFlipped ? local.y : bounds.height - local.y)
    if !blocksEditor && editorRect.contains(cssPoint)
      && !overlays.contains(where: { $0.contains(cssPoint) })
    {
      return nil
    }
    return super.hitTest(point)
  }
}
