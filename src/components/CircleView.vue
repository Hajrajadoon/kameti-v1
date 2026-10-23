<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { wallet } from '../store.js'
import { deriveAddress, scanWallet, formatBch } from '../chain.js'
import { sendPayment } from '../payment.js'
import { circleId, getRounds } from '../circle.js'
import { trackPayments, isLate } from '../tracking.js'
import { NETWORK } from '../config.js'

const props = defineProps({
  circle: { type: Object, required: true },
})

// Safety cap per payment. Raise it deliberately before real use on mainnet.
const MAX_CIRCLE_SATS = 5_000_000n // 0.05 BCH

const payerIndex = ref(-1) // which member the connected wallet belongs to
const busyRound = ref(null)
const errorText = ref('')
const lastTx = ref('')
let controller = null

const paid = ref([]) // paid[roundIndex][payerNumber] = { txid, height }
const tracking = ref(false)
const trackError = ref('')
const lastTracked = ref('')

const rounds = computed(() => getRounds(props.circle))

const currentRoundIndex = computed(() => {
  const now = Date.now()
  let idx = 0
  rounds.value.forEach((r, i) => {
    if (new Date(r.dueDate).getTime() <= now) idx = i
  })
  return idx
})

const canPay = computed(() => wallet.ready && payerIndex.value >= 0 && busyRound.value === null)

// 'self' | 'paid' | 'late' | 'pending'
function cellStatus(roundIdx, memberIdx) {
  if (roundIdx === memberIdx) return 'self'
  if (paid.value[roundIdx]?.[memberIdx + 1]) return 'paid'
  return isLate(rounds.value[roundIdx].dueDate) ? 'late' : 'pending'
}

function paidCount(roundIdx) {
  return Object.keys(paid.value[roundIdx] || {}).length
}

const myPayments = computed(() =>
  payerIndex.value < 0
    ? []
    : rounds.value
        .map((r, i) => ({ ...r, idx: i, status: cellStatus(i, payerIndex.value) }))
        .filter(r => r.idx !== payerIndex.value),
)

async function refreshStatus() {
  tracking.value = true
  trackError.value = ''
  try {
    const id = await circleId(props.circle)
    paid.value = await trackPayments(props.circle, rounds.value, id)
    lastTracked.value = new Date().toLocaleTimeString()
  } catch (e) {
    console.error('Tracking failed:', e)
    trackError.value = 'Could not read payments: ' + (e?.message || String(e))
  } finally {
    tracking.value = false
  }
}

onMounted(refreshStatus)

function detectMe() {
  const m = wallet.manager
  if (!m) return
  const mine = new Set()
  for (let i = 0; i < 20; i++) {
    try {
      mine.add(deriveAddress(m, 0, i).toLowerCase())
    } catch (e) {
      // skip addresses that cannot be derived
    }
  }
  payerIndex.value = props.circle.members.findIndex(mem => mine.has(mem.address.toLowerCase()))
}

watch(
  () => wallet.ready,
  ready => {
    if (ready) detectMe()
    else payerIndex.value = -1
  },
  { immediate: true },
)

function cancel() {
  if (controller) controller.abort('Cancelled by user')
}

async function payRound(round) {
  errorText.value = ''
  lastTx.value = ''

  if (!wallet.manager) {
    errorText.value = 'Connect your wallet first.'
    return
  }
  if (payerIndex.value < 0) {
    errorText.value = 'Choose which member you are first.'
    return
  }

  busyRound.value = round.round
  controller = new AbortController()
  const timer = setTimeout(() => controller.abort('Timed out waiting for the wallet'), 120000)

  try {
    // Look up fresh coins right before paying, so we never spend stale ones
    const scan = await scanWallet(wallet.manager, 20)
    const id = await circleId(props.circle)

    const result = await sendPayment(
      wallet.manager,
      scan.coins,
      round.recipient.address,
      BigInt(round.amountSats),
      `Kameti ${props.circle.name}: round ${round.round}`,
      controller.signal,
      {
        opReturn: ['KAMETI', id, String(round.round), String(payerIndex.value + 1)],
        maxSats: MAX_CIRCLE_SATS,
      },
    )
    lastTx.value = result.txid || 'sent'
    setTimeout(refreshStatus, 4000)
  } catch (e) {
    console.error('Round payment failed:', e)
    errorText.value =
      e?.name === 'AbortError'
        ? 'Cancelled, or the wallet did not answer in time. Keep this tab in front and your wallet open, then try again.'
        : e?.message || String(e)
  } finally {
    clearTimeout(timer)
    busyRound.value = null
    controller = null
  }
}
</script>

