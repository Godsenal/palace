// Linear GraphQL POST를 Promise로 래핑한 공유 헬퍼. 의존성 0 (Node 내장 https만). 호출처: linear-create.mjs·linear-move.mjs·linear-states.mjs.
// ⚠️ key는 반드시 호출자가 검증해 인자로 넘긴다 — 이 모듈은 env를 직접 안 읽는다(no-silent-fallback: 키 검증·명시적 실패 규약은 호출부에 보존).
// 성공: GraphQL data 객체로 resolve. 실패(j.errors·JSON 파싱·네트워크·타임아웃 15s): Error로 reject — 호출자가 처리.
import https from 'node:https';

export function linearGql(query, variables, key) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: key, 'content-length': Buffer.byteLength(body) },
      timeout: 15000,
    }, (r) => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.errors) return rej(new Error(j.errors[0]?.message || 'graphql error'));
          res(j.data);
        } catch { rej(new Error(`HTTP ${r.statusCode} — JSON 파싱 실패`)); }
      });
    });
    req.on('error', e => rej(e));
    req.on('timeout', () => { req.destroy(); rej(new Error('타임아웃(15s)')); });
    req.end(body);
  });
}
