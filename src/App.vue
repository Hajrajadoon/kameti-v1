<script setup>
import { ref, computed } from 'vue';
import { bchToSats, satsToBch, validate, createCircle, encodeCircle, decodeCircle } from './circle.js';

const hash = location.hash.slice(1);
const circle = ref(hash ? (() => { try { return decodeCircle(hash); } catch { return null; } })() : null);

const name = ref('');
const amountBch = ref('0.001');
const intervalDays = ref(30);
const startDate = ref(new Date().toISOString().slice(0, 10));
const members = ref([{ name: '', address: '' }, { name: '', address: '' }, { name: '', address: '' }]);
const errors = ref([]);

const shareLink = computed(() => circle.value ? `${location.origin}${location.pathname}#${encodeCircle(circle.value)}` : '');

function create() {
  const input = { name: name.value, members: members.value.map(m => ({ name: m.name.trim(), address: m.address.trim() })),
    amountSats: bchToSats(amountBch.value), startDate: startDate.value, intervalDays: Number(intervalDays.value) };
  errors.value = validate(input);
  if (errors.value.length) return;
  circle.value = createCircle(input);
  location.hash = encodeCircle(circle.value);
}
</script>

<template>
  <main style="max-width:720px;margin:2rem auto;padding:0 1rem;font-family:system-ui">
    <h1>Kameti.cash</h1>
    <p>Interest-free savings circle. No custody, no fees, public proof on Bitcoin Cash.</p>

    <form v-if="!circle" @submit.prevent="create">
      <input v-model="name" placeholder="Circle name" required />
      <label>Amount per member (BCH) <input v-model="amountBch" /></label>
      <label>Days between rounds <input v-model="intervalDays" type="number" min="1" /></label>
      <label>Start date <input v-model="startDate" type="date" /></label>
      <div v-for="(m, i) in members" :key="i">
        <input v-model="m.name" :placeholder="`Member ${i + 1} name`" />
        <input v-model="m.address" placeholder="bitcoincash:q..." style="width:60%" />
      </div>
      <button type="button" @click="members.length < 6 && members.push({ name: '', address: '' })">+ Add member</button>
      <button>Create circle</button>
      <ul style="color:#b00"><li v-for="e in errors" :key="e">{{ e }}</li></ul>
    </form>

    <section v-else>
      <h2>{{ circle.name }}</h2>
      <table border="1" cellpadding="6">
        <tr><th>Round</th><th>Receives</th><th>Due</th><th>Pot (BCH)</th></tr>
        <tr v-for="r in circle.rounds" :key="r.round">
          <td>{{ r.round }}</td><td>{{ r.recipient.name }}</td>
          <td>{{ r.dueDate.slice(0, 10) }}</td><td>{{ satsToBch(r.potSats) }}</td>
        </tr>
      </table>
      <p>Share this link with members:</p>
      <input :value="shareLink" readonly style="width:100%" />
    </section>
  </main>
</template>