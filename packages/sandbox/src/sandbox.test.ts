// Hermetic unit tests for the opt-in OS-isolation sandbox. No Docker is launched, no network is
// touched — these exercise ONLY the pure argv/mount/env boundary logic. A mount or env leak here
// defeats the whole point of the sandbox, so the invariants are asserted explicitly.
import { describe, expect, test } from "bun:test";
import {
  type SandboxSpec,
  buildSandboxArgs,
  resolveSandboxEnv,
  sandboxWorktreeMounts,
  scanGitConfigForCredentials,
} from "./index.ts";

const WORKTREE = "/Users/ci/.hamsterwheel/worktrees/loop-abc-181";
const GITDIR = "/Users/ci/Projects/owner-repo/.git";
const TOKEN = "ghs_ShortLivedRepoScoped_deadbeef";
const ANTHROPIC = "sk-ant-sandbox-key-xyz";

// A realistic host env: the required sandbox creds + docker CLI plumbing + a pile of secrets that
// MUST NOT cross into the container.
const hostEnv = (
  over: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
  SANDBOX_GITHUB_TOKEN: TOKEN,
  SANDBOX_ANTHROPIC_API_KEY: ANTHROPIC,
  PATH: "/usr/bin:/bin",
  HOME: "/Users/ci",
  DOCKER_HOST: "unix:///var/run/docker.sock",
  TERM: "xterm-256color",
  // secrets that must be left behind:
  AWS_SECRET_ACCESS_KEY: "AKIA-super-secret",
  DATABASE_URI: "postgres://user:pw@host/db",
  GITHUB_TOKEN: "ghp_host_full_scope_token",
  GH_TOKEN: "ghp_host_full_scope_token",
  CLOUDFLARE_API_TOKEN: "cf-secret",
  ANTHROPIC_API_KEY: "sk-ant-host-personal",
  ...over,
});

const stdSpec = (over: Partial<SandboxSpec> = {}): SandboxSpec => ({
  image: "hamsterwheel/sandbox:latest",
  network: "bridge",
  workdir: WORKTREE,
  mounts: sandboxWorktreeMounts(WORKTREE, GITDIR),
  forwardEnv: resolveSandboxEnv(hostEnv()).forwardNames,
  command: ["claude", "-p", "do the thing", "--permission-mode", "acceptEdits"],
  ...over,
});

describe("sandboxWorktreeMounts", () => {
  test("mounts ONLY the worktree + its git common dir, each at its real absolute path", () => {
    expect(sandboxWorktreeMounts(WORKTREE, GITDIR)).toEqual([
      { hostPath: WORKTREE, containerPath: WORKTREE },
      { hostPath: GITDIR, containerPath: GITDIR },
    ]);
  });
  test("never surfaces a host credential dir", () => {
    const mounts = sandboxWorktreeMounts(WORKTREE, GITDIR);
    const paths = mounts.flatMap((m) => [m.hostPath, m.containerPath]);
    for (const p of paths) {
      expect(p).not.toContain(".ssh");
      expect(p).not.toContain(".config/gh");
      expect(p).not.toContain(".aws");
      expect(p).not.toContain(".claude");
    }
  });
});

