import AppKit

extension NSColor {
  convenience init(rgb: Int) {
    self.init(
      calibratedRed: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255,
      blue: CGFloat(rgb & 255) / 255, alpha: 1)
  }
}

// Neovim sends only visible grid cells. AppKit renders them directly: ordinary
// editing starts no WebContent, GPU or networking helper process from WebKit.
final class EditorView: NSView, NSTextInputClient {
  struct Cell {
    var text = " "
    var highlight = 0
  }
  var engine: Neovim?
  var interactive = true
  var vimEnabled = false { didSet { needsDisplay = true } }
  var columns = 100, rows = 35, cursorRow = 0, cursorColumn = 0, modeName = "normal"
  var cellWidth: CGFloat = 8.4, lineHeight: CGFloat = 22
  var font = NSFont.monospacedSystemFont(ofSize: 14, weight: .regular)
  var foreground = NSColor(rgb: 0xe8edf3), background = NSColor(rgb: 0x15191f)
  var grid: [[Cell]] = []
  var highlights: [Int: [String: Any]] = [:]
  var onMode: ((String) -> Void)?
  var onActivity: (() -> Void)?
  var onClipboard: ((Bool) -> Void)?
  var sourceText: (() -> String)?
  private var marked = NSAttributedString(string: "")
  private var markedSelection = NSRange(location: 0, length: 0)
  private var resizeWork: DispatchWorkItem?
  override var isFlipped: Bool { true }
  override var acceptsFirstResponder: Bool { true }
  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.backgroundColor = background.cgColor
    cellWidth = ("M" as NSString).size(withAttributes: [.font: font]).width.rounded(.up)
    allocate(columns, rows)
    setAccessibilityElement(true)
    setAccessibilityRole(.textArea)
    setAccessibilityLabel("Code editor")
    toolTip =
      "Edit normally, or enable Vim for Neovim commands. Command-P finds files; Command-F finds text."
  }
  required init?(coder: NSCoder) { fatalError() }
  func allocate(_ width: Int, _ height: Int) {
    columns = width
    rows = height
    grid = Array(repeating: Array(repeating: Cell(), count: width), count: height)
    needsDisplay = true
  }
  override func setFrameSize(_ size: NSSize) {
    super.setFrameSize(size)
    scheduleResize()
  }
  func scheduleResize() {
    resizeWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.engine?.ready == true else { return }
      let cols = max(20, Int((self.bounds.width - 16) / self.cellWidth))
      let rows = max(4, Int((self.bounds.height - 12) / self.lineHeight))
      if cols != self.columns || rows != self.rows {
        self.engine?.call("nvim_ui_try_resize", [cols, rows])
      }
    }
    resizeWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.025, execute: work)
  }
  func redraw(_ batches: [[Any]]) {
    var flush = false
    for batch in batches {
      guard let name = batch.first as? String else { continue }
      for value in batch.dropFirst() {
        guard let a = value as? [Any] else { continue }
        switch name {
        case "grid_resize":
          if a.count >= 3, (a[0] as? Int) == 1 { allocate(a[1] as? Int ?? 100, a[2] as? Int ?? 35) }
        case "grid_clear": if (a.first as? Int) == 1 { allocate(columns, rows) }
        case "grid_cursor_goto":
          if a.count >= 3, (a[0] as? Int) == 1 {
            cursorRow = a[1] as? Int ?? 0
            cursorColumn = a[2] as? Int ?? 0
          }
        case "grid_line":
          guard a.count >= 4, (a[0] as? Int) == 1, let row = a[1] as? Int, row >= 0, row < rows,
            let cells = a[3] as? [[Any]]
          else { continue }
          var col = a[2] as? Int ?? 0
          var highlight = 0
          for cell in cells {
            guard let text = cell.first as? String else { continue }
            if cell.count > 1 { highlight = cell[1] as? Int ?? 0 }
            let count = cell.count > 2 ? cell[2] as? Int ?? 1 : 1
            for _ in 0..<min(max(0, count), columns) {
              if col >= 0 && col < columns {
                grid[row][col] = Cell(text: text, highlight: highlight)
              }
              col += 1
            }
          }
        case "grid_scroll":
          guard a.count >= 7, (a[0] as? Int) == 1 else { continue }
          let top = max(0, a[1] as? Int ?? 0)
          let bottom = min(rows, a[2] as? Int ?? rows)
          let left = max(0, a[3] as? Int ?? 0)
          let right = min(columns, a[4] as? Int ?? columns)
          let dy = a[5] as? Int ?? 0
          let dx = a[6] as? Int ?? 0
          let old = grid
          if top < bottom && left < right {
            for row in top..<bottom {
              for col in left..<right {
                let sr = row + dy
                let sc = col + dx
                grid[row][col] =
                  (sr >= top && sr < bottom && sc >= left && sc < right) ? old[sr][sc] : Cell()
              }
            }
          }
        case "hl_attr_define":
          if a.count >= 2, let id = a[0] as? Int { highlights[id] = a[1] as? [String: Any] ?? [:] }
        case "default_colors_set":
          if a.count >= 2 {
            if let fg = a[0] as? Int, fg >= 0 { foreground = NSColor(rgb: fg) }
            if let bg = a[1] as? Int, bg >= 0 {
              background = NSColor(rgb: bg)
              layer?.backgroundColor = background.cgColor
            }
          }
        case "mode_change":
          modeName = a.first as? String ?? "normal"
          onMode?(modeName)
        case "flush": flush = true
        default: break
        }
      }
    }
    if flush {
      needsDisplay = true
      inputContext?.invalidateCharacterCoordinates()
    }
  }
  override func draw(_ dirtyRect: NSRect) {
    background.setFill()
    dirtyRect.fill()
    for row in 0..<min(rows, grid.count) {
      let top = 6 + CGFloat(row) * lineHeight
      if top + lineHeight < dirtyRect.minY || top > dirtyRect.maxY { continue }
      for col in 0..<columns {
        let cell = grid[row][col]
        let style = highlights[cell.highlight] ?? [:]
        var fg = (style["foreground"] as? Int).map(NSColor.init(rgb:)) ?? foreground
        var bg = (style["background"] as? Int).map(NSColor.init(rgb:)) ?? background
        if style["reverse"] as? Bool == true { swap(&fg, &bg) }
        let rect = NSRect(
          x: 8 + CGFloat(col) * cellWidth, y: top, width: cellWidth, height: lineHeight)
        if !bg.isEqual(background) {
          bg.setFill()
          rect.fill()
        }
        if cell.text.isEmpty || cell.text == " " { continue }
        let f =
          style["bold"] as? Bool == true
          ? NSFont.monospacedSystemFont(ofSize: font.pointSize, weight: .semibold) : font
        var attributes: [NSAttributedString.Key: Any] = [
          .font: f, .foregroundColor: fg, .ligature: 0,
        ]
        if style["italic"] as? Bool == true { attributes[.obliqueness] = 0.15 }
        if style["underline"] as? Bool == true || style["undercurl"] as? Bool == true {
          attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
        }
        (cell.text as NSString).draw(
          at: NSPoint(x: rect.minX, y: top + (lineHeight - f.ascender + f.descender) / 2 - 1),
          withAttributes: attributes)
      }
    }
    if cursorRow >= 0 && cursorRow < rows && cursorColumn >= 0 && cursorColumn < columns {
      var rect = NSRect(
        x: 8 + CGFloat(cursorColumn) * cellWidth, y: 6 + CGFloat(cursorRow) * lineHeight,
        width: cellWidth, height: lineHeight)
      let active = window?.firstResponder === self
      NSColor(rgb: 0xc6e3ad).withAlphaComponent(active ? 0.8 : 0.35).setFill()
      if !vimEnabled || modeName.hasPrefix("insert") {
        rect.size.width = 2
        rect.fill()
      } else if active {
        NSColor(rgb: 0xc6e3ad).withAlphaComponent(0.28).setFill()
        rect.fill()
      } else {
        NSBezierPath(rect: rect.insetBy(dx: 0.5, dy: 0.5)).stroke()
      }
      if marked.length > 0 {
        let value = NSMutableAttributedString(attributedString: marked)
        value.addAttributes(
          [
            .font: font, .foregroundColor: foreground, .backgroundColor: background,
            .underlineStyle: NSUnderlineStyle.single.rawValue,
          ], range: NSRange(location: 0, length: value.length))
        value.draw(at: rect.origin)
      }
    }
  }
  override func becomeFirstResponder() -> Bool {
    needsDisplay = true
    return true
  }
  override func resignFirstResponder() -> Bool {
    needsDisplay = true
    return true
  }
  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    if window?.firstResponder === self, event.modifierFlags.contains(.command),
      [UInt16(123), 124, 125, 126].contains(event.keyCode)
    {
      keyDown(with: event)
      return true
    }
    return super.performKeyEquivalent(with: event)
  }
  override func keyDown(with event: NSEvent) {
    guard engine?.ready == true, interactive else {
      NSSound.beep()
      return
    }
    onActivity?()
    if hasMarkedText() {
      interpretKeyEvents([event])
      return
    }
    let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    let specials: [UInt16: String] = [
      36: "CR", 48: "Tab", 51: "BS", 53: "Esc", 117: "Del", 123: "Left", 124: "Right", 125: "Down",
      126: "Up", 115: "Home", 119: "End", 116: "PageUp", 121: "PageDown",
    ]
    if let key = specials[event.keyCode] {
      var prefix = ""
      if modifiers.contains(.control) { prefix += "C-" }
      if modifiers.contains(.option) { prefix += "M-" }
      if modifiers.contains(.shift) { prefix += "S-" }
      if modifiers.contains(.command) {
        let mapped: [String: String] = [
          "Left": "Home", "Right": "End", "Up": "C-Home", "Down": "C-End",
        ]
        let shift = modifiers.contains(.shift) ? "S-" : ""
        engine?.keys("<\(shift)\(mapped[key] ?? key)>")
      } else {
        // Neovim uses Control for word navigation; macOS uses Option.
        if ["Left", "Right"].contains(key), modifiers.contains(.option),
          !modifiers.contains(.control)
        {
          prefix = modifiers.contains(.shift) ? "C-S-" : "C-"
        }
        engine?.keys("<\(prefix)\(key)>")
      }
      return
    }
    if modifiers.contains(.control), let text = event.charactersIgnoringModifiers, !text.isEmpty {
      engine?.keys("<C-\(text)>")
      return
    }
    interpretKeyEvents([event])
  }
  func insertText(_ string: Any, replacementRange: NSRange) {
    guard interactive else { return }
    onActivity?()
    let text = (string as? NSAttributedString)?.string ?? string as? String ?? ""
    unmarkText()
    engine?.lua("return _G.nimlo.type(...)", [text])
  }
  override func doCommand(by selector: Selector) {
    let commands: [String: String] = [
      "moveLeft:": "Left", "moveRight:": "Right", "moveUp:": "Up", "moveDown:": "Down",
      "moveLeftAndModifySelection:": "S-Left", "moveRightAndModifySelection:": "S-Right",
      "moveUpAndModifySelection:": "S-Up", "moveDownAndModifySelection:": "S-Down",
      "moveWordLeft:": "C-Left", "moveWordRight:": "C-Right",
      "moveWordLeftAndModifySelection:": "C-S-Left",
      "moveWordRightAndModifySelection:": "C-S-Right",
      "moveToBeginningOfLine:": "Home", "moveToEndOfLine:": "End",
      "moveToBeginningOfLineAndModifySelection:": "S-Home",
      "moveToEndOfLineAndModifySelection:": "S-End",
      "moveToBeginningOfDocument:": "C-Home", "moveToEndOfDocument:": "C-End",
      "moveToBeginningOfDocumentAndModifySelection:": "C-S-Home",
      "moveToEndOfDocumentAndModifySelection:": "C-S-End",
      "deleteBackward:": "BS", "deleteForward:": "Del", "insertNewline:": "CR", "insertTab:": "Tab",
      "insertBacktab:": "S-Tab", "cancelOperation:": "Esc",
    ]
    if let key = commands[NSStringFromSelector(selector)] { engine?.keys("<\(key)>") }
  }
  func hasMarkedText() -> Bool { marked.length > 0 }
  func markedRange() -> NSRange {
    marked.length > 0
      ? NSRange(location: 0, length: marked.length) : NSRange(location: NSNotFound, length: 0)
  }
  func selectedRange() -> NSRange { markedSelection }
  func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
    onActivity?()
    marked = (string as? NSAttributedString) ?? NSAttributedString(string: string as? String ?? "")
    markedSelection = selectedRange
    needsDisplay = true
  }
  func unmarkText() {
    marked = NSAttributedString(string: "")
    markedSelection = NSRange(location: 0, length: 0)
    needsDisplay = true
  }
  func validAttributesForMarkedText() -> [NSAttributedString.Key] {
    [.underlineStyle, .foregroundColor, .backgroundColor]
  }
  func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?)
    -> NSAttributedString?
  {
    guard marked.length > 0 else { return nil }
    let intersection = NSIntersectionRange(range, NSRange(location: 0, length: marked.length))
    actualRange?.pointee = intersection
    return marked.attributedSubstring(from: intersection)
  }
  func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
    let rect = NSRect(
      x: 8 + CGFloat(cursorColumn) * cellWidth, y: 6 + CGFloat(cursorRow) * lineHeight,
      width: cellWidth, height: lineHeight)
    return window?.convertToScreen(convert(rect, to: nil)) ?? rect
  }
  func characterIndex(for point: NSPoint) -> Int { 0 }
  private func mouse(_ event: NSEvent, _ action: String) {
    window?.makeFirstResponder(self)
    let p = convert(event.locationInWindow, from: nil)
    let row = max(0, min(rows - 1, Int((p.y - 6) / lineHeight)))
    let col = max(0, min(columns - 1, Int((p.x - 8) / cellWidth)))
    var mods = ""
    if event.modifierFlags.contains(.shift) { mods += "S" }
    if event.modifierFlags.contains(.control) { mods += "C" }
    if event.clickCount == 2 { mods += "2" }
    if event.clickCount >= 3 { mods += "3" }
    engine?.call("nvim_input_mouse", ["left", action, mods, 1, row, col])
  }
  override func mouseDown(with event: NSEvent) { mouse(event, "press") }
  override func mouseDragged(with event: NSEvent) { mouse(event, "drag") }
  override func mouseUp(with event: NSEvent) { mouse(event, "release") }
  override func scrollWheel(with event: NSEvent) {
    let delta =
      abs(event.scrollingDeltaY) > abs(event.scrollingDeltaX)
      ? event.scrollingDeltaY : event.scrollingDeltaX
    guard delta != 0 else { return }
    let vertical = abs(event.scrollingDeltaY) > abs(event.scrollingDeltaX)
    let action = vertical ? (delta > 0 ? "up" : "down") : (delta > 0 ? "left" : "right")
    for _ in 0..<min(8, max(1, Int(abs(delta) / 12))) {
      engine?.call(
        "nvim_input_mouse", ["wheel", action, "", 1, max(0, cursorRow), max(0, cursorColumn)])
    }
  }
  @objc func copy(_ sender: Any?) { engine?.lua("_G.nimlo.copy(false)") }
  @objc func cut(_ sender: Any?) {
    guard interactive else { return }
    onActivity?()
    engine?.lua("_G.nimlo.copy(true)")
  }
  @objc func paste(_ sender: Any?) {
    guard interactive else { return }
    onActivity?()
    if let value = NSPasteboard.general.string(forType: .string) { engine?.text(value) }
  }
  @objc override func selectAll(_ sender: Any?) { engine?.lua("_G.nimlo.select_all()") }
}
