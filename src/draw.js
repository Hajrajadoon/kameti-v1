import { provider } from './chain.js'

// The draw uses a block that is 2 blocks deep, so a small reorg cannot change the result
export const DRAW_CONFIRMATIONS = 2

const sha256 = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
const toHex = bytes => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
const fromHex = hex => Uint8Array.from(hex.match(/.{2}/g).map(h => parseInt(h, 16)))

export const getHeight = () => provider.getBlockHeight()

// The hash of a block = double SHA-256 of its 80-byte header, shown in reverse byte order
export async function getBlockHash(height) {
  const reply = await provider.performRequest('blockchain.block.header', height)
  const headerHex = typeof reply === 'string' ? reply : reply?.header || reply?.hex
  if (typeof headerHex !== 'string' || !/^[0-9a-f]{160}$/i.test(headerHex)) {
    throw new Error('The server returned an unexpected block header.')
  }
  const first = await sha256(fromHex(headerHex))
  const second = await sha256(first)
  return toHex(second.reverse())
}

/**
 * Deterministic shuffle of the positions 0..n-1. The same block hash and circle id
 * always give the same order, so every member (and anyone checking) sees the same result.
 * Roll 1 decides who receives first, roll 2 who receives second, and so on.
 */
export async function drawOrder(blockHash, id, n) {
  const order = Array.from({ length: n }, (_, i) => i)
  let counter = 0

  // Unbiased random number below `max`, taken from SHA-256 of blockHash, id and a counter
  async function below(max) {
    const limit = 0x100000000 - (0x100000000 % max)
    while (true) {
      const digest = await sha256(new TextEncoder().encode(`${blockHash}:${id}:${counter++}`))
      const value = new DataView(digest.buffer).getUint32(0)
      if (value < limit) return value % max
    }
  }

  for (let i = n - 1; i > 0; i--) {
    const j = await below(i + 1)
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return order
}