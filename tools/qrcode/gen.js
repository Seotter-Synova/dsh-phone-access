// 把二维码画到终端（用成熟库编码）。
// 比例：终端字符高≈宽 2 倍，所以每行放两个模块、每模块横向占 2 字符（半块字符）。
// 用法：node tools/qrcode/gen.js "<url>" [quiet]
import { encodeWithLibrary } from './lib.mjs'

const text = process.argv[2]
if (!text) {
  console.error('usage: node gen.js <url> [quiet]')
  process.exit(2)
}
const quiet = Number(process.argv[3] ?? 2)

const { matrix, version } = encodeWithLibrary(text, 'M')
const size = matrix.length
const quietCols = '  '.repeat(quiet)
const blank = ' '.repeat((size + quiet * 2) * 2)

console.log(blank)
for (let r = 0; r < size; r += 2) {
  let line = quietCols
  for (let c = 0; c < size; c += 1) {
    const top = matrix[r][c] ? 0 : 1      // 1 = 亮/白
    const bottom = r + 1 < size ? (matrix[r + 1][c] ? 0 : 1) : 0
    if (top && bottom) line += '██'
    else if (top && !bottom) line += '▀▀'
    else if (!top && bottom) line += '▄▄'
    else line += '  '
  }
  console.log(line + quietCols)
}
console.log(blank)
console.error(`[qr] ${text.length} chars -> v${version}, ${size}x${size} modules, ${Math.ceil(size / 2) + 2} lines`)
