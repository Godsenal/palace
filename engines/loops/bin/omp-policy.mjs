const role = String(process.env.LOOPS_OMP_ROLE || 'worker');
const noTools = new Set(['triage', 'controller']);
const readOnly = new Set(['verifier', 'validator']);
const forbiddenEverywhere = new Set(['browser', 'computer']);
const mutatingTools = new Set(['edit', 'write', 'apply_patch', 'ast_edit', 'notebook', 'memory_edit']);
const remoteDanger = [
  /\bgh\s+pr\s+(?:merge|close)\b/i,
  /\bgh\s+(?:release\s+create|repo\s+(?:create|delete))\b/i,
  /\bgit\s+push\b[^\n;&|]*(?:--force|-f\b|--force-with-lease)/i,
  /\b(?:npm|pnpm|yarn|cargo)\s+publish\b/i,
  /\b(?:vercel|netlify|flyctl|railway|wrangler)\b[^\n;&|]*\b(?:deploy|publish|destroy|delete)\b/i,
  /\bkubectl\s+(?:apply|create|delete|replace|patch|set|rollout|scale)\b/i,
  /\b(?:terraform|tofu)\s+(?:apply|destroy|import)\b/i
];
const readOnlyMutation = [
  /\bgit\s+(?:add|commit|checkout|switch|reset|restore|clean|merge|rebase|cherry-pick|am|push)\b/i,
  /\b(?:rm|mv|cp|install|mkdir|touch|truncate)\b/i,
  /(?:^|[^<])>{1,2}\s*[^&]/,
  /\b(?:sed\s+-i|perl\s+-i|tee\b)/i
];

export default function loopsPolicy(pi) {
  pi.on('tool_call', async (event) => {
    const name = String(event.toolName || '');
    const input = event.input && typeof event.input === 'object' ? event.input : {};
    if (noTools.has(role)) return { block: true, reason: `Loops ${role} 역할은 도구를 사용할 수 없습니다.` };
    if (forbiddenEverywhere.has(name)) return { block: true, reason: 'Loops는 결정론적 ego-browser 측정 경로만 사용합니다.' };
    if (name === 'github' && /merge|close|deploy|release|force/i.test(JSON.stringify(input))) {
      return { block: true, reason: 'Loops는 merge, deploy, release, force-push GitHub 작업을 허용하지 않습니다.' };
    }
    if (readOnly.has(role) && mutatingTools.has(name)) return { block: true, reason: `Loops ${role}는 코드 읽기 전용입니다.` };
    if (name === 'bash' || name === 'eval') {
      const command = [input.command, input.code, input.expression].filter((value) => typeof value === 'string').join('\n');
      if (remoteDanger.some((pattern) => pattern.test(command))) return { block: true, reason: 'Loops는 merge, deploy, publish, force-push를 허용하지 않습니다.' };
      if (readOnly.has(role) && readOnlyMutation.some((pattern) => pattern.test(command))) {
        const verdictWrite = /(?:verify|validate)\/[A-Za-z0-9._-]+\.json/.test(command) && /LOOPS_HOME|\/loops\//.test(command);
        if (!verdictWrite) return { block: true, reason: `Loops ${role}는 소스나 Git 상태를 변경할 수 없습니다.` };
      }
    }
  });
}
