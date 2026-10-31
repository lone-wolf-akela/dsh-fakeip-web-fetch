/**
 * Unit tests for the fake-IP address policy and resolver. They run on plain Node
 * (`node test/unit.mjs`) because these modules depend only on `ipaddr.js` and the
 * built-in DNS client — the plugin entry is what needs a Harness runtime.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyAddress, createAllowlist, isPublicAddress, parseCidrList } from '../lib/cidr.js'
import { AddressRejected, createAddressResolver } from '../lib/address-policy.js'

/** Build one `dns.lookup(..., { all: true })` answer entry. */
const answer = (address, family) => ({ address, family })

/** An AbortSignal that never fires, which is what a normal fetch passes. */
const live = () => new AbortController().signal

/**
 * A fake `dns.lookup` serving a fixed table, recording every hostname it was asked about.
 *
 * @param {Record<string, Array<{ address: string, family: number }>>} table - hostname to answers.
 * @returns {Function & { calls: string[] }} the fake lookup.
 */
function lookupOf(table) {
	const calls = []
	const lookup = async (hostname) => {
		calls.push(hostname)
		const entries = table[hostname]
		if (entries === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })
		return entries
	}
	lookup.calls = calls
	return lookup
}

test('default allowlist accepts the Clash/mihomo pool and nothing else non-public', () => {
	const allow = createAllowlist({})
	assert.equal(classifyAddress('198.18.0.5', allow), 'fake-ip')
	assert.equal(classifyAddress('198.18.0.94', allow), 'fake-ip')
	assert.equal(classifyAddress('198.19.255.255', allow), 'fake-ip')
	assert.equal(classifyAddress('104.21.74.197', allow), 'public')
	assert.equal(classifyAddress('192.168.1.1', allow), 'blocked')
	assert.equal(classifyAddress('10.0.0.5', allow), 'blocked')
	assert.equal(classifyAddress('127.0.0.1', allow), 'blocked')
	assert.equal(classifyAddress('100.64.0.1', allow), 'blocked')
	assert.equal(classifyAddress('169.254.1.1', allow), 'blocked')
	assert.equal(classifyAddress('0.0.0.0', allow), 'blocked')
	assert.equal(classifyAddress('198.20.0.1', allow), 'public')
	assert.equal(classifyAddress('not-an-address', allow), 'invalid')
})

test('IPv4-mapped IPv6 is classified by its embedded IPv4 address', () => {
	const allow = createAllowlist({})
	assert.equal(classifyAddress('::ffff:198.18.0.63', allow), 'fake-ip')
	assert.equal(classifyAddress('::ffff:192.168.1.1', allow), 'blocked')
})

test('default IPv6 allowlist covers mihomo and sing-box fake pools, not a LAN ULA', () => {
	const allow = createAllowlist({})
	assert.equal(classifyAddress('fdfe:dcba:9876::1', allow), 'fake-ip')
	assert.equal(classifyAddress('fc00::1', allow), 'fake-ip')
	assert.equal(classifyAddress('fc00:3fff::1', allow), 'fake-ip')
	assert.equal(classifyAddress('fd51:661b:432e::1', allow), 'blocked')
	assert.equal(classifyAddress('fd00:1234::1', allow), 'blocked')
	assert.equal(classifyAddress('fe80::1', allow), 'blocked')
	assert.equal(classifyAddress('2001:4860:4860::8888', allow), 'public')
	assert.equal(classifyAddress('[::1]', allow), 'blocked')
})

test('isPublicAddress follows the stock provider rule', () => {
	assert.equal(isPublicAddress('8.8.8.8'), true)
	assert.equal(isPublicAddress('198.18.0.5'), false)
	assert.equal(isPublicAddress('192.168.1.1'), false)
	assert.equal(isPublicAddress('junk'), false)
})

test('CIDR lists are validated loudly', () => {
	assert.throws(() => parseCidrList('198.18.0.0/15', 'fakeIpV4Cidrs'), TypeError)
	assert.throws(() => parseCidrList([''], 'fakeIpV4Cidrs'), /empty CIDR/)
	assert.throws(() => parseCidrList(['300.0.0.0/8'], 'fakeIpV4Cidrs'), /not a valid CIDR/)
	assert.throws(() => createAddressResolver({ fakeIpV4Cidrs: ['nope'] }), /not a valid CIDR/)
})

test('a configured pool replaces the default pool', () => {
	const allow = createAllowlist({ fakeIpV4Cidrs: ['10.0.0.0/8'], fakeIpV6Cidrs: [] })
	assert.equal(classifyAddress('10.1.2.3', allow), 'fake-ip')
	assert.equal(classifyAddress('198.18.0.5', allow), 'blocked')
	assert.equal(classifyAddress('fdfe:dcba:9876::1', allow), 'blocked')
})

test('resolver keeps a fake-IP answer and reports its addresses for pinning', async () => {
	const lookup = lookupOf({ 'github.com': [answer('198.18.0.94', 4)] })
	const resolve = createAddressResolver({}, { lookup })
	assert.deepEqual(await resolve('github.com', live()), [answer('198.18.0.94', 4)])
	assert.deepEqual(lookup.calls, ['github.com'])
})

