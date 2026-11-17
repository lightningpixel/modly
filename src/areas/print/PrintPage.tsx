import { Component, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Canvas } from '@react-three/fiber'
import { Environment, Lightformer, OrbitControls, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { useAppStore } from '@shared/stores/appStore'
import { useNavStore } from '@shared/stores/navStore'
import type { ProjectedAssetLibraryEntry } from '@areas/generate/assetLibraryProjection'
import { getDefaultAssetLibraryService } from '@areas/generate/assetLibraryService'
import {
  filterVisibleAssetLibraryEntries,
  isAssetLibraryEntryOpenable,
  openAssetLibraryEntry,
  sortAssetLibraryEntries,
} from '@areas/generate/assetLibraryUi'
import {
  CUSTOM_PRINTER_ID,
  MAX_VOLUME_MM,
  MIN_VOLUME_MM,
  PRINTER_PRESETS,
  checkFit,
  createLatestGuard,
  describeOverflow,
  errorForModel,
  isGlbUrl,
  formatVolume,
  modelSizeMm,
  parsePrintScale,
  parsePrinterChoice,
  resolveBuildVolume,
  type BuildVolume,
  type ModelError,
  type PrintScale,
  type PrinterChoice,
} from './printBed'
import { slicerSourceToken } from '@areas/generate/orcaSlicerLink'
import { usePrintStore } from './printStore'
import { disposeObject, groundPlacement } from '@shared/three/meshScene'

const PRINTER_STORAGE_KEY = 'modly.print.printer'

function readStoredPrinter(): PrinterChoice {
  try { return parsePrinterChoice(localStorage.getItem(PRINTER_STORAGE_KEY)) } catch { return parsePrinterChoice(null) }
}

/** A model's bounding-box size, in its own (glTF) units. */
type Size3 = { x: number, y: number, z: number }

// ─── 3D scene (millimetres) ──────────────────────────────────────────────────

/** Plate grid: a line every 10 mm, a brighter one every 50 mm. */
function PlateGrid({ volume }: { volume: BuildVolume }): JSX.Element {
  const [minor, major] = useMemo(() => {
    const minorPoints: number[] = []
    const majorPoints: number[] = []
    const w = volume.width / 2
    const d = volume.depth / 2
    for (let x = 0; x <= volume.width + 1e-6; x += 10) {
      const target = Math.round(x) % 50 === 0 ? majorPoints : minorPoints
      target.push(x - w, 0, -d, x - w, 0, d)
    }
    for (let z = 0; z <= volume.depth + 1e-6; z += 10) {
      const target = Math.round(z) % 50 === 0 ? majorPoints : minorPoints
      target.push(-w, 0, z - d, w, 0, z - d)
    }
    const geometry = (points: number[]) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
      return g
    }
    return [geometry(minorPoints), geometry(majorPoints)]
  }, [volume.width, volume.depth])

  useEffect(() => () => { minor.dispose(); major.dispose() }, [minor, major])

  return (
    <group position={[0, 0.05, 0]}>
      <lineSegments geometry={minor}><lineBasicMaterial color="#303036" /></lineSegments>
      <lineSegments geometry={major}><lineBasicMaterial color="#4a4a52" /></lineSegments>
    </group>
  )
}

function BuildPlate({ volume, fits }: { volume: BuildVolume, fits: boolean }): JSX.Element {
  const edges = useMemo(
    () => new THREE.EdgesGeometry(new THREE.BoxGeometry(volume.width, volume.height, volume.depth)),
    [volume.width, volume.height, volume.depth],
  )
  useEffect(() => () => edges.dispose(), [edges])

  return (
    <group>
      <mesh position={[0, -1, 0]}>
        <boxGeometry args={[volume.width, 2, volume.depth]} />
        <meshStandardMaterial color="#202024" roughness={0.9} />
      </mesh>
      <PlateGrid volume={volume} />
      <lineSegments geometry={edges} position={[0, volume.height / 2, 0]}>
        <lineBasicMaterial color={fits ? '#52525b' : '#ef4444'} />
      </lineSegments>
    </group>
  )
}

