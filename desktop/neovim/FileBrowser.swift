import AppKit

final class FileNode: NSObject {
  let name: String, path: String, directory: Bool
  var children: [FileNode] = [], loaded = false, loading = false, depth = 0
  var waiters: [(Bool) -> Void] = []
  init(_ name: String, _ path: String, _ directory: Bool, depth: Int = 0) {
    self.name = name
    self.path = path
    self.directory = directory
    self.depth = depth
  }
  convenience init(_ entry: [String: Any], depth: Int) {
    self.init(
      entry["name"] as? String ?? "", entry["path"] as? String ?? "",
      entry["directory"] as? Bool ?? false, depth: depth)
  }
}
final class FileBrowser: NSView, NSOutlineViewDataSource, NSOutlineViewDelegate,
  NSSearchFieldDelegate
{
  let outline = NSOutlineView(), scroll = NSScrollView(), filter = NSSearchField(),
    title = NSTextField(labelWithString: "FILES")
  let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("file"))
  var client: WorkspaceClient?
  var onOpen: ((String) -> Void)?, onNew: (() -> Void)?, onNotice: ((String) -> Void)?
  var cache: [FileNode] = []
  var root = FileNode("Project", "", true), project = "", selectedPath = "",
    matches: [FileNode] = []
  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.backgroundColor = NSColor(rgb: 0x1b2129).cgColor
    title.font = NSFont.systemFont(ofSize: 10, weight: .semibold)
    title.textColor = NSColor(rgb: 0x8491a2)
    filter.placeholderString = "Filter expanded folders"
    filter.delegate = self
    filter.font = NSFont.systemFont(ofSize: 12)
    filter.focusRingType = .none
    let add = NSButton(
      image: NSImage(systemSymbolName: "plus", accessibilityDescription: "New file")!, target: self,
      action: #selector(newFile))
    add.isBordered = false
    add.toolTip = "New file · Command-N"
    for view in [title, add, filter, scroll] {
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
    }
    outline.addTableColumn(column)
    outline.outlineTableColumn = column
    outline.headerView = nil
    outline.dataSource = self
    outline.delegate = self
    outline.target = self
    outline.action = #selector(clicked)
    outline.rowHeight = 27
    outline.indentationPerLevel = 12
    outline.intercellSpacing = NSSize(width: 0, height: 1)
    outline.backgroundColor = NSColor(rgb: 0x1b2129)
    outline.selectionHighlightStyle = .regular
    outline.columnAutoresizingStyle = .noColumnAutoresizing
    outline.autoresizesOutlineColumn = false
    column.resizingMask = .userResizingMask
    column.width = 280
    scroll.documentView = outline
    scroll.hasVerticalScroller = true
    scroll.hasHorizontalScroller = true
    scroll.autohidesScrollers = true
    scroll.drawsBackground = false
    NSLayoutConstraint.activate([
      title.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      title.topAnchor.constraint(equalTo: topAnchor, constant: 18),
      add.centerYAnchor.constraint(equalTo: title.centerYAnchor),
      add.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
      add.widthAnchor.constraint(equalToConstant: 24),
      add.heightAnchor.constraint(equalToConstant: 24),
      filter.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 14),
      filter.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
      filter.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
      filter.heightAnchor.constraint(equalToConstant: 26),
      scroll.topAnchor.constraint(equalTo: filter.bottomAnchor, constant: 10),
      scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
      scroll.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
    ])
  }
  required init?(coder: NSCoder) { fatalError() }
  func update(project: String, name: String, files: [[String: Any]]) {
    self.project = project
    root = FileNode(name, "", true)
    root.loaded = true
    root.children = files.map { FileNode($0, depth: 1) }
    cache = [root]
    selectedPath = ""
    filter.stringValue = ""
    matches = []
    outline.reloadData()
    outline.expandItem(root)
    resizeColumn()
  }
  func controlTextDidChange(_ notification: Notification) {
    let query = filter.stringValue.lowercased()
    matches = []
    func collect(_ node: FileNode) {
      for child in node.children {
        if child.name.lowercased().contains(query) { matches.append(child) }
        collect(child)
      }
    }
    if !query.isEmpty { collect(root) }
    outline.reloadData()
    resizeColumn()
  }
  func resizeColumn() {
    var width = max(220, bounds.width - 2)
    func measure(_ node: FileNode) {
      width = max(
        width,
        CGFloat(node.depth) * 12
          + (node.name as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 12)])
          .width + 64)
      for child in node.children { measure(child) }
    }
    measure(root)
    column.width = width
  }
  override func setFrameSize(_ size: NSSize) {
    super.setFrameSize(size)
    resizeColumn()
  }
  func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
    if !filter.stringValue.isEmpty { return item == nil ? matches.count : 0 }
    return (item as? FileNode)?.children.count ?? 1
  }
  func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
    if !filter.stringValue.isEmpty { return matches[index] }
    return (item as? FileNode)?.children[index] ?? root
  }
  func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
    filter.stringValue.isEmpty && (item as? FileNode)?.directory == true
  }
  func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any)
    -> NSView?
  {
    guard let node = item as? FileNode else { return nil }
    let cell = NSTableCellView()
    let icon = NSImageView()
    let label = NSTextField(labelWithString: node.name)
    icon.image = NSImage(
      systemSymbolName: node.directory ? "folder" : "doc", accessibilityDescription: nil)
    icon.contentTintColor = NSColor(rgb: 0x8491a2)
    label.font = NSFont.systemFont(ofSize: 12)
    label.textColor = node.path == selectedPath ? NSColor(rgb: 0xc6e3ad) : NSColor(rgb: 0xdde4ed)
    label.lineBreakMode = .byClipping
    icon.translatesAutoresizingMaskIntoConstraints = false
    label.translatesAutoresizingMaskIntoConstraints = false
    cell.addSubview(icon)
    cell.addSubview(label)
    cell.textField = label
    cell.imageView = icon
    cell.toolTip = node.path
    NSLayoutConstraint.activate([
      icon.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 3),
      icon.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
      icon.widthAnchor.constraint(equalToConstant: 14),
      icon.heightAnchor.constraint(equalToConstant: 14),
      label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 7),
      label.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
      label.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -6),
    ])
    return cell
  }
  func outlineViewItemWillExpand(_ notification: Notification) {
    guard let node = notification.userInfo?["NSObject"] as? FileNode else { return }
    load(node) { _ in }
  }
  func load(_ node: FileNode, done: @escaping (Bool) -> Void) {
    if node.loaded {
      done(true)
      return
    }
    node.waiters.append(done)
    guard !node.loading, let client else { return }
    node.loading = true
    let scope = project
    client.command("list_project_files", ["targetProjectId": scope, "directory": node.path]) {
      [weak self, weak node] result in
      guard let self, let node else { return }
      node.loading = false
      var loaded = false
      if self.project == scope, case .success(let reply) = result {
        let files = reply["files"] as? [[String: Any]] ?? []
        func overBudget() -> Bool {
          self.cache.count >= 64
            || self.cache.reduce(0, { $0 + $1.children.count }) + files.count > 8000
        }
        while overBudget(),
          let victim = self.cache.first(where: {
            $0 !== self.root
              && (!self.outline.isItemExpanded($0) || self.outline.row(forItem: $0) < 0)
          })
        {
          let prefix = victim.path + "/"
          self.cache.removeAll { $0 === victim || $0.path.hasPrefix(prefix) }
          victim.children = []
          victim.loaded = false
        }
        if !overBudget() {
          node.loaded = true
          node.children = files.map { FileNode($0, depth: node.depth + 1) }
          self.cache.append(node)
          loaded = true
          self.outline.reloadItem(node, reloadChildren: true)
          self.outline.expandItem(node)
          self.resizeColumn()
        } else {
          self.outline.collapseItem(node)
          self.onNotice?(
            "Collapse a folder before expanding another. This keeps the file tree small.")
        }
      } else if case .failure(let error) = result {
        self.onNotice?(error.localizedDescription)
      }
      let waiters = node.waiters
      node.waiters = []
      for waiter in waiters { waiter(loaded) }
    }
  }
  @objc func clicked() {
    guard let node = outline.item(atRow: outline.clickedRow) as? FileNode else { return }
    if node.directory {
      if outline.isItemExpanded(node) {
        outline.collapseItem(node)
      } else {
        outline.expandItem(node)
      }
    } else {
      onOpen?(node.path)
    }
  }
  @objc func newFile() { onNew?() }
  func select(_ path: String) {
    selectedPath = path
    outline.reloadData()
    let scope = project
    let parts = path.split(separator: "/").map(String.init)
    func reveal(_ parent: FileNode, _ index: Int) {
      guard self.project == scope, self.selectedPath == path, index < parts.count else { return }
      self.load(parent) { [weak self] ok in
        guard let self, ok, self.project == scope, self.selectedPath == path,
          let node = parent.children.first(where: { $0.name == parts[index] })
        else { return }
        self.outline.expandItem(parent)
        if index + 1 == parts.count {
          let row = self.outline.row(forItem: node)
          if row >= 0 {
            self.outline.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
            self.outline.scrollRowToVisible(row)
          }
        } else {
          reveal(node, index + 1)
        }
      }
    }
    if !parts.isEmpty && filter.stringValue.isEmpty { reveal(root, 0) }
  }

}

