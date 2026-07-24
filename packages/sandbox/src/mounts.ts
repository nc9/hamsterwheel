import type { SandboxMount } from "./spec.ts";

// The host paths that cross into the sandbox: the issue worktree and its git common dir, each mounted
// at its OWN absolute path (identity mount). A LINKED worktree's `.git` is a pointer file into the
// primary repo's .git/worktrees/… (OUTSIDE the worktree), and that gitdir back-references the worktree
// by absolute path — so git/commit/push inside the container only resolve if BOTH live at their real
// host paths. Deliberately NOTHING else crosses: no $HOME, ~/.ssh, ~/.config/gh, or cloud cred dirs.
// gitCommonDir exposes repo git metadata (branches/objects) but no host credentials; a fully hermetic
// in-container clone (mounting nothing of the host repo) is a tighter follow-up.
export const sandboxWorktreeMounts = (worktree: string, gitCommonDir: string): SandboxMount[] => [
  { hostPath: worktree, containerPath: worktree },
  { hostPath: gitCommonDir, containerPath: gitCommonDir },
];
