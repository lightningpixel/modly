/**
 * "Does this model fit in VRAM?" verdict, computed from the model's estimated
 * footprint against the detected VRAM. Only meaningful on GPUs we can measure
 * (NVIDIA via nvidia-smi); returns null otherwise so no misleading badge shows
 * on Vulkan/CPU where `vramGb` is unknown.
 */
export interface VramFit {
  label:     string
  className: string
}

export function vramFit(estimateMb?: number, vramGb?: number | null): VramFit | null {
  if (!estimateMb || !vramGb) return null
  const vramMb = vramGb * 1024
  if (estimateMb <= vramMb * 0.9)
    return { label: 'Fits', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' }
  if (estimateMb <= vramMb)
    return { label: 'Tight', className: 'border-amber-500/30 bg-amber-500/10 text-amber-400' }
  return { label: "Won't fit", className: 'border-red-500/30 bg-red-500/10 text-red-400' }
}