final class FilePalette: NSObject, NSTableViewDataSource, NSTableViewDelegate,
  NSSearchFieldDelegate, NSWindowDelegate
{
  let panel = NSPanel(
    contentRect: NSRect(x: 0, y: 0, width: 640, height: 430), styleMask: [.titled, .closable],
    backing: .buffered, defer: false)
  let field = NSSearchField(), table = NSTableView(), hint = NSTextField(labelWithString: "")
  let scroll = NSScrollView()
  var rows: [[String: Any]] = [], client: WorkspaceClient, project: String,
    rootFiles: [[String: Any]], onOpen: ((String) -> Void)?, onClose: (() -> Void)?
  private var epoch = 0, work: DispatchWorkItem?, wantOpen = false
  init(client: WorkspaceClient, name: String, files: [[String: Any]]) {
    self.client = client
    project = client.projectId
    rootFiles = files
    super.init()
    panel.title = "Find file · " + name
    panel.appearance = NSAppearance(named: .darkAqua)
    panel.backgroundColor = NSColor(rgb: 0x1b2129)
    panel.isReleasedWhenClosed = false
    panel.delegate = self
    let view = panel.contentView!
    field.delegate = self
    field.placeholderString = "File name or folder/path"
    field.font = NSFont.systemFont(ofSize: 15)
    field.focusRingType = .none
    let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("result"))
    column.width = 594
    table.addTableColumn(column)
    table.headerView = nil
    table.delegate = self
    table.dataSource = self
    table.rowHeight = 46
    table.intercellSpacing = NSSize(width: 0, height: 2)
    table.backgroundColor = NSColor(rgb: 0x1b2129)
    table.target = self
    table.doubleAction = #selector(openSelected)
    scroll.documentView = table
    scroll.hasVerticalScroller = true
    scroll.drawsBackground = false
    hint.font = NSFont.systemFont(ofSize: 11)
    hint.textColor = NSColor(rgb: 0x8491a2)
    for item in [field, scroll, hint] {
      item.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(item)
    }
    NSLayoutConstraint.activate([
      field.topAnchor.constraint(equalTo: view.topAnchor, constant: 16),
      field.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
      field.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
      field.heightAnchor.constraint(equalToConstant: 34),
      scroll.topAnchor.constraint(equalTo: field.bottomAnchor, constant: 12),
      scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
      scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
      scroll.bottomAnchor.constraint(equalTo: hint.topAnchor, constant: -8),
      hint.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 18),
      hint.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -18),
      hint.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -12),
      hint.heightAnchor.constraint(equalToConstant: 18),
    ])
  }
  func show(_ parent: NSWindow) {
    parent.beginSheet(panel)
    panel.makeFirstResponder(field)
    search()
  }
  func close() {
    epoch += 1
    work?.cancel()
    if let parent = panel.sheetParent { parent.endSheet(panel) }
    panel.orderOut(nil)
    onClose?()
  }
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    close()
    return false
  }
  func controlTextDidChange(_ notification: Notification) {
    epoch += 1
    wantOpen = false
    work?.cancel()
    let next = DispatchWorkItem { [weak self] in self?.search() }
    work = next
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: next)
  }
  func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
  func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView?
  {
    let entry = rows[row]
    let view = NSView()
    let name = NSTextField(
      labelWithString: (entry["name"] as? String ?? "")
        + ((entry["directory"] as? Bool) == true ? "/" : ""))
    let path = NSTextField(labelWithString: entry["path"] as? String ?? "")
    name.font = NSFont.systemFont(ofSize: 13, weight: .medium)
    path.font = NSFont.systemFont(ofSize: 11)
    path.textColor = NSColor(rgb: 0x8491a2)
    name.lineBreakMode = .byTruncatingMiddle
    path.lineBreakMode = .byTruncatingHead
    name.frame = NSRect(x: 12, y: 23, width: 580, height: 18)
    path.frame = NSRect(x: 12, y: 6, width: 580, height: 14)
    view.addSubview(name)
    view.addSubview(path)
    return view
  }
  func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
    switch NSStringFromSelector(selector) {
    case "moveDown:":
      select(table.selectedRow + 1)
      return true
    case "moveUp:":
      select(table.selectedRow - 1)
      return true
    case "insertNewline:":
      work?.cancel()
      if rows.isEmpty {
        wantOpen = true
        search()
      } else {
        openSelected()
      }
      return true
    case "cancelOperation:":
      close()
      return true
    case "insertTab:":
      if let entry = selected() {
        field.stringValue =
          (entry["path"] as? String ?? "") + ((entry["directory"] as? Bool) == true ? "/" : "")
        epoch += 1
        search()
      }
      return true
    default: return false
    }
  }
  func select(_ index: Int) {
    if rows.isEmpty { return }
    let row = (index + rows.count) % rows.count
    table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
    table.scrollRowToVisible(row)
  }
  func selected() -> [String: Any]? {
    let index = max(0, table.selectedRow)
    return index < rows.count ? rows[index] : nil
  }
  @objc func openSelected() {
    guard client.projectId == project else {
      close()
      return
    }
    guard let entry = selected(), let path = entry["path"] as? String else { return }
    if entry["directory"] as? Bool == true {
      field.stringValue = path + "/"
      epoch += 1
      wantOpen = false
      search()
    } else {
      let callback = onOpen
      close()
      DispatchQueue.main.async { callback?(path) }
    }
  }
  func search() {
    epoch += 1
    let current = epoch
    rows = []
    table.reloadData()
    let query = field.stringValue.trimmingCharacters(in: .whitespaces)
    if query.isEmpty {
      rows = Array(rootFiles.prefix(80))
      table.reloadData()
      select(0)
      hint.stringValue = "↑↓ choose · Return open · Tab complete · Escape close"
      return
    }
    if query.contains("/") {
      let parts = query.split(separator: "/", omittingEmptySubsequences: false)
      let directory = parts.dropLast().joined(separator: "/")
      let needle = String(parts.last ?? "").lowercased()
      hint.stringValue = "Loading folder…"
      client.command("list_project_files", ["targetProjectId": project, "directory": directory]) {
        [weak self] result in
        guard let self, self.epoch == current else { return }
        switch result {
        case .success(let value):
          self.rows = Array(
            (value["files"] as? [[String: Any]] ?? []).filter {
              ($0["name"] as? String ?? "").lowercased().contains(needle)
            }.prefix(80))
          self.finish()
        case .failure(let error): self.hint.stringValue = error.localizedDescription
        }
      }
    } else {
      hint.stringValue = "Searching project…"
      batch(query, cursor: NSNull(), epoch: current)
    }
  }
  private func finish() {
    let selected = max(0, table.selectedRow)
    table.reloadData()
    select(selected)
    hint.stringValue =
      rows.isEmpty ? "No matching files" : "↑↓ choose · Return open · Tab complete · Escape close"
    if wantOpen && !rows.isEmpty {
      wantOpen = false
      openSelected()
    }
  }
  private func batch(_ query: String, cursor: Any, epoch: Int) {
    client.command(
      "search_project_files", ["targetProjectId": project, "query": query, "cursor": cursor]
    ) { [weak self] result in
      guard let self, self.epoch == epoch, self.panel.isVisible else { return }
      switch result {
      case .failure(let error): self.hint.stringValue = error.localizedDescription
      case .success(let reply):
        let selection = self.selected()?["path"] as? String
        let needle = query.lowercased()
        var map: [String: [String: Any]] = [:]
        for entry in self.rows + (reply["files"] as? [[String: Any]] ?? []) {
          if let path = entry["path"] as? String { map[path] = entry }
        }
        self.rows = Array(
          map.values.sorted { a, b in
            let an = (a["name"] as? String ?? "")
            let bn = (b["name"] as? String ?? "")
            let ap = an.lowercased().hasPrefix(needle)
            let bp = bn.lowercased().hasPrefix(needle)
            if ap != bp { return ap }
            return an == bn ? (a["path"] as? String ?? "") < (b["path"] as? String ?? "") : an < bn
          }.prefix(80))
        self.table.reloadData()
        self.select(self.rows.firstIndex { ($0["path"] as? String) == selection } ?? 0)
        if self.wantOpen && !self.rows.isEmpty {
          self.wantOpen = false
          self.openSelected()
          return
        }
        if let cursor = reply["cursor"], !(cursor is NSNull) {
          self.hint.stringValue = "Searching project… · Return opens an available result"
          self.batch(query, cursor: cursor, epoch: epoch)
        } else {
          self.finish()
        }
      }
    }
  }
}
