<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { wallet } from '../store.js'
import { deriveAddress, scanWallet, formatBch } from '../chain.js'
import { sendPayment } from '../payment.js'
import { circleId, getRounds, DEFAULT_WINDOW_DAYS } from '../circle.js'
import { trackPayments, isLate } from '../tracking.js'
import { getHeight, getBlockHash, drawOrder, DRAW_CONFIRMATIONS } from '../draw.js'
import { fetchEvents, resolveEvents } from '../events.js'
import { NETWORK } from '../config.js'
import EventsPanel from './EventsPanel.vue'

const props = defineProps({
  circle: { type: Object, required: true },
})
defineEmits(['demo-copy'])

// Safety cap per payment. Raise it deliberately before real use on mainnet.
const MAX_CIRCLE_SATS = 5_000_000n // 0.05 BCH

const meIdx = ref(-1) // position of the connected wallet in the member list, -1 = unknown
const busyRound = ref(null)
const errorText = ref('')
const lastTx = ref('')
let controller = null

const paid = ref([]) // paid[roundIndex][memberNumber] = { txid, height }
const tracking = ref(false)
const trackError = ref('')
const lastTracked = ref('')
const circleIdText = ref('')

// circle changes (join, leave, swap) read from the blockchain
const ev = ref(null)
const evLoading = ref(false)
const evError = ref('')
let evTimer = null

const windowDays = computed(() => props.circle.payWindow || DEFAULT_WINDOW_DAYS)

// ----- dice draw -----
const hasDraw = computed(
  () => Number.isInteger(props.circle.drawHeight) && props.circle.drawHeight > 0,
)
const hasPriority = computed(
  () =>
    Number.isInteger(props.circle.first) &&
    props.circle.first >= 0 &&
    props.circle.first < props.circle.members.length,
)
const drawStatus = ref(hasDraw.value ? 'loading' : 'none') // none | loading | pending | ready | error
const drawError = ref('')
const currentHeight = ref(0)
const blockHash = ref('')
const seq = ref(null)
let drawTimer = null

const orderReady = computed(() => !hasDraw.value || drawStatus.value === 'ready')
const remainingBlocks = computed(() =>
  Math.max(0, props.circle.drawHeight + DRAW_CONFIRMATIONS - currentHeight.value),
)

// ----- the circle as it is now (after joins, leaves and swaps) -----
const baseOrder = computed(() => seq.value || props.circle.members.map((_, i) => i))
const effCircle = computed(() =>
  ev.value ? { ...props.circle, members: ev.value.universe } : props.circle,
)
const effOrder = computed(() => (ev.value ? ev.value.order : baseOrder.value))
const rounds = computed(() => getRounds(effCircle.value, effOrder.value))

async function loadDraw() {
  if (!hasDraw.value) return
  try {
    drawError.value = ''
    const height = await getHeight()
    currentHeight.value = height
    if (height < props.circle.drawHeight + DRAW_CONFIRMATIONS) {
      drawStatus.value = 'pending'
      return
    }
    const hash = await getBlockHash(props.circle.drawHeight)
    const id = await circleId(props.circle)
    seq.value = await drawOrder(
      hash,
      id,
      props.circle.members.length,
      hasPriority.value ? props.circle.first : -1,
    )
    blockHash.value = hash
    drawStatus.value = 'ready'
    if (drawTimer) {
      clearInterval(drawTimer)
      drawTimer = null
    }
    detectMe()
    refreshAll()
  } catch (e) {
    console.error('Draw failed:', e)
    drawStatus.value = 'error'
    drawError.value = e?.message || String(e)
  }
}

async function loadEvents() {
  if (!orderReady.value) return
  evLoading.value = true
  evError.value = ''
  try {
    const id = await circleId(props.circle)
    const list = await fetchEvents(props.circle, id)
    ev.value = await resolveEvents(props.circle, baseOrder.value, list)
    detectMe()
  } catch (e) {
    console.error('Reading circle changes failed:', e)
    evError.value = 'Could not read circle changes: ' + (e?.message || String(e))
  } finally {
    evLoading.value = false
  }
}

async function refreshAll() {
  await loadEvents()
  await refreshStatus()
}

// While some change is not in a block yet, look again every 30 seconds
watch(
  () => Boolean(ev.value?.log?.some(item => item.tentative || item.status === 'waiting')),
  waiting => {
    if (waiting && !evTimer) {
      evTimer = setInterval(() => {
        if (!evLoading.value) refreshAll()
      }, 30000)
    } else if (!waiting && evTimer) {
      clearInterval(evTimer)
      evTimer = null
    }
  },
)

const currentRoundIndex = computed(() => {
  const now = Date.now()
  let idx = 0
  rounds.value.forEach((r, i) => {
    if (new Date(r.periodStart).getTime() <= now) idx = i
  })
  return idx
})

const isActive = computed(() => meIdx.value >= 0 && effOrder.value.includes(meIdx.value))

const canPay = computed(
  () =>
    wallet.ready &&
    meIdx.value >= 0 &&
    isActive.value &&
    busyRound.value === null &&
    orderReady.value,
)

