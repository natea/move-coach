// Move Coach Camera: the app macOS asks about camera access.
// Claude launches its CLI with responsibility disclaimed, so a helper spawned from
// there has no camera grant. Launched via `open`, this stub is the responsible
// process for its children; it stays alive while the helper runs so the grant holds.
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <sys/wait.h>

extern char **environ;
static pid_t child;

static void forward(int sig) { if (child > 0) kill(child, sig); }

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: move-coach-camera <program> [args...]\n"); return 2; }
  signal(SIGTERM, forward);
  signal(SIGINT, forward);
  signal(SIGHUP, forward);
  if (posix_spawn(&child, argv[1], NULL, NULL, &argv[1], environ) != 0) { perror("posix_spawn"); return 127; }
  int status = 0;
  while (waitpid(child, &status, 0) < 0) {}
  return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
