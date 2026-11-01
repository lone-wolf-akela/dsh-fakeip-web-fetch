/**
 * Address policy for the fake-IP-aware fetch provider: pool constants, CIDR
 * parsing, and the classification the resolver binds to one configuration.
 *
 * A fake-IP resolver (Clash/mihomo, OpenClash, sing-box, Surge, ...) answers
 * proxied hostnames with addresses from a reserved pool, so that the proxy core
 * can map the connection back to the domain that was asked for. Those addresses
 * are by construction not publicly routable, which is exactly what DSH's stock
 * provider refuses. This module decides which non-public addresses are the
 * local fake-IP pool (accepted) and which ones remain a genuine local-network
 * destination (still refused).
 *
 * Only `ipaddr.js` and the string form of an address live here, so the policy is
 * testable without a Harness runtime.
 *
 * @module dsh-fakeip-web-fetch/cidr
 */
import ipaddr from 'ipaddr.js'

/**
 * The pool Clash/mihomo, sing-box and Surge hand out by default: 198.18.0.0/15
 * is the RFC 2544 benchmarking range, never a public destination. OpenClash's
 * default `fake-ip-range` (198.18.0.1/16) is a subset of it.
 */
export const DEFAULT_FAKE_IPV4_CIDRS = ['198.18.0.0/15']

/**
 * IPv6 fake-IP pools seen in the wild. mihomo and OpenClash commonly answer
 * proxied AAAA queries from the NAT64 prefix `64:ff9b::/96`, index-paired
 * with the IPv4 fake pool; mihomo's documentation and template also show
 * `fdfe:dcba:9876::1/64`, and sing-box / some OpenClash templates use
 * `fc00::/18`. None of these can be a public destination, and a resolver
 * that hands out something else needs `fakeIpV6Cidrs` configured to match
 * its `fake-ip-range6`.
 *
 * The NAT64 translation check still runs on every resolved address, so on a
 * network where DNS64 is actually active a real NAT64 destination that
 * embeds a private IPv4 stays refused even though the prefix is listed
 * here; the fake pool in that prefix loses to the same check.
 */
export const DEFAULT_FAKE_IPV6_CIDRS = ['64:ff9b::/96', 'fdfe:dcba:9876::/64', 'fc00::/18']

/**
 * Strip the brackets WHATWG `URL` keeps around IPv6 literals (`[::1]` -> `::1`).
 *
 * @param {string} hostname - a hostname or bracketed IPv6 literal.
 * @returns {string} the address or hostname without brackets.
 */
export function stripIpv6Brackets(hostname) {
	return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/**
 * Parse one configured CIDR list into ipaddr.js ranges.
 *
 * @param {unknown} entries - the configured list, e.g. `['198.18.0.0/15']`.
 * @param {string} field - the Config field name, used in the diagnostic.
 * @returns {Array<{ cidr: string, address: ipaddr.IPv4 | ipaddr.IPv6, prefixLength: number }>} compiled ranges.
 * @throws {TypeError} when the field is not an array.
 * @throws {Error} when an entry is empty or not a valid CIDR.
 */
export function parseCidrList(entries, field) {
	if (!Array.isArray(entries)) throw new TypeError(`${field} must be an array of CIDR strings`)
	const ranges = []
	for (const entry of entries) {
		const cidr = String(entry).trim()
		if (cidr === '') throw new Error(`${field} contains an empty CIDR`)
		let parsed
		try {
			parsed = ipaddr.parseCIDR(cidr)
		} catch (cause) {
			throw new Error(`${field} entry "${cidr}" is not a valid CIDR: ${cause instanceof Error ? cause.message : String(cause)}`)
		}
		ranges.push({ cidr, address: parsed[0], prefixLength: parsed[1] })
	}
	return ranges
}

/**
 * Build the allowlist a resolver binds once, at activation.
 *
 * @param {{ fakeIpV4Cidrs?: unknown, fakeIpV6Cidrs?: unknown }} config - resolved provider config.
 * @returns {{ fakeIpV4: ReturnType<typeof parseCidrList>, fakeIpV6: ReturnType<typeof parseCidrList> }} compiled allowlist.
 */
export function createAllowlist(config = {}) {
	return {
		fakeIpV4: parseCidrList(config.fakeIpV4Cidrs ?? DEFAULT_FAKE_IPV4_CIDRS, 'fakeIpV4Cidrs'),
		fakeIpV6: parseCidrList(config.fakeIpV6Cidrs ?? DEFAULT_FAKE_IPV6_CIDRS, 'fakeIpV6Cidrs')
	}
}

/**
 * Parse an address, folding IPv4-mapped IPv6 into its embedded IPv4 address the
 * same way the stock provider does.
 *
 * @param {string} input - textual IPv4 or IPv6 address.
 * @returns {ipaddr.IPv4 | ipaddr.IPv6 | undefined} the parsed address, or `undefined` when unparseable.
 */
export function parseAddress(input) {
	let parsed
	try {
		parsed = ipaddr.parse(stripIpv6Brackets(input))
	} catch {
		return undefined
	}
	if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) return parsed.toIPv4Address()
	return parsed
}

/**
 * Whether an address is globally reachable unicast — the stock provider's rule.
 *
 * @param {string} input - textual IPv4 or IPv6 address.
 * @returns {boolean} true only for a public unicast destination.
 */
export function isPublicAddress(input) {
	const parsed = parseAddress(input)
	return parsed !== undefined && parsed.range() === 'unicast'
}

/**
 * Whether a parsed address falls inside one of the compiled ranges of its family.
 *
 * @param {ipaddr.IPv4 | ipaddr.IPv6} parsed - the address to test.
 * @param {ReturnType<typeof parseCidrList>} ranges - ranges of one address family.
 * @returns {boolean} true when the address is inside `ranges`.
 */
export function matchesAnyRange(parsed, ranges) {
	return ranges.some((range) => parsed.kind() === range.address.kind() && parsed.match(range.address, range.prefixLength))
}

/**
 * Classify one resolved address against the allowlist.
 *
 * `public` addresses need no allowance; `fake-ip` addresses are non-public but
 * inside the configured pool and are exactly what a fake-IP proxy can route;
 * everything else is `blocked` — loopback, RFC 1918, link-local, carrier-grade
 * NAT, unique-local space outside the pool, and so on.
 *
 * @param {string} input - textual IPv4 or IPv6 address.
 * @param {{ fakeIpV4: ReturnType<typeof parseCidrList>, fakeIpV6: ReturnType<typeof parseCidrList> }} allowlist - compiled allowance.
 * @returns {'invalid' | 'public' | 'fake-ip' | 'blocked'} the verdict.
 */
export function classifyAddress(input, allowlist) {
	const parsed = parseAddress(input)
	if (parsed === undefined) return 'invalid'
	if (parsed.range() === 'unicast') return 'public'
	const ranges = parsed.kind() === 'ipv4' ? allowlist.fakeIpV4 : allowlist.fakeIpV6
	return matchesAnyRange(parsed, ranges) ? 'fake-ip' : 'blocked'
}
