const DAY = 86_400_000

const dateOnly = iso => iso.slice(0, 10).replaceAll('-', '')
const nextDay = iso => {
  const d = new Date(iso.slice(0, 10) + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10).replaceAll('-', '')
}
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const esc = s =>
  String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')

// A short sentence about where we are in a round's payment window
export function windowText(periodStart, dueDate) {
  const now = Date.now()
  const start = Date.parse(periodStart)
  const end = Date.parse(dueDate) + DAY
  if (now < start) {
    const d = Math.ceil((start - now) / DAY)
    return `the window opens in ${d} day${d === 1 ? '' : 's'}`
  }
  if (now >= end) return 'the window has ended'
  const d = Math.ceil((end - now) / DAY)
  return `${d} day${d === 1 ? '' : 's'} left to pay`
}

/**
 * Builds a calendar file (.ics) with one all-day event per payment window.
 * payments: [{ round, to, amount, start, end }]  (start and end are ISO dates, end = last day to pay)
 */
export function buildCalendar({ circleName, circleId, payerNo, payments }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Kameti.cash//Payments//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ]
  for (const p of payments) {
    const summary = `Kameti: pay ${p.to} ${p.amount} BCH (round ${p.round})`
    const description =
      `Circle: ${circleName}. Round ${p.round}. Pay ${p.to} ${p.amount} BCH from your own wallet ` +
      `between ${p.start.slice(0, 10)} and ${p.end.slice(0, 10)} (UTC). Every payment goes straight to the receiver.`
    lines.push(
      'BEGIN:VEVENT',
      `UID:${circleId}-${p.round}-${payerNo}@kameti.cash`,
      `DTSTAMP:${stamp()}`,
      `DTSTART;VALUE=DATE:${dateOnly(p.start)}`,
      `DTEND;VALUE=DATE:${nextDay(p.end)}`,
      `SUMMARY:${esc(summary)}`,
      `DESCRIPTION:${esc(description)}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${esc('Your Kameti payment window opens today')}`,
      'TRIGGER:PT9H',
      'END:VALARM',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${esc('Your Kameti payment window ends tomorrow')}`,
      'TRIGGER;RELATED=END:-P1D',
      'END:VALARM',
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n')
}

// Saves a text file on the user's computer or phone
export function downloadText(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type: type + ';charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}