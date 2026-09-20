const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|ref_url|source|s|t|si|cmpid|_hsenc|_hsmi)$/i;

/**
 * Canonical form used to recognise several items pointing at one origin:
 * https, lowercase host without `www.`, x.com for Twitter, no tracking
 * parameters, no fragment, no trailing slash. Returns null for non-HTTP input.
 */
export function canonicalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.protocol = "https:";
  url.hash = "";
  url.username = "";
  url.password = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^(mobile\.)?twitter\.com$/, "x.com");
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  const canonical = url.toString();
  return url.pathname === "/" && !url.search ? canonical.replace(/\/$/, "") : canonical;
}

export function canonicalLinks(urls: readonly string[], exclude?: string): string[] {
  const seen = new Set<string>();
  for (const raw of urls) {
    const canonical = canonicalizeUrl(raw);
    if (canonical && canonical !== exclude) seen.add(canonical);
  }
  return [...seen];
}
