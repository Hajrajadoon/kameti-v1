import {
  binToHex,
  hexToBin,
  decodeTransaction,
  cashAddressToLockingBytecode,
} from '@bitauth/libauth'
import { provider, scanWallet } from './chain.js'
import { ADDRESS_PREFIX } from './config.js'
import { sendPayment } from './payment.js'
import { roundStart, lockTime } from './circle.js'

const TAG = 'KAMETI'
const KINDS = ['LEAVE', 'JOIN', 'SWAP']
const EVENT_DUST = 546n // the small amount each note sends to the board address
const PREPARE_SATS = 5000n // topped up onto the member address when it is empty
const MIN_ACTOR_SATS = 2000n // enough on the member address to post a note

function lockingBytecodeOf(address) {
  const r = cashAddressToLockingBytecode(address)
  if (typeof r === 'string') throw new Error('Bad address: ' + r)
  return r.bytecode
}
const lockingHexOf = address => binToHex(lockingBytecodeOf(address))
const reverseHex = hex => hex.match(/../g).reverse().join('')

async function scripthashOf(address) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', lockingBytecodeOf(address)))
  return binToHex(digest.reverse())
}

// Reads the text chunks of an OP_RETURN output, or returns null if it is not one
function parseNote(script) {
  if (script[0] !== 0x6a) return null
  const chunks = []
  let i = 1
  while (i < script.length) {
    const op = script[i++]
    let len
    if (op >= 1 && op <= 75) len = op
    else if (op === 0x4c) len = script[i++]
    else return null
    if (i + len > script.length) return null
    chunks.push(new TextDecoder().decode(script.slice(i, i + len)))
    i += len
  }
  return chunks
}

// A transaction never changes, so we remember what we learned about it
const txCache = new Map()
async function readTx(txid) {
  if (txCache.has(txid)) return txCache.get(txid)
  const hex = await provider.performRequest('blockchain.transaction.get', txid, false)
  const tx = decodeTransaction(hexToBin(hex))
  if (typeof tx === 'string') throw new Error('Could not decode transaction ' + txid)
  const info = {
    notes: [],
    outputs: tx.outputs.map(o => ({ lockingHex: binToHex(o.lockingBytecode) })),
    inputs: tx.inputs.map(i => ({ txid: binToHex(i.outpointTransactionHash), index: i.outpointIndex })),
  }
  for (const out of tx.outputs) {
    const note = parseNote(out.lockingBytecode)
    if (note) info.notes.push(note)
  }
  txCache.set(txid, info)
  return info
}

// Block time from the 80-byte block header (bytes 68 to 71, little endian)
const timeCache = new Map()
async function blockTime(height) {
  if (timeCache.has(height)) return timeCache.get(height)
  const reply = await provider.performRequest('blockchain.block.header', height)
  const hex = typeof reply === 'string' ? reply : reply?.header || reply?.hex
  if (typeof hex !== 'string' || hex.length < 160) throw new Error('Unexpected block header.')
  const b = hexToBin(hex.slice(0, 160))
  const seconds = (b[68] | (b[69] << 8) | (b[70] << 16) | (b[71] << 24)) >>> 0
  const ms = seconds * 1000
  timeCache.set(height, ms)
  return ms
}

// Did this transaction spend a coin that belongs to `address`? This proves who posted the note.
async function spendsFrom(info, address) {
  const wanted = lockingHexOf(address)
  for (const input of info.inputs) {
    for (const candidate of [input.txid, reverseHex(input.txid)]) {
      try {
        const prev = await readTx(candidate)
        const out = prev.outputs[input.index]
        if (out) {
          if (out.lockingHex === wanted) return true
          break
        }
      } catch (e) {
        // try the other byte order
      }
    }
  }
  return false
}

async function authorized(event, address) {
  try {
    return await spendsFrom(event.info, address)
  } catch (e) {
    return false
  }
}

const sumSats = list => list.reduce((s, c) => s + c.satoshis, 0n)

/**
 * Posts a circle change as a note. It must spend coins from the member's own address.
 * If that address is empty, it is topped up first (one extra approval in the wallet).
 */
