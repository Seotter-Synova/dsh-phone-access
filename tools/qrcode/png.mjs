// 零依赖：把模块矩阵导出成 1-bit 灰度 PNG（扫码器最友好的形态）。
// PNG 需要 CRC32 与 zlib 流，两者都能用 Node 内置模块算。
import zlib from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crcBuf])
}

/**
 * @param {number[][]} matrix 0=黑模块 1=白模块（尺寸 size x size）
 * @param {number} scale 每个模块的像素数
 * @param {number} quiet 静默区模块数
 * @returns {Buffer} PNG 文件字节
 */
export function matrixToPng(matrix, scale = 8, quiet = 4) {
  const size = matrix.length
  const modules = size + quiet * 2
  const pixels = modules * scale

  // 1-bit 灰度：0=黑，1=白；每行前加一个 filter 字节 0
  const rowBytes = Math.ceil(pixels / 8)
  const raw = Buffer.alloc((rowBytes + 1) * pixels)
  let offset = 0
  for (let py = 0; py < pixels; py += 1) {
    raw[offset] = 0 // filter: none
    offset += 1
    const my = Math.floor(py / scale) - quiet
    for (let px = 0; px < pixels; px += 1) {
      const mx = Math.floor(px / scale) - quiet
      const isDark = mx >= 0 && my >= 0 && mx < size && my < size ? matrix[my][mx] === 1 : false
      if (!isDark) raw[offset + (px >> 3)] |= 0x80 >> (px & 7) // 1 = 白
    }
    offset += rowBytes
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(pixels, 0)
  ihdr.writeUInt32BE(pixels, 4)
  ihdr[8] = 1 // bit depth
  ihdr[9] = 0 // color type: grayscale
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