test('resolver still refuses private and loopback answers', async () => {
	const resolve = createAddressResolver({}, { lookup: lookupOf({ 'lan.example': [answer('10.0.0.5', 4)] }) })
	await assert.rejects(
		() => resolve('lan.example', live()),
		(error) => error instanceof AddressRejected && error.code === 'WEB_BLOCKED_URL' && /non-public IP address/.test(error.message)
	)
	const loopback = createAddressResolver({}, { lookup: lookupOf({ 'loop.example': [answer('127.0.0.1', 4)] }) })
	await assert.rejects(() => loopback('loop.example', live()), /non-public IP address/)
})

test('one refused address refuses the whole answer set', async () => {
	const mixed = createAddressResolver({}, {
		lookup: lookupOf({ 'mixed.example': [answer('198.18.0.5', 4), answer('192.168.1.10', 4)] })
	})
	await assert.rejects(() => mixed('mixed.example', live()), /non-public IP address/)
	const good = createAddressResolver({}, {
		lookup: lookupOf({ 'good.example': [answer('104.21.74.197', 4), answer('198.18.0.5', 4)] })
	})
	assert.deepEqual(
		await good('good.example', live()),
		[answer('104.21.74.197', 4), answer('198.18.0.5', 4)]
	)
})

test('unusable DNS answers keep the upstream error codes', async () => {
	const empty = createAddressResolver({}, { lookup: async () => [] })
	await assert.rejects(
		() => empty('empty.example', live()),
		(error) => error.code === 'WEB_PROVIDER_ERROR' && /resolved to no addresses/.test(error.message)
	)
	const broken = createAddressResolver({}, { lookup: async () => [answer('not-an-ip', 4)] })
	await assert.rejects(
		() => broken('broken.example', live()),
		(error) => error.code === 'WEB_PROVIDER_ERROR' && /invalid IP address/.test(error.message)
	)
})

test('IP literals are classified without a lookup', async () => {
	// An IPv6 fake-IP literal still triggers NAT64 prefix discovery, exactly as
	// the stock resolver does; that lookup is not part of classifying the literal.
	const lookup = lookupOf({ 'ipv4only.arpa': [answer('223.5.5.5', 4)] })
	const resolve = createAddressResolver({}, { lookup })
	assert.deepEqual(await resolve('198.18.0.63', live()), [answer('198.18.0.63', 4)])
	assert.deepEqual(await resolve('[fdfe:dcba:9876::1]', live()), [answer('fdfe:dcba:9876::1', 6)])
	await assert.rejects(() => resolve('127.0.0.1', live()), /non-public IP address/)
	// The only DNS query is the RFC 7050 probe; the literals themselves were never resolved.
	assert.deepEqual(lookup.calls, ['ipv4only.arpa'])
})

test('NAT64 answers that translate to a non-public IPv4 are refused', async () => {
	// A DNS64 prefix inside global unicast space: ipaddr.js sees a public IPv6
	// address, and only the translation check catches the private IPv4 inside.
	const prefix = '2a00:1450:4000::'
	const table = {
		'ipv4only.arpa': [answer(`${prefix}c000:aa`, 6)],
		'private.example': [answer(`${prefix}7f00:1`, 6)],
		'public.example': [answer(`${prefix}808:808`, 6)]
	}
	const resolve = createAddressResolver({}, { lookup: lookupOf(table) })
	await assert.rejects(
		() => resolve('private.example', live()),
		(error) => error.code === 'WEB_BLOCKED_URL' && /NAT64/.test(error.message)
	)
	assert.deepEqual(await resolve('public.example', live()), [answer(`${prefix}808:808`, 6)])
})

test('the standard NAT64 prefix stays refused as a non-public destination', async () => {
	const table = {
		'ipv4only.arpa': [answer('64:ff9b::c000:aa', 6)],
		'nat64.example': [answer('64:ff9b::808:808', 6)]
	}
	const resolve = createAddressResolver({}, { lookup: lookupOf(table) })
	await assert.rejects(
		() => resolve('nat64.example', live()),
		(error) => error.code === 'WEB_BLOCKED_URL' && /non-public IP address/.test(error.message)
	)
})

test('an IPv6 fake-IP answer is accepted', async () => {
	const table = {
		'ipv4only.arpa': [answer('223.5.5.5', 4)],
		'v6.example': [answer('fdfe:dcba:9876::1', 6)]
	}
	const resolve = createAddressResolver({}, { lookup: lookupOf(table) })
	assert.deepEqual(await resolve('v6.example', live()), [answer('fdfe:dcba:9876::1', 6)])
})

test('a cancelled fetch stops waiting for hostname resolution', async () => {
	const controller = new AbortController()
	const slow = () => new Promise(() => {})
	const resolve = createAddressResolver({}, { lookup: slow })
	const pending = resolve('slow.example', controller.signal)
	controller.abort(new Error('cancelled'))
	await assert.rejects(() => pending, /aborted during hostname resolution/)
})
