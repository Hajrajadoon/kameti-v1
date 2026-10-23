<script setup>
import { ref, computed } from 'vue'
import {
  bchToSats,
  satsToBch,
  validate,
  createCircle,
  encodeCircle,
  decodeCircle,
  shuffled,
  MIN_MEMBERS,
  MAX_MEMBERS,
} from './circle.js'
import { ADDRESS_PREFIX } from './config.js'
import WalletConnect from './components/WalletConnect.vue'
import CircleView from './components/CircleView.vue'

// Open a circle from the share link (old-format links are ignored)
const hash = location.hash.slice(1)
const circle = ref(
  hash
    ? (() => {
        try {
          const c = decodeCircle(hash)
          return c && c.unit && c.members ? c : null
        } catch {
          return null
        }
      })()
    : null,
)

const name = ref('')
const amountBch = ref('0.0001')
const every = ref(1)
const unit = ref('months')
const startDate = ref(new Date().toISOString().slice(0, 10))
const members = ref([
  { name: '', address: '' },
  { name: '', address: '' },
  { name: '', address: '' },
])
const errors = ref([])

const shareLink = computed(() =>
  circle.value ? `${location.origin}${location.pathname}#${encodeCircle(circle.value)}` : '',
)

const summary = computed(() => {
  const n = members.value.length
  const sats = bchToSats(amountBch.value)
  if (!(sats > 0)) return ''
  return `${n} members, ${n} rounds. Each member pays ${satsToBch(sats)} BCH per round, and the member whose turn it is receives ${satsToBch(sats * n)} BCH in total (${n - 1} payments from others plus their own share).`
})

function create() {
  const input = {
    name: name.value,
    members: members.value.map(m => ({ name: m.name.trim(), address: m.address.trim() })),
    amountSats: bchToSats(amountBch.value),
    startDate: startDate.value,
    every: Number(every.value),
    unit: unit.value,
  }
  errors.value = validate(input)
  if (errors.value.length) return
  circle.value = createCircle(input)
  location.hash = encodeCircle(circle.value)
}

function addMember() {
  if (members.value.length < MAX_MEMBERS) members.value.push({ name: '', address: '' })
}

function removeMember(i) {
  if (members.value.length > MIN_MEMBERS) members.value.splice(i, 1)
}

function move(i, delta) {
  const j = i + delta
  if (j < 0 || j >= members.value.length) return
  const list = [...members.value]
  ;[list[i], list[j]] = [list[j], list[i]]
  members.value = list
}

function drawOrder() {
  if (confirm('Shuffle the payout order at random? Do this live with all members watching.')) {
    members.value = shuffled(members.value)
  }
}

function startOver() {
  circle.value = null
  location.hash = ''
}
</script>

<template>
  <main style="max-width: 820px; margin: 2rem auto; padding: 0 1rem; font-family: system-ui">
    <h1>Kameti.cash</h1>
    <p>Interest-free savings circle. No custody, no fees, public proof on Bitcoin Cash.</p>

    <WalletConnect />

    <form v-if="!circle" @submit.prevent="create">
      <h2>Create a circle</h2>
      <input v-model="name" placeholder="Circle name" required />
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

      <h3>Members in payout order</h3>
      <p>
        <small>
          The list below is the payout order: the first member receives in round 1, the second in
          round 2, and so on. Agree the order together (priority or need), or use the random draw
          while everyone is watching.
        </small>
      </p>

      <div v-for="(m, i) in members" :key="i" class="member">
        <span class="num">{{ i + 1 }}</span>
        <input v-model="m.name" :placeholder="`Member ${i + 1} name`" />
        <input v-model="m.address" :placeholder="`${ADDRESS_PREFIX}:q...`" />
        <button type="button" @click="move(i, -1)" :disabled="i === 0" title="Move up">↑</button>
        <button type="button" @click="move(i, 1)" :disabled="i === members.length - 1" title="Move down">↓</button>
        <button
          type="button"
          @click="removeMember(i)"
          :disabled="members.length <= MIN_MEMBERS"
          title="Remove"
        >✕</button>
      </div>

      <div class="row">
        <button type="button" @click="addMember" :disabled="members.length >= MAX_MEMBERS">+ Add member</button>
        <button type="button" @click="drawOrder">🎲 Random draw</button>
      </div>

      <p v-if="summary"><small>{{ summary }}</small></p>

      <button type="submit">Create circle</button>
      <ul style="color: #b00">
        <li v-for="e in errors" :key="e">{{ e }}</li>
      </ul>
    </form>

    <div v-else>
      <CircleView :circle="circle" />
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
.row { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: end; }
.member { display: flex; gap: 0.4rem; align-items: center; }
.member .num { width: 1.5rem; text-align: right; }
.member input:nth-of-type(1) { width: 25%; }
.member input:nth-of-type(2) { flex: 1; }
button { padding: 0.5rem 0.8rem; font-size: 1rem; cursor: pointer; }
table { border-collapse: collapse; width: 100%; }
</style>