describe("buildSandboxArgs", () => {
  test("binds EXACTLY the given mounts and nothing else", () => {
    const argv = buildSandboxArgs(stdSpec());
    const volumeVals = argv.filter((_, i) => argv[i - 1] === "-v");
    expect(volumeVals).toEqual([`${WORKTREE}:${WORKTREE}`, `${GITDIR}:${GITDIR}`]);
    // one -v per mount, no stray mounts
    expect(argv.filter((a) => a === "-v").length).toBe(2);
  });

  test("no host credential path is ever mounted", () => {
    const joined = buildSandboxArgs(stdSpec()).join(" ");
    for (const bad of ["/.ssh", ".config/gh", "/.aws", "/.claude", "docker.sock"]) {
      expect(joined).not.toContain(bad);
    }
  });

  test("forwards env by NAME only — no secret VALUE lands in argv (no `ps` leak)", () => {
    const argv = buildSandboxArgs(stdSpec());
    // GH_TOKEN is forwarded, but only its name:
    expect(argv).toContain("GH_TOKEN");
    expect(argv.some((a) => a.startsWith("--env") && a.includes("="))).toBe(false); // never `--env FOO=bar`
    // the actual token/key values are absent from every arg:
    const joined = argv.join("");
    expect(joined).not.toContain(TOKEN);
    expect(joined).not.toContain(ANTHROPIC);
    // and host secrets are absent entirely:
    expect(joined).not.toContain("AKIA-super-secret");
    expect(joined).not.toContain("ghp_host_full_scope_token");
  });

  test("--env entries are exactly the resolved allow-list (GH_TOKEN, ANTHROPIC_API_KEY, TERM)", () => {
    const argv = buildSandboxArgs(stdSpec());
    const envNames = argv.filter((_, i) => argv[i - 1] === "--env");
    expect(new Set(envNames)).toEqual(new Set(["GH_TOKEN", "ANTHROPIC_API_KEY", "TERM"]));
    // no host secret is forwarded by name either:
    for (const bad of [
      "AWS_SECRET_ACCESS_KEY",
      "DATABASE_URI",
      "GITHUB_TOKEN",
      "CLOUDFLARE_API_TOKEN",
    ]) {
      expect(envNames).not.toContain(bad);
    }
  });

  test("is an ephemeral `docker run` with the requested network + workdir, image then command last", () => {
    const argv = buildSandboxArgs(stdSpec({ network: "none" }));
    expect(argv[0]).toBe("run");
    expect(argv).toContain("--rm");
    expect(argv[argv.indexOf("--network") + 1]).toBe("none");
    expect(argv[argv.indexOf("-w") + 1]).toBe(WORKTREE);
    const img = argv.indexOf("hamsterwheel/sandbox:latest");
    expect(img).toBeGreaterThan(-1);
    expect(argv.slice(img)).toEqual([
      "hamsterwheel/sandbox:latest",
      "claude",
      "-p",
      "do the thing",
      "--permission-mode",
      "acceptEdits",
    ]);
  });

  test("readOnly mounts render :ro", () => {
    const argv = buildSandboxArgs(
      stdSpec({ mounts: [{ hostPath: "/x", containerPath: "/x", readOnly: true }] }),
    );
    expect(argv.filter((_, i) => argv[i - 1] === "-v")).toEqual(["/x:/x:ro"]);
  });

  test("rejects a NAME=value env entry (would leak the value into argv — the invariant is enforced here, not just by callers)", () => {
    expect(() => buildSandboxArgs(stdSpec({ forwardEnv: ["GH_TOKEN=ghs_leak"] }))).toThrow(
      /malformed env name/,
    );
    expect(() => buildSandboxArgs(stdSpec({ forwardEnv: ["FOO BAR"] }))).toThrow(
      /malformed env name/,
    );
  });
});

describe("scanGitConfigForCredentials — fail-closed on a credential-bearing .git/config", () => {
  test("a clean config (no creds) flags nothing", () => {
    const clean = `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/owner/repo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin`;
    expect(scanGitConfigForCredentials(clean)).toEqual([]);
    expect(scanGitConfigForCredentials("")).toEqual([]);
  });
  test("a set credential.helper is flagged (host helper / !shell snippet)", () => {
    expect(scanGitConfigForCredentials(`[credential]\n\thelper = osxkeychain`)).toContain(
      "credential-helper",
    );
    expect(
      scanGitConfigForCredentials(`[credential]\n\thelper = !gh auth git-credential`),
    ).toContain("credential-helper");
  });
  test("a remote URL with embedded userinfo/token is flagged", () => {
    expect(
      scanGitConfigForCredentials(
        `[remote "origin"]\n\turl = https://x-access-token:ghp_SECRET@github.com/owner/repo.git`,
      ),
    ).toContain("remote-url-userinfo");
    // a plain tokenless https remote is NOT flagged:
    expect(
      scanGitConfigForCredentials(`[remote "origin"]\n\turl = https://github.com/owner/repo.git`),
    ).not.toContain("remote-url-userinfo");
  });
  test("a url.*.insteadOf rewrite is flagged (can redirect the push)", () => {
    expect(
      scanGitConfigForCredentials(
        `[url "https://evil.example/"]\n\tinsteadOf = https://github.com/`,
      ),
    ).toContain("url-insteadof");
  });
  test("multiple leak vectors accumulate", () => {
    const cfg = `[credential]\n\thelper = store\n[url "https://evil/"]\n\tinsteadOf = https://github.com/`;
    expect(scanGitConfigForCredentials(cfg).length).toBeGreaterThanOrEqual(2);
  });
});

