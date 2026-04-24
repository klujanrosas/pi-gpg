// pi-gpg Touch ID helper.
//
// Prompts for biometric user-presence via LocalAuthentication. Exits:
//   0  — authenticated
//   1  — user cancelled / failed
//   2  — unavailable on this system (no biometrics, no policy)
//   3  — bad arguments
//
// Invocation:
//   pi-gpg-touchid "<reason shown in system dialog>"
//
// The reason string appears in macOS's Touch ID prompt. Keep it short and
// specific — e.g. "Release cached GPG passphrase for ABCD1234".

import Foundation
import LocalAuthentication

let args = CommandLine.arguments
if args.count < 2 {
    FileHandle.standardError.write(Data("usage: pi-gpg-touchid <reason>\n".utf8))
    exit(3)
}

let reason = args[1]
let ctx = LAContext()
ctx.localizedFallbackTitle = "" // hide the "Enter Password" fallback

var err: NSError?
guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) else {
    if let msg = err?.localizedDescription {
        FileHandle.standardError.write(Data("unavailable: \(msg)\n".utf8))
    } else {
        FileHandle.standardError.write(Data("unavailable\n".utf8))
    }
    exit(2)
}

let sem = DispatchSemaphore(value: 0)
var authed = false
var authErr: Error?

ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, e in
    authed = ok
    authErr = e
    sem.signal()
}
sem.wait()

if authed {
    exit(0)
}
if let e = authErr {
    FileHandle.standardError.write(Data("denied: \(e.localizedDescription)\n".utf8))
}
exit(1)
