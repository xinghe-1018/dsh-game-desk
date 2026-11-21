/**
 * dsh-game-desk · 房间房主纯函数
 *
 * 从 lib/index.js 机械搬出（批次 3），函数体一字未改，只加了 export。
 * 只有判定逻辑：不读 ROOM、不读盘、不碰全局状态。落 ROOM 的 applyHostRelease 仍在 lib/index.js。
 */
/** 定房主（纯函数）：返回下一个房主 who，'' 表示暂时没人当家。规矩（按顺序判断）：
 *  1) 只有 via === 'local'（本机窗口）能当房主，lan/remote 一律不参选；
 *  2) 这次心跳来自 DSH 嵌入页（embed = 页面 URL 带 ?panel=…）→ 只有它能从别人手里接管房主；
 *     随手开的浏览器标签即使选了本子（caseFolder）也不算，否则测试标签会把真正的房主顶掉；
 *  3) 房主空位、或原房主已经不在在场表里 → 这个本机客户端接任；
 *  4) 否则不抢：同机开两个窗口时，后到的那个不会把先来的房主顶掉。
 *  present 传 ROOM.clients（只要支持 .has(who) 即可）。 */
export function pickHostWho(prevWho, who, via, embed, present) {
  const prev = String(prevWho || '')
  const self = String(who || '')
  if (via !== 'local' || !self) return prev
  if (embed === true) return self
  const alive = prev !== '' && present && typeof present.has === 'function' && present.has(prev)
  return alive ? prev : self
}
/** 房主离场后的房主身份（纯函数）：走的正好是房主就返回 ''，否则原样返回。 */
export function hostAfterRelease(hostWho, goneWho) {
  const host = String(hostWho || '')
  if (host !== '' && host === String(goneWho || '')) return ''
  return host
}
