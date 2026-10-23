<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import {
  useWizardConnect,
  WizardConnectQRDialog,
} from '@paytaca/wizardconnect-vue'

import { NETWORK } from '../config.js'
import { deriveAddress, scanWallet, formatBch } from '../chain.js'
import { wallet } from '../store.js'
import TestPayment from './TestPayment.vue'

const {
  state,
  manager,
  uri,
  qrUri,
  walletName,
  connect,
  disconnect,
  error,
} = useWizardConnect({
  dappName: 'Kameti.cash',
  dappIcon: `${window.location.origin}/favicon.ico`,
})

const walletReady = ref(false)
const walletAddress = ref('')
const scanning = ref(false)
const scanError = ref('')
const addressError = ref('')
const totalSats = ref(null)
const coins = ref([])
const scannedAddressCount = ref(0)
const lastChecked = ref('')

let attachedTo = null
let walletReadyHandler = null
let disconnectHandler = null

function resetBalance() {
  totalSats.value = null
  coins.value = []
  scannedAddressCount.value = 0
  lastChecked.value = ''
  scanError.value = ''
}

function resetWallet() {
  walletReady.value = false
  walletAddress.value = ''
  addressError.value = ''
  wallet.manager = null
  wallet.ready = false
  resetBalance()
}

function refreshAddress(m) {
  try {
    const address = deriveAddress(m, 0, 0)

    if (typeof address !== 'string') {
      throw new Error('Wallet address is not a string.')
    }

    walletAddress.value = address
    addressError.value = ''
    walletReady.value = true
    wallet.manager = m
    wallet.ready = true
  } catch (e) {
    console.error('Could not derive wallet address:', e)
    walletAddress.value = ''
    addressError.value = e?.message || 'Could not read wallet address.'
    walletReady.value = false
    wallet.manager = null
    wallet.ready = false
  }
}

function attachWallet(m) {
  if (!m || m === attachedTo) return

  if (attachedTo) {
    if (walletReadyHandler) {
      attachedTo.removeListener?.('walletready', walletReadyHandler)
    }
    if (disconnectHandler) {
      attachedTo.removeListener?.('disconnect', disconnectHandler)
    }
  }

  attachedTo = m

  walletReadyHandler = () => {
    refreshAddress(m)
  }

  disconnectHandler = () => {
    resetWallet()
  }

  m.addListener('walletready', walletReadyHandler)
  m.addListener('disconnect', disconnectHandler)

  if (state.value === 'connected' || walletReady.value) {
    refreshAddress(m)
  }
}

watch(manager, attachWallet, { immediate: true })

watch(
  state,
  currentState => {
    console.log('WizardConnect state:', currentState)

    if (currentState === 'connected' && manager.value) {
      refreshAddress(manager.value)
    }

    if (currentState === 'disconnected' || currentState === 'disconnected_by_user') {
      resetWallet()
    }
  },
  { immediate: true },
)

async function checkBalance() {
  const m = manager.value

  if (!m) {
    scanError.value = 'Connect your wallet first.'
    return
  }

  scanning.value = true
  scanError.value = ''

  try {
    refreshAddress(m)

    if (!walletAddress.value) {
      throw new Error(addressError.value || 'Could not obtain a valid wallet address.')
    }

    const result = await scanWallet(m, 20)

    if (manager.value !== m) return

    totalSats.value = result.totalSats
    coins.value = result.coins
    scannedAddressCount.value = result.scannedAddressCount
    lastChecked.value = new Date().toLocaleTimeString()
  } catch (e) {
    console.error('Balance lookup failed:', e)
    scanError.value = 'Could not check balance: ' + (e?.message || String(e))
  } finally {
    scanning.value = false
  }
}

function handleDisconnect() {
  resetWallet()
  disconnect()
}

onBeforeUnmount(() => {
  if (attachedTo) {
    if (walletReadyHandler) {
      attachedTo.removeListener?.('walletready', walletReadyHandler)
    }
    if (disconnectHandler) {
      attachedTo.removeListener?.('disconnect', disconnectHandler)
    }
  }
})
</script>

<template>
  <div class="wallet">
    <p>
      Network:
      <strong>{{ NETWORK }}</strong>
    </p>

    <div v-if="walletReady">
      <p>
        ✅ Connected
        <strong v-if="walletName">: {{ walletName }}</strong>
      </p>

      <p v-if="walletAddress" style="overflow-wrap: anywhere">
        Receive address #0:
        <code>{{ walletAddress }}</code>
      </p>

      <p v-if="addressError" style="color: #dc2626">
        {{ addressError }}
      </p>

      <button @click="checkBalance" :disabled="scanning || !walletAddress">
        {{ scanning ? 'Checking balance...' : 'Refresh balance' }}
      </button>

      <p v-if="scanError" role="alert" style="color: #dc2626">
        {{ scanError }}
      </p>

      <section v-if="totalSats !== null" class="balance" aria-live="polite">
        <h3>Wallet balance</h3>

        <p>
          <strong style="font-size: 1.5rem">{{ formatBch(totalSats) }} BCH</strong>
        </p>

        <p>Unspent ordinary BCH outputs: {{ coins.length }}</p>
        <p>Addresses scanned: {{ scannedAddressCount }}</p>

        <p v-if="lastChecked">Last checked: {{ lastChecked }}</p>

        <p>
          <small>
            Balance covers the scanned receive/change addresses only.
            It may not include funds on addresses outside the scan range
            or CashToken outputs.
          </small>
        </p>

        <details v-if="coins.length">
          <summary>View unspent outputs</summary>

          <ul>
            <li
              v-for="coin in coins"
              :key="coin.txid + ':' + coin.vout"
              style="overflow-wrap: anywhere; margin-bottom: 12px"
            >
              <div>{{ coin.path }} address #{{ coin.index }}</div>
              <div>{{ formatBch(coin.satoshis) }} BCH</div>
              <small>{{ coin.txid }}:{{ coin.vout }}</small>
            </li>
          </ul>
        </details>

        <p v-else>No ordinary BCH outputs were found in the scanned addresses.</p>
      </section>

      <TestPayment
        v-if="totalSats !== null && coins.length"
        :manager="manager"
        :coins="coins"
        @sent="checkBalance"
      />

      <p>
        <small>
          If your wallet does not respond to a request, check that your phone's
          date and time are set to automatic.
        </small>
      </p>

      <button @click="handleDisconnect">Disconnect</button>
    </div>

    <div v-else>
      <p v-if="state === 'reconnecting'">
        Reconnecting to your wallet... Keep the wallet app open.
      </p>

      <button v-else @click="connect()" :disabled="state === 'connecting'">
        {{ state === 'connecting' ? 'Connecting...' : 'Connect Wallet' }}
      </button>

      <p v-if="state === 'connecting'">Waiting for your wallet to connect...</p>

      <p v-if="error" role="alert" style="color: #dc2626">
        {{ error }}
      </p>
    </div>

    <WizardConnectQRDialog
      :show="state === 'connecting'"
      :uri="uri ?? ''"
      :qrUri="qrUri ?? ''"
      :onClose="handleDisconnect"
    />
  </div>
</template>