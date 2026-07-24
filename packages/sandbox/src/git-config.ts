// The mounted primary .git/config can smuggle host credentials across the boundary OR hijack the push
// away from the injected token: a set `credential.helper` (a host helper or a `!shell` snippet that
// then runs INSIDE the container), a remote URL with embedded userinfo/token (scheme://user:tok@host),
// or a `url.*.insteadOf` rewrite that redirects the push to an attacker-chosen remote. Flag these so
// the sandbox FAILS CLOSED — the hermetic in-container-clone follow-up removes the mount entirely.
// Pure + unit-tested. Errs toward flagging (a false positive just routes to a human).
const GIT_CONFIG_CREDENTIAL_RE: [string, RegExp][] = [
  ["credential-helper", /^\s*helper\s*=/im], // any configured credential helper (repo-local is unusual → suspect)
  ["remote-url-userinfo", /^\s*url\s*=\s*[a-z][a-z0-9+.-]*:\/\/[^@\s/]+@/im], // scheme://user[:pw]@host — embedded creds
  ["url-insteadof", /\binsteadof\s*=/im], // url.<base>.insteadOf can silently redirect the push
];
export const scanGitConfigForCredentials = (configText: string): string[] =>
  GIT_CONFIG_CREDENTIAL_RE.filter(([, re]) => re.test(configText)).map(([name]) => name);
