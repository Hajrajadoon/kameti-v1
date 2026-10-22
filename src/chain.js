
import { ElectrumNetworkProvider } from 'cashscript'
import { publicKeyToP2pkhCashAddress } from '@bitauth/libauth'
import { NETWORK, ADDRESS_PREFIX } from './config.js'

export const provider = new ElectrumNetworkProvider(NETWORK, {
  hostname: 'electrum-chipnet.optnlabs.com',
})

const PATHS = [
  { childIndex: 0, name: 'receive' },
  { childIndex: 1, name: 'change' },
]

/**
 * Convert a wallet public-key result to the byte array expected by libauth.
 * Supports common byte-array and object-wrapped representations.
 */
function normalizePublicKey(value) {
  if (value instanceof Uint8Array) {
    return value
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    )
  }

  if (Array.isArray(value)) {
    return Uint8Array.from(value)
  }

  if (typeof value === 'string') {
    const hex = value.startsWith('0x') ? value.slice(2) : value

    if (/^(02|03)[0-9a-fA-F]{64}$/.test(hex)) {
      return Uint8Array.from(
        hex.match(/.{2}/g).map(byte => parseInt(byte, 16)),
      )
    }

    throw new Error('Wallet returned an invalid public-key string.')
  }

  if (value && typeof value === 'object') {
    for (const key of ['publicKey', 'pubkey', 'public_key', 'bytes']) {
      if (value[key] != null && value[key] !== value) {
        try {
          return normalizePublicKey(value[key])
        } catch {
          // Try another recognized public-key field.
        }
      }
    }
  }

  throw new Error(
    'Unsupported wallet public-key format. Inspect manager.getPubkey() in the console.',
  )
}

/**
 * Extract the actual CashAddress from libauth's result.
 * Never convert an arbitrary object to a string.
 */
function extractCashAddress(result) {
  if (typeof result === 'string') {
    return validateAddress(result)
  }

  if (result && typeof result === 'object') {
    if (result.error) {
      throw new Error(
        typeof result.error === 'string'
          ? result.error
          : 'Could not encode the wallet public key.',
      )
    }

    for (const key of ['address', 'cashAddress', 'cash_address']) {
      if (typeof result[key] === 'string') {
        return validateAddress(result[key])
      }
    }
  }

  throw new Error('Address encoder did not return a CashAddress string.')
}

/**
 * Validate the address before passing it to the network provider.
 */
export function validateAddress(address) {
  if (typeof address !== 'string') {
    throw new Error('Wallet address must be a string.')
  }

  const normalized = address.trim()

  if (
    !normalized ||
    normalized === '[object Object]' ||
    !normalized.includes(':')
  ) {
    throw new Error('Invalid CashAddress returned by the wallet.')
  }

  const [prefix, payload, ...extra] = normalized.split(':')

  if (
    extra.length ||
    prefix !== ADDRESS_PREFIX ||
    !payload ||
    !/^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/i.test(payload)
  ) {
    throw new Error(
      `Invalid address for ${NETWORK}. Expected prefix "${ADDRESS_PREFIX}:".`,
    )
  }

  return normalized
}

/**
 * Derive a P2PKH CashAddress from the wallet's public key.
 *
 * childIndex 0 = receive
 * childIndex 1 = change
 */
export function deriveAddress(manager, childIndex = 0, index = 0) {
  if (!manager || typeof manager.getPubkey !== 'function') {
    throw new Error('Wallet manager is not ready.')
  }

  const pubkeyResult = manager.getPubkey(childIndex, BigInt(index))

  if (pubkeyResult && typeof pubkeyResult.then === 'function') {
    throw new Error(
      'getPubkey() returned a Promise. This wallet API requires asynchronous address derivation.',
    )
  }

  if (pubkeyResult == null) {
    throw new Error(
      `Wallet did not return a public key for path ${childIndex}/${index}.`,
    )
  }

  const publicKey = normalizePublicKey(pubkeyResult)

  const result = publicKeyToP2pkhCashAddress({
    publicKey,
    prefix: ADDRESS_PREFIX,
  })

  return extractCashAddress(result)
}

/**
 * Convert satoshis to an exact, readable BCH amount.
 */
export function formatBch(sats) {
  return (Number(sats) / 100_000_000).toFixed(8)
}

/**
 * Scan the first `count` receive and change addresses.
 *
 * Important: This scans a finite range, not necessarily every address
 * ever used by the wallet.
 */
export async function scanWallet(manager, count = 20) {
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error('Scan count must be between 1 and 100.')
  }

  const jobs = []

  for (const path of PATHS) {
    for (let index = 0; index < count; index++) {
      const address = deriveAddress(
        manager,
        path.childIndex,
        index,
      )

      jobs.push({
        ...path,
        index,
        address,
      })
    }
  }

  // Query in small batches to avoid overwhelming the Electrum server.
  const coins = []
  const addressResults = []
  let totalSats = 0n
  const batchSize = 5

  for (let start = 0; start < jobs.length; start += batchSize) {
    const batch = jobs.slice(start, start + batchSize)

    const results = await Promise.all(
      batch.map(async job => ({
        ...job,
        utxos: await provider.getUtxos(job.address),
      })),
    )

    for (const result of results) {
      let addressSats = 0n

      for (const utxo of result.utxos) {
        // Do not count CashToken outputs as ordinary BCH coins.
        if (utxo.token) continue

        const satoshis = BigInt(utxo.satoshis)

        const coin = {
          address: result.address,
          path: result.name,
          index: result.index,
          txid: utxo.txid,
          vout: utxo.vout,
          satoshis,
        }

        coins.push(coin)
        addressSats += satoshis
        totalSats += satoshis
      }

      addressResults.push({
        address: result.address,
        path: result.name,
        index: result.index,
        satoshis: addressSats,
      })
    }
  }

  return {
    coins,
    addresses: addressResults,
    totalSats,
    scannedAddressCount: jobs.length,
    network: NETWORK,
  }
}
