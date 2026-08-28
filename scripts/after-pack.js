// @ts-check
// Ad-hoc signature for the macOS bundle.
//
// Without an Apple Developer licence ($99/year) we can neither sign with a
// Developer ID nor notarize. But on Apple Silicon a binary with NO signature at
// all refuses to launch — this is not a mere Gatekeeper warning. An ad-hoc
// signature (`--sign -`) is free and lifts that block.
//
// This hook runs AFTER packaging and BEFORE the DMG is built, so the signature
// ends up inside the app we ship. `identity: null` turns off electron-builder's
// own signing, so nothing overwrites it afterwards.
//
// The user still meets Gatekeeper on first launch ("unverified developer"):
// right-click > Open, or `xattr -cr` on the app.

const path = require('path')
const { execFileSync } = require('child_process')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )

  // Apple deprecates --deep for real signing, but it is still the standard way
  // to ad-hoc sign nested binaries recursively (Electron Framework, helpers).
  // Failing here must break the build: an unsigned arm64 DMG does not launch, so
  // we would rather find out in CI than on a user's machine.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit'
  })

  // Confirm the signature landed and the app is considered valid.
  execFileSync('codesign', ['--verify', '--verbose=2', appPath], {
    stdio: 'inherit'
  })

  console.log(`[after-pack] Ad-hoc signature applied: ${appPath}`)
}
