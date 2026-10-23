import { shallowReactive } from 'vue'

// Shared between the wallet component and the circle screen
export const wallet = shallowReactive({
  manager: null, // the WizardConnect manager, set when the wallet is connected
  ready: false,
})