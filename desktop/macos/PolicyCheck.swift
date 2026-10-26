import Foundation

@main
struct PolicyCheck {
    static func main() {
        let fm = FileManager.default, temporary = fm.temporaryDirectory.appendingPathComponent("nimlo-policy-"+UUID().uuidString)
        try! fm.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: temporary) }
        let preference = temporary.appendingPathComponent("last-project.json")
        precondition(!NimloPolicy.hasSavedProject(state: temporary.path))
        try! JSONSerialization.data(withJSONObject:["workspace":temporary.path]).write(to: preference)
        precondition(NimloPolicy.hasSavedProject(state: temporary.path))
        try! JSONSerialization.data(withJSONObject:["workspace":temporary.appendingPathComponent("deleted-project").path]).write(to: preference)
        precondition(!NimloPolicy.hasSavedProject(state: temporary.path))
        try! Data("{\"workspace\":\"relative\"}".utf8).write(to: preference)
        precondition(!NimloPolicy.hasSavedProject(state: temporary.path))
        let token = String(repeating: "a", count: 64)
        precondition(NimloPolicy.launchURL("http://127.0.0.1:8742/#token="+token, port: 8742) != nil)
        for value in ["http://localhost:8742/#token="+token, "https://127.0.0.1:8742/#token="+token,
                      "http://127.0.0.1:8743/#token="+token, "http://127.0.0.1:8742/api/#token="+token,
                      "http://evil.test:8742/#token="+token, "http://user@127.0.0.1:8742/#token="+token,
                      "http://127.0.0.1:8742/?secret=1#token="+token, "http://127.0.0.1:8742/#token=abc"] {
            precondition(NimloPolicy.launchURL(value, port: 8742) == nil)
        }
        precondition(NimloPolicy.localPage(URL(string: "http://127.0.0.1:8742/")!, port: 8742))
        for value in ["file:///etc/passwd", "http://127.0.0.1:8742/api/bootstrap", "http://127.0.0.1:8743/", "http://evil.test:8742/"] {
            precondition(!NimloPolicy.localPage(URL(string: value)!, port: 8742))
        }
        precondition(NimloPolicy.externalLink(URL(string: "https://example.com/docs")!))
        precondition(NimloPolicy.localBlob(URL(string: "blob:http://127.0.0.1:8742/1234")!, port: 8742))
        for value in ["blob:http://127.0.0.1:8743/1234", "blob:http://evil.test:8742/1234", "blob:http://user@127.0.0.1:8742/1234",
                      "blob:file:///etc/passwd", "data:text/plain,abc", "blob:http://127.0.0.1:8742/", "blob:http://127.0.0.1:8742/a?x=1"] {
            precondition(!NimloPolicy.localBlob(URL(string: value)!, port: 8742))
        }
        precondition(NimloPolicy.downloadName("../draft.txt") == "draft.txt")
        for name in ["", "..", "a\nb.txt", "a:b.txt", String(repeating: "a", count: 201)] {
            precondition(NimloPolicy.downloadName(name) == "Nimlo-draft.txt")
        }
        for value in ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,test", "https://user:pass@example.com/", "https://example.com/#token="+token, "https://example.com/#invite="+token] {
            precondition(!NimloPolicy.externalLink(URL(string: value)!))
        }
        print("PASS desktop navigation policy")
    }
}
