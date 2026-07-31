// disclaim-exec — make a spawned CLI its own macOS TCC "responsible process".
//
// WHY: when Screenchart spawns a CLI agent (Claude Code, Cursor Agent, …) as a
// child, macOS walks up the process tree and blames the *app* (Screenchart) for
// the agent's file access — so testing a provider pops Photos / Desktop /
// Documents / Downloads / Apple Music prompts under Screenchart's name.
// detached:true does NOT fix this (process-group != TCC responsibility).
//
// FIX: responsibility_spawnattrs_setdisclaim() (the private API VS Code and Qt
// Creator use) sheds the responsibility bit so the spawned program becomes its
// OWN responsible process — prompts, if any, are attributed to the agent, not us.
//
// HOW: we set the disclaim attribute + POSIX_SPAWN_SETEXEC, which makes
// posix_spawn REPLACE this process image with the target (like execve): same pid,
// same fds, same cwd, same env, same process group. So the Node-side stdin/stdout
// piping, timeout, and process-group kill keep working exactly as before — this
// helper is invisible except for the disclaim.
//
// Usage:  disclaim-exec <program> [args...]
// Built universal (x86_64 + arm64) at package time — see scripts/afterPack.js.

#include <spawn.h>
#include <stdio.h>
#include <string.h>

extern char **environ;

// Private, header-less macOS API (present in libSystem). Declared like VS Code /
// Chromium do. Sets the "disclaim responsibility" flag on the spawn attributes.
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "disclaim-exec: usage: disclaim-exec <program> [args...]\n");
    return 2;
  }

  posix_spawnattr_t attr;
  if (posix_spawnattr_init(&attr) != 0) {
    perror("disclaim-exec: posix_spawnattr_init");
    return 1;
  }

  responsibility_spawnattrs_setdisclaim(&attr, 1);

  // SETEXEC: don't fork — replace this process image with the target, so the
  // agent inherits our pid/fds/cwd/env/pgid untouched.
  if (posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETEXEC) != 0) {
    perror("disclaim-exec: posix_spawnattr_setflags");
    return 1;
  }

  pid_t pid;
  int rc = posix_spawn(&pid, argv[1], NULL, &attr, &argv[1], environ);

  // With SETEXEC a successful spawn never returns. Any return is a failure.
  fprintf(stderr, "disclaim-exec: failed to exec %s: %s\n", argv[1], strerror(rc));
  return 127;
}
