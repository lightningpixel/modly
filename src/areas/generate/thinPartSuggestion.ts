export const MIN_THIN_PART_SUGGESTION_CONFIDENCE = 0.97
export const CAREFUL_PIPELINE_SETTING = '1024_cascade'

export const THIN_PART_SUGGESTION_MESSAGE =
  'This looks like it has thin parts, such as blades, wires, or tentacles. ' +
  'Those can come out shredded at the normal setting. Use the Careful setting? ' +
  'It takes about 1 minute total instead of about 25 seconds.'

export interface ThinPartSuggestion {
  confidence: number
  proposedSetting: typeof CAREFUL_PIPELINE_SETTING
}

const PIPELINE_ORDER: Record<string, number> = {
  '512': 0,
  '1024': 1,
  '1024_cascade': 2,
  '1536_cascade': 3,
}

/**
 * The threshold is deliberately narrow and conservative. In the actual
 * renderer, the false-positive squid sketch scored 0.955102 and the confirmed
 * fan photo scored 0.972787. The score is not a probability and disagreed
 * across lamp crops, so even a qualifying result is only ever offered.
 */
export function getThinPartSuggestion(
  confidence: number,
  currentSetting: string,
): ThinPartSuggestion | null {
  if (!Number.isFinite(confidence) || confidence < MIN_THIN_PART_SUGGESTION_CONFIDENCE) return null
  if ((PIPELINE_ORDER[currentSetting] ?? PIPELINE_ORDER[CAREFUL_PIPELINE_SETTING]) >= PIPELINE_ORDER[CAREFUL_PIPELINE_SETTING]) {
    return null
  }
  return {
    confidence,
    proposedSetting: CAREFUL_PIPELINE_SETTING,
  }
}

