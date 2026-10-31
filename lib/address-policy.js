/**
 * The fake-IP-aware address resolver handed to the stock HTTP fetch provider.
 *
 * The stock provider accepts a resolver in its constructor and pins every
 * connection to the addresses that resolver returned; this module reproduces the
 * upstream resolution rules (one lookup, whole-answer validation, NAT64
 * translation checks) and substitutes the one rule a fake-IP deployment cannot
 * satisfy: a non-public address is refused unless it belongs to the configured
 * fake-IP pool.
 *
 * Rejections are raised as {@link AddressRejected} so this module stays free of
 * Harness imports and is testable with an injected lookup; the plugin entry
 * translates them into the `WebError` codes the web tool reports.
 *
 * Resolution rules are derived from `@deepseek-ai/dsh-web-fetch-http`
 * (MIT, Copyright (c) DeepSeek) — see NOTICE.
 *
 * @module dsh-fakeip-web-fetch/address-policy
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { classifyAddress, createAllowlist, stripIpv6Brackets } from './cidr.js'

/** RFC 6052 prefix lengths that may carry an IPv4 destination through NAT64. */
const RFC6052_PREFIX_LENGTHS = [32, 40, 48, 56, 64, 96]
/** RFC 7050's reserved hostname for discovering the active DNS64 prefix. */
const IPV4ONLY_DISCOVERY_HOST = 'ipv4only.arpa'
/** The two IPv4 addresses RFC 7050 reserves inside the NAT64 prefix. */
const IPV4ONLY_SENTINELS = new Set(['192.0.0.170', '192.0.0.171'])

/**
 * A destination the provider must not connect to, carrying the `WebError` code
 * the plugin entry re-raises. `WEB_BLOCKED_URL` covers policy refusals;
 * `WEB_PROVIDER_ERROR` covers unusable DNS answers.
 */
export class AddressRejected extends Error {
	/**
	 * @param {string} message - the message shown to the model.
	 * @param {'WEB_BLOCKED_URL' | 'WEB_PROVIDER_ERROR'} code - the `WebError` code to raise.
	 */
	constructor(message, code) {
		super(message)
		this.name = 'AddressRejected'
		this.code = code
	}
}

/**
 * Build the resolver the stock provider calls before it connects.
 *
 * @param {{ fakeIpV4Cidrs?: unknown, fakeIpV6Cidrs?: unknown }} [config] - resolved provider config.
 * @param {{ lookup?: Function, allowlist?: ReturnType<typeof createAllowlist> }} [options] - test seams.
 * @returns {(hostname: string, signal: AbortSignal) => Promise<Array<{ address: string, family: number }>>} the resolver.
 */
