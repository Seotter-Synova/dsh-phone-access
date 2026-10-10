// 给 .ps1 补 UTF-8 BOM（PowerShell 5.1 在本机按 ANSI 读无 BOM 的 .ps1，中文会变语法错）。
// 只处理 .ps1；已是 BOM 的跳过。用法：node tools/ensure-ps1-bom.mjs <file...>
import fs from 'node:fs'

let changed = 0
for (const file of process.argv.slice(2)) {
  if (!fs.existsSync(file)) {
    console.log(`skip (missing): ${file}`)
    continue
  }
  const bytes = fs.readFileSync(file)
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    console.log(`ok   BOM present: ${file}`)
    continue
  }
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]))
  console.log(`add  BOM: ${file} (${bytes.length} -> ${bytes.length + 3})`)
  changed += 1
}
console.log(`done, ${changed} file(s) changed`)
