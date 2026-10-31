/**
 * `web-fetch-fakeip` — the anonymous public HTTP(S) fetch provider for the
 * `ctx.web` seam, kept compatible with a fake-IP DNS.
 *
 * The stock provider (`@deepseek-ai/dsh-web-fetch-http`) refuses any hostname
 * that resolves to a non-public address. That is the right default for a direct
 * connection, but a fake-IP resolver answers every proxied hostname from a
 * reserved pool (198.18.0.0/15, ULA space, ...), so behind Clash/mihomo,
 * OpenClash, sing-box or Surge every fetch fails with
 * `URL hostname "..." resolves to a non-public IP address`.
 *
 * This provider is the stock class with a resolver that additionally accepts the
 * configured fake-IP pools. Everything else — transport, address pinning,
 * same-origin redirects, byte/character caps, charset decoding and error codes —
 * is the upstream implementation, so only the address policy differs.
 *
 * @module dsh-fakeip-web-fetch
 */
import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import * as webFetchHttp from '@deepseek-ai/dsh-web-fetch-http'
import { AddressRejected, createAddressResolver } from './address-policy.js'
import { DEFAULT_FAKE_IPV4_CIDRS, DEFAULT_FAKE_IPV6_CIDRS } from './cidr.js'

/** Node coerces larger timer delays to 1 ms, so a longer one is rejected at configuration time. */
const MAX_NODE_TIMER_DELAY_MS = 2147483647
/** The upstream default `User-Agent`, restated only when the package stops exporting it. */
const FALLBACK_USER_AGENT = 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-fetch-fakeip'
/** The web seam this provider registers into. */
export const inject = ['web']

/**
 * Provider configuration: the stock limits plus the fake-IP pools this
 * deployment's resolver hands out.
 */
export const Config = z.object({
	maxResponseBytes: z.number().default(5000000),
	maxBodyChars: z.number().default(100000),
	timeoutMs: z.number().default(30000),
	maxRedirects: z.number().default(5),
	userAgent: z.string().default(webFetchHttp.DEFAULT_USER_AGENT ?? FALLBACK_USER_AGENT),
	fakeIpV4Cidrs: z.array(z.string()).default(DEFAULT_FAKE_IPV4_CIDRS),
	fakeIpV6Cidrs: z.array(z.string()).default(DEFAULT_FAKE_IPV6_CIDRS)
})

/**
 * A resource limit must be a positive finite number.
 *
 * @param {string} field - Config field name.
 * @param {number} value - resolved value.
 * @returns {void}
 */
function assertPositiveFinite(field, value) {
	if (!Number.isFinite(value) || value <= 0) throw new Error(`web-fetch-fakeip: ${field} must be a positive finite number`)
}

/**
 * The timeout must also fit Node's timer range.
 *
 * @param {number} value - resolved `timeoutMs`.
 * @returns {void}
 */
function assertTimeoutMs(value) {
	assertPositiveFinite('timeoutMs', value)
	if (value > MAX_NODE_TIMER_DELAY_MS) throw new Error(`web-fetch-fakeip: timeoutMs must be no greater than ${MAX_NODE_TIMER_DELAY_MS}`)
}

/**
 * The redirect hop cap must be a non-negative integer (0 follows no redirects).
 *
 * @param {string} field - Config field name.
 * @param {number} value - resolved value.
 * @returns {void}
 */
function assertNonNegativeInteger(field, value) {
	if (!Number.isInteger(value) || value < 0) throw new Error(`web-fetch-fakeip: ${field} must be a non-negative integer`)
}

/**
 * Register the fake-IP-aware provider with `ctx.web`.
 *
 * The provider keeps the stock id `http`, so `fetchProvider: http` in the `web`
 * row and any user configuration that pins `http` keep working; the bundle
 * disables the stock row instead of letting two providers register the same id.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} config - resolved provider configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
	const resolved = /** @type {Record<string, any>} */ (config)
	const HttpFetchProvider = webFetchHttp.HttpFetchProvider
	if (typeof HttpFetchProvider !== 'function') {
		throw new Error('web-fetch-fakeip: @deepseek-ai/dsh-web-fetch-http does not export HttpFetchProvider; the installed DSH version is not supported by this bundle')
	}
	assertPositiveFinite('maxResponseBytes', resolved.maxResponseBytes)
	assertPositiveFinite('maxBodyChars', resolved.maxBodyChars)
	assertTimeoutMs(resolved.timeoutMs)
	assertNonNegativeInteger('maxRedirects', resolved.maxRedirects)
	const limits = {
		maxResponseBytes: resolved.maxResponseBytes,
		maxBodyChars: resolved.maxBodyChars,
		timeoutMs: resolved.timeoutMs,
		maxRedirects: resolved.maxRedirects,
		userAgent: resolved.userAgent
	}
	// Parsing here reports a bad CIDR as an activation diagnostic instead of a
	// fetch failure later, and compiles the allowlist once per activation.
	const resolveAddresses = createAddressResolver(resolved)
	const provider = new HttpFetchProvider(limits, async (hostname, signal) => {
		try {
			return await resolveAddresses(hostname, signal)
		} catch (error) {
			if (error instanceof AddressRejected) throw new WebError(error.message, error.code, { cause: error })
			throw error
		}
	})
	ctx.effect(() => ctx.web.registerFetchProvider(provider), 'web-fetch-fakeip.registerFetchProvider()')
}
