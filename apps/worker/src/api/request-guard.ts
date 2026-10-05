const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * CSRF guard for state-changing requests. Returns a rejection response, or
 * null when the request may proceed.
 */
export function guardRequest(request: Request): Response | null {
  if (SAFE_METHODS.has(request.method)) return null;

  const fetchSite = request.headers.get("Sec-Fetch-Site");
  const origin = request.headers.get("Origin");
  if (fetchSite === null && origin === null) return reject(403, "missing_origin_signal");
  if (fetchSite !== null && fetchSite !== "same-origin") return reject(403, "cross_site");
  if (origin !== null && origin !== new URL(request.url).origin) return reject(403, "origin_mismatch");

  if (request.method === "POST") {
    const contentType = request.headers.get("Content-Type") ?? "";
    const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") return reject(415, "json_required");
  }
  return null;
}

function reject(status: number, error: string): Response {
  return Response.json({ error }, { status });
}
