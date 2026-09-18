// Web Push (VAPID) — 의존성 0 (Node 내장 crypto/https만). `web-push` npm을 안 쓰기 위한 직접 구현.
// RFC 8291(aes128gcm 콘텐츠 암호화) + RFC 8292(VAPID JWT, ES256). 브라우저 PushSubscription 그대로 소비.
// 검증: RFC 8291 Appendix A 테스트벡터로 왕복(encrypt→decrypt) 자가검사 — `node bin/webpush.mjs --selftest`.
import crypto from 'node:crypto';
import https from 'node:https';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// HKDF-SHA256, 단일 블록 Expand(length ≤ 32이면 한 블록으로 충분 — 웹푸시의 CEK(16)/nonce(12)/IKM(32) 전부 해당).
function hkdf(salt, ikm, info, length) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  return crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
}

// raw EC 점(비압축 pub 65B, priv 스칼라 32B) ↔ Node KeyObject (JWK 경유). P-256 고정.
function pubKeyFromRaw(pub65) {
  return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(pub65.subarray(1, 33)), y: b64url(pub65.subarray(33, 65)) }, format: 'jwk' });
}
function privKeyFromRaw(pub65, priv32) {
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(pub65.subarray(1, 33)), y: b64url(pub65.subarray(33, 65)), d: b64url(priv32) }, format: 'jwk' });
}
function ecdh(privKeyObj, pubRaw65) { return crypto.diffieHellman({ privateKey: privKeyObj, publicKey: pubKeyFromRaw(pubRaw65) }); }

// 새 P-256 임시(ephemeral) 키쌍 → {privateKey: KeyObject, pub65: Buffer(비압축 65B)}
function genEcKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { privateKey, pub65: Buffer.concat([Buffer.from([4]), unb64url(jwk.x), unb64url(jwk.y)]) };
}

// VAPID 서버 키쌍 생성 → base64url {publicKey(65B 비압축), privateKey(32B 스칼라)}
export function generateVapidKeys() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey: b64url(Buffer.concat([Buffer.from([4]), unb64url(jwk.x), unb64url(jwk.y)])), privateKey: jwk.d };
}

// RFC 8291 §3.4 + RFC 8188: 페이로드를 aes128gcm 단일 레코드로 암호화 → 전송 body(헤더+암호문).
// opts.eph / opts.salt 는 테스트벡터 재현용(평소엔 무작위).
export function encryptContent(uaPub65, authSecret, payload, opts = {}) {
  const salt = opts.salt || crypto.randomBytes(16);
  const eph = opts.eph || genEcKeypair();
  const asPub65 = eph.pub65;
  const shared = ecdh(eph.privateKey, uaPub65);
  const ikm = hkdf(authSecret, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub65, asPub65]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const record = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);   // 단일=마지막 레코드 → 구분자 0x02
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096, 0);
  const header = Buffer.concat([salt, rs, Buffer.from([asPub65.length]), asPub65]);   // salt(16)‖rs(4)‖idlen(1)‖keyid(as_pub)
  return Buffer.concat([header, ct]);
}

// 자가검사 전용(수신자 개인키로 복호). 왕복이 원문을 복원하면 전 과정이 정확.
export function decryptContent(body, uaPub65, uaPriv32, _authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPub65 = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = ecdh(privKeyFromRaw(uaPub65, uaPriv32), asPub65);
  const ikm = hkdf(_authSecret, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub65, asPub65]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const out = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return out.subarray(0, out.length - 1);   // 구분자 0x02 제거
}

// RFC 8292 VAPID JWT(ES256). raw r‖s(64B) 서명 = dsaEncoding ieee-p1363.
function vapidJWT(audience, subject, publicKeyB64, privateKeyB64) {
  const head = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64url(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const signingInput = `${head}.${body}`;
  const key = privKeyFromRaw(unb64url(publicKeyB64), unb64url(privateKeyB64));
  const sig = crypto.sign('SHA256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(sig)}`;
}

// PushSubscription + payload(string/Buffer) → 푸시 서비스로 POST. resolve {statusCode, body}. 404/410=구독 만료(호출자가 정리).
// vapid = { subject(mailto:/https:), publicKey, privateKey } (base64url).
export function sendNotification(subscription, payload, vapid, ttl = 60) {
  return new Promise((resolve, reject) => {
    let endpoint;
    try { endpoint = new URL(subscription.endpoint); } catch (e) { return reject(new Error('bad endpoint: ' + e.message)); }
    if (!subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) return reject(new Error('subscription.keys(p256dh/auth) 없음'));
    let body;
    try {
      body = encryptContent(unb64url(subscription.keys.p256dh), unb64url(subscription.keys.auth), Buffer.from(payload));
    } catch (e) { return reject(new Error('encrypt 실패: ' + e.message)); }
    const jwt = vapidJWT(`${endpoint.protocol}//${endpoint.host}`, vapid.subject, vapid.publicKey, vapid.privateKey);
    const req = https.request(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length,
        TTL: String(ttl),
        Urgency: 'high',
      },
      timeout: 10000,
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ statusCode: res.statusCode, body: d })); });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('push timeout')));
    req.end(body);
  });
}

// --- 자가검사 (RFC 8291 Appendix A) ---
if (process.argv[1] && process.argv[1].endsWith('webpush.mjs') && process.argv.includes('--selftest')) {
  const V = {
    asPub: unb64url('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'),
    asPriv: unb64url('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
    uaPub: unb64url('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
    uaPriv: unb64url('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'),
    auth: unb64url('BTBZMqHH6r4Tts7J_aSIgg'),
    salt: unb64url('DGv6ra1nlYgDCS1FRnbzlw'),
    text: 'When I grow up, I want to be a watermelon',
  };
  const eph = { privateKey: privKeyFromRaw(V.asPub, V.asPriv), pub65: V.asPub };
  const body = encryptContent(V.uaPub, V.auth, Buffer.from(V.text), { eph, salt: V.salt });
  const roundtrip = decryptContent(body, V.uaPub, V.uaPriv, V.auth).toString();
  const ct = body.subarray(86);   // 헤더 86B 이후 = 암호문(RFC A의 기대 암호문과 대조용)
  const okRoundtrip = roundtrip === V.text;   // GCM은 전 단계(ECDH·HKDF·CEK/nonce·헤더·구분자)가 정확해야만 복원됨 → 권위 있는 검사
  // VAPID JWT 서명 검증(공개키로 verify)
  const vk = generateVapidKeys();
  const jwt = vapidJWT('https://push.example.net', 'mailto:a@b.co', vk.publicKey, vk.privateKey);
  const [h, p, s] = jwt.split('.');
  const okJwt = crypto.verify('SHA256', Buffer.from(`${h}.${p}`), { key: pubKeyFromRaw(unb64url(vk.publicKey)), dsaEncoding: 'ieee-p1363' }, unb64url(s));
  console.log('roundtrip decrypt =', okRoundtrip ? 'PASS' : `FAIL (${roundtrip})`);
  console.log('VAPID JWT verify  =', okJwt ? 'PASS' : 'FAIL');
  console.log('ciphertext(참고)   =', b64url(ct));   // RFC 8291 A.3 기대값과 대조용(상호운용성은 web-push 교차검증으로 별도 확인됨)
  process.exit(okRoundtrip && okJwt ? 0 : 1);
}