describe("resolveSandboxEnv — fail-closed token", () => {
  test("missing SANDBOX_GITHUB_TOKEN throws a clear repo-scoped-token message (no host fall-back)", () => {
    expect(() => resolveSandboxEnv(hostEnv({ SANDBOX_GITHUB_TOKEN: undefined }))).toThrow(
      /SANDBOX_GITHUB_TOKEN/,
    );
    expect(() => resolveSandboxEnv(hostEnv({ SANDBOX_GITHUB_TOKEN: undefined }))).toThrow(
      /repo-scoped/i,
    );
    expect(() => resolveSandboxEnv(hostEnv({ SANDBOX_GITHUB_TOKEN: undefined }))).toThrow(
      /fall-?back/i,
    );
  });
  test("empty / whitespace-only token also fails closed", () => {
    expect(() => resolveSandboxEnv(hostEnv({ SANDBOX_GITHUB_TOKEN: "" }))).toThrow(
      /SANDBOX_GITHUB_TOKEN/,
    );
    expect(() => resolveSandboxEnv(hostEnv({ SANDBOX_GITHUB_TOKEN: "   " }))).toThrow(
      /SANDBOX_GITHUB_TOKEN/,
    );
  });
  test("missing SANDBOX_ANTHROPIC_API_KEY throws", () => {
    expect(() => resolveSandboxEnv(hostEnv({ SANDBOX_ANTHROPIC_API_KEY: undefined }))).toThrow(
      /SANDBOX_ANTHROPIC_API_KEY/,
    );
  });
});

describe("resolveSandboxEnv — allow-list", () => {
  test("token maps to GH_TOKEN and the model key to ANTHROPIC_API_KEY (trimmed)", () => {
    const { containerEnv } = resolveSandboxEnv(hostEnv({ SANDBOX_GITHUB_TOKEN: `  ${TOKEN}  ` }));
    expect(containerEnv.GH_TOKEN).toBe(TOKEN);
    expect(containerEnv.ANTHROPIC_API_KEY).toBe(ANTHROPIC);
  });

  test("containerEnv carries ONLY the allow-listed vars — no host secret crosses", () => {
    const { containerEnv, forwardNames } = resolveSandboxEnv(hostEnv());
    expect(new Set(Object.keys(containerEnv))).toEqual(
      new Set(["GH_TOKEN", "ANTHROPIC_API_KEY", "TERM"]),
    );
    expect(new Set(forwardNames)).toEqual(new Set(Object.keys(containerEnv)));
    for (const secret of [
      "AWS_SECRET_ACCESS_KEY",
      "DATABASE_URI",
      "GITHUB_TOKEN",
      "CLOUDFLARE_API_TOKEN",
      "DOCKER_HOST",
      "PATH",
      "HOME",
    ]) {
      expect(containerEnv[secret]).toBeUndefined();
      expect(forwardNames).not.toContain(secret);
    }
    // the host's OWN full ANTHROPIC_API_KEY / GH_TOKEN must NOT survive — only the SANDBOX_* values do:
    expect(containerEnv.ANTHROPIC_API_KEY).not.toBe("sk-ant-host-personal");
    expect(containerEnv.GH_TOKEN).not.toBe("ghp_host_full_scope_token");
  });

  test("host passthrough vars are only forwarded when present", () => {
    const { forwardNames } = resolveSandboxEnv(hostEnv({ TERM: undefined }));
    expect(forwardNames).not.toContain("TERM");
    expect(new Set(forwardNames)).toEqual(new Set(["GH_TOKEN", "ANTHROPIC_API_KEY"]));
  });

  test("processEnv gives the docker CLI its plumbing (PATH/HOME/DOCKER_HOST) plus the container values", () => {
    const { processEnv } = resolveSandboxEnv(hostEnv());
    expect(processEnv.PATH).toBe("/usr/bin:/bin");
    expect(processEnv.HOME).toBe("/Users/ci");
    expect(processEnv.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
    // and the by-name-forwarded values must be resolvable by docker:
    expect(processEnv.GH_TOKEN).toBe(TOKEN);
    expect(processEnv.ANTHROPIC_API_KEY).toBe(ANTHROPIC);
    // but host secrets are still absent from the docker process env:
    expect(processEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(processEnv.DATABASE_URI).toBeUndefined();
  });
});

describe("end-to-end boundary (pure): resolve → mounts → argv", () => {
  test("a full sandboxed invocation mounts only repo paths and never leaks a secret value", () => {
    const { forwardNames } = resolveSandboxEnv(hostEnv());
    const argv = buildSandboxArgs({
      image: "hamsterwheel/sandbox:latest",
      network: "bridge",
      workdir: WORKTREE,
      mounts: sandboxWorktreeMounts(WORKTREE, GITDIR),
      forwardEnv: forwardNames,
      command: ["claude", "-p", "<prompt>"],
    });
    const joined = argv.join("");
    // every mounted host path is under the repo/worktree, never a home/cred dir:
    for (const v of argv.filter((_, i) => argv[i - 1] === "-v")) {
      expect(v.startsWith(WORKTREE) || v.startsWith(GITDIR)).toBe(true);
    }
    expect(joined).not.toContain(TOKEN);
    expect(joined).not.toContain(ANTHROPIC);
    expect(joined).not.toContain("AKIA-super-secret");
    expect(argv).toContain("GH_TOKEN"); // forwarded by name
    expect(argv[0]).toBe("run");
  });
});
