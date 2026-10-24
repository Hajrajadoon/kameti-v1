<script setup>
import { ref, computed } from 'vue'
import {
  bchToSats,
  satsToBch,
  validate,
  createCircle,
  encodeCircle,
  decodeCircle,
  MIN_MEMBERS,
  MAX_MEMBERS,
  DEFAULT_WINDOW_DAYS,
} from './circle.js'
import { getHeight } from './draw.js'
import { ADDRESS_PREFIX } from './config.js'
import WalletConnect from './components/WalletConnect.vue'
import CircleView from './components/CircleView.vue'

// A shared link is data from someone else, so it is fully checked before it is used
function openFromLink() {
  const hash = location.hash.slice(1)
  if (!hash) return null
  try {
    const c = decodeCircle(hash)
    return validate(c).length === 0 ? c : null
  } catch {
    return null
  }
}

const circle = ref(openFromLink())
const badLink = ref(Boolean(location.hash.slice(1)) && !circle.value)

const name = ref('')
const amountBch = ref('0.0001')
const every = ref(1)
const unit = ref('months')
const payWindow = ref(DEFAULT_WINDOW_DAYS)
const startDate = ref(new Date().toISOString().slice(0, 10))
const orderMode = ref('draw') // 'draw' = blockchain dice draw, 'manual' = list order, 'demo' = instant demo draw
const drawLead = ref(3) // how many blocks ahead the draw block is
const firstIdx = ref(-1) // priority seat: member who takes round 1 (-1 = nobody)
const members = ref([
  { name: '', address: '' },
  { name: '', address: '' },
  { name: '', address: '' },
])
const errors = ref([])
const creating = ref(false)
const copyError = ref('')

const shareLink = computed(() =>
  circle.value ? `${location.origin}${location.pathname}#${encodeCircle(circle.value)}` : '',
)

const summary = computed(() => {
  const n = members.value.length
  const sats = bchToSats(amountBch.value)
  if (!(sats > 0)) return ''
  return `${n} members, ${n} rounds. Each member pays ${satsToBch(sats)} BCH per round, and the member whose turn it is receives ${satsToBch(sats * n)} BCH in total (${n - 1} payments from others plus their own share).`
})

async function create() {
  const usePriority = orderMode.value !== 'manual' && firstIdx.value >= 0
  const input = {
    name: name.value,
    members: members.value.map(m => ({ name: m.name.trim(), address: m.address.trim() })),
    amountSats: bchToSats(amountBch.value),
    startDate: startDate.value,
    every: Number(every.value),
    unit: unit.value,
    payWindow: Number(payWindow.value),
    first: usePriority ? firstIdx.value : undefined,
  }
  errors.value = validate(input)
  if (errors.value.length) return

  let drawHeight = 0
  if (orderMode.value === 'draw' || orderMode.value === 'demo') {
    creating.value = true
    try {
      // demo = a block that already exists, so the order appears immediately
      const lead = orderMode.value === 'demo' ? -2 : Number(drawLead.value)
      drawHeight = (await getHeight()) + lead
    } catch (e) {
      console.error(e)
      errors.value = ['Could not read the blockchain to schedule the draw. Check your connection and try again.']
      creating.value = false
      return
    }
    creating.value = false
  }

  circle.value = createCircle({
    ...input,
    first: input.first ?? -1,
    drawHeight,
    demo: orderMode.value === 'demo',
  })
  badLink.value = false
  location.hash = encodeCircle(circle.value)
}

// Turns the circle on screen into an instant demo circle (same members and settings)
async function makeDemoCopy() {
  copyError.value = ''
  try {
    const height = await getHeight()
    circle.value = createCircle({ ...circle.value, drawHeight: height - 2, demo: true })
    location.hash = encodeCircle(circle.value)
  } catch (e) {
    console.error(e)
    copyError.value = 'Could not read the blockchain. Check your connection and try again.'
  }
}

function addMember() {
  if (members.value.length < MAX_MEMBERS) members.value.push({ name: '', address: '' })
}

function removeMember(i) {
  if (members.value.length <= MIN_MEMBERS) return
  members.value.splice(i, 1)
  // keep the priority seat pointing at the same person
  if (firstIdx.value === i) firstIdx.value = -1
  else if (firstIdx.value > i) firstIdx.value -= 1
}

function move(i, delta) {
  const j = i + delta
  if (j < 0 || j >= members.value.length) return
  const list = [...members.value]
  ;[list[i], list[j]] = [list[j], list[i]]
  members.value = list
}

function startOver() {
  circle.value = null
  badLink.value = false
  copyError.value = ''
  location.hash = ''
}
</script>