/** The model at its printed size, centred on the plate and resting on it. */
function PlacedModel({ url, mmPerUnit, onSize }: {
  url: string
  mmPerUnit: number
  onSize: (size: Size3) => void
}): JSX.Element {
  const { scene } = useGLTF(url)

  const placement = useMemo(() => groundPlacement(scene), [scene])

  useEffect(() => {
    const { x, y, z } = placement.size
    onSize({ x, y, z })
  }, [placement, onSize])

  // Free the loader cache and GPU memory when the model changes, as Generate does.
  useEffect(() => () => {
    useGLTF.clear(url)
    disposeObject(scene)
  }, [url, scene])

  return (
    <group scale={mmPerUnit}>
      <group position={placement.offset}>
        <primitive object={scene} />
      </group>
    </group>
  )
}

class ModelBoundary extends Component<{ children: ReactNode, resetKey: string, onError: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  componentDidCatch(error: Error): void {
    console.warn('[PrintPage] Failed to load model:', error.message)
    this.props.onError()
  }
  componentDidUpdate(prev: { resetKey: string }): void {
    if (prev.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false })
  }
  render(): ReactNode { return this.state.failed ? null : this.props.children }
}

function PlateScene({ volume, modelUrl, mmPerUnit, fits, onSize, onError }: {
  volume: BuildVolume
  modelUrl: string | null
  /** Null until the print scale is known: the model is not placed before. */
  mmPerUnit: number | null
  fits: boolean
  onSize: (size: Size3) => void
  onError: () => void
}): JSX.Element {
  const span = Math.max(volume.width, volume.depth, volume.height)
  return (
    <Canvas
      camera={{ position: [span * 0.9, span * 0.85, span * 1.25], fov: 45, near: 1, far: span * 40 }}
      dpr={[1, 2]}
      gl={{ antialias: true, outputColorSpace: THREE.SRGBColorSpace }}
    >
      <color attach="background" args={['#18181b']} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[span, span * 2, span]} intensity={1.2} />
      <directionalLight position={[-span, span * 0.5, -span]} intensity={0.4} />
      <Environment background={false}>
        <Lightformer intensity={2} position={[0, 4, 4]} scale={8} />
        <Lightformer intensity={0.5} position={[-4, 2, -4]} scale={6} />
      </Environment>

      <BuildPlate volume={volume} fits={fits} />
      {modelUrl && mmPerUnit !== null && (
        <ModelBoundary resetKey={modelUrl} onError={onError}>
          <Suspense fallback={null}>
            <PlacedModel key={modelUrl} url={modelUrl} mmPerUnit={mmPerUnit} onSize={onSize} />
          </Suspense>
        </ModelBoundary>
      )}

      <OrbitControls
        makeDefault
        target={[0, volume.height / 4, 0]}
        minDistance={20}
        maxDistance={span * 8}
        enableDamping
        dampingFactor={0.05}
      />
    </Canvas>
  )
}

// ─── Side panel ──────────────────────────────────────────────────────────────

const FIELD = 'h-8 w-full rounded-lg border border-zinc-800 bg-zinc-900/70 px-2.5 text-xs text-zinc-200 focus:outline-none focus-visible:border-accent/50'

function Section({ title, children }: { title: string, children: ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">{title}</p>
      {children}
    </section>
  )
}

function VolumeInput({ label, value, onChange }: { label: string, value: number, onChange: (value: number) => void }): JSX.Element {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-[10px] text-zinc-500">{label}</span>
      <input
        type="number"
        min={MIN_VOLUME_MM}
        max={MAX_VOLUME_MM}
        step={1}
        value={value}
        onChange={(event) => { const v = Number(event.target.value); if (Number.isFinite(v)) onChange(v) }}
        className={FIELD}
      />
    </label>
  )
}

