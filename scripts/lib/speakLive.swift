// Speak lines with a voice that cannot be rendered to a file, and record them anyway.
//
// A Personal Voice is refused by `AVSpeechSynthesizer.write`: Apple routes it to the output
// device only ("Cannot use AVSpeechSynthesizerBufferCallback with Personal Voices, defaulting to
// output channel"), so `say -o` and the buffer callback both come back empty. What this does
// instead is point the system's default output at a loopback device (BlackHole 2ch), speak each
// line live, and record the loopback's input with ffmpeg while it plays.
//
//   swift scripts/lib/speakLive.swift <voice name or identifier> <lines.json>
//
// `lines.json` is `[{ "text": "...", "file": "/abs/path.wav" }, ...]`. Each file is written raw,
// with the recording's lead-in and tail of silence still on it; the caller trims.
//
// Two things it guarantees, because both failures are silent from the outside: the previous
// default output is **restored on every exit** (normal, error, Ctrl-C), or the Mac is left playing
// into a device nobody can hear; and a Personal Voice is **authorised first**, since an
// unauthorised one is simply not in the voice list.

import AVFoundation
import CoreAudio
import Foundation

struct Line: Decodable {
  let text: String
  let file: String
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(("speakLive: " + message + "\n").data(using: .utf8)!)
  restoreOutput()
  exit(1)
}

// MARK: - The default output device

func defaultOutput() -> AudioDeviceID {
  var id = AudioDeviceID(0)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultOutputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id)
  return id
}

func setDefaultOutput(_ id: AudioDeviceID) -> Bool {
  var device = id
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultOutputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  return AudioObjectSetPropertyData(
    AudioObjectID(kAudioObjectSystemObject), &address, 0, nil,
    UInt32(MemoryLayout<AudioDeviceID>.size), &device) == noErr
}

func deviceNamed(_ name: String) -> AudioDeviceID? {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var size = UInt32(0)
  AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size)
  var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids)
  for id in ids {
    var nameAddress = AudioObjectPropertyAddress(
      mSelector: kAudioObjectPropertyName,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var cfName: Unmanaged<CFString>?
    var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    if AudioObjectGetPropertyData(id, &nameAddress, 0, nil, &nameSize, &cfName) == noErr,
      let value = cfName?.takeRetainedValue() as String?, value == name
    {
      return id
    }
  }
  return nil
}

var previousOutput: AudioDeviceID?

func restoreOutput() {
  if let previous = previousOutput {
    _ = setDefaultOutput(previous)
    previousOutput = nil
  }
}

// MARK: - Speaking

final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
  let synthesizer = AVSpeechSynthesizer()
  var finished = false
  override init() {
    super.init()
    synthesizer.delegate = self
  }
  func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { finished = true }
  func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { finished = true }

  func speak(_ text: String, voice: AVSpeechSynthesisVoice) {
    finished = false
    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = voice
    synthesizer.speak(utterance)
    let deadline = Date().addingTimeInterval(120)
    while !finished && Date() < deadline {
      RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }
  }
}

func wait(_ seconds: Double) {
  RunLoop.main.run(until: Date().addingTimeInterval(seconds))
}

// MARK: - Main

let arguments = CommandLine.arguments
guard arguments.count == 3 else { fail("usage: speakLive.swift <voice> <lines.json>") }
let wanted = arguments[1]
guard let data = FileManager.default.contents(atPath: arguments[2]),
  let lines = try? JSONDecoder().decode([Line].self, from: data)
else { fail("cannot read \(arguments[2])") }

// Authorise before listing: an unauthorised Personal Voice is absent from `speechVoices()`.
var authorised = false
AVSpeechSynthesizer.requestPersonalVoiceAuthorization { _ in authorised = true }
let authDeadline = Date().addingTimeInterval(60)
while !authorised && Date() < authDeadline { wait(0.1) }

guard
  let voice = AVSpeechSynthesisVoice.speechVoices().first(where: {
    $0.identifier == wanted || $0.name == wanted
  })
else {
  let names = AVSpeechSynthesisVoice.speechVoices()
    .filter { $0.voiceTraits.contains(.isPersonalVoice) }.map(\.name)
  fail("no voice \"\(wanted)\". Personal voices here: \(names.isEmpty ? "none" : names.joined(separator: ", "))")
}

guard let loopback = deviceNamed("BlackHole 2ch") else {
  fail("no BlackHole 2ch device. Install it (brew install blackhole-2ch) and restart.")
}

previousOutput = defaultOutput()
for sig in [SIGINT, SIGTERM, SIGHUP] {
  signal(sig) { _ in
    restoreOutput()
    exit(130)
  }
}
guard setDefaultOutput(loopback) else { fail("could not switch the output to BlackHole") }
// Let the switch settle before the first utterance, or its opening syllable goes to the old device.
wait(0.5)

let speaker = Speaker()
for (index, line) in lines.enumerated() {
  let recorder = Process()
  recorder.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/ffmpeg")
  recorder.arguments = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "avfoundation", "-i", ":BlackHole 2ch",
    "-ac", "1", "-ar", "48000", line.file,
  ]
  let stdin = Pipe()
  recorder.standardInput = stdin
  do { try recorder.run() } catch { fail("could not start ffmpeg: \(error)") }
  wait(0.6)  // ffmpeg opening the device; anything spoken before this is lost
  speaker.speak(line.text, voice: voice)
  wait(0.4)  // the synthesiser reports finished slightly before the last sample leaves
  stdin.fileHandleForWriting.write("q".data(using: .utf8)!)
  recorder.waitUntilExit()
  print("\(index + 1)/\(lines.count) \(line.file)")
}

restoreOutput()
