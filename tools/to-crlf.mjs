// 把文本文件统一成 CRLF（.cmd/.bat 用 LF 在 cmd.exe 里有解析风险）。
// 用法：node tools/to-crlf.mjs <file...>
import fs from 'node:fs'

for (const file of process.argv.slice(2)) {
  if (!fs.existsSync(file)) {
    console.log(`skip (missing): ${file}`)
    continue
  }
  const original = fs.readFileSync(file, 'utf8')
  const normalized = original.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
  if (normalized === original) {
    console.log(`ok   already CRLF: ${file}`)
    continue
  }
  fs.writeFileSync(file, normalized, 'utf8')
  console.log(`fix  CRLF: ${file}`)
}