export async function publishEvent(
  manager,
  coins,
  actorAddress,
  boardAddress,
  chunks,
  signal,
  onStatus = () => {},
) {
  const lower = actorAddress.toLowerCase()
  let mine = coins.filter(c => c.address.toLowerCase() === lower)

  if (sumSats(mine) < MIN_ACTOR_SATS) {
    onStatus('Step 1 of 2: preparing your member address. Approve this in your wallet.')
    await sendPayment(
      manager,
      coins,
      actorAddress,
      PREPARE_SATS,
      'Kameti: prepare your member address',
      signal,
      { maxSats: 20_000n },
    )

    let ready = false
    for (let i = 0; i < 12 && !ready; i++) {
      await new Promise(resolve => setTimeout(resolve, 1500))
      const scan = await scanWallet(manager, 20)
      mine = scan.coins.filter(c => c.address.toLowerCase() === lower)
      ready = sumSats(mine) >= MIN_ACTOR_SATS
    }
    if (!ready) {
      throw new Error(
        'Your member address was topped up, but the coin has not appeared yet. Wait a few seconds and try again.',
      )
    }
  }

  onStatus('Posting your change. Approve it in your wallet.')
  return sendPayment(manager, mine, boardAddress, EVENT_DUST, 'Kameti circle change', signal, {
    opReturn: chunks,
    maxSats: 1000n,
    changeTo: actorAddress,
  })
}

// Reads every change note posted for this circle (including ones not yet in a block)
export async function fetchEvents(circle, id) {
  const board = circle.members[0].address
  const history = await provider.performRequest(
    'blockchain.scripthash.get_history',
    await scripthashOf(board),
  )
  const events = []
  for (const entry of Array.isArray(history) ? history : []) {
    let info
    try {
      info = await readTx(entry.tx_hash)
    } catch (e) {
      continue
    }
    for (const note of info.notes) {
      if (note[0] !== TAG || note[1] !== id || !KINDS.includes(note[2])) continue
      events.push({ kind: note[2], args: note.slice(3), txid: entry.tx_hash, height: entry.height, info })
    }
  }
  return events
}

/**
 * Turns the base circle plus all change notes into the current circle.
 * baseOrder is the payout order from the draw (positions in circle.members).
 * Notes that are not in a block yet are applied too, after the confirmed ones, and marked tentative.
 */