// 'self' | 'paid' | 'late' | 'pending' for a member number in a round
function statusFor(roundIdx, memberNo) {
  const round = rounds.value[roundIdx]
  if (round.recipientNo === memberNo) return 'self'
  if (paid.value[roundIdx]?.[memberNo]) return 'paid'
  return isLate(round.dueDate) ? 'late' : 'pending'
}

// Columns of the status grid follow the payout order
const cellStatus = (roundIdx, colIdx) => statusFor(roundIdx, rounds.value[colIdx].recipientNo)

function paidCount(roundIdx) {
  return Object.keys(paid.value[roundIdx] || {}).length
}

const myPayments = computed(() => {
  if (meIdx.value < 0 || !orderReady.value || !isActive.value) return []
  const no = meIdx.value + 1
  return rounds.value
    .map((r, i) => ({ ...r, idx: i, status: statusFor(i, no) }))
    .filter(r => r.status !== 'self')
})

// Has the connected member already paid someone, or received money? (they cannot leave then)
const myMoneyMoved = computed(() => {
  if (meIdx.value < 0) return false
  const no = meIdx.value + 1
  return rounds.value.some((r, i) => {
    const p = paid.value[i] || {}
    return Boolean(p[no]) || (r.recipientNo === no && Object.keys(p).length > 0)
  })
})

async function refreshStatus() {
  if (!orderReady.value) return
  tracking.value = true
  trackError.value = ''
  try {
    const id = await circleId(props.circle)
    paid.value = await trackPayments(effCircle.value, rounds.value, id)
    lastTracked.value = new Date().toLocaleTimeString()
  } catch (e) {
    console.error('Tracking failed:', e)
    trackError.value = 'Could not read payments: ' + (e?.message || String(e))
  } finally {
    tracking.value = false
  }
}

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
  meIdx.value = effCircle.value.members.findIndex(mem => mine.has(mem.address.toLowerCase()))
}

watch(
  () => wallet.ready,
  ready => {
    if (ready) detectMe()
    else meIdx.value = -1
  },
  { immediate: true },
)

onMounted(async () => {
  circleIdText.value = await circleId(props.circle)
  if (hasDraw.value) {
    await loadDraw()
    if (drawStatus.value !== 'ready') {
      drawTimer = setInterval(() => {
        if (drawStatus.value !== 'ready') loadDraw()
      }, 60000)
    }
  } else {
    refreshAll()
  }
})

onBeforeUnmount(() => {
  if (drawTimer) clearInterval(drawTimer)
  if (evTimer) clearInterval(evTimer)
})

function cancel() {
  if (controller) controller.abort('Cancelled by user')
}

