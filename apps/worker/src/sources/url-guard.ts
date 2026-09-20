// Guard for URLs that come from crawled content (feed entries, redirects).
// Workers cannot resolve DNS, so this is a syntactic check: it blocks literal
// internal addresses and the Worker's own hostnames, not DNS rebinding.

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

function isBlockedIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || // "this" network
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224 // multicast and reserved
  );
}

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

export function checkOutboundUrl(raw: string | URL, ownHosts: readonly string[] = []): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "scheme_not_allowed" };
  if (url.username || url.password) return { ok: false, reason: "credentials_in_url" };

  // The URL parser already canonicalizes decimal, octal and hex IPv4 forms.
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  // Every IPv6 literal is refused: no configured source needs one, and it
  // removes loopback, link-local, unique-local and IPv4-mapped forms at once.
  if (host.startsWith("[")) return { ok: false, reason: "ipv6_literal" };
  if (IPV4_LITERAL.test(host)) return isBlockedIpv4(host) ? { ok: false, reason: "internal_address" } : { ok: true, url };
  if (!host.includes(".")) return { ok: false, reason: "dotless_host" };
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: "internal_address" };
  }
  if (host === "workers.dev" || host.endsWith(".workers.dev")) return { ok: false, reason: "workers_dev" };
  if (ownHosts.some((own) => own.toLowerCase() === host)) return { ok: false, reason: "own_host" };
  return { ok: true, url };
}
