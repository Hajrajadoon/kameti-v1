export const bchToSats = bch => Math.round(Number(bch) * 1e8);
export const satsToBch = s => (s / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');

export function validate({ members, amountSats, intervalDays }) {
  const errors = [];
  if (members.length < 3 || members.length > 6) errors.push('Use 3 to 6 members.');
  if (!(amountSats >= 1000)) errors.push('Amount is too small.');
  if (!(intervalDays >= 1)) errors.push('Interval must be at least 1 day.');
  const seen = new Set();
  for (const m of members) {
    if (!m.name.trim()) errors.push('Every member needs a name.');
    if (!/^(bitcoincash|bchtest):[a-z0-9]{30,}$/i.test(m.address.trim()))
      errors.push(`Invalid address for ${m.name || 'a member'}.`);
    if (seen.has(m.address.trim())) errors.push('Duplicate address.');
    seen.add(m.address.trim());
  }
  return errors;
}

export function createCircle({ name, members, amountSats, startDate, intervalDays }) {
  const day = 86400000;
  const rounds = members.map((recipient, i) => ({
    round: i + 1,
    recipient,
    dueDate: new Date(new Date(startDate).getTime() + i * intervalDays * day).toISOString(),
    payers: members.filter(m => m.address !== recipient.address),
    amountSats,
    potSats: amountSats * (members.length - 1),
  }));
  return { name, members, amountSats, intervalDays, startDate, rounds };
}

// whole circle lives in the URL: no database, no server
const toB64 = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
  .replace(/\+/g, '-').replace(/\//g, '_');
const fromB64 = s => new TextDecoder().decode(
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
export const encodeCircle = c => toB64(JSON.stringify(c));
export const decodeCircle = s => JSON.parse(fromB64(s));