import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "../env";

export type AccessResult =
  | { ok: true; email: string }
  | { ok: false; status: 401 | 403 | 503; reason: string };

// Errors that mean "this token is not acceptable". Anything else (network
// failure, non-200 from the certs endpoint, timeout) means the key set could
// not be loaded, which must fail closed with 503 rather than let a request in.
const REJECTED_TOKEN_CODES = new Set([
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_INVALID",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JOSE_ALG_NOT_ALLOWED",
]);

const keySets = new Map<string, JWTVerifyGetKey>();

function keySetFor(teamDomain: string): JWTVerifyGetKey {
  let keySet = keySets.get(teamDomain);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    keySets.set(teamDomain, keySet);
  }
  return keySet;
}

export async function verifyAccess(
  request: Request,
  env: Pick<Env, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD" | "OWNER_EMAIL">,
  keySetOverride?: JWTVerifyGetKey,
): Promise<AccessResult> {
  if (__DEV_AUTH_BYPASS__) return { ok: true, email: env.OWNER_EMAIL };

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.OWNER_EMAIL) {
    return { ok: false, status: 503, reason: "access_not_configured" };
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { ok: false, status: 401, reason: "missing_token" };

  try {
    // Resolved only now: building the key set needs a valid team domain, which was just checked.
    const keySet = keySetOverride ?? keySetFor(env.ACCESS_TEAM_DOMAIN);
    const { payload } = await jwtVerify(token, keySet, {
      algorithms: ["RS256"],
      issuer: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
      requiredClaims: ["exp"],
    });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (email !== env.OWNER_EMAIL.toLowerCase()) {
      return { ok: false, status: 403, reason: "not_owner" };
    }
    return { ok: true, email };
  } catch (err) {
    if (err instanceof errors.JOSEError && REJECTED_TOKEN_CODES.has(err.code)) {
      return { ok: false, status: 403, reason: err.code };
    }
    return { ok: false, status: 503, reason: "jwks_unavailable" };
  }
}