export default function PrintPage(): JSX.Element {
  const apiUrl = useAppStore((s) => s.apiUrl)
  const currentJob = useAppStore((s) => s.currentJob)
  const navigate = useNavStore((s) => s.navigate)
  const source = usePrintStore((s) => s.source)
  const setSource = usePrintStore((s) => s.setSource)
  const service = useMemo(() => getDefaultAssetLibraryService(), [])

  const [printer, setPrinter] = useState<PrinterChoice>(readStoredPrinter)
  const [assets, setAssets] = useState<ProjectedAssetLibraryEntry[]>([])
  // Both are kept with the model they belong to, so a stale one never shows.
  const [modelSize, setModelSize] = useState<{ modelUrl: string, size: Size3 } | null>(null)
  const [scale, setScale] = useState<{ modelUrl: string, value: PrintScale } | null>(null)
  const [error, setError] = useState<ModelError | null>(null)
  // A library asset opens asynchronously: only the latest choice may apply.
  const [sourceGuard] = useState(createLatestGuard)

  useEffect(() => {
    let cancelled = false
    service.list()
      .then((result) => {
        if (cancelled || !result.success) return
        const meshes = filterVisibleAssetLibraryEntries(result.entries).filter(isAssetLibraryEntryOpenable)
        setAssets(sortAssetLibraryEntries(meshes, 'date'))
      })
      .catch(() => { /* the picker just lists fewer assets */ })
    return () => { cancelled = true }
  }, [service])

  function changePrinter(next: PrinterChoice) {
    setPrinter(next)
    try { localStorage.setItem(PRINTER_STORAGE_KEY, JSON.stringify(next)) } catch { /* private mode / quota */ }
  }

  // GLB only: splats have no plate size, and imports are converted to GLB.
  const currentUrl = currentJob?.status === 'done' && currentJob.outputUrl && isGlbUrl(currentJob.outputUrl)
    ? currentJob.outputUrl
    : null
  const sourceUrl = source.kind === 'library' ? source.url : currentUrl
  const modelUrl = sourceUrl ? `${apiUrl}${sourceUrl}` : null
  const loadError = errorForModel(error, modelUrl)

  async function chooseSource(value: string) {
    const ticket = sourceGuard.take()
    setError(null)
    if (value === 'current') { setSource({ kind: 'current' }); return }
    const entry = assets.find((a) => a.id === value)
    if (!entry) return
    const result = await openAssetLibraryEntry(service, entry)
    if (!sourceGuard.isLatest(ticket)) return
    if (!result.success) { setError({ modelUrl, message: result.message }); return }
    setSource({ kind: 'library', id: entry.id, name: entry.displayName, url: result.selection.job.outputUrl ?? '' })
  }

  // The print scale comes from the backend's slicer rule, so the size on the
  // plate is the size OrcaSlicer receives, calibrated or not.
  useEffect(() => {
    if (!modelUrl) return
    const token = slicerSourceToken(sourceUrl ?? undefined)
    if (!token) {
      setError({ modelUrl, message: 'This model cannot be sized for printing.' })
      return
    }
    let cancelled = false
    fetch(`${apiUrl}/export/print-scale/${token}`)
      .then(async (response) => (response.ok ? parsePrintScale(await response.json()) : null))
      .catch(() => null)
      .then((value) => {
        if (cancelled) return
        if (value) setScale({ modelUrl, value })
        else setError({ modelUrl, message: 'The print size of this model could not be read.' })
      })
    return () => { cancelled = true }
  }, [apiUrl, sourceUrl, modelUrl])

  const onSize = useCallback((size: Size3) => {
    if (modelUrl) setModelSize({ modelUrl, size })
  }, [modelUrl])

  const printScale = scale?.modelUrl === modelUrl ? scale.value : null
  const sizeUnits = modelSize?.modelUrl === modelUrl ? modelSize.size : null
  const measured = printScale && sizeUnits
    ? { size: modelSizeMm(sizeUnits, printScale.mmPerUnit), calibrated: printScale.calibrated }
    : null

  const volume = resolveBuildVolume(printer)
  const fit = measured ? checkFit(measured.size, volume) : null

  return (
    <div className="flex h-full w-full overflow-hidden">
      <aside className="flex w-72 shrink-0 flex-col gap-5 overflow-y-auto border-r border-zinc-800 bg-surface-400/60 px-4 py-5">
        <div>
          <h1 className="text-[17px] font-semibold tracking-tight text-zinc-100">Print</h1>
          <p className="mt-0.5 text-[11px] text-zinc-500">See the model on your printer's build plate at the size the slicer gets.</p>
        </div>

        <Section title="Model">
          <select
            aria-label="Model to print"
            value={source.kind === 'library' ? source.id : 'current'}
            onChange={(event) => { void chooseSource(event.target.value) }}
            className={FIELD}
          >
            <option value="current">Current mesh (Generate){currentUrl ? '' : ' — none'}</option>
            {source.kind === 'library' && !assets.some((a) => a.id === source.id) && (
              <option value={source.id}>{source.name}</option>
            )}
            {assets.length > 0 && (
              <optgroup label="Library">
                {assets.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}
              </optgroup>
            )}
          </select>
          {loadError && <p role="alert" className="text-[11px] text-amber-300">{loadError}</p>}
        </Section>

        <Section title="Printer">
          <select
            aria-label="Printer"
            value={printer.presetId}
            onChange={(event) => changePrinter({ ...printer, presetId: event.target.value })}
            className={FIELD}
          >
            {PRINTER_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
            <option value={CUSTOM_PRINTER_ID}>Custom…</option>
          </select>
          {printer.presetId === CUSTOM_PRINTER_ID ? (
            <div className="flex gap-2">
              {(['width', 'depth', 'height'] as const).map((side) => (
                <VolumeInput
                  key={side}
                  label={`${side[0].toUpperCase()}${side.slice(1)} (mm)`}
                  value={printer.custom[side]}
                  onChange={(value) => changePrinter({ ...printer, custom: { ...printer.custom, [side]: value } })}
                />
              ))}
            </div>
          ) : null}
          <p className="text-[11px] text-zinc-500">Build volume: {formatVolume(volume)}</p>
        </Section>

        {measured && fit && (
          <Section title="Size">
            <p className="text-xs text-zinc-200">{formatVolume(measured.size)}</p>
            {fit.fits ? (
              <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-300">
                Fits the build volume.
              </p>
            ) : (
              <p role="alert" className="rounded-lg border border-red-500/40 bg-red-950/60 px-2.5 py-1.5 text-[11px] text-red-200">
                {describeOverflow(measured.size, volume, fit.over)}
              </p>
            )}
            {!measured.calibrated && (
              <p role="note" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200">
                <b>Provisional size.</b> This model has no real size yet, so it is shown at the size the slicer would get. Set a real size with <b>Set Real Size</b> in Generate's Edit panel.
              </p>
            )}
          </Section>
        )}
      </aside>

      <div className="relative min-w-0 flex-1 bg-surface-400">
        <PlateScene
          volume={volume}
          modelUrl={modelUrl}
          mmPerUnit={printScale?.mmPerUnit ?? null}
          fits={fit?.fits ?? true}
          onSize={onSize}
          onError={() => setError({ modelUrl, message: 'The model could not be loaded.' })}
        />
        {!modelUrl && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm font-medium text-zinc-300">No model to print</p>
            <p className="max-w-xs text-xs text-zinc-500">Generate or open a mesh, or pick one from the Library on the left.</p>
            <button type="button" onClick={() => navigate('generate')} className="pointer-events-auto mt-1 text-xs font-medium text-accent-light hover:text-violet-300">
              Go to Generate
            </button>
          </div>
        )}
        {modelUrl && (
          <p className="pointer-events-none absolute bottom-4 right-4 text-xs text-zinc-600">Drag to rotate • Scroll to zoom</p>
        )}
      </div>
    </div>
  )
}
