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
