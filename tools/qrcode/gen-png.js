// 生成二维码 PNG 文件（用成熟库 qrcode-generator 编码，扫码器最友好的形态）。
// 2026-10-09：自写编码器结构正确但掩码层与标准不符，实际扫不出来；改用成熟库。
// 用法：node tools/qrcode/gen-png.js "<url>" <输出路径> [scale] [quiet]
import fs from 'node:fs'
import { encodeWithLibrary } from './lib.mjs'
import { matrixToPng } from './png.mjs'

const text = process.argv[2]
const out = process.argv[3]
if (!text || !out) {
  console.error('usage: node gen-png.js <url> <out.png> [scale] [quiet]')
  process.exit(2)
}
const scale = Number(process.argv[4] ?? 8)
const quiet = Number(process.argv[5] ?? 4)

const { matrix, version } = encodeWithLibrary(text, 'M')
const png = matrixToPng(matrix, scale, quiet)
fs.writeFileSync(out, png)
const pixels = (matrix.length + quiet * 2) * scale
console.log(JSON.stringify({ out, bytes: png.length, version, modules: matrix.length, pixels }))
