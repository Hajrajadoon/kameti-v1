<script setup>
import { ref, computed } from 'vue'
import { wallet } from '../store.js'
import { scanWallet, deriveAddress } from '../chain.js'
import { publishEvent } from '../events.js'

const props = defineProps({
  circle: { type: Object, required: true }, // the circle as it was created
  circleId: { type: String, default: '' },
  ev: { type: Object, default: null }, // result of resolveEvents, or null
  meNo: { type: Number, default: 0 }, // member number of the connected wallet (1-based), 0 = not a member
  moneyMoved: { type: Boolean, default: false }, // the connected member already paid or received
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
})
const emit = defineEmits(['refresh'])

const busy = ref(false)
const justSent = ref(false) // short pause after a note was sent, so it cannot be sent twice by accident
const status = ref('')
const message = ref('')
const problem = ref('')
const joinName = ref('')
const swapWith = ref(0)

const boardAddress = computed(() => props.circle.members[0].address)
const universe = computed(() => props.ev?.universe || props.circle.members)
const order = computed(() => props.ev?.order || props.circle.members.map((_, i) => i))
const activeNos = computed(() => order.value.map(i => i + 1))
const meActive = computed(() => props.meNo > 0 && activeNos.value.includes(props.meNo))
const isOpen = computed(() => (props.ev ? props.ev.phase === 'open' : true))
const vacancies = computed(() => props.ev?.vacancies || 0)
const others = computed(() => activeNos.value.filter(n => n !== props.meNo))
const incoming = computed(() => (props.ev?.pendingSwaps || []).filter(s => s.b === props.meNo))
const outgoing = computed(() => (props.ev?.pendingSwaps || []).filter(s => s.a === props.meNo))
const canJoin = computed(
  () => wallet.ready && props.meNo === 0 && isOpen.value && vacancies.value > 0,
)
const lockText = computed(() =>
  props.ev ? new Date(props.ev.lock).toISOString().slice(0, 10) : '',
)
const alreadyAgreed = computed(
  () => swapWith.value > 0 && outgoing.value.some(s => s.b === swapWith.value),
)
const blocked = computed(() => busy.value || justSent.value)

const nameOf = no => universe.value[no - 1]?.name || `Member ${no}`
const addressOf = no => universe.value[no - 1]?.address

function statusWord(item) {
  if (item.status === 'applied' && item.tentative) return 'applied, final after the next block'
  return item.status
}

// Builds the note, asks the wallet to post it, then refreshes
async function post(build, okText) {
  problem.value = ''
  message.value = ''
  status.value = ''
  if (!wallet.manager) {
    problem.value = 'Connect your wallet first.'
    return
  }
  if (blocked.value) return
  busy.value = true
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('Timed out waiting for the wallet'), 180000)
  try {
    const scan = await scanWallet(wallet.manager, 20)
    const { chunks, actor } = build(scan)
    await publishEvent(
      wallet.manager,
      scan.coins,
      actor,
      boardAddress.value,
      chunks,
      controller.signal,
      text => (status.value = text),
    )
    message.value = okText
    // keep the buttons off for a minute so one change cannot be posted several times
    justSent.value = true
    setTimeout(() => (justSent.value = false), 60000)
    setTimeout(() => emit('refresh'), 3000)
  } catch (e) {
    console.error('Posting a change failed:', e)
    problem.value =
      e?.name === 'AbortError'
        ? 'Cancelled, or the wallet did not answer in time. Keep this tab in front and your wallet open, then try again.'
        : e?.message || String(e)
  } finally {
    clearTimeout(timer)
    busy.value = false
    status.value = ''
  }
}

const SENT = 'Sent. It already shows below. It becomes final after the next block.'

function leave() {
  if (!confirm('Leave this circle? Your seat becomes open and everyone behind you moves up.')) return
  post(
    () => ({
      chunks: ['KAMETI', props.circleId, 'LEAVE', String(props.meNo)],
      actor: addressOf(props.meNo),
    }),
    SENT,
  )
}

function agreeSwap(partnerNo) {
  post(
    () => ({
      chunks: ['KAMETI', props.circleId, 'SWAP', String(props.meNo), String(partnerNo)],
      actor: addressOf(props.meNo),
    }),
    'Your agreement was sent. The seats swap as soon as both members have agreed. Please do not click again.',
  )
}

function proposeSwap() {
  if (!swapWith.value) {
    problem.value = 'Choose who you want to swap with.'
    return
  }
  if (alreadyAgreed.value) {
    problem.value = 'You already agreed to swap with this member. Now they must agree too.'
    return
  }
  agreeSwap(swapWith.value)
}