<template>
  <section class="circle">
    <h2>{{ circle.name }}</h2>
    <p>
      {{ circle.members.length }} members, {{ circle.members.length }} rounds, one round every
      {{ circle.every }} {{ circle.unit }}. Each member pays
      <strong>{{ formatBch(circle.amountSats) }} BCH</strong> per round ({{ NETWORK }}).
      Every payment goes straight to that round's recipient. Nobody holds the pool.
      Dates are in UTC.
    </p>

    <div v-if="wallet.ready">
      <label>
        I am:
        <select v-model.number="payerIndex">
          <option :value="-1">Choose your name...</option>
          <option v-for="(m, i) in circle.members" :key="i" :value="i">{{ m.name }}</option>
        </select>
      </label>
      <p v-if="payerIndex < 0" style="color: #b45309">
        The connected wallet's address is not in this circle's member list. Pick who you are.
      </p>
    </div>
    <p v-else><small>Connect your wallet above to pay.</small></p>

    <div v-if="payerIndex >= 0" class="owe">
      <h3>You owe</h3>
      <ul>
        <li v-for="r in myPayments" :key="r.round">
          Round {{ r.round }}: pay <strong>{{ r.recipient.name }}</strong>
          {{ formatBch(r.amountSats) }} BCH by {{ r.dueDate.slice(0, 10) }}
          <span v-if="r.status === 'paid'"> ✅ paid</span>
          <span v-else-if="r.status === 'late'" style="color: #dc2626"> ⚠ late</span>
        </li>
      </ul>
    </div>

    <h3>Rounds</h3>
    <div style="overflow-x: auto">
      <table border="1" cellpadding="6">
        <thead>
          <tr>
            <th>Round</th>
            <th>Receives</th>
            <th>Pay by</th>
            <th>Paid so far</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in rounds" :key="r.round">
            <td>{{ r.round }}<small v-if="i === currentRoundIndex"> (current)</small></td>
            <td>{{ r.recipient.name }}</td>
            <td>{{ r.dueDate.slice(0, 10) }}</td>
            <td>
              {{ paidCount(i) }} of {{ circle.members.length - 1 }}
              ({{ formatBch(paidCount(i) * r.amountSats) }} BCH)
            </td>
            <td>
              <span v-if="payerIndex === i">You receive this round</span>
              <span v-else-if="payerIndex >= 0 && cellStatus(i, payerIndex) === 'paid'">✅ You paid</span>
              <button v-else :disabled="!canPay" @click="payRound(r)">
                {{ busyRound === r.round ? 'Waiting for wallet...' : 'Pay now' }}
              </button>
              <button v-if="busyRound === r.round" @click="cancel">Cancel</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <h3>Who has paid</h3>
    <p>
      <button :disabled="tracking" @click="refreshStatus">
        {{ tracking ? 'Reading the blockchain...' : 'Refresh payment status' }}
      </button>
      <small v-if="lastTracked"> Last checked: {{ lastTracked }}</small>
    </p>
    <p v-if="trackError" role="alert" style="color: #dc2626">{{ trackError }}</p>

    <div style="overflow-x: auto">
      <table border="1" cellpadding="6">
        <thead>
          <tr>
            <th>Round (receiver)</th>
            <th v-for="(m, j) in circle.members" :key="j">{{ m.name }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in rounds" :key="r.round">
            <td>{{ r.round }} ({{ r.recipient.name }})</td>
            <td v-for="(m, j) in circle.members" :key="j" style="text-align: center">
              <span v-if="cellStatus(i, j) === 'self'" title="Receiver">—</span>
              <span v-else-if="cellStatus(i, j) === 'paid'" :title="paid[i][j + 1].txid">✅</span>
              <span v-else-if="cellStatus(i, j) === 'late'" style="color: #dc2626">⚠ Late</span>
              <span v-else>⏳</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p>
      <small>
        ✅ paid, ⏳ not yet due, ⚠ late, — receives this round. A payment counts when the
        blockchain shows it reached the receiver with this circle's note and at least the agreed amount.
      </small>
    </p>

    <p v-if="errorText" role="alert" style="color: #dc2626">{{ errorText }}</p>
    <p v-if="lastTx" style="overflow-wrap: anywhere">
      ✅ Payment sent. Transaction: <code>{{ lastTx }}</code>
    </p>
  </section>
</template>