export function createAddressResolver(config = {}, options = {}) {
	const allowlist = options.allowlist ?? createAllowlist(config)
	const resolver = options.lookup ?? dnsLookup

	/**
	 * Resolve one hostname once and validate the complete answer set.
	 *
	 * @param {string} hostname - URL hostname, brackets included for IPv6 literals.
	 * @param {AbortSignal} signal - aborts the wait; an in-flight OS lookup may finish unused.
	 * @returns {Promise<Array<{ address: string, family: number }>>} the addresses the transport may use.
	 */
	async function resolveAddresses(hostname, signal) {
		const unbracketed = stripIpv6Brackets(hostname)
		const literalFamily = isIP(unbracketed)
		const resolved = literalFamily === 0
			? await raceWithSignal(resolver(unbracketed, { all: true, order: 'verbatim' }), signal)
			: [{ address: unbracketed, family: literalFamily }]
		if (resolved.length === 0) throw new AddressRejected(`hostname "${hostname}" resolved to no addresses`, 'WEB_PROVIDER_ERROR')
		const nat64Prefixes = resolved.some((entry) => entry.family === 6 && isIP(entry.address) === 6)
			? await discoverNat64Prefixes(signal)
			: []
		const addresses = []
		for (const entry of resolved) {
			if ((entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family) {
				throw new AddressRejected(`hostname "${hostname}" resolved to an invalid IP address`, 'WEB_PROVIDER_ERROR')
			}
			const verdict = classifyAddress(entry.address, allowlist)
			if (verdict === 'invalid') throw new AddressRejected(`hostname "${hostname}" resolved to an invalid IP address`, 'WEB_PROVIDER_ERROR')
			if (verdict === 'blocked') throw new AddressRejected(`URL hostname "${hostname}" resolves to a non-public IP address`, 'WEB_BLOCKED_URL')
			const translatedIpv4 = translatedIpv4Address(entry.address, nat64Prefixes)
			if (translatedIpv4 !== undefined && classifyAddress(translatedIpv4, allowlist) !== 'public') {
				throw new AddressRejected(`URL hostname "${hostname}" resolves through NAT64 to a non-public IPv4 address`, 'WEB_BLOCKED_URL')
			}
			addresses.push({ address: entry.address, family: entry.family })
		}
		return addresses
	}

	/**
	 * Discover the active DNS64 prefix set using RFC 7050's reserved hostname.
	 *
	 * @param {AbortSignal} signal - request cancellation.
	 * @returns {Promise<Array<{ bytes: number[], length: number }>>} discovered NAT64 prefixes.
	 */
	async function discoverNat64Prefixes(signal) {
		const discovered = await raceWithSignal(resolver(IPV4ONLY_DISCOVERY_HOST, { all: true, order: 'verbatim' }), signal)
		const prefixes = []
		const seen = new Set()
		for (const entry of discovered) {
			if (entry.family !== 6 || isIP(entry.address) !== 6) continue
			const bytes = ipaddr.parse(entry.address).toByteArray()
			for (const length of RFC6052_PREFIX_LENGTHS) {
				const embedded = embeddedIpv4Address(bytes, length)
				if (embedded === undefined || !IPV4ONLY_SENTINELS.has(embedded)) continue
				const prefixBytes = bytes.slice(0, length / 8)
				const key = `${length}:${prefixBytes.join('.')}`
				if (seen.has(key)) continue
				seen.add(key)
				prefixes.push({ bytes: prefixBytes, length })
			}
		}
		return prefixes
	}

	return resolveAddresses
}

/**
 * Return the RFC 6052-embedded IPv4 address when an IPv6 address matches a discovered prefix.
 *
 * @param {string} input - textual address.
 * @param {Array<{ bytes: number[], length: number }>} prefixes - discovered prefixes.
 * @returns {string | undefined} the embedded IPv4 address, or `undefined`.
 */
function translatedIpv4Address(input, prefixes) {
	if (isIP(input) !== 6) return undefined
	const bytes = ipaddr.parse(input).toByteArray()
	for (const prefix of prefixes) {
		if (!prefix.bytes.every((byte, index) => bytes[index] === byte)) continue
		const embedded = embeddedIpv4Address(bytes, prefix.length)
		if (embedded !== undefined) return embedded
	}
	return undefined
}

/**
 * Extract one IPv4 address from an RFC 6052 IPv6 layout.
 *
 * @param {number[]} bytes - the IPv6 address as bytes.
 * @param {number} prefixLength - the RFC 6052 prefix length.
 * @returns {string | undefined} the embedded IPv4 address, or `undefined` when the layout does not fit.
 */
function embeddedIpv4Address(bytes, prefixLength) {
	if (prefixLength === 96) return bytes.slice(12, 16).join('.')
	if (bytes[8] !== 0) return undefined
	const prefixBytes = prefixLength / 8
	const beforeReservedOctet = 8 - prefixBytes
	return [...bytes.slice(prefixBytes, prefixBytes + beforeReservedOctet), ...bytes.slice(9, 13 - beforeReservedOctet)].join('.')
}

/**
 * Race a non-cancellable OS lookup without letting tool cancellation wait for it.
 *
 * @param {Promise<unknown>} promise - the lookup in flight.
 * @param {AbortSignal} signal - request cancellation.
 * @returns {Promise<unknown>} the lookup result, or a rejection once `signal` aborts.
 */
function raceWithSignal(promise, signal) {
	const abortError = () => new Error('web fetch aborted during hostname resolution', { cause: signal.reason })
	if (signal.aborted) return Promise.reject(abortError())
	return new Promise((resolve, reject) => {
		const abort = () => {
			reject(abortError())
		}
		signal.addEventListener('abort', abort, { once: true })
		promise.then(resolve, reject).finally(() => {
			signal.removeEventListener('abort', abort)
		})
	})
}
