import CoreFoundation
import Foundation

// A bounded MessagePack codec for Neovim's public RPC protocol. No third-party
// Swift runtime is needed. Buffer handles are decoded from MessagePack EXT.
enum MP {
  enum Failure: Error { case incomplete, invalid, oversized }
  static let limit = 16 * 1024 * 1024
  static func encode(_ value: Any) -> Data {
    var out = Data()
    func integer(_ value: UInt64, _ count: Int) {
      for shift in stride(from: (count - 1) * 8, through: 0, by: -8) {
        out.append(UInt8(truncatingIfNeeded: value >> shift))
      }
    }
    func length(_ n: Int, small: UInt8, one: UInt8?, two: UInt8, four: UInt8, cap: Int) {
      if n < cap {
        out.append(small | UInt8(n))
      } else if n <= 255, let one {
        out.append(one)
        integer(UInt64(n), 1)
      } else if n <= 65535 {
        out.append(two)
        integer(UInt64(n), 2)
      } else {
        out.append(four)
        integer(UInt64(n), 4)
      }
    }
    func put(_ value: Any) {
      if value is NSNull {
        out.append(0xc0)
      } else if let number = value as? NSNumber {
        if CFGetTypeID(number) == CFBooleanGetTypeID() {
          out.append(number.boolValue ? 0xc3 : 0xc2)
        } else if String(cString: number.objCType).contains("f")
          || String(cString: number.objCType).contains("d")
        {
          out.append(0xcb)
          integer(number.doubleValue.bitPattern, 8)
        } else {
          let n = number.int64Value
          if n >= 0 && n <= 127 {
            out.append(UInt8(n))
          } else if n >= -32 && n < 0 {
            out.append(UInt8(truncatingIfNeeded: n))
          } else {
            out.append(0xd3)
            integer(UInt64(bitPattern: n), 8)
          }
        }
      } else if let string = value as? String {
        let data = Data(string.utf8)
        length(data.count, small: 0xa0, one: 0xd9, two: 0xda, four: 0xdb, cap: 32)
        out.append(data)
      } else if let list = value as? [Any] {
        length(list.count, small: 0x90, one: nil, two: 0xdc, four: 0xdd, cap: 16)
        list.forEach(put)
      } else if let map = value as? [String: Any] {
        length(map.count, small: 0x80, one: nil, two: 0xde, four: 0xdf, cap: 16)
        for key in map.keys.sorted() {
          put(key)
          put(map[key]!)
        }
      } else {
        out.append(0xc0)
      }
    }
    put(value)
    return out
  }
  static func decode(_ data: Data, offset: inout Int, depth: Int = 0) throws -> Any {
    guard depth < 64 else { throw Failure.oversized }
    func bytes(_ n: Int) throws -> Data {
      guard n >= 0 && n <= limit else { throw Failure.oversized }
      guard offset + n <= data.count else { throw Failure.incomplete }
      let result = data.subdata(in: offset..<(offset + n))
      offset += n
      return result
    }
    func uint(_ n: Int) throws -> UInt64 {
      try bytes(n).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
    }
    func string(_ n: Int) throws -> String { String(decoding: try bytes(n), as: UTF8.self) }
    func array(_ n: Int) throws -> [Any] {
      guard n <= limit / 2 else { throw Failure.oversized }
      return try (0..<n).map { _ in try decode(data, offset: &offset, depth: depth + 1) }
    }
    func map(_ n: Int) throws -> [String: Any] {
      guard n <= limit / 2 else { throw Failure.oversized }
      var result: [String: Any] = [:]
      for _ in 0..<n {
        let key = try decode(data, offset: &offset, depth: depth + 1)
        let value = try decode(data, offset: &offset, depth: depth + 1)
        if let key = key as? String { result[key] = value }
      }
      return result
    }
    func ext(_ n: Int) throws -> Any {
      _ = try uint(1)
      let payload = try bytes(n)
      var at = 0
      return (try? decode(payload, offset: &at, depth: depth + 1)) ?? NSNull()
    }
    let code = try uint(1)
    switch code {
    case 0...127: return Int(code)
    case 224...255: return Int(Int8(bitPattern: UInt8(code)))
    case 128...143: return try map(Int(code & 15))
    case 144...159: return try array(Int(code & 15))
    case 160...191: return try string(Int(code & 31))
    case 0xc0: return NSNull()
    case 0xc2: return false
    case 0xc3: return true
    case 0xc4: return try bytes(Int(try uint(1)))
    case 0xc5: return try bytes(Int(try uint(2)))
    case 0xc6: return try bytes(Int(try uint(4)))
    case 0xc7: return try ext(Int(try uint(1)))
    case 0xc8: return try ext(Int(try uint(2)))
    case 0xc9: return try ext(Int(try uint(4)))
    case 0xca: return Double(Float(bitPattern: UInt32(try uint(4))))
    case 0xcb: return Double(bitPattern: try uint(8))
    case 0xcc: return Int(try uint(1))
    case 0xcd: return Int(try uint(2))
    case 0xce: return Int(try uint(4))
    case 0xcf: return Int64(bitPattern: try uint(8))
    case 0xd0: return Int(Int8(bitPattern: UInt8(try uint(1))))
    case 0xd1: return Int(Int16(bitPattern: UInt16(try uint(2))))
    case 0xd2: return Int(Int32(bitPattern: UInt32(try uint(4))))
    case 0xd3: return Int64(bitPattern: try uint(8))
    case 0xd4: return try ext(1)
    case 0xd5: return try ext(2)
    case 0xd6: return try ext(4)
    case 0xd7: return try ext(8)
    case 0xd8: return try ext(16)
    case 0xd9: return try string(Int(try uint(1)))
    case 0xda: return try string(Int(try uint(2)))
    case 0xdb: return try string(Int(try uint(4)))
    case 0xdc: return try array(Int(try uint(2)))
    case 0xdd: return try array(Int(try uint(4)))
    case 0xde: return try map(Int(try uint(2)))
    case 0xdf: return try map(Int(try uint(4)))
    default: throw Failure.invalid
    }
  }
}

struct NimloFailure: LocalizedError {
  let message: String
  var errorDescription: String? { message }
  init(_ message: String) { self.message = message }
}
