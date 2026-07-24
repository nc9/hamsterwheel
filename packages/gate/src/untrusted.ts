// Issue title/body are UNTRUSTED observed content — anyone with repo access (or a community submission
// promoted into an internal issue) can author them. These markers trip a prompt-injection tripwire →
// the issue is blocked for a human, never fed to the autonomous agent. Defense-in-depth alongside the
// delimited/quoted untrusted block in the prompt (see `fence`).
export const INJECTION_MARKERS: [string, RegExp][] = [
  [
    "override-instructions",
    /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(all|any|previous|prior|above|earlier|your)\b[^.\n]{0,20}\b(instruction|context|prompt|rule|system)/i,
  ],
  ["role-hijack", /\b(you are now|new instructions|new task:|act as|pretend to be|from now on)\b/i],
  [
    "permission-escape",
    /bypasspermissions|dangerously-skip|--dangerously|allowedtools|permission-mode/i,
  ],
  [
    "secret-exfil",
    /\b(exfiltrat|id_rsa|\.ssh\/|AWS_SECRET|AWS_ACCESS|GITHUB_TOKEN)\b|\.env[^\n]{0,30}(secret|key|token)|print[^\n]{0,20}(secret|token|key)/i,
  ],
  ["pipe-to-shell", /\b(curl|wget|fetch)\b[^\n]*\|\s*(ba|z)?sh\b/i],
  [
    "destructive-shell",
    /\brm\s+-rf\s+[~/]|git\s+remote\s+set-url|git\s+push[^\n]*--force[^\n]*\b(main|master)\b|chmod\s+777/i,
  ],
  ["encoded-blob", /base64\s+(-d|--decode)|eval\s*\(|atob\s*\(/i],
];
export const screenInjection = (text: string): string[] =>
  INJECTION_MARKERS.filter(([, re]) => re.test(text)).map(([name]) => name);

// Unguessable per-run delimiter so untrusted content can't forge the closing fence
// (crypto.randomUUID is unpredictable; a timestamp would be).
export const fence = (n: number): string => `UNTRUSTED-${n}-${crypto.randomUUID()}`;
