import { ADDRESS_PREFIX } from './config.js'

export const bchToSats = bch => Math.round(Number(bch) * 1e8)
export const satsToBch = s => (s / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')

export const MIN_MEMBERS = 3
export const MAX_MEMBERS = 20
export const UNITS = ['days', 'weeks', 'months']
export const DEFAULT_WINDOW_DAYS = 7

function addDays(iso, days) {
  const d = new Date(iso)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString()
}

// Adds `count` days/weeks/months to a start date ('YYYY-MM-DD') and returns an ISO date
function addPeriod(startDate, count, unit) {
  const d = new Date(String(startDate).slice(0, 10) + 'T00:00:00Z')
  if (unit === 'months') {
    const day = d.getUTCDate()
    d.setUTCDate(1)
    d.setUTCMonth(d.getUTCMonth() + count)
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
    d.setUTCDate(Math.min(day, lastDay))
  } else {
    d.setUTCDate(d.getUTCDate() + count * (unit === 'weeks' ? 7 : 1))
  }
  return d.toISOString()
}

// When round number r starts (r = 0 is the first round)
export const roundStart = (circle, r) => addPeriod(circle.startDate, r * circle.every, circle.unit)

// Joining and leaving are possible until the second round starts (the whole first period)
export const lockTime = circle => Date.parse(roundStart(circle, 1))

// Checks a circle. Used for the create form AND for circles opened from a shared link.
export function validate({
  name,
  members,
  amountSats,
  startDate,
  every,
  unit,
  drawHeight,
  first,
  payWindow,
}) {
  const errors = []
  if (typeof name !== 'string' || !name.trim()) errors.push('Give the circle a name.')
  else if (name.trim().length > 60) errors.push('The circle name is too long (60 characters max).')

  if (!Array.isArray(members) || members.length < MIN_MEMBERS || members.length > MAX_MEMBERS) {
    errors.push(`Use ${MIN_MEMBERS} to ${MAX_MEMBERS} members.`)
    return errors
  }
  if (!Number.isInteger(amountSats) || amountSats < 1000 || amountSats > 100_000_000) {
    errors.push('Amount per member must be between 0.00001 and 1 BCH.')
  }
  if (!(Number.isInteger(every) && every >= 1 && every <= 366)) {
    errors.push('"Every" must be a whole number from 1 to 366.')
  }
  if (!UNITS.includes(unit)) errors.push('Choose days, weeks or months.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '')) errors.push('Choose a start date.')
  if (drawHeight !== undefined && !(Number.isInteger(drawHeight) && drawHeight > 0)) {
    errors.push('Invalid draw block.')
  }
  if (first !== undefined && !(Number.isInteger(first) && first >= 0 && first < members.length)) {
    errors.push('Invalid priority seat.')
  }
  if (payWindow !== undefined) {
    const periodDays = unit === 'days' ? every : unit === 'weeks' ? 7 * every : 28 * every
    if (!Number.isInteger(payWindow) || payWindow < 1 || payWindow > 14) {
      errors.push('The payment window must be between 1 and 14 days.')
    } else if (Number.isFinite(periodDays) && payWindow > periodDays) {
      errors.push('The payment window cannot be longer than one round.')
    }
  }

  const addressPattern = new RegExp(`^${ADDRESS_PREFIX}:[a-z0-9]{30,}$`, 'i')
  const seen = new Set()
  members.forEach((m, i) => {
    const mname = typeof m?.name === 'string' ? m.name.trim() : ''
    const label = mname || `Member ${i + 1}`
    if (!mname) errors.push(`Member ${i + 1} needs a name.`)
    else if (mname.length > 40) errors.push(`${label}: name is too long (40 characters max).`)
    const address = typeof m?.address === 'string' ? m.address.trim().toLowerCase() : ''
    if (!addressPattern.test(address)) errors.push(`Invalid ${ADDRESS_PREFIX}: address for ${label}.`)
    if (seen.has(address)) errors.push(`Duplicate address for ${label}.`)
    seen.add(address)
  })
  return errors
}

// The circle is stored in the share link, so we keep it small: the rounds are calculated when needed
export function createCircle({
  name,
  members,
  amountSats,
  startDate,
  every,
  unit,
  drawHeight = 0,
  demo = false,
  first = -1,
  payWindow = DEFAULT_WINDOW_DAYS,
}) {
  const circle = { name: name.trim(), members, amountSats, startDate, every, unit, payWindow }
  if (drawHeight > 0) circle.drawHeight = drawHeight
  if (demo) circle.demo = true
  if (Number.isInteger(first) && first >= 0) circle.first = first
  return circle
}

/**
 * One round per active member. `seq` is the order members receive in, as positions in
 * circle.members (for example [2, 0, 1]). Without it, the list order is used.
 * recipientNo is the member's fixed number (1 = first in the list), which never changes.
 * Each round starts on periodStart and everyone pays inside the window that ends on dueDate.
 */
export function getRounds(circle, seq = null) {
  const order = seq && seq.length ? seq : circle.members.map((_, i) => i)
  const n = order.length
  const windowDays = circle.payWindow || DEFAULT_WINDOW_DAYS
  return order.map((memberIdx, r) => {
    const periodStart = addPeriod(circle.startDate, r * circle.every, circle.unit)
    return {
      round: r + 1,
      recipient: circle.members[memberIdx],
      recipientNo: memberIdx + 1,
      periodStart,
      dueDate: addDays(periodStart, windowDays - 1), // last day to pay
      amountSats: circle.amountSats,
      potSats: circle.amountSats * n, // everyone's share, including the recipient's own
      fromOthersSats: circle.amountSats * (n - 1), // what actually arrives from the other members
    }
  })
}

// Whole circle lives in the URL: no database, no server
const toB64 = s =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_')
const fromB64 = s =>
  new TextDecoder().decode(
    Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)),
  )
export const encodeCircle = c => toB64(JSON.stringify(c))
export const decodeCircle = s => JSON.parse(fromB64(s))

// Short id of a circle. It is written into every payment and it seeds the draw.
// It does not depend on member order, but any change to the rules changes the id.
export async function circleId(circle) {
  const priority = Number.isInteger(circle.first) ? circle.members[circle.first]?.address : ''
  const data = JSON.stringify({
    m: circle.members.map(x => x.address.toLowerCase()).sort(),
    a: circle.amountSats,
    s: circle.startDate,
    e: circle.every,
    u: circle.unit,
    d: circle.drawHeight || 0,
    p: (priority || '').toLowerCase(),
    w: circle.payWindow || DEFAULT_WINDOW_DAYS,
  })
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 8)
}