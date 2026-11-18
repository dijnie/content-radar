function denied(status: number, error: string) {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function checkOperatorPassword(request: Request, PASSWORD?: string): Promise<Response | null> {
  if (!PASSWORD) return denied(503, "password_not_configured");
  const credentials = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (!credentials) return denied(401, "password_required");
  let supplied: Uint8Array<ArrayBuffer>;
  try {
    supplied = Uint8Array.from(atob(credentials), character => character.charCodeAt(0));
  } catch {
    return denied(403, "invalid_password");
  }
  const [expected, received] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(`settings:${PASSWORD}`)),
    crypto.subtle.digest("SHA-256", supplied),
  ]);
  if (!crypto.subtle.timingSafeEqual(expected, received)) {
    return denied(403, "invalid_password");
  }
  return null;
}
