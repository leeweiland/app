import crypto from "crypto";
import http2 from "http2";

// @capacitor/push-notifications hands iOS the raw APNs device token, not an
// FCM registration token — there's no Firebase iOS SDK in this app to do the
// APNs->FCM exchange, so firebase-admin's getMessaging().send({token}) can
// never work for iOS (it expects an FCM token, not a raw 64-hex-char APNs
// token). This talks to Apple's APNs HTTP/2 API directly instead, using a
// provider auth JWT signed with an APNs Auth Key (.p8) — no extra npm
// dependency needed, Node's built-in crypto/http2 cover it.

const APNS_HOST = "https://api.push.apple.com"; // production gateway — matches ios-config/App.entitlements' aps-environment=production
const BUNDLE_ID = "com.pacificrimathleticsapp.app";
const TOKEN_MAX_AGE_MS = 55 * 60 * 1000; // Apple allows ~60min reuse; refresh a bit early

let cachedToken = null; // { jwt, iat }

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function apnsConfigured() {
  return !!(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_AUTH_KEY_B64);
}

function getApnsJwt() {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const keyB64 = process.env.APNS_AUTH_KEY_B64;
  if (!keyId || !teamId || !keyB64) {
    throw new Error("APNs not configured (APNS_KEY_ID / APNS_TEAM_ID / APNS_AUTH_KEY_B64 missing)");
  }
  const now = Date.now();
  if (cachedToken && now - cachedToken.iat < TOKEN_MAX_AGE_MS) return cachedToken.jwt;

  const privateKey = Buffer.from(keyB64, "base64").toString("utf8");
  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const payload = base64url(JSON.stringify({ iss: teamId, iat }));
  const signingInput = `${header}.${payload}`;
  // Apple requires the raw IEEE-P1363 (r||s) signature format, not the
  // DER encoding crypto.sign() produces by default.
  const signature = crypto.sign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" });
  const jwt = `${signingInput}.${base64url(signature)}`;
  cachedToken = { jwt, iat: now };
  return jwt;
}

export function sendApnsPush(deviceToken, { title, body, conversationId } = {}) {
  return new Promise((resolve, reject) => {
    let jwt;
    try { jwt = getApnsJwt(); } catch (e) { reject(e); return; }

    const client = http2.connect(APNS_HOST);
    client.on("error", reject);

    const payload = JSON.stringify({
      aps: { alert: { title, body }, sound: "default" },
      conversationId: String(conversationId || ""),
    });

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": BUNDLE_ID,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    });

    let responseBody = "";
    let status = null;
    req.on("response", (headers) => { status = headers[":status"]; });
    req.setEncoding("utf8");
    req.on("data", (chunk) => { responseBody += chunk; });
    req.on("end", () => {
      client.close();
      if (status === 200) { resolve({ ok: true }); return; }
      let reason = responseBody;
      try { reason = JSON.parse(responseBody).reason || responseBody; } catch {}
      reject(Object.assign(new Error(`APNs ${status}: ${reason}`), { status, reason }));
    });
    req.on("error", (e) => { client.close(); reject(e); });
    req.write(payload);
    req.end();
  });
}
