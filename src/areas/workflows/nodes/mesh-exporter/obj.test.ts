import test from 'node:test'
import assert from 'node:assert/strict'
import { objFiles, type ObjPrimitive } from './obj'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

function triangle(texture: number | null, uvs: number[] | null = [0, 0.25, 1, 0, 0, 1]): ObjPrimitive {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals:   null,
    uvs:       uvs ? new Float32Array(uvs) : null,
    indices:   [0, 1, 2],
    texture,
  }
}

const lines = (data: string | Uint8Array) => String(data).split('\n')

test('a textured mesh writes the obj, mtl and texture side by side', () => {
  const files = objFiles([triangle(0)], [{ image: PNG, mimeType: 'image/png' }], 'my model')
  assert.deepEqual(files.map((f) => f.name), ['my model.obj', 'my model.mtl', 'my model_texture.png'])

  const obj = lines(files[0].data)
  assert.ok(obj.includes('mtllib my model.mtl'))
  assert.ok(obj.includes('usemtl material'))
  assert.ok(obj.includes('f 1/1 2/2 3/3'))
  const mtl = lines(files[1].data)
  assert.ok(mtl.includes('newmtl material'))
  assert.ok(mtl.includes('map_Kd my model_texture.png'))
  assert.equal(files[2].data, PNG)
})

test('flips V from the glTF top-left origin to the OBJ bottom-left one', () => {
  const [obj] = objFiles([triangle(0)], [{ image: PNG, mimeType: 'image/png' }], 'm')
  const vts = lines(obj.data).filter((l) => l.startsWith('vt '))
  assert.deepEqual(vts, ['vt 0.000000 0.750000', 'vt 1.000000 1.000000', 'vt 0.000000 0.000000'])
})

test('keeps a JPEG texture as JPEG', () => {
  const files = objFiles([triangle(0)], [{ image: PNG, mimeType: 'image/jpeg' }], 'm')
  assert.equal(files[2].name, 'm_texture.jpg')
})

test('an untextured mesh writes the obj alone', () => {
  const files = objFiles([triangle(null)], [], 'm')
  assert.deepEqual(files.map((f) => f.name), ['m.obj'])
  assert.ok(!String(files[0].data).includes('mtllib'))
  assert.ok(!String(files[0].data).includes('usemtl'))
})

test('a texture without UVs or in an unreadable format is left out', () => {
  assert.deepEqual(objFiles([triangle(0, null)], [{ image: PNG, mimeType: 'image/png' }], 'm').map((f) => f.name), ['m.obj'])
  assert.deepEqual(objFiles([triangle(0)], [{ image: PNG, mimeType: 'image/ktx2' }], 'm').map((f) => f.name), ['m.obj'])
})

test('several textures are numbered and untextured parts get their own material', () => {
  const textures = [{ image: PNG, mimeType: 'image/png' }, { image: PNG, mimeType: 'image/png' }]
  const files = objFiles([triangle(0), triangle(null), triangle(1)], textures, 'm')
  assert.deepEqual(files.map((f) => f.name), ['m.obj', 'm.mtl', 'm_texture_1.png', 'm_texture_2.png'])
  const usemtl = lines(files[0].data).filter((l) => l.startsWith('usemtl '))
  assert.deepEqual(usemtl, ['usemtl material_1', 'usemtl untextured', 'usemtl material_2'])
  const mtl = lines(files[1].data)
  assert.ok(mtl.includes('map_Kd m_texture_1.png'))
  assert.ok(mtl.includes('map_Kd m_texture_2.png'))
  assert.ok(mtl.includes('newmtl untextured'))
})

test('face indices continue across primitives', () => {
  const [obj] = objFiles([triangle(0), triangle(0)], [{ image: PNG, mimeType: 'image/png' }], 'm')
  assert.ok(lines(obj.data).includes('f 4/4 5/5 6/6'))
})