export async function resolveEvents(circle, baseOrder, events) {
  const universe = circle.members.map(m => ({ name: m.name, address: m.address }))
  let order = [...baseOrder]
  let vacancies = 0
  const log = []
  const pending = new Map()
  const lock = lockTime(circle)
  const nameOf = idx => universe[idx]?.name || `Member ${idx + 1}`
  const addressPattern = new RegExp(`^${ADDRESS_PREFIX}:[a-z0-9]{30,}$`, 'i')

  const rank = e => (e.height > 0 ? e.height : Number.MAX_SAFE_INTEGER)
  const sorted = [...events].sort((x, y) => {
    const rx = rank(x)
    const ry = rank(y)
    if (rx !== ry) return rx < ry ? -1 : 1
    return x.txid < y.txid ? -1 : x.txid > y.txid ? 1 : 0
  })

  for (const e of sorted) {
    const tentative = !(e.height > 0)
    const entry = { kind: e.kind, txid: e.txid, status: 'ignored', text: '', tentative }
    log.push(entry)
    const stop = reason => {
      entry.status = 'ignored'
      entry.text = reason
    }

    let time
    if (tentative) {
      time = Date.now()
    } else {
      try {
        time = await blockTime(e.height)
      } catch (err) {
        entry.status = 'waiting'
        entry.text = 'Waiting for the block time.'
        continue
      }
    }

    if (e.kind === 'LEAVE') {
      const no = Number(e.args[0])
      const idx = no - 1
      if (!Number.isInteger(no) || idx < 0 || idx >= universe.length) {
        stop('Unknown member number.')
        continue
      }
      if (!order.includes(idx)) {
        stop(`${nameOf(idx)} is not an active member.`)
        continue
      }
      if (time >= lock) {
        stop('Too late: leaving is only possible before the second round starts.')
        continue
      }
      if (!(await authorized(e, universe[idx].address))) {
        stop('Not posted from that member wallet.')
        continue
      }
      order = order.filter(i => i !== idx)
      vacancies++
      // any waiting swap agreement of the member who left is no longer valid
      for (const [k, s] of [...pending]) {
        if (s.a === no || s.b === no) {
          s.entry.status = 'ignored'
          s.entry.text = 'Cancelled because a member left.'
          pending.delete(k)
        }
      }
      entry.status = 'applied'
      entry.text = `${nameOf(idx)} left. Their seat is open and everyone behind moves up.`
      continue
    }

    if (e.kind === 'JOIN') {
      const name = String(e.args[0] || '').trim()
      const address = String(e.args[1] || '').trim()
      entry.text = `${name || 'Someone'} asks to join`
      if (!name || name.length > 40 || !addressPattern.test(address)) {
        stop('Invalid name or address.')
        continue
      }
      if (universe.some(m => m.address.toLowerCase() === address.toLowerCase())) {
        stop('That address is already in this circle.')
        continue
      }
      if (time >= lock) {
        stop('Too late: joining is only possible before the second round starts.')
        continue
      }
      if (vacancies <= 0) {
        stop('No open seat.')
        continue
      }
      if (!(await authorized(e, address))) {
        stop('Not posted from that wallet.')
        continue
      }
      universe.push({ name, address })
      order.push(universe.length - 1)
      vacancies--
      entry.status = 'applied'
      entry.text = `${name} joined and takes the last position.`
      continue
    }

    if (e.kind === 'SWAP') {
      const a = Number(e.args[0])
      const b = Number(e.args[1])
      const ia = a - 1
      const ib = b - 1
      if (
        !Number.isInteger(a) || !Number.isInteger(b) || a === b ||
        ia < 0 || ib < 0 || ia >= universe.length || ib >= universe.length
      ) {
        stop('Invalid swap.')
        continue
      }
      entry.text = `${nameOf(ia)} agrees to swap seats with ${nameOf(ib)}`
      if (!order.includes(ia) || !order.includes(ib)) {
        stop('Both members must be active.')
        continue
      }
      if (!(await authorized(e, universe[ia].address))) {
        stop('Not posted from that member wallet.')
        continue
      }

      const key = `${a}>${b}`
      if (pending.has(key)) {
        stop('Duplicate: this agreement was already posted, so it is counted once.')
        continue
      }
      pending.set(key, { a, b, time, entry })

      const other = pending.get(`${b}>${a}`)
      if (!other) {
        entry.status = 'pending'
        entry.text += ' (waiting for the other member)'
        continue
      }

      const pa = order.indexOf(ia)
      const pb = order.indexOf(ib)
      const earliest = Math.min(Date.parse(roundStart(circle, pa)), Date.parse(roundStart(circle, pb)))
      pending.delete(key)
      pending.delete(`${b}>${a}`)
      if (Math.max(time, other.time) >= earliest) {
        stop('Too late: one of the two rounds had already started.')
        other.entry.status = 'ignored'
        other.entry.text = 'Too late: one of the two rounds had already started.'
        continue
      }
      ;[order[pa], order[pb]] = [order[pb], order[pa]]
      entry.status = 'applied'
      entry.text = `${nameOf(ia)} and ${nameOf(ib)} swapped seats.`
      other.entry.status = 'applied'
      other.entry.text = entry.text

      // other waiting agreements that involve either member are now out of date
      for (const [k, s] of [...pending]) {
        if (s.a === a || s.a === b || s.b === a || s.b === b) {
          s.entry.status = 'ignored'
          s.entry.text = 'Replaced by a completed swap.'
          pending.delete(k)
        }
      }
    }
  }

  return {
    universe,
    order,
    vacancies,
    log,
    lock,
    phase: Date.now() < lock ? 'open' : 'locked',
    hasTentative: log.some(item => item.tentative && item.status === 'applied'),
    pendingSwaps: [...pending.values()]
      .filter(s => order.includes(s.a - 1) && order.includes(s.b - 1))
      .map(s => ({ a: s.a, b: s.b })),
  }
}