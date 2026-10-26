import AppKit

let app = NSApplication.shared
let delegate = NativeApp()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
