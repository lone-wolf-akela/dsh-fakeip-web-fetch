# dsh-fakeip-web-fetch

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai) 插件包：让 `web_fetch` 工具在 **fake-IP** DNS 环境下继续可用，适用于 Clash/mihomo、OpenClash、sing-box、Surge 等所有从保留地址池里回答被代理域名的方案。

```
Error: URL hostname "cn-sec.com" resolves to a non-public IP address
```

这条报错来自 DSH 自带匿名抓取提供方的 SSRF 防护：只要主机名解析出非公网地址就整组拒绝，避免模型选的 URL 打到本机或内网服务。而 fake-IP 解析器会对**每一个被代理的域名**都从保留池（通常是 `198.18.0.0/15`）里给出地址，于是整个 web 都被拦掉。

本插件包保留上游提供方本身，只把「非公网」这条规则放宽一处：落在本地 fake-IP 池里的地址予以放行。回环、RFC 1918、链路本地、运营商级 NAT、组播、池外的唯一本地地址等，照旧拒绝。

## 改了什么

| | 上游 `@deepseek-ai/dsh-web-fetch-http` | 本插件包 |
|---|---|---|
| 地址解析 | 一次解析，全部地址必须是公网单播 | 相同，另加配置的 fake-IP 池 |
| 传输、地址钉扎 | Undici agent 固定到已校验地址 | 不变（直接用上游类） |
| 重定向 | 仅同源，有跳数上限 | 不变 |
| 字节/字符上限、字符集、内容类型 | 上游默认值 | 同名 Config 字段、同默认值 |
| 与 web 工具的对接 | 以 `http` 为提供方 id 注册 | 仍是 `http` |

提供方是用上游的 `HttpFetchProvider` 类实例化出来的，不是复制：插件包把上游那一行禁用、插入自己的一行，再由自己的插件把自定义 resolver 传给上游类。若未来 DSH 版本不再导出该类，激活会给出明确诊断，而不是静默降级。

## 地址策略

放行：

* 公网单播地址（`range() === 'unicast'`），与原来一致；
* 落在 `fakeIpV4Cidrs` 内的地址，默认 `198.18.0.0/15`（RFC 2544 基准测试段；OpenClash 默认的 `198.18.0.1/16` 与 sing-box 的 `198.18.0.0/15` 都是它的子集）；
* 落在 `fakeIpV6Cidrs` 内的地址，默认 `64:ff9b::/96`（mihomo/OpenClash 常把 NAT64 前缀当作双栈 fake 池，与 IPv4 池同序号配对）、`fdfe:dcba:9876::/64`（mihomo 文档中的 `fake-ip-range6`）与 `fc00::/18`（sing-box 及部分 OpenClash 模板）；
* 上述地址的 IPv4-mapped IPv6 写法（`::ffff:198.18.0.63`）。

仍然拒绝：

* 回环（`127.0.0.0/8`、`::1`）、未指定地址（`0.0.0.0`）、组播、广播；
* RFC 1918 私网、运营商级 NAT（`100.64.0.0/10`）、链路本地（`169.254.0.0/16`、`fe80::/10`）；
* 池外唯一本地地址 —— 例如按上面的默认池，路由器自身的 `fd51:661b:432e::1` 会被拒绝；
* 标准 NAT64 前缀 `64:ff9b::/96`，以及任何被探测到的 DNS64 前缀中内嵌非公网 IPv4 的地址；
* 一切格式非法或不一致的解析结果。

整组拒绝语义保留：只要有一条地址被拒，整个应答作废，恶意 DNS 无法把一个内网地址夹在公网地址旁混进来。

## 安装

已发布到 npm 时：

```bash
dsh plugin --profile <profile> add @lone-wolf-akela/dsh-fakeip-web-fetch
```

从本地目录安装：在 Harness Web UI 的 **设置 → 插件 → 安装插件包** 中选择本目录的绝对路径（Plugin Manager 会以链接方式安装），随后重启该 profile，让补丁层生效。

插件包会把自身追加到 `dsh.profile.bundles`（其中的层在所有内置 bundle 之后应用），并贡献以下补丁：

```yaml
- id: web-fetch-http
  name: "@deepseek-ai/dsh-web-fetch-http"
  disabled: true

- insert:
    - id: web-fetch-fakeip
      name: "@lone-wolf-akela/dsh-fakeip-web-fetch"
```

