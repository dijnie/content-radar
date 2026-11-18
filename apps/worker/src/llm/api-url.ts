/** Accept a provider base URL or the full chat URL used by existing deployments. */
export function providerUrl(value: string, resource: "chat/completions" | "embeddings"): URL {
  const url = new URL(value.trim());
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("invalid provider URL");
  }
  const base = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  url.pathname = `${base}/${resource}`;
  return url;
}
