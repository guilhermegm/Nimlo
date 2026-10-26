import Foundation

// Native and browser clients use the same authenticated, revision-checked host.
// This owns an ephemeral URLSession and never reads Nimlo's browser credentials.
final class WorkspaceClient {
  var onEvent: (([String: Any]) -> Void)?
  var onStatus: ((Bool, String) -> Void)?
  var connected = false
  var projectId = "", generation = 0
  var launch: URL?, origin = "", token = ""
  let clientId = "native-" + UUID().uuidString
  private var session: URLSession!, socket: URLSessionWebSocketTask?
  private var pending: [String: ([String: Any], (Result<[String: Any], Error>) -> Void)] = [:]
  private var next = 0, sequence = 0, stopped = false
  init() {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 20
    config.httpCookieAcceptPolicy = .always
    session = URLSession(configuration: config)
  }
  func connect(_ launch: URL) {
    self.launch = launch
    stopped = false
    sequence += 1
    guard var c = URLComponents(url: launch, resolvingAgainstBaseURL: false),
      let fragment = c.fragment, fragment.hasPrefix("token=")
    else {
      onStatus?(false, "Invalid private host address")
      return
    }
    token = String(fragment.dropFirst(6))
    c.fragment = nil
    c.path = ""
    c.query = nil
    origin = c.url!.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    openSocket()
  }
  private func openSocket() {
    guard !stopped, var c = URLComponents(string: origin) else { return }
    sequence += 1
    let epoch = sequence
    c.scheme = "ws"
    c.path = "/ws"
    c.queryItems = [
      URLQueryItem(name: "clientId", value: clientId),
      URLQueryItem(name: "name", value: "Nimlo"), URLQueryItem(name: "patches", value: "0"),
    ]
    if !projectId.isEmpty {
      c.queryItems!.append(URLQueryItem(name: "projectId", value: projectId))
    }
    var request = URLRequest(url: c.url!)
    request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
    request.setValue(origin, forHTTPHeaderField: "Origin")
    let task = session.webSocketTask(with: request)
    socket = task
    task.maximumMessageSize = 32 * 1024 * 1024
    task.resume()
    receive(task, epoch: epoch)
  }
  private func receive(_ task: URLSessionWebSocketTask, epoch: Int) {
    task.receive { [weak self] result in
      DispatchQueue.main.async {
        guard let self, self.sequence == epoch, !self.stopped else { return }
        switch result {
        case .success(let message):
          let data: Data
          switch message {
          case .string(let text): data = Data(text.utf8)
          case .data(let bytes): data = bytes
          @unknown default: return
          }
          if let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            if value["type"] as? String == "bootstrap" {
              self.projectId = value["projectId"] as? String ?? ""
              self.generation = value["generation"] as? Int ?? 0
              self.connected = true
              self.onStatus?(true, "")
            }
            if let generation = value["generation"] as? Int { self.generation = generation }
            self.onEvent?(value)
            if let id = value["requestId"] as? String,
              let (_, done) = self.pending.removeValue(forKey: id)
            {
              if value["type"] as? String == "error" {
                done(
                  .failure(NimloFailure(value["message"] as? String ?? "Workspace command failed")))
              } else {
                done(.success(value))
              }
            }
          }
          self.receive(task, epoch: epoch)
        case .failure(let error):
          self.connected = false
          self.onStatus?(false, error.localizedDescription)
          let callbacks = self.pending.values.map { $0.1 }
          self.pending.removeAll()
          for callback in callbacks { callback(.failure(error)) }
          DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            if self.sequence == epoch && !self.stopped { self.openSocket() }
          }
        }
      }
    }
  }
  func command(
    _ type: String, _ fields: [String: Any] = [:],
    completion: @escaping (Result<[String: Any], Error>) -> Void = { _ in }
  ) {
    guard connected, let socket else {
      completion(
        .failure(
          NimloFailure("The workspace is disconnected. Your local text is kept in the editor.")))
      return
    }
    next += 1
    let id = "native-\(next)"
    var value = fields
    value["type"] = type
    value["requestId"] = id
    value["projectId"] = projectId
    value["generation"] = generation
    do {
      let data = try JSONSerialization.data(withJSONObject: value)
      let text = String(decoding: data, as: UTF8.self)
      pending[id] = (value, completion)
      socket.send(.string(text)) { [weak self] error in
        if let error {
          DispatchQueue.main.async { self?.pending.removeValue(forKey: id)?.1(.failure(error)) }
        }
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
        self?.pending.removeValue(forKey: id)?.1(
          .failure(NimloFailure("The workspace did not acknowledge this command")))
      }
    } catch { completion(.failure(error)) }
  }
  func snapshot(project: String, completion: @escaping (Result<[String: Any], Error>) -> Void) {
    guard var c = URLComponents(string: origin) else { return }
    c.path = "/api/bootstrap"
    c.queryItems = [URLQueryItem(name: "projectId", value: project)]
    var request = URLRequest(url: c.url!)
    request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
    session.dataTask(with: request) { data, response, error in
      DispatchQueue.main.async {
        if let error {
          completion(.failure(error))
          return
        }
        guard (response as? HTTPURLResponse)?.statusCode == 200, let data,
          let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else {
          completion(.failure(NimloFailure("Cannot read the project state")))
          return
        }
        completion(.success(value))
      }
    }.resume()
  }
  func stop() {
    stopped = true
    sequence += 1
    connected = false
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    session.invalidateAndCancel()
  }
}
