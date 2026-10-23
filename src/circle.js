import { ADDRESS_PREFIX } from './config.js'

export const bchToSats = bch => Math.round(Number(bch) * 1e8)
export const satsToBch = s => (s / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')

export const MIN_MEMBERS = 3
export const MAX_MEMBERS = 20
export const UNITS = ['days', 'weeks', 'months']

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

export function validate({ name, members, amountSats, startDate, every, unit }) {
  const errors = []
  if (!name || !name.trim()) errors.push('Give the circle a name.')
  if (members.length < MIN_MEMBERS || members.length > MAX_MEMBERS) {
    errors.push(`Use ${MIN_MEMBERS} to ${MAX_MEMBERS} members.`)
  }
  if (!(amountSats >= 1000)) errors.push('Amount per member is too small (minimum 0.00001 BCH).')
  if (!(Number.isInteger(every) && every >= 1 && every <= 366)) {
    errors.push('"Every" must be a whole number from 1 to 366.')
  }
  if (!UNITS.includes(unit)) errors.push('Choose days, weeks or months.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '')) errors.push('Choose a start date.')

  const addressPattern = new RegExp(`^${ADDRESS_PREFIX}:[a-z0-9]{30,}$`, 'i')
  const seen = new Set()
  members.forEach((m, i) => {
    const label = m.name.trim() || `Member ${i + 1}`
    if (!m.name.trim()) errors.push(`Member ${i + 1} needs a name.`)
    const address = m.address.trim().toLowerCase()
    if (!addressPattern.test(address)) errors.push(`Invalid ${ADDRESS_PREFIX}: address for ${label}.`)
    if (seen.has(address)) errors.push(`Duplicate address for ${label}.`)
    seen.add(address)
  })
  return errors
}

// The circle is stored in the share link, so we keep it small: the rounds are calculated when needed
export function createCircle({ name, members, amountSats, startDate, every, unit }) {
  return { name: name.trim(), members, amountSats, startDate, every, unit }
}

// One round per member. The member at position i receives in round i + 1.
export function getRounds(circle) {
  const n = circle.members.length
  return circle.members.map((recipient, i) => ({
    round: i + 1,
    recipient,
    dueDate: addPeriod(circle.startDate, i * circle.every, circle.unit),
    amountSats: circle.amountSats,
    potSats: circle.amountSats * n, // everyone's share, including the recipient's own
    fromOthersSats: circle.amountSats * (n - 1), // what actually arrives from the other members
  }))
}

// Random draw (Fisher-Yates with the browser's secure random numbers)
export function shuffled(list) {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    const j = buf[0] % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
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

// Short id of a circle, written into every payment so payments can be matched to it
export async function circleId(circle) {
  const data = JSON.stringify({
        m: circle.members.map(x => x.address).sort(),
    a: circle.amountSats,
    s: circle.startDate,
  })
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 8)
}