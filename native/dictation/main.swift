import AVFoundation
import Darwin
import Foundation
import Speech

// This helper owns one recording. It never writes audio to disk or permits
// server recognition; its parent receives only the final transcript.
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

final class Dictation {
    private let locale: Locale
    private var recognizer: SFSpeechRecognizer?
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var tapInstalled = false
    private var finished = false
    private var stopping = false
    private var text = ""

    init(locale: Locale) { self.locale = locale }

    func start() {
        guard !finished else { return }
        // Inspect language support before prompting for permissions. Missing
        // system language assets cannot be fixed by a microphone grant.
        guard SFSpeechRecognizer(locale: locale)?.supportsOnDeviceRecognition == true else {
            unavailableLanguage()
            return
        }
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard !self.finished else { return }
                guard status == .authorized else {
                    self.fail("Allow Speech Recognition for Stark Code in System Settings → Privacy & Security, then try again.")
                    return
                }
                self.authorizeMicrophone()
            }
        }
    }

    private func authorizeMicrophone() {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            beginRecording()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { allowed in
                DispatchQueue.main.async {
                    guard !self.finished else { return }
                    if allowed { self.beginRecording() }
                    else { self.microphoneDenied() }
                }
            }
        default:
            microphoneDenied()
        }
    }

    private func microphoneDenied() {
        fail("Allow Microphone access for Stark Code in System Settings → Privacy & Security, then try again.")
    }

    private func unavailableLanguage() {
        fail("On-device dictation is unavailable for \(locale.identifier). Enable this language in macOS System Settings → Keyboard → Dictation, wait for its download, then try again.")
    }

    private func beginRecording() {
        guard !finished else { return }
        guard let recognizer = SFSpeechRecognizer(locale: locale),
              recognizer.supportsOnDeviceRecognition else {
            unavailableLanguage()
            return
        }
        guard recognizer.isAvailable else {
            fail("On-device speech recognition is unavailable right now. Try again shortly.")
            return
        }
        self.recognizer = recognizer
        let request = SFSpeechAudioBufferRecognitionRequest()
        // Apple only honors requiresOnDeviceRecognition when the capability
        // check above succeeds. There must never be a cloud fallback.
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.addsPunctuation = true
        self.request = request
        let engine = AVAudioEngine()
        self.engine = engine
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            fail("No microphone input is available. Check your Mac's Sound settings and try again.")
            return
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        tapInstalled = true
        task = recognizer.recognitionTask(with: request) { result, error in
            DispatchQueue.main.async {
                guard !self.finished else { return }
                if let result {
                    // Bound output even if recognition produces a pathological result.
                    self.text = String(decoding: result.bestTranscription.formattedString.utf8.prefix(32_000), as: UTF8.self)
                    if result.isFinal {
                        self.complete()
                        return
                    }
                }
                if error != nil {
                    if !self.text.isEmpty || self.stopping { self.complete() }
                    else { self.fail("No speech was recognized. Check your microphone and try again.") }
                }
            }
        }
        do {
            engine.prepare()
            try engine.start()
        } catch {
            fail("The microphone could not start. Check your Mac's Sound settings and try again.")
            return
        }
        emit(["type": "recording"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 300) { self.stop() }
    }

    private func endAudio() {
        engine?.stop()
        if tapInstalled {
            engine?.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        request?.endAudio()
    }

    func stop() {
        guard !finished, !stopping else { return }
        // A click while permission is pending must not start a recording later.
        guard task != nil else { cancel(); return }
        stopping = true
        endAudio()
        // Some devices never deliver a final result after endAudio. Preserve
        // the most recent recognition instead of leaving the composer busy.
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { self.complete() }
    }

    func cancel() { finish(["type": "cancelled"]) }

    private func complete() {
        guard !finished else { return }
        let transcript = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if transcript.isEmpty { fail("No speech was recognized. Try again when you're ready.") }
        else { finish(["type": "transcript", "text": transcript]) }
    }

    private func fail(_ message: String) { finish(["type": "error", "message": message]) }

    private func finish(_ event: [String: Any]) {
        guard !finished else { return }
        finished = true
        endAudio()
        task?.cancel()
        task = nil
        request = nil
        engine = nil
        emit(event)
        exit(0)
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
var localeIdentifier = Locale.current.identifier
var checkOnly = false
var index = 0
while index < arguments.count {
    switch arguments[index] {
    case "--locale" where index + 1 < arguments.count:
        index += 1
        localeIdentifier = arguments[index]
    case "--check":
        checkOnly = true
    default:
        emit(["type": "error", "message": "Invalid dictation helper arguments."])
        exit(64)
    }
    index += 1
}

let locale = Locale(identifier: localeIdentifier)
if checkOnly {
    // Capability inspection never requests TCC permission or opens an audio device.
    let supported = SFSpeechRecognizer(locale: locale)?.supportsOnDeviceRecognition == true
    emit(["supported": supported, "locale": locale.identifier])
    exit(0)
}

signal(SIGPIPE, SIG_IGN)
let dictation = Dictation(locale: locale)
let signals = [SIGTERM, SIGINT].map { code -> DispatchSourceSignal in
    signal(code, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: code, queue: .main)
    source.setEventHandler { dictation.cancel() }
    source.resume()
    return source
}
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        guard line.utf8.count <= 256,
              let data = line.data(using: .utf8),
              let command = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let type = command["type"], type == "stop" || type == "cancel" else {
            DispatchQueue.main.async { dictation.cancel() }
            return
        }
        DispatchQueue.main.async {
            if type == "stop" { dictation.stop() }
            else { dictation.cancel() }
        }
    }
    // Losing the parent closes stdin and must release the microphone.
    DispatchQueue.main.async { dictation.cancel() }
}
DispatchQueue.main.async { dictation.start() }
RunLoop.main.run()
