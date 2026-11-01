# dsh-fakeip-web-fetch

A [DeepSeek Harness](https://github.com/deepseek-ai) bundle that keeps the `web_fetch` tool working behind a **fake-IP** DNS — Clash/mihomo, OpenClash, sing-box, Surge, and anything else that answers proxied hostnames from a reserved pool.

```
Error: URL hostname "cn-sec.com" resolves to a non-public IP address
```

That error is DSH's stock anonymous fetch provider doing its job: it refuses any hostname that resolves to a non-public address, so a URL the model picked cannot reach a loopback or LAN service. A fake-IP resolver, however, answers *every proxied hostname* from a reserved pool — usually `198.18.0.0/15` — so the guard rejects the entire web.

This bundle swaps that provider for the same upstream provider class with one widened rule: a non-public address is accepted when it belongs to the local fake-IP pool. Everything else — loopback, RFC 1918, link-local, carrier-grade NAT, multicast, unique-local space outside the pool — stays refused.

## What changes

| | Stock `@deepseek-ai/dsh-web-fetch-http` | This bundle |
|---|---|---|
| Resolver | one DNS answer set, every address must be public unicast | same, plus the configured fake-IP pools |
| Transport, address pinning | Undici agent pinned to the validated addresses | unchanged (upstream class) |
| Redirects | same-origin only, hop cap | unchanged |
| Byte / character caps, charset, content types | upstream defaults | same Config fields and defaults |
| Web tool integration | registered as provider `http` | still provider `http` |

The provider is instantiated from the upstream class, not copied: the bundle disables the stock row and inserts its own row, and the plugin passes the upstream `HttpFetchProvider` a resolver of its own. If a future DSH release removes that class, activation fails with a clear diagnostic instead of silently degrading.

## Address policy

Accepted:

* public unicast addresses (`range() === 'unicast'`), exactly as before;
* addresses inside `fakeIpV4Cidrs` — default `198.18.0.0/15` (RFC 2544 benchmarking space; OpenClash's default `198.18.0.1/16` and sing-box's `198.18.0.0/15` are subsets);
* addresses inside `fakeIpV6Cidrs` — default `64:ff9b::/96` (the NAT64 prefix mihomo/OpenClash reuse as a dual-stack fake pool, index-paired with the IPv4 pool), `fdfe:dcba:9876::/64` (mihomo's documented `fake-ip-range6`) and `fc00::/18` (sing-box and several OpenClash templates);
* IPv4-mapped IPv6 forms of the above (`::ffff:198.18.0.63`).

Still refused:

* loopback (`127.0.0.0/8`, `::1`), unspecified (`0.0.0.0`), multicast, broadcast;
* RFC 1918 private space, carrier-grade NAT (`100.64.0.0/10`), link-local (`169.254.0.0/16`, `fe80::/10`);
* unique-local IPv6 **outside** the configured pool — for example the router's own ULA, `fd51:661b:432e::1` with the defaults above;
* the standard NAT64 prefix `64:ff9b::/96`, and any discovered DNS64 prefix whose embedded IPv4 is non-public;
* every malformed or inconsistent answer.

One refused address refuses the whole answer set, so a hostile DNS answer cannot smuggle a private destination in next to a public one.

## Install

Published bundle:

```bash
dsh plugin --profile <profile> add @lone-wolf-akela/dsh-fakeip-web-fetch
```

From a checkout (no registry round trip), point the Plugin Manager at the package directory, or in the Harness Web UI: **Settings → Plugins → install bundle**, choosing the absolute path of this directory. Then restart the profile so the patch layer composes.

The bundle appends itself to `dsh.profile.bundles`, whose layers apply after the shipped bundles, and contributes:

```yaml
- id: web-fetch-http
  name: "@deepseek-ai/dsh-web-fetch-http"
  disabled: true

- insert:
    - id: web-fetch-fakeip
      name: "@lone-wolf-akela/dsh-fakeip-web-fetch"
```

Because the provider keeps the id `http`, `fetchProvider: http` in the `web` row and any user configuration that pins `http` keep resolving. Configuration that targeted the stock row (`web-fetch-http`) has to move to the `web-fetch-fakeip` row — a patch replaces a row's entire `config`, it does not merge.

## Configuration

All fields are optional; the row works with an empty `config`.

| Field | Default | Meaning |
|---|---|---|
| `fakeIpV4Cidrs` | `['198.18.0.0/15']` | IPv4 pools a fake-IP resolver may hand out |
| `fakeIpV6Cidrs` | `['64:ff9b::/96', 'fdfe:dcba:9876::/64', 'fc00::/18']` | IPv6 pools a fake-IP resolver may hand out |
| `maxResponseBytes` | `5000000` | response body cap |
| `maxBodyChars` | `100000` | decoded character cap |
| `timeoutMs` | `30000` | fetch timeout |
| `maxRedirects` | `5` | same-origin redirect hop cap (`0` follows none) |
| `userAgent` | upstream default | `User-Agent` sent with every request |

Example row override:

```yaml
- id: web-fetch-fakeip
  name: "@lone-wolf-akela/dsh-fakeip-web-fetch"
  config:
    fakeIpV4Cidrs: ['198.18.0.0/15']
    fakeIpV6Cidrs: ['fd00:1:2::/64']
    timeoutMs: 60000
```

### Matching your resolver's pool

The defaults cover the common deployments. Confirm what your resolver actually hands out, and set the pools to match it:

```bash
# IPv4 pool
nslookup www.google.com            # e.g. 198.18.0.5
# IPv6 pool (only answered when the resolver returns AAAA at all)
nslookup -type=AAAA www.google.com # e.g. fdfe:dcba:9876::5
```

* **Clash / mihomo**: `dns.fake-ip-range` and `dns.fake-ip-range6`.
* **OpenClash**: the same values under `覆写设置 → DNS` (Fake-IP 范围), or the generated `config.yaml`.
* **sing-box**: `inet4_range` / `inet6_range` under the `fakeip` DNS server.

## Security note

The stock guard exists so a URL chosen by a model cannot reach services on this machine or this LAN. Widening it to a fake-IP pool is a deliberate, documented exception: those addresses are not routable anywhere except through the local proxy core, which maps them back to the domain that was resolved.

Keep the pools as narrow as your resolver allows. In particular, do **not** use `fc00::/7` as a catch-all for IPv6: that block contains the real unique-local addresses of LAN devices (the router included) and would reopen exactly the hole the guard closes.

The fetch remains anonymous: no cookies, no ambient credentials, no request headers from the browser session.

## Known limitations

* Depends on `@deepseek-ai/dsh-web-fetch-http` exporting `HttpFetchProvider`; the bundle fails activation with a diagnostic when it does not.
* `ipaddr.js` classifies `64:ff9b::/96` as NAT64 rather than unicast, so the standard NAT64 prefix is refused even when it would translate to a public IPv4 — same as upstream.
* IPv6 pools take effect only when the resolver returns AAAA answers. With IPv6 disabled in the proxy, no AAAA address ever reaches the provider.
* A fake pool inside `64:ff9b::/96` and a genuinely active DNS64 share one prefix. When the provider discovers a DNS64 prefix, addresses in it that embed a private IPv4 fail the NAT64 check, so a fake pool there stops resolving on such a network.
* The bundle replaces the provider; other bundles or user patches that reference the stock row's config must move to the new row id.

## Development

```bash
npm install
npm test
```

`test/unit.mjs` covers the address policy and resolver with an injected `dns.lookup`; the plugin entry only pulls in a Harness runtime at activation.

## License

MIT. The resolution logic in `lib/address-policy.js` is derived from `@deepseek-ai/dsh-web-fetch-http` (MIT, Copyright (c) DeepSeek); see [NOTICE](NOTICE).
