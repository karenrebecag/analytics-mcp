/**
 * What this server is allowed to fetch.
 *
 * Configuration IS the allowlist: hosts come only from the site's own bindings,
 * so no tool argument can reach a host the operator never configured.
 */
import type { Site } from '../sources/types.js';

const LOOPBACK_HOSTS = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);
const PRIVATE_SUFFIXES = ['.local', '.internal', '.localdomain', '.home.arpa'];

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

function isIpLiteral(hostname: string): boolean {
  // URL keeps IPv6 in brackets; IPv4 is four dotted numbers.
  return hostname.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

function isPrivateName(hostname: string): boolean {
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  return PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

/**
 * A Search Console `sc-domain:` property covers every subdomain, so a page that
 * ranks under www is inside the binding the operator configured. Domain scope
 * is returned separately from exact hosts because the two are matched
 * differently, and conflating them is how a suffix check turns into a hole.
 */
export interface AllowedHosts {
  exact: Set<string>;
  domains: Set<string>;
}

export function allowedHostsForSite(site: Site): AllowedHosts {
  const exact = new Set<string>();
  const domains = new Set<string>();

  const { ga4, cloudflare, gsc } = site.sources;
  for (const host of [ga4?.host, cloudflare?.host, gsc?.host]) {
    if (host) exact.add(normalizeHost(host));
  }

  const siteUrl = gsc?.siteUrl?.trim();
  if (siteUrl) {
    if (siteUrl.toLowerCase().startsWith('sc-domain:')) {
      domains.add(normalizeHost(siteUrl.slice('sc-domain:'.length)));
    } else {
      try {
        exact.add(normalizeHost(new URL(siteUrl).hostname));
      } catch {
        // An unparseable siteUrl contributes nothing rather than everything.
      }
    }
  }

  return { exact, domains };
}

export function isAllowedHost(hostname: string, hosts: AllowedHosts): boolean {
  const host = normalizeHost(hostname);
  if (hosts.exact.has(host)) return true;
  // The dot is what makes this safe: 'evil-example.com' does not end with
  // '.example.com', so it never matches a domain-scoped binding.
  return [...hosts.domains].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * Runs before any socket is opened. Throws rather than returning a flag so a
 * caller cannot forget to check.
 */
export function assertFetchable(rawUrl: string, hosts: AllowedHosts): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'https:') {
    throw new Error(`Only https pages can be fetched, got '${url.protocol}'.`);
  }
  if (url.username || url.password) {
    throw new Error('URLs carrying credentials are never fetched.');
  }
  if (isIpLiteral(url.hostname) || isPrivateName(url.hostname)) {
    throw new Error('Refusing to fetch a private or literal-address host.');
  }
  if (!isAllowedHost(url.hostname, hosts)) {
    const known = [...hosts.exact, ...[...hosts.domains].map((d) => `*.${d}`)].join(', ');
    throw new Error(
      `Host '${url.hostname}' is not bound to this site. Configured: ${known || '(none)'}`,
    );
  }
  return url;
}

/**
 * A name inside the allowlist can still point somewhere it has no business
 * pointing. A forgotten subdomain with a dangling DNS record, or a wildcard
 * nobody audits, resolves to whatever its owner chose — including an address on
 * the network this server runs in. The host check answers "is this ours"; only
 * the address answers "is this reachable from the outside too".
 */
export type HostLookup = (hostname: string) => Promise<Array<{ address: string }>>;

function ipv4IsPrivate(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return true; // Unparseable is refused, not trusted.
  const [a, b] = parts;
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 169 && b === 254) return true; // Link-local, and cloud metadata lives here.
  if (a === 100 && b >= 64 && b <= 127) return true; // Carrier-grade NAT.
  if (a === 198 && (b === 18 || b === 19)) return true;
  return a >= 224; // Multicast and reserved.
}

export function isPrivateAddress(address: string): boolean {
  const value = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0];
  if (value.includes('.') && !value.includes(':')) return ipv4IsPrivate(value);

  // An IPv4 address wearing an IPv6 costume is still that address.
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return ipv4IsPrivate(mapped[1]);

  if (value === '::' || value === '::1') return true;
  const head = value.split(':')[0];
  const first = head === '' ? 0 : Number.parseInt(head, 16);
  if (!Number.isFinite(first)) return true;
  if (first >= 0xfc00 && first <= 0xfdff) return true; // Unique local.
  if (first >= 0xfe80 && first <= 0xfebf) return true; // Link-local.
  return false;
}

/**
 * HACK: this validates the addresses a name resolves to now, and `fetch`
 * resolves again when it connects. An attacker holding a short TTL for a name
 * inside the allowlist can still move it between the two. Closing that means
 * pinning the connection to the address validated here, which needs an undici
 * Agent — a dependency SPEC §1 freezes out. Revisit when the platform exposes
 * connection pinning, or when this server is ever pointed at hosts the operator
 * does not control.
 */
export async function assertPublicAddress(hostname: string, lookup: HostLookup): Promise<void> {
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new Error(`Could not resolve '${hostname}'.`);
  }
  if (addresses.length === 0) throw new Error(`'${hostname}' resolves to nothing.`);

  // Every address, not the first: the client may pick any of them.
  const offender = addresses.find((entry) => isPrivateAddress(entry.address));
  if (offender) {
    throw new Error(
      `'${hostname}' resolves to a private address (${offender.address}); refusing to fetch it.`,
    );
  }
}
