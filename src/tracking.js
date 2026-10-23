import {
  cashAddressToLockingBytecode,
  binToHex,
  hexToBin,
  decodeTransaction,
} from '@bitauth/libauth'
import { provider } from './chain.js'

const NOTE_TAG = 'KAMETI'
const DAY_MS = 86_400_000

// A round is late once its whole due day (UTC) has passed
export const isLate = dueDateIso => Date.now() > Date.parse(dueDateIso) + DAY_MS

function lockingBytecodeOf(address) {
  const r = cashAddressToLockingBytecode(address)
  if (typeof r === 'string') throw new Error('Bad address: ' + r)
  return r.bytecode
}

// Electrum servers index addresses by "scripthash"
async function scripthashOf(address) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', lockingBytecodeOf(address)))
  return binToHex(digest.reverse())
}

// Reads the text chunks of an OP_RETURN output, or returns null if it isn't one
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

// A transaction never changes, so we can remember what we learned about it
const txCache = new Map()

async function readTx(txid) {
  if (txCache.has(txid)) return txCache.get(txid)
  const hex = await provider.performRequest('blockchain.transaction.get', txid, false)
  const tx = decodeTransaction(hexToBin(hex))
  if (typeof tx === 'string') throw new Error('Could not decode transaction ' + txid)
  const info = { notes: [], outputs: [] }
  for (const out of tx.outputs) {
    const note = parseNote(out.lockingBytecode)
    if (note) info.notes.push(note)
    info.outputs.push({ lockingHex: binToHex(out.lockingBytecode), sats: out.valueSatoshis })
  }
  txCache.set(txid, info)
  return info
}

async function getHistory(address) {
  const scripthash = await scripthashOf(address)
  const list = await provider.performRequest('blockchain.scripthash.get_history', scripthash)
  return Array.isArray(list) ? list : []
}

/**
 * Returns one entry per round: { [payerNumber]: { txid, height } }
 * payerNumber is the member's position in the list (1 = first member).
 */
export async function trackPayments(circle, rounds, id) {
  const n = circle.members.length
  const result = []

  for (let r = 0; r < rounds.length; r++) {
    const round = rounds[r]
    const paid = {}
    const recipientHex = binToHex(lockingBytecodeOf(round.recipient.address))
    const history = await getHistory(round.recipient.address)

    for (const entry of history) {
      let info
      try {
        info = await readTx(entry.tx_hash)
      } catch (e) {
        console.log('Skipping transaction', entry.tx_hash, e?.message || e)
        continue
      }
      for (const note of info.notes) {
        if (note[0] !== NOTE_TAG || note[1] !== id || Number(note[2]) !== round.round) continue
        const payer = Number(note[3])
        if (!Number.isInteger(payer) || payer < 1 || payer > n || payer - 1 === r) continue

        let received = 0n
        for (const o of info.outputs) if (o.lockingHex === recipientHex) received += o.sats

        if (received >= BigInt(round.amountSats) && !paid[payer]) {
          paid[payer] = { txid: entry.tx_hash, height: entry.height }
        }
      }
    }
    result.push(paid)
  }
  return result
}