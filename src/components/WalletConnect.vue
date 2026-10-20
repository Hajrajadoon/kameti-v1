<script setup>
import { ref, watch } from 'vue'
import { publicKeyToP2pkhCashAddress } from '@bitauth/libauth'
import {
  useWizardConnect,
  WizardConnectQRDialog,
} from '@paytaca/wizardconnect-vue'

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
  dappIcon: `${location.origin}/favicon.ico`,
})

const walletReady = ref(false)
const walletAddress = ref('')

let attachedTo = null

// Attach wallet listeners when the manager becomes available.
watch(
  manager,
  (m) => {
    if (!m || m === attachedTo) return

    attachedTo = m

    m.addListener('walletready', () => {
      walletReady.value = true

      try {
        const pubkey = m.getPubkey(0, 0n)

        if (pubkey) {
          const res = publicKeyToP2pkhCashAddress({
  publicKey: pubkey,
})

if (typeof res === 'string') {
  throw new Error(res)
}

walletAddress.value = res.address
console.log('Wallet address:', walletAddress.value)
          console.log(
            'Wallet address (index 0):',
            walletAddress.value,
          )
        } else {
          walletAddress.value = ''
          console.warn('No public key returned by the wallet.')
        }
      } catch (e) {
        walletAddress.value = ''
        console.error('Could not derive address:', e)
      }
    })

    m.addListener('disconnect', (reason, message) => {
      console.log('Disconnected', reason, message)
      walletReady.value = false
      walletAddress.value = ''
    })
  },
  { immediate: true },
)

// Debug connection state in the browser console (F12).
watch(
  state,
  (s) => console.log('WizardConnect state:', s),
  { immediate: true },
)

function handleDisconnect() {
  walletReady.value = false
  walletAddress.value = ''
  disconnect()
}
</script>

<template>
  <div class="wallet">
    <div v-if="walletReady">
      <p>
        ✅ Connected<span v-if="walletName">: {{ walletName }}</span>
      </p>

      <p
        v-if="walletAddress"
        style="word-break: break-all;"
      >
        Address: {{ walletAddress }}
      </p>

      <button @click="handleDisconnect">
        Disconnect
      </button>
    </div>

    <div v-else>
      <p v-if="state === 'reconnecting'">
        Reconnecting to your wallet... Keep the wallet app open.
      </p>

      <button
        v-else
        @click="connect()"
        :disabled="state === 'connected' || state === 'connecting'"
      >
        {{ state === 'connecting' ? 'Connecting...' : 'Connect Wallet' }}
      </button>

      <p v-if="state === 'connecting'">
        Waiting for wallet to connect...
      </p>

      <p v-if="error" style="color: red;">
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