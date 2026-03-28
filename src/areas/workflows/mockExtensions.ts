export interface ParamSchema {
  id:       string
  label:    string
  type:     'select' | 'int' | 'float'
  default:  number | string
  options?: { value: number | string; label: string }[]
  min?:     number
  max?:     number
  step?:    number
}

export interface MockExtension {
  id:          string
  name:        string
  description: string
  category:    'preprocessor' | 'generator' | 'postprocessor'
  input:       'image' | 'text' | 'mesh'
  output:      'image' | 'mesh'
  params:      ParamSchema[]
}

export const MOCK_EXTENSIONS: MockExtension[] = [
  {
    id:          'background-removal',
    name:        'Background Removal',
    description: 'Remove background from image using rembg',
    category:    'preprocessor',
    input:       'image',
    output:      'image',
    params: [
      { id: 'model', label: 'Model', type: 'select', default: 'u2net',
        options: [{ value: 'u2net', label: 'u2net' }, { value: 'isnet', label: 'ISNet' }, { value: 'birefnet', label: 'BiRefNet' }] },
    ],
  },
  {
    id:          'triposr',
    name:        'TripoSR',
    description: 'Fast single-image 3D reconstruction (~6GB VRAM)',
    category:    'generator',
    input:       'image',
    output:      'mesh',
    params: [
      { id: 'foreground_ratio', label: 'Foreground Ratio', type: 'float', default: 0.85, min: 0.5, max: 1.0, step: 0.05 },
      { id: 'resolution',       label: 'Resolution',       type: 'int',   default: 256,  min: 128, max: 512 },
    ],
  },
  {
    id:          'triposg',
    name:        'TripoSG',
    description: 'High-quality image-to-3D via flow matching (~8GB VRAM)',
    category:    'generator',
    input:       'image',
    output:      'mesh',
    params: [
      { id: 'num_inference_steps', label: 'Steps',     type: 'int',    default: 50,  min: 8,   max: 50 },
      { id: 'guidance_scale',      label: 'CFG Scale', type: 'float',  default: 7.0, min: 0.0, max: 20.0, step: 0.5 },
      { id: 'seed',                label: 'Seed',      type: 'int',    default: 42,  min: 0,   max: 2147483647 },
      { id: 'decoder',             label: 'Decoder',   type: 'select', default: 'DiffDMC',
        options: [{ value: 'DiffDMC', label: 'DiffDMC' }, { value: 'marching_cubes', label: 'Marching Cubes' }] },
    ],
  },
  {
    id:          'hunyuan3d-mini',
    name:        'Hunyuan3D Mini',
    description: 'Lightweight 0.6B model, fast generation',
    category:    'generator',
    input:       'image',
    output:      'mesh',
    params: [
      { id: 'quality',           label: 'Quality',         type: 'select', default: 30,
        options: [{ value: 10, label: 'Fast' }, { value: 30, label: 'Balanced' }, { value: 50, label: 'High' }] },
      { id: 'octree_resolution', label: 'Mesh Resolution', type: 'select', default: 380,
        options: [{ value: 256, label: 'Low' }, { value: 380, label: 'Medium' }, { value: 512, label: 'High' }] },
      { id: 'guidance_scale',    label: 'CFG Scale',       type: 'float',  default: 5.5, min: 1.0, max: 10.0, step: 0.5 },
      { id: 'seed',              label: 'Seed',            type: 'int',    default: 42,  min: 0,   max: 2147483647 },
    ],
  },
  {
    id:          'hunyuan3d-mini-turbo',
    name:        'Hunyuan3D Mini Turbo',
    description: 'Faster variant of Hunyuan3D Mini',
    category:    'generator',
    input:       'image',
    output:      'mesh',
    params: [
      { id: 'guidance_scale', label: 'CFG Scale', type: 'float', default: 5.5, min: 1.0, max: 10.0, step: 0.5 },
      { id: 'seed',           label: 'Seed',      type: 'int',   default: 42,  min: 0,   max: 2147483647 },
    ],
  },
  {
    id:          'trellis-2',
    name:        'TRELLIS 2',
    description: 'High-fidelity image-to-3D with PBR textures (~24GB VRAM)',
    category:    'generator',
    input:       'image',
    output:      'mesh',
    params: [
      { id: 'steps',          label: 'Steps',     type: 'int',   default: 50,  min: 10, max: 100 },
      { id: 'guidance_scale', label: 'CFG Scale', type: 'float', default: 7.5, min: 1.0, max: 15.0, step: 0.5 },
      { id: 'seed',           label: 'Seed',      type: 'int',   default: 42,  min: 0,  max: 2147483647 },
    ],
  },
  {
    id:          'mesh-optimizer',
    name:        'Mesh Optimizer',
    description: 'Reduce polygon count while preserving shape',
    category:    'postprocessor',
    input:       'mesh',
    output:      'mesh',
    params: [
      { id: 'target_faces', label: 'Target Faces', type: 'int',    default: 50000, min: 1000, max: 500000 },
      { id: 'method',       label: 'Method',       type: 'select', default: 'quadric',
        options: [{ value: 'quadric', label: 'Quadric' }, { value: 'angle', label: 'Angle' }] },
    ],
  },
  {
    id:          'texture-baker',
    name:        'Texture Baker',
    description: 'Bake and optimize PBR textures on the mesh',
    category:    'postprocessor',
    input:       'mesh',
    output:      'mesh',
    params: [
      { id: 'resolution', label: 'Resolution', type: 'select', default: 1024,
        options: [{ value: 512, label: '512px' }, { value: 1024, label: '1024px' }, { value: 2048, label: '2048px' }] },
      { id: 'format',     label: 'Format',     type: 'select', default: 'png',
        options: [{ value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPG' }] },
    ],
  },
]

export function getMockExtension(id: string): MockExtension | undefined {
  return MOCK_EXTENSIONS.find((e) => e.id === id)
}
