<script setup>
import { ref, watch } from 'vue'
import { useWizardConnect, WizardConnectQRDialog } from '@paytaca/wizardconnect-vue'

const { state, manager, uri, qrUri, walletName, connect, disconnect, error } = useWizardConnect({
  dappName: 'Kameti.cash',
  dappIcon: `${location.origin}/favicon.ico`,
})

const walletReady = ref(false)

watch([state, manager], ([newState, newManager], [oldState]) => {
  if (newManager && oldState === 'idle') {
    newManager.addListener('walletready', () => {
      walletReady.value = true
    })
    newManager.addListener('disconnect', (reason, message) => {
      console.log('Disconnected', reason, message)
      walletReady.value = false
    })
  }
})
</script>

<template>
  <div class="wallet">
    <div v-if="!walletReady">
      <button
        @click="connect()"
        :disabled="state === 'connected' || state === 'reconnecting'"
      >
        {{ state === 'connecting' ? 'Connecting...' : 'Connect Wallet' }}
      </button>
      <p v-if="state === 'connecting'">Waiting for wallet to connect...</p>
      <p v-if="error" style="color: red">{{ error }}</p>
    </div>

    <div v-else>
      <p>✅ Connected<span v-if="walletName">: {{ walletName }}</span></p>
      <button @click="disconnect">Disconnect</button>
    </div>

    <WizardConnectQRDialog
      :show="state === 'connecting'"
      :uri="uri ?? ''"
      :qrUri="qrUri ?? ''"
      :onClose="disconnect"
    />
  </div>
</template>