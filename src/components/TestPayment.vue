<script setup>
import { ref } from 'vue'
import { sendPayment } from '../payment.js'
import { bchToSats } from '../circle.js'
import { ADDRESS_PREFIX } from '../config.js'

const props = defineProps({
  manager: { type: Object, default: null },
  coins: { type: Array, default: () => [] },
})
const emit = defineEmits(['sent'])

const toAddress = ref('')
const amountBch = ref('0.0001')
const busy = ref(false)
const errorText = ref('')
const txid = ref('')

let controller = null

function cancel() {
  if (controller) controller.abort('Cancelled by user')
}

async function pay() {
  errorText.value = ''
  txid.value = ''
  busy.value = true
  controller = new AbortController()
  // Give up after 2 minutes so the page never hangs forever
  const timer = setTimeout(() => controller.abort('Timed out waiting for the wallet'), 120000)
  try {
    const sats = BigInt(bchToSats(amountBch.value))
    const result = await sendPayment(
      props.manager,
      props.coins,
      toAddress.value,
      sats,
      'Kameti test payment',
      controller.signal,
    )
    txid.value = result.txid || 'sent'
    setTimeout(() => emit('sent'), 3000)
  } catch (e) {
    console.error('Payment failed:', e)
    errorText.value =
      e?.name === 'AbortError'
        ? 'Cancelled, or the wallet did not answer in time. Keep this tab in front and Paytaca open, then try again.'
        : e?.message || String(e)
  } finally {
    clearTimeout(timer)
    busy.value = false
    controller = null
  }
}
</script>

<template>
  <section class="test-payment">
    <h3>Test payment</h3>
    <p><small>Sends a small payment from your connected wallet. Your wallet will ask you to approve it.</small></p>
    <label>
      Recipient address ({{ ADDRESS_PREFIX }}:...)
      <input v-model="toAddress" :placeholder="ADDRESS_PREFIX + ':q...'" style="width: 100%" />
    </label>
    <label>
      Amount (BCH)
      <input v-model="amountBch" />
    </label>
    <button @click="pay" :disabled="busy || !toAddress">
      {{ busy ? 'Waiting for wallet approval...' : 'Send test payment' }}
    </button>
    <button v-if="busy" @click="cancel">Cancel</button>
    <p v-if="errorText" role="alert" style="color: #dc2626">{{ errorText }}</p>
    <p v-if="txid" style="overflow-wrap: anywhere">✅ Sent. Transaction: <code>{{ txid }}</code></p>
  </section>
</template>