提供方 id 仍是 `http`，所以 `web` 行里的 `fetchProvider: http` 以及任何钉住 `http` 的用户配置继续有效。原先针对 `web-fetch-http` 行的自定义配置需要搬到 `web-fetch-fakeip` 行 —— 补丁是整段替换 `config`，不会深合并。

## 配置

全部字段可省略，空 `config` 即可工作。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `fakeIpV4Cidrs` | `['198.18.0.0/15']` | fake-IP 解析器可能给出的 IPv4 池 |
| `fakeIpV6Cidrs` | `['64:ff9b::/96', 'fdfe:dcba:9876::/64', 'fc00::/18']` | fake-IP 解析器可能给出的 IPv6 池 |
| `maxResponseBytes` | `5000000` | 响应体字节上限 |
| `maxBodyChars` | `100000` | 解码后字符上限 |
| `timeoutMs` | `30000` | 抓取超时 |
| `maxRedirects` | `5` | 同源重定向上限（`0` 表示不跟随） |
| `userAgent` | 上游默认值 | 每次请求的 `User-Agent` |

覆盖示例：

```yaml
- id: web-fetch-fakeip
  name: "@lone-wolf-akela/dsh-fakeip-web-fetch"
  config:
    fakeIpV4Cidrs: ['198.18.0.0/15']
    fakeIpV6Cidrs: ['fd00:1:2::/64']
    timeoutMs: 60000
```

### 对齐你的解析器地址池

默认值覆盖常见部署。请用下面两条命令确认你的解析器实际给出的地址，再按需调整：

```bash
# IPv4 池
nslookup www.google.com            # 例如 198.18.0.5
# IPv6 池（仅当解析器真的返回 AAAA 时才有答复）
nslookup -type=AAAA www.google.com # 例如 fdfe:dcba:9876::5
```

* **Clash / mihomo**：`dns.fake-ip-range` 与 `dns.fake-ip-range6`。
* **OpenClash**：`覆写设置 → DNS`（Fake-IP 范围）中的同名项，或生成的 `config.yaml`。
* **sing-box**：`fakeip` DNS 服务器中的 `inet4_range` / `inet6_range`。

## 安全说明

上游这条防护存在的意义，是让模型挑选的 URL 无法访问本机或局域网服务。把校验放宽到 fake-IP 池是一次有意的、写明了的例外：这些地址除了经由本地代理内核映射回域名之外，没有任何路由可达性。

请把地址池收窄到解析器真正使用的范围。尤其**不要**用 `fc00::/7` 作为 IPv6 的通配放行：该段包含局域网设备（含路由器）真实的唯一本地地址，等于把这条防护原本堵上的洞重新打开。

抓取仍是匿名的：不带 Cookie、不带环境凭据、不带浏览器会话里的任何请求头。

## 已知限制

* 依赖 `@deepseek-ai/dsh-web-fetch-http` 导出 `HttpFetchProvider`；不导出时本插件包激活失败并给出诊断。
* `ipaddr.js` 把 `64:ff9b::/96` 归类为 NAT64 而非单播，因此标准 NAT64 前缀即使在转换后是公网 IPv4 也会被拒绝 —— 与上游一致。
* 仅当解析器返回 AAAA 时 IPv6 池才会生效；代理侧关闭 IPv6 时，提供方根本收不到 AAAA 地址。
* 若 fake 池借用了 `64:ff9b::/96`，而网络里 DNS64 真的生效，该前缀内嵌私网 IPv4 的地址会被 NAT64 校验拒绝，于是这个 fake 池在该网络下不再可用。
* 本插件包替换了提供方；其他插件包或用户补丁若引用上游行 id 的配置，需要改到新的行 id。

## 开发

```bash
npm install
npm test
```

`test/unit.mjs` 用注入的 `dns.lookup` 覆盖地址策略与解析器；插件入口只在激活时才会用到 Harness 运行时。

## 许可

MIT。`lib/address-policy.js` 中的解析逻辑派生自 `@deepseek-ai/dsh-web-fetch-http`（MIT，Copyright (c) DeepSeek），详见 [NOTICE](NOTICE)。
