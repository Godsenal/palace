// PWA/푸시 아이콘 생성기 — 의존성 0 (Node 내장 zlib만). 재현용으로 repo에 남긴다(무빌드 — 손대면 `node bin/make-icons.mjs`).
// 산출: vendor/icon-192.png, vendor/icon-512.png. 디자인: 다크 네이비 정사각(maskable full-bleed) + 틸 루프 링(⟳) + 화살촉.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));   // bin/ 의 상위 = repo 루트

// CRC-32 (PNG 청크용)
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (~c) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0); return Buffer.concat([len, td, crc]); }

function png(N) {
  const bg = [13, 19, 28], teal = [47, 208, 187];   // --panel, --signal
  const cx = (N - 1) / 2, cy = (N - 1) / 2;
  const outer = N * 0.40, inner = N * 0.265, mid = (outer + inner) / 2, half = (outer - inner) / 2;
  const gapDeg = 62;   // 링을 끊는 각도 폭(시계 12시 기준) — ⟳ 느낌
  // 화살촉 삼각형 꼭짓점(링 끝, 12시 오른쪽) — 세 절반평면 테스트
  const aEnd = (-90 + gapDeg / 2) * Math.PI / 180;   // 갭의 시계방향 끝 각도
  const tipR = mid, ax = cx + Math.cos(aEnd) * tipR, ay = cy + Math.sin(aEnd) * tipR;
  const tang = aEnd + Math.PI / 2;   // 접선(시계방향 진행) 방향
  const tip = [ax + Math.cos(tang) * half * 2.1, ay + Math.sin(tang) * half * 2.1];
  const bckl = aEnd, bw = half * 1.9;
  const b1 = [cx + Math.cos(bckl) * (mid + bw), cy + Math.sin(bckl) * (mid + bw)];
  const b2 = [cx + Math.cos(bckl) * (mid - bw), cy + Math.sin(bckl) * (mid - bw)];
  const sign = (p, a, b) => (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
  const inTri = (px, py) => { const p = [px, py]; const d1 = sign(p, tip, b1), d2 = sign(p, b1, b2), d3 = sign(p, b2, tip); const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0; return !(neg && pos); };

  const raw = Buffer.alloc((N * 4 + 1) * N);
  let o = 0;
  for (let y = 0; y < N; y++) {
    raw[o++] = 0;   // filter: none
    for (let x = 0; x < N; x++) {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
      let ang = Math.atan2(dy, dx) * 180 / Math.PI + 90;   // 12시=0
      if (ang > 180) ang -= 360; if (ang < -180) ang += 360;
      const onRing = d >= inner && d <= outer && Math.abs(ang) > gapDeg / 2;
      const isTeal = onRing || inTri(x, y);
      const c = isTeal ? teal : bg;
      // 라운드 코너(maskable 밖 여백을 살짝 둥글게) — 코너 반경 밖은 투명
      const rad = N * 0.20, mgx = Math.max(0, rad - x, x - (N - 1 - rad)), mgy = Math.max(0, rad - y, y - (N - 1 - rad));
      const corner = Math.hypot(mgx, mgy) > rad;
      raw[o++] = c[0]; raw[o++] = c[1]; raw[o++] = c[2]; raw[o++] = corner ? 0 : 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;   // 8-bit, RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

for (const n of [192, 512]) {
  const p = `${ROOT}/vendor/icon-${n}.png`;
  writeFileSync(p, png(n));
  console.log('wrote', p);
}