<template>
  <main style="max-width: 820px; margin: 2rem auto; padding: 0 1rem; font-family: system-ui">
    <h1>Kameti.cash</h1>
    <p>Interest-free savings circle. No custody, no fees, public proof on Bitcoin Cash.</p>

    <WalletConnect />

    <p v-if="badLink" role="alert" style="color: #dc2626">
      This link is not a valid circle for this network. Ask the organizer for a new link.
    </p>

    <form v-if="!circle" @submit.prevent="create">
      <h2>Create a circle</h2>
      <input v-model="name" placeholder="Circle name" maxlength="60" required />
      <label>Amount per member, per round (BCH) <input v-model="amountBch" /></label>

      <div class="row">
        <label>
          Pay every
          <input v-model.number="every" type="number" min="1" max="366" />
        </label>
        <label>
          Unit
          <select v-model="unit">
            <option value="days">days</option>
            <option value="weeks">weeks</option>
            <option value="months">months</option>
          </select>
        </label>
        <label>
          First round date
          <input v-model="startDate" type="date" />
        </label>
      </div>

      <label>
        Everyone pays within the first
        <select v-model.number="payWindow">
          <option :value="3">3 days of each round</option>
          <option :value="5">5 days of each round</option>
          <option :value="7">7 days of each round (recommended)</option>
          <option :value="10">10 days of each round</option>
        </select>
      </label>
      <p>
        <small>
          All members pay the round's receiver inside this window, so the receiver gets the whole
          amount at once and not in pieces through the month.
        </small>
      </p>

      <h3>Who receives first?</h3>
      <label>
        <span><input type="radio" value="draw" v-model="orderMode" /> Dice draw by the blockchain (recommended)</span>
      </label>
      <label>
        <span><input type="radio" value="manual" v-model="orderMode" /> Set by hand (the list order below is the payout order)</span>
      </label>
      <label>
        <span><input type="radio" value="demo" v-model="orderMode" /> Instant demo draw (demos only, not fair for real circles)</span>
      </label>

      <label v-if="orderMode === 'draw'">
        Draw happens
        <select v-model.number="drawLead">
          <option :value="1">after 1 block (testing)</option>
          <option :value="3">after about 3 blocks (about 30 minutes)</option>
          <option :value="6">after about 6 blocks (about 1 hour)</option>
          <option :value="12">after about 12 blocks (about 2 hours)</option>
        </select>
      </label>
      <p v-if="orderMode === 'draw'">
        <small>
          The order is decided by a future block's hash, which nobody can predict or control.
          Everyone must open the link and check the member list before the draw. Set the
          first round date after the draw.
        </small>
      </p>

      <label v-if="orderMode !== 'manual'">
        Priority seat (first turn)
        <select v-model.number="firstIdx">
          <option :value="-1">None: the blockchain draw decides everyone</option>
          <option v-for="(m, i) in members" :key="i" :value="i">{{ m.name || `Member ${i + 1}` }}</option>
        </select>
      </label>
      <p v-if="orderMode !== 'manual' && firstIdx >= 0">
        <small>
          This member receives in round 1 and the draw decides everyone else. Use it when someone
          has an urgent need and the whole group agrees <strong>before</strong> the circle starts.
          The first receiver carries the most trust, so only agree to it if you know them.
        </small>
      </p>

      <h3>Members</h3>
      <div v-for="(m, i) in members" :key="i" class="member">
        <span class="num">{{ i + 1 }}</span>
        <input v-model="m.name" :placeholder="`Member ${i + 1} name`" maxlength="40" />
        <input v-model="m.address" :placeholder="`${ADDRESS_PREFIX}:q...`" />
        <template v-if="orderMode === 'manual'">
          <button type="button" @click="move(i, -1)" :disabled="i === 0" title="Move up">↑</button>
          <button type="button" @click="move(i, 1)" :disabled="i === members.length - 1" title="Move down">↓</button>
        </template>
        <button
          type="button"
          @click="removeMember(i)"
          :disabled="members.length <= MIN_MEMBERS"
          title="Remove"
        >✕</button>
      </div>

      <div class="row">
        <button type="button" @click="addMember" :disabled="members.length >= MAX_MEMBERS">+ Add member</button>
      </div>

      <p v-if="summary"><small>{{ summary }}</small></p>

      <button type="submit" :disabled="creating">
        {{ creating ? 'Reading the blockchain...' : 'Create circle' }}
      </button>
      <ul style="color: #b00">
        <li v-for="e in errors" :key="e">{{ e }}</li>
      </ul>
    </form>

    <div v-else>
      <CircleView :key="shareLink" :circle="circle" @demo-copy="makeDemoCopy" />
      <p v-if="copyError" role="alert" style="color: #dc2626">{{ copyError }}</p>
      <p>Share this link with the other members. Everyone opens the same link and connects their own wallet:</p>
      <input :value="shareLink" readonly style="width: 100%" />
      <p v-if="shareLink.length > 2000">
        <small>This link is long. If a chat app cuts it off, send it as a file or in two messages.</small>
      </p>
      <p><button type="button" @click="startOver">Start a new circle</button></p>
    </div>
  </main>
</template>

<style scoped>
form { display: grid; gap: 0.75rem; }
label { display: grid; gap: 0.25rem; }
input, select { padding: 0.5rem; font-size: 1rem; }
input[type='radio'] { padding: 0; margin-right: 0.4rem; }
.row { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: end; }
.member { display: flex; gap: 0.4rem; align-items: center; }
.member .num { width: 1.5rem; text-align: right; }
.member input:nth-of-type(1) { width: 25%; }
.member input:nth-of-type(2) { flex: 1; }
button { padding: 0.5rem 0.8rem; font-size: 1rem; cursor: pointer; }
table { border-collapse: collapse; width: 100%; }
</style>