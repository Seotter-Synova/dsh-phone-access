// 用成熟库 qrcode-generator（MIT，零依赖）生成二维码矩阵。
// 该库是两段式：dist/qrcode.js 定义全局 qrcode，dist/qrcode_UTF8.js 覆盖其 stringToBytes。
// 用 node:vm 在同一上下文里按顺序求值，得到可用的 qrcode。
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(here, 'pkg', 'package', 'dist')

const sandbox = {}
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(path.join(distDir, 'qrcode.js'), 'utf8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(distDir, 'qrcode_UTF8.js'), 'utf8'), sandbox)

const qrcode = sandbox.qrcode
if (typeof qrcode !== 'function') throw new Error('qrcode-generator failed to load')

/**
 * @param {string} text
 * @param {'L'|'M'|'Q'|'H'} ecLevel
 * @returns {{ matrix: number[][], version: number }}
 */
export function encodeWithLibrary(text, ecLevel = 'M') {
  const qr = qrcode(0, ecLevel) // 0 = 自动选择版本
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const matrix = []
  for (let r = 0; r < n; r += 1) {
    const row = []
    for (let c = 0; c < n; c += 1) row.push(qr.isDark(r, c) ? 1 : 0)
    matrix.push(row)
  }
  return { matrix, version: (n - 17) / 4 }
}
