import Foundation

let arguments = CommandLine.arguments
guard arguments.count == 3, arguments[1] == "--plan", arguments[2].hasPrefix("/") else {
    FileHandle.standardError.write(Data("Usage: nimlo-update-helper --plan /private/path/plan.json\n".utf8))
    exit(64)
}
do {
    try NimloUpdateInstaller.install(planURL: URL(fileURLWithPath: arguments[2]).standardizedFileURL)
} catch {
    FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
    exit(1)
}
