import { deflateSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** @param {Buffer} buffer */
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const name = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

/** @param {Buffer} target @param {number} offset @param {[number, number, number]} color @param {number} alpha */
function blend(target, offset, color, alpha) {
  const inverse = 1 - alpha
  target[offset] = Math.round(color[0] * alpha + target[offset] * inverse)
  target[offset + 1] = Math.round(color[1] * alpha + target[offset + 1] * inverse)
  target[offset + 2] = Math.round(color[2] * alpha + target[offset + 2] * inverse)
  target[offset + 3] = Math.min(255, Math.round(255 * alpha + target[offset + 3] * inverse))
}

/** @param {number} x @param {number} y @param {number} size @param {number} radius */
function roundedSquareDistance(x, y, size, radius) {
  const qx = Math.abs(x - size / 2) - (size / 2 - radius)
  const qy = Math.abs(y - size / 2) - (size / 2 - radius)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
}

/** @param {number} size */
function raster(size) {
  const pixels = Buffer.alloc(size * size * 4)
  const scale = size / 512
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4
      const mask = roundedSquareDistance(x, y, size, 118 * scale)
      if (mask > 0) continue
      const vertical = y / size
      pixels[offset] = Math.round(19 - vertical * 12)
      pixels[offset + 1] = Math.round(24 - vertical * 14)
      pixels[offset + 2] = Math.round(37 - vertical * 20)
      pixels[offset + 3] = 255

      const glowLeft = Math.max(0, 1 - Math.hypot(x - 190 * scale, y - 252 * scale) / (180 * scale))
      const glowRight = Math.max(0, 1 - Math.hypot(x - 322 * scale, y - 252 * scale) / (180 * scale))
      blend(pixels, offset, [255, 163, 82], glowLeft * 0.13)
      blend(pixels, offset, [66, 205, 242], glowRight * 0.14)

      for (const diamond of [
        { cx: 205, color: [255, 177, 101] },
        { cx: 307, color: [91, 215, 246] }
      ]) {
        const metric = Math.abs(x / scale - diamond.cx) / 101 + Math.abs(y / scale - 256) / 110
        if (metric < 0.86) blend(pixels, offset, diamond.color, 0.11)
        const edge = Math.max(0, 1 - Math.abs(metric - 0.94) / 0.055)
        if (edge > 0) blend(pixels, offset, diamond.color, edge * 0.92)
      }

      const center = Math.hypot(x / scale - 256, y / scale - 256)
      if (center < 31) blend(pixels, offset, [185, 164, 255], Math.max(0, (31 - center) / 48))
      if (center < 14) blend(pixels, offset, [185, 164, 255], 1)

      if (mask > -2 * scale) pixels[offset + 3] = Math.round(255 * Math.max(0, -mask / (2 * scale)))
    }
  }
  return pixels
}

/** @param {number} size */
function png(size) {
  const pixels = raster(size)
  const rows = []
  for (let y = 0; y < size; y += 1) {
    rows.push(Buffer.from([0]), pixels.subarray(y * size * 4, (y + 1) * size * 4))
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** @param {Buffer} pngBuffer */
function ico(pngBuffer) {
  const header = Buffer.alloc(22)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  header[6] = 0
  header[7] = 0
  header[8] = 0
  header[9] = 0
  header.writeUInt16LE(1, 10)
  header.writeUInt16LE(32, 12)
  header.writeUInt32LE(pngBuffer.length, 14)
  header.writeUInt32LE(22, 18)
  return Buffer.concat([header, pngBuffer])
}

await mkdir(resolve(root, 'resources'), { recursive: true })
const iconPng = png(512)
const iconIcoPng = png(256)
await Promise.all([
  writeFile(resolve(root, 'resources', 'icon.png'), iconPng),
  writeFile(resolve(root, 'resources', 'icon.ico'), ico(iconIcoPng))
])
