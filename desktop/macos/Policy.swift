import Foundation

enum NimloPolicy {
    static func hasSavedProject(state: String) -> Bool {
        let path = (state as NSString).appendingPathComponent("last-project.json")
        let fm = FileManager.default
        guard let attributes = try? fm.attributesOfItem(atPath: path),
              attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber, size.intValue <= 8192,
              let data = try? Data(contentsOf: URL(fileURLWithPath: path)), data.count <= 8192,
              let record = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let root = record["workspace"], root.hasPrefix("/") else { return false }
        var directory: ObjCBool = false
        return fm.fileExists(atPath: root, isDirectory: &directory) && directory.boolValue
    }
    static func launchURL(_ text: String, port: Int) -> URL? {
        guard let c = URLComponents(string: text), c.scheme == "http", c.host == "127.0.0.1",
              c.port == port, c.path == "/", c.query == nil, c.user == nil, c.password == nil,
              let fragment = c.fragment, fragment.hasPrefix("token="), fragment.count == 70,
              fragment.dropFirst(6).allSatisfy({ "0123456789abcdef".contains($0) }) else { return nil }
        return c.url
    }
    static func localPage(_ url: URL, port: Int) -> Bool {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return c.scheme == "http" && c.host == "127.0.0.1" && c.port == port && c.path == "/" && c.user == nil && c.password == nil
    }
    static func externalLink(_ url: URL) -> Bool {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false), let host = c.host,
              ["https", "http"].contains(c.scheme), !host.isEmpty, c.user == nil, c.password == nil else { return false }
        return !(c.fragment?.hasPrefix("token=") ?? false) && !(c.fragment?.hasPrefix("invite=") ?? false)
    }
    static func localBlob(_ url: URL, port: Int) -> Bool {
        guard url.scheme == "blob", let c = URLComponents(string: String(url.absoluteString.dropFirst(5))) else { return false }
        return c.scheme == "http" && c.host == "127.0.0.1" && c.port == port && c.user == nil && c.password == nil
            && c.query == nil && c.fragment == nil && c.path.count > 1
    }
    static func downloadName(_ suggested: String) -> String {
        let name = (suggested as NSString).lastPathComponent
        guard !name.isEmpty, name != ".", name != "..", name.utf8.count <= 200,
              !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || $0 == ":" }) else { return "Nimlo-draft.txt" }
        return name
    }
}
