import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-vision-intent-')), 'visionIntent.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/shared/services/visionIntent.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

const { wantsToSeeTheImage } = loadModule()

// Turns that need eyes: the answer depends on what the picture shows.
const LOOKING = [
  'Regarde cette image et dis-moi ce que tu vois',
  "Qu'est-ce qu'il y a sur cette photo ?",
  'Décris-moi cette image',
  'peux-tu analyser cette image ?',
  'Identifie l’objet sur la photo',
  'What is this?',
  "What's in the picture?",
  'Can you see the cat?',
  'describe this image please',
  'Read the text on the sign',
  'analyze it',
]

// Turns that only carry the image to the pipeline.
const CARRYING = [
  'Transforme cette image en modèle 3D',
  'Fais-en un modèle 3D texturé',
  'Turn this into a 3D model',
  'Génère un mesh à partir de ça',
  'Crée un workflow pour ça',
  'lance le workflow',
  'Make it printable',
  'Utilise-la comme entrée du workflow',
]

test('a turn that asks to look at the picture is recognised', () => {
  for (const text of LOOKING) {
    assert.equal(wantsToSeeTheImage(text), true, text)
  }
})

test('a turn that only feeds the picture to the pipeline is not', () => {
  for (const text of CARRYING) {
    assert.equal(wantsToSeeTheImage(text), false, text)
  }
})

test('an empty message asks for nothing', () => {
  assert.equal(wantsToSeeTheImage(''), false)
})

test('the verb is matched inside a longer sentence, not as a substring', () => {
  assert.equal(wantsToSeeTheImage('Regarde bien avant de générer le mesh'), true)
  // "voir" lives inside "pouvoir" / "devoir" — a bare substring match would fire.
  assert.equal(wantsToSeeTheImage('Tu devrais pouvoir faire un mesh de ça'), false)
  assert.equal(wantsToSeeTheImage('Il faudra revoir les paramètres'), false)
})
