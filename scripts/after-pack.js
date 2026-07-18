// @ts-check
// Signature ad-hoc du bundle macOS.
//
// Sans licence Apple Developer (99 $/an) on ne peut ni signer avec un Developer
// ID ni notariser. Mais sur Apple Silicon, un binaire SANS AUCUNE signature
// refuse de se lancer (ce n'est pas un simple avertissement Gatekeeper).
// La signature ad-hoc (`--sign -`) est gratuite et lève ce blocage.
//
// Ce hook tourne APRÈS le packaging et AVANT la fabrication du DMG, donc la
// signature est bien embarquée dans l'app distribuée. Comme `identity: null`
// désactive la signature interne d'electron-builder, rien ne l'écrase ensuite.
//
// L'utilisateur verra quand même Gatekeeper au premier lancement
// ("développeur non vérifié") : clic droit > Ouvrir, ou `xattr -cr` sur l'app.

const path = require('path')
const { execFileSync } = require('child_process')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )

  // --deep est déprécié par Apple pour la signature réelle, mais reste la façon
  // standard d'ad-hoc signer récursivement les binaires imbriqués (Electron
  // Framework, helpers). Échouer ici doit casser le build : un DMG arm64 non
  // signé ne se lance pas, autant le savoir en CI plutôt que chez l'utilisateur.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit'
  })

  // Vérifie que la signature est bien posée et que l'app est jugée valide.
  execFileSync('codesign', ['--verify', '--verbose=2', appPath], {
    stdio: 'inherit'
  })

  console.log(`[after-pack] Signature ad-hoc appliquée : ${appPath}`)
}
