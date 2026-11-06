// 验证键盘 PageDown / JS scrollBy 能否滚动列表
import { connect, sleep } from '../src/cdp.js'

const base = 'http://127.0.0.1:9335'
const page = await connect(base, { match: (u) => u.includes('pinduoduo.com'), pickExisting: true })
await page.send('Page.bringToFront', {}, 8000)
console.log('scrollY0', await page.evaluate('window.scrollY'))

// 1) 键盘 PageDown
try {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 }, 5000)
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 }, 5000)
  await sleep(1200)
  console.log('after PageDown scrollY', await page.evaluate('window.scrollY'))
} catch (error) {
  console.log('PageDown err', String(error.message))
}

// 2) JS scrollBy
const y = await page.evaluate('(window.scrollTo(0, window.scrollY + 500), window.scrollY)')
await sleep(1200)
console.log('after scrollTo', y, await page.evaluate('window.scrollY'))

// 3) synthesizeScrollGesture
try {
  await page.send('Input.synthesizeScrollGesture', { x: 640, y: 500, yDistance: -600, speed: 800 }, 6000)
  await sleep(1200)
  console.log('after gesture scrollY', await page.evaluate('window.scrollY'))
} catch (error) {
  console.log('gesture err', String(error.message))
}
page.close()