function join() {
  const name = joinName.value.trim()
  if (!name || name.length > 40) {
    problem.value = 'Enter your name (up to 40 characters).'
    return
  }
  post(
    scan => {
      // use the receive address that holds the most coins, or the first one if none holds any
      const totals = new Map()
      for (const c of scan.coins) {
        if (c.path === 'receive') totals.set(c.address, (totals.get(c.address) || 0n) + c.satoshis)
      }
      let best = null
      for (const [address, sats] of totals) if (!best || sats > best.sats) best = { address, sats }
      const address = best ? best.address : deriveAddress(wallet.manager, 0, 0)
      return { chunks: ['KAMETI', props.circleId, 'JOIN', name, address], actor: address }
    },
    SENT,
  )
}
</script>

<template>
  <section class="changes">
    <h3>Joining, leaving and swapping seats</h3>

    <p v-if="loading">Reading circle changes from the blockchain...</p>
    <p v-if="error" role="alert" style="color: #dc2626">{{ error }}</p>

    <p v-if="ev && isOpen">
      <strong>Open until {{ lockText }}.</strong> Until then members can leave, and a new member
      can take a vacated seat (at the last position). A seat still empty after that date is removed,
      so the circle gets shorter.
      <span v-if="vacancies > 0"><strong> Open seats: {{ vacancies }}.</strong></span>
    </p>
    <p v-else-if="ev">
      <strong>Closed.</strong> The circle has {{ order.length }} members
      <span v-if="order.length < circle.members.length">
        (it shrank from {{ circle.members.length }})
      </span>
      and runs to the end. Nobody can leave or join. Seat swaps are still possible before either
      round starts.
    </p>

    <p v-if="ev && ev.hasTentative" style="color: #b45309">
      <small>
        Some changes are not in a block yet. They are shown as applied and become final after the
        next block. This page re-checks by itself every 30 seconds.
      </small>
    </p>

    <div v-if="wallet.ready && meActive">
      <div v-if="isOpen">
        <button :disabled="blocked || moneyMoved" @click="leave">Leave this circle</button>
        <small v-if="moneyMoved">
          You already paid or received in this circle, so you cannot leave it.
        </small>
      </div>

      <p>
        <label>
          Swap seats with:
          <select v-model.number="swapWith">
            <option :value="0">Choose a member...</option>
            <option v-for="n in others" :key="n" :value="n">{{ nameOf(n) }}</option>
          </select>
        </label>
        <button :disabled="blocked || alreadyAgreed" @click="proposeSwap">
          {{ alreadyAgreed ? 'Waiting for them to agree' : 'Agree to swap' }}
        </button>
        <br />
        <small>
          Both members must agree. Click once and wait. Agree to swap only with someone you have
          talked to, and never pay for a seat. Do not pay a round before its window opens.
        </small>
      </p>

      <ul v-if="incoming.length">
        <li v-for="s in incoming" :key="s.a + '>' + s.b">
          {{ nameOf(s.a) }} wants to swap seats with you.
          <button :disabled="blocked" @click="agreeSwap(s.a)">Agree</button>
        </li>
      </ul>
      <ul v-if="outgoing.length">
        <li v-for="s in outgoing" :key="s.a + '>' + s.b">
          Waiting for {{ nameOf(s.b) }} to agree to your swap.
        </li>
      </ul>
    </div>

    <div v-if="canJoin">
      <p>You are not in this circle, and there is an open seat. You would take the last position.</p>
      <label>
        Your name
        <input v-model="joinName" maxlength="40" placeholder="Your name" />
      </label>
      <button :disabled="blocked" @click="join">Join this circle</button>
    </div>
    <p v-else-if="wallet.ready && meNo === 0 && ev"><small>There is no open seat for you right now.</small></p>

    <p v-if="!wallet.ready"><small>Connect your wallet above to join, leave or swap.</small></p>

    <p v-if="busy">{{ status || 'Waiting for your wallet...' }}</p>
    <p v-if="problem" role="alert" style="color: #dc2626">{{ problem }}</p>
    <p v-if="message" style="color: #15803d">{{ message }}</p>

    <h4>Changes so far</h4>
    <p v-if="!ev || !ev.log.length"><small>No changes have been posted yet.</small></p>
    <ul v-else>
      <li v-for="item in ev.log" :key="item.txid + item.kind">
        <strong>{{ item.kind }}:</strong> {{ item.text }}
        <small>({{ statusWord(item) }})</small>
      </li>
    </ul>
    <p>
      <button :disabled="loading" @click="emit('refresh')">Refresh changes</button>
    </p>
  </section>
</template>