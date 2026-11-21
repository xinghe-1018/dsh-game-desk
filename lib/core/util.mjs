// lib/core/util.mjs —— 通用小件：fs 唤醒键、深拷贝、时间戳、扩展名归类。
// 纯函数：不读 CONF / ctx / 任何插件级单例，只吃参数；由 core、services 与 lib/index.js 直接 import。
import { statSync } from 'node:fs'
import { extname } from 'node:path'

/** 目录唤醒键：自身 mtime + ctime。 */
export function dirWake(dir) {
  try {
    const st = statSync(dir)
    return st.mtimeMs + '|' + st.ctimeMs
  } catch { return '' }
}

/** 深拷贝一份（structuredClone 优先）：缓存命中时用它，别把同一份对象同时交给两个调用方。 */
export function cloneData(v) {
  try { return structuredClone(v) } catch { /* 老运行时没有 structuredClone，退回 JSON */ }
  try { return JSON.parse(JSON.stringify(v)) } catch { return v }
}

/** 备份用的时间戳：yyyyMMddHHmmss（本地时间，定宽 ⇒ 按名字排序就是时间序）。 */
export function backupStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

export function kindOf(name) {
  const ext = extname(String(name)).toLowerCase()
  if (ext === '.pdf') return 'pdf'
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext)) return 'image'
  if (['.doc', '.docx', '.rtf', '.odt'].includes(ext)) return 'doc'
  if (['.txt', '.md', '.yml', '.yaml', '.json', '.csv'].includes(ext)) return 'text'
  return 'other'
}
