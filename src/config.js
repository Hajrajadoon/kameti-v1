// To go live later: NETWORK = 'mainnet' and ADDRESS_PREFIX = 'bitcoincash'
export const NETWORK = 'chipnet'
export const ADDRESS_PREFIX = 'bchtest'

// Blockchain data server. Leave it empty to use CashScript's own default list of servers.
// If connections keep failing, put the hostname of a working server here, for example
// 'electrum-chipnet.optnlabs.com'. A mainnet server is needed when you switch to mainnet.
export const ELECTRUM_HOST = 'electrum-chipnet.optnlabs.com'