async function payRound(round) {
  errorText.value = ''
  lastTx.value = ''

  if (!orderReady.value) {
    errorText.value = 'The order has not been drawn yet.'
    return
  }
  if (!wallet.manager) {
    errorText.value = 'Connect your wallet first.'
    return
  }
  if (meIdx.value < 0 || !isActive.value) {
    errorText.value = 'Choose which active member you are first.'
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
        opReturn: ['KAMETI', id, String(round.round), String(meIdx.value + 1)],
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
      {{ rounds.length }} members, {{ rounds.length }} rounds, one round every
      {{ circle.every }} {{ circle.unit }}. Each member pays
      <strong>{{ formatBch(circle.amountSats) }} BCH</strong> per round ({{ NETWORK }}).
      Everyone pays inside the first <strong>{{ windowDays }} days</strong> of each round, so the
      receiver gets the whole amount at once. Every payment goes straight to the receiver.
      Nobody holds the pool. Dates are in UTC.
    </p>

    <p>
      <small>
        Order mode:
        <strong v-if="circle.demo">instant demo draw</strong>
        <strong v-else-if="hasDraw">blockchain draw at block {{ circle.drawHeight }}</strong>
        <strong v-else>set by hand</strong>
        <span v-if="hasPriority">
          , priority seat (first turn): <strong>{{ circle.members[circle.first].name }}</strong>
        </span>
      </small>
    </p>

    <details class="verify" open>
      <summary><strong>Check before you pay</strong> (circle id {{ circleIdText }})</summary>
      <p>
        <small>
          Every member must see the <strong>same circle id</strong> and the same addresses below.
          If your id differs from the group's, do not pay. Someone may have changed the link.
          These are the members when the circle was created. Later changes are listed further down.
        </small>
      </p>
      <ol>
        <li v-for="(m, i) in circle.members" :key="i" style="overflow-wrap: anywhere">
          {{ m.name }}: <code>{{ m.address }}</code>
        </li>
      </ol>
    </details>

    <div v-if="hasDraw" class="draw">
      <h3>Order decided by the blockchain</h3>

      <p v-if="circle.demo" style="color: #b45309">
        <strong>Demo circle:</strong> the draw used a block that already existed, so an organizer
        could choose the moment to get a favourable order. Use the normal draw for real circles.
      </p>

      <p v-if="hasPriority">
        <strong>{{ circle.members[circle.first].name }}</strong> holds the priority seat and
        receives in round 1. The group agreed this before the draw. The draw decides everyone else.
        The first receiver carries the most trust, so only agree to it if you know and trust them.
      </p>

      <p v-if="drawStatus === 'loading'">Reading the blockchain...</p>

      <div v-else-if="drawStatus === 'pending'">
        <p>
          The payout order is decided by block <strong>{{ circle.drawHeight }}</strong>
          of the {{ NETWORK }} blockchain. Nobody can predict or control it.
          Current block: {{ currentHeight }}. The draw runs in about
          <strong>{{ remainingBlocks }}</strong> more blocks
          (roughly {{ remainingBlocks * 10 }} minutes).
        </p>
        <p>
          <strong>All members must open this link and check the list above before the draw.</strong>
          If the list changes later, the order changes too, and everyone can see it.
        </p>
        <p>
          <button @click="loadDraw">Check again</button>
          <button v-if="!circle.demo" @click="$emit('demo-copy')">
            Skip the wait: make an instant demo copy (demo only)
          </button>
        </p>
      </div>

      <div v-else-if="drawStatus === 'ready'">
        <p>
          Draw done with block {{ circle.drawHeight }}.
          Block hash: <code style="overflow-wrap: anywhere">{{ blockHash }}</code>
        </p>
        <ol style="list-style: none; padding-left: 0">
          <li v-for="(idx, i) in seq" :key="idx">
            <span v-if="hasPriority && i === 0">Priority seat:</span>
            <span v-else>Roll {{ hasPriority ? i : i + 1 }}:</span>
            <strong> {{ circle.members[idx].name }}</strong> receives in round {{ i + 1 }}
            (before any later changes)
          </li>
        </ol>
        <p>
          <small>
            Anyone can repeat this draw from the block hash and the circle id
            ({{ circleIdText }}) and will get the same order.
          </small>
        </p>
      </div>

      <div v-else-if="drawStatus === 'error'">
        <p role="alert" style="color: #dc2626">Could not run the draw: {{ drawError }}</p>
        <p><button @click="loadDraw">Try again</button></p>
      </div>
    </div>

    <div v-if="wallet.ready">
      <label>
        I am:
        <select v-model.number="meIdx">
          <option :value="-1">Choose your name...</option>
          <option v-for="(m, i) in effCircle.members" :key="i" :value="i">
            {{ m.name }}{{ effOrder.includes(i) ? '' : ' (left)' }}
          </option>
        </select>
      </label>
      <p v-if="meIdx < 0" style="color: #b45309">
        The connected wallet's address is not in this circle's member list. You can join if a seat is open.
      </p>
      <p v-else-if="!isActive" style="color: #b45309">You are not an active member of this circle.</p>
    </div>
    <p v-else><small>Connect your wallet above to pay.</small></p>

    <EventsPanel
      v-if="orderReady"
      :circle="circle"
      :circle-id="circleIdText"
      :ev="ev"
      :me-no="isActive ? meIdx + 1 : 0"
      :money-moved="myMoneyMoved"
      :loading="evLoading"
      :error="evError"
      @refresh="refreshAll"
    />

    <template v-if="orderReady">
      <div v-if="meIdx >= 0 && isActive" class="owe">
        <h3>You owe</h3>
        <ul>
          <li v-for="r in myPayments" :key="r.round">
            Round {{ r.round }}: pay <strong>{{ r.recipient.name }}</strong>
            {{ formatBch(r.amountSats) }} BCH between {{ r.periodStart.slice(0, 10) }}
            and {{ r.dueDate.slice(0, 10) }}
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
              <th>Pay window</th>
              <th>Paid so far</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in rounds" :key="r.round">
              <td>{{ r.round }}<small v-if="i === currentRoundIndex"> (current)</small></td>
              <td>{{ r.recipient.name }}</td>
              <td>{{ r.periodStart.slice(0, 10) }} to {{ r.dueDate.slice(0, 10) }}</td>
              <td>
                {{ paidCount(i) }} of {{ rounds.length - 1 }}
                ({{ formatBch(paidCount(i) * r.amountSats) }} BCH)
              </td>
              <td>
                <span v-if="meIdx >= 0 && r.recipientNo === meIdx + 1">You receive this round</span>
                <span v-else-if="meIdx >= 0 && isActive && statusFor(i, meIdx + 1) === 'paid'">✅ You paid</span>
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
              <th v-for="r in rounds" :key="r.round">{{ r.recipient.name }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in rounds" :key="r.round">
              <td>{{ r.round }} ({{ r.recipient.name }})</td>
              <td v-for="(c, j) in rounds" :key="c.round" style="text-align: center">
                <span v-if="cellStatus(i, j) === 'self'" title="Receiver">—</span>
                <span v-else-if="cellStatus(i, j) === 'paid'" :title="paid[i][c.recipientNo].txid">✅</span>
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
    </template>

    <p v-if="errorText" role="alert" style="color: #dc2626">{{ errorText }}</p>
    <p v-if="lastTx" style="overflow-wrap: anywhere">
      ✅ Payment sent. Transaction: <code>{{ lastTx }}</code>
    </p>
  </section>
</template>