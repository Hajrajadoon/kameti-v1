import { TransactionBuilder, placeholderP2PKHUnlocker } from 'cashscript'
import {
  stringify,
  encodeTransaction,
  binToHex,
  hexToBin,
  hashTransaction,
  cashAddressToLockingBytecode,
} from '@bitauth/libauth'
import { provider, deriveAddress, validateAddress } from './chain.js'

const DUST = 546n // smallest output the network accepts
const MAX_TEST_SATS = 100_000n // 0.001 BCH safety cap for the test form
const FEE_PER_BYTE = 1.2 // slightly above the 1 sat/byte minimum

function estimateFee(inputCount, outputCount) {
  const size = 10 + inputCount * 150 + outputCount * 40
  return BigInt(Math.ceil(size * FEE_PER_BYTE))
}

// Pick the biggest coins first so the transaction stays small
function selectCoins(coins, amountSats) {
  const sorted = [...coins].sort((a, b) => (a.satoshis > b.satoshis ? -1 : 1))
  const chosen = []
  let total = 0n
  for (const coin of sorted) {
    chosen.push(coin)
    total += coin.satoshis
    const fee = estimateFee(chosen.length, 2)
    if (total >= amountSats + fee) return { chosen, total, fee }
  }
  throw new Error('Not enough BCH to cover the amount plus the network fee.')
}

// Which "change" address index to use for the money that comes back to you
function pickChangeIndex(manager) {
  try {
    if (typeof manager.getIndexToUse === 'function') {
      return Number(manager.getIndexToUse(1))
    }
    if (typeof manager.pubkeyState?.getIndexToUse === 'function') {
      return Number(manager.pubkeyState.getIndexToUse(1))
    }
  } catch (e) {
    console.log('Could not get change index, using 0:', e)
  }
  return 0 // simple fallback: first change address
}

// The locking script (hex) that proves which address owns a coin
function lockingBytecodeHex(address) {
  const result = cashAddressToLockingBytecode(address)
  if (typeof result === 'string') {
    throw new Error('Could not read address ' + address + ': ' + result)
  }
  return binToHex(result.bytecode)
}

// Debug helper: prints every WizardConnect message to the console while we sign
function watchMessages(manager) {
  const onSent = msg => console.log('WC sent:', msg?.action, msg?.sequence ?? '')
  const onReceived = msg =>
    console.log('WC received:', msg?.action, msg?.sequence ?? '', msg?.error ?? '')
  try {
    manager.on('messagesent', onSent)
    manager.on('messagereceived', onReceived)
  } catch (e) {
    console.log('Could not attach message logging:', e)
  }
  return () => {
    try {
      const off = manager.off || manager.removeListener
      off?.call(manager, 'messagesent', onSent)
      off?.call(manager, 'messagereceived', onReceived)
    } catch (e) {
      // nothing to clean up
    }
  }
}

export async function sendPayment(
  manager,
  coins,
  toAddress,
  amountSats,
  prompt = 'Kameti payment',
  signal,
) {
  const to = validateAddress(toAddress)

  if (amountSats < DUST) throw new Error('Amount is below the minimum of 546 satoshis.')
  if (amountSats > MAX_TEST_SATS) throw new Error('The test form is limited to 0.001 BCH.')

  const { chosen, total, fee } = selectCoins(coins, amountSats)

  // Change goes back to a change address of the same wallet
  const changeIndex = pickChangeIndex(manager)
  const changeAddress = deriveAddress(manager, 1, changeIndex)
  const change = total - amountSats - fee

  const builder = new TransactionBuilder({ provider })
  for (const coin of chosen) {
    builder.addInput(
      {
        txid: coin.txid,
        vout: coin.vout,
        satoshis: coin.satoshis,
        lockingBytecode: lockingBytecodeHex(coin.address),
      },
      placeholderP2PKHUnlocker(coin.address),
    )
  }
  builder.addOutput({ to, amount: amountSats })
  if (change >= DUST) builder.addOutput({ to: changeAddress, amount: change })

  const wc = await builder.generateWcTransactionObject({ broadcast: true, userPrompt: prompt })

  // [inputIndex, 'receive' | 'change', addressIndex] for every input the wallet must sign
  const inputPaths = chosen.map((coin, i) => [i, coin.path, coin.index])

  console.log('Manager methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(manager)))
  console.log('Input paths:', JSON.stringify(inputPaths))
  if (typeof manager.signTransaction !== 'function') {
    throw new Error(
      'This version of the WizardConnect library has no signTransaction. Update it and try again.',
    )
  }

  let response
  const stopWatching = watchMessages(manager)
  try {
    response = await manager.signTransaction(
      {
        transaction: {
          transaction: binToHex(encodeTransaction(wc.transaction)),
          sourceOutputs: JSON.parse(stringify(wc.sourceOutputs)),
          broadcast: true,
          userPrompt: prompt,
        },
        inputPaths,
      },
      { signal },
    )
  } finally {
    stopWatching()
  }

  const signedHex = response?.signedTransaction
  if (!signedHex) throw new Error(response?.error || 'The wallet did not return a signed transaction.')

  // The wallet should broadcast it. Sending it again is harmless, so we do it as a safety net.
  try {
    await provider.sendRawTransaction(signedHex)
  } catch (e) {
    console.log('Extra broadcast skipped (probably already sent):', e?.message || e)
  }

  let txid = ''
  try {
    txid = hashTransaction(hexToBin(signedHex))
  } catch (e) {
    console.log('Could not compute txid:', e)
  }
  return { txid, signedHex, feeSats: fee }
}