export function applyThinPartSuggestion(
  currentParams: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...currentParams,
    pipeline_type: CAREFUL_PIPELINE_SETTING,
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function periodicStrength(values: number[], minimumOrder = 3, maximumOrder = 12): number {
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return 0
  const mean = total / values.length
  const centered = values.map((value) => value - mean)
  const absolute = centered.reduce((sum, value) => sum + Math.abs(value), 0)
  if (absolute <= 1e-9) return 0

  let best = 0
  for (let order = minimumOrder; order <= maximumOrder; order += 1) {
    let real = 0
    let imaginary = 0
    for (let index = 0; index < centered.length; index += 1) {
      const angle = -2 * Math.PI * order * index / centered.length
      real += centered[index] * Math.cos(angle)
      imaginary += centered[index] * Math.sin(angle)
    }
    best = Math.max(best, Math.hypot(real, imaginary) / absolute)
  }
  return best
}

function projectionRepetition(edges: Uint8Array, width: number, height: number): number {
  const rows = new Array<number>(height).fill(0)
  const columns = new Array<number>(width).fill(0)
  for (let index = 0; index < edges.length; index += 1) {
    if (!edges[index]) continue
    const y = Math.floor(index / width)
    const x = index % width
    rows[y] += 1
    columns[x] += 1
  }

  const autocorrelation = (values: number[]): number => {
    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
    const centered = values.map((value) => value - mean)
    const energy = centered.reduce((sum, value) => sum + value * value, 0)
    if (energy <= 1e-9) return 0
    const lower = Math.max(3, Math.floor(values.length / 40))
    const upper = Math.max(lower + 1, Math.floor(values.length / 5))
    let best = 0
    for (let lag = lower; lag < upper; lag += 1) {
      let overlap = 0
      for (let index = 0; index < values.length - lag; index += 1) {
        overlap += centered[index] * centered[index + lag]
      }
      best = Math.max(best, overlap / energy)
    }
    return clamp(best)
  }

  return Math.max(autocorrelation(rows), autocorrelation(columns))
}

/**
 * Browser equivalent of thinfeatures.py's Pillow measurement. The detector
 * measures edge density plus radial or parallel repetition; it never changes
 * settings itself.
 */
export function scoreThinPartPixels(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): number {
  if (width < 32 || height < 32) throw new Error(`Image is too small to check (${width}×${height}).`)
  if (rgba.length !== width * height * 4) throw new Error('Image pixels could not be read.')

  const grey = new Uint8ClampedArray(width * height)
  for (let index = 0; index < grey.length; index += 1) {
    const offset = index * 4
    grey[index] = Math.round(
      0.299 * rgba[offset] +
      0.587 * rgba[offset + 1] +
      0.114 * rgba[offset + 2],
    )
  }

  // Pillow's FIND_EDGES kernel: eight neighbours at -1, centre at 8.
  const edgeValues = new Uint8ClampedArray(width * height)
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x
      let value = grey[index] * 8
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue
          value -= grey[(y + offsetY) * width + x + offsetX]
        }
      }
      edgeValues[index] = Math.max(0, Math.min(255, Math.round(value)))
    }
  }

  const interior: number[] = []
  for (let y = 2; y < height - 2; y += 1) {
    for (let x = 2; x < width - 2; x += 1) {
      interior.push(edgeValues[y * width + x])
    }
  }
  interior.sort((a, b) => a - b)
  const median = interior[Math.floor(interior.length / 2)]
  const threshold = Math.max(22, median + 18)
  const edges = new Uint8Array(width * height)
  let activeCount = 0
  let activeTotal = 0
  for (let y = 2; y < height - 2; y += 1) {
    for (let x = 2; x < width - 2; x += 1) {
      const index = y * width + x
      if (edgeValues[index] < threshold) continue
      edges[index] = 1
      activeCount += 1
      activeTotal += edgeValues[index]
    }
  }

  const interiorCount = Math.max(1, (width - 4) * (height - 4))
  const edgeFraction = activeCount / interiorCount
  const edgeEnergy = activeTotal / Math.max(1, interiorCount * 255)

  const centerX = (width - 1) * 0.5
  const centerY = (height - 1) * 0.5
  const maximumRadius = Math.min(width, height) * 0.48
  const minimumRadius = maximumRadius * 0.16
  const angular = new Array<number>(72).fill(0)
  for (let index = 0; index < edges.length; index += 1) {
    if (!edges[index]) continue
    const y = Math.floor(index / width)
    const x = index % width
    const dx = x - centerX
    const dy = y - centerY
    const radius = Math.hypot(dx, dy)
    if (radius < minimumRadius || radius > maximumRadius) continue
    const angle = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)
    const slot = Math.min(angular.length - 1, Math.floor(angle * angular.length))
    angular[slot] += 1
  }
  const smoothedAngular = angular.map((_, index) =>
    (
      angular[(index - 1 + angular.length) % angular.length] +
      angular[index] +
      angular[(index + 1) % angular.length]
    ) / 3,
  )
  const radialRepetition = periodicStrength(smoothedAngular)
  const parallelRepetition = projectionRepetition(edges, width, height)
  const repetition = Math.max(radialRepetition, parallelRepetition)

  const fineScore = clamp((edgeFraction - 0.035) / 0.15)
  const energyScore = clamp((edgeEnergy - 0.012) / 0.075)
  const detail = Math.max(fineScore, energyScore)
  let score = clamp(0.48 * detail + 0.52 * clamp((repetition - 0.08) / 0.42))
  if (detail < 0.18 || repetition < 0.12) score *= 0.55
  return Math.round(score * 1_000_000) / 1_000_000
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('The selected image could not be checked.'))
    image.src = src
  })
}

export async function measureThinPartConfidence(src: string): Promise<number> {
  const image = await loadImage(src)
  const scale = Math.min(1, 384 / image.naturalWidth, 384 / image.naturalHeight)
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('The selected image could not be checked.')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, width, height)
  const pixels = context.getImageData(0, 0, width, height)
  return scoreThinPartPixels(pixels.data, width, height)
}
