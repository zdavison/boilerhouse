/*
 * Boilerhouse PID 1 init for microVMs.
 *
 * Responsibilities:
 *   - Mount essential filesystems (/proc, /sys, /dev, /dev/pts, /tmp)
 *   - Open /dev/console for stdio
 *   - Fork the idle-agent (if present)
 *   - Fork the entrypoint (from argv, fallback /bin/sh)
 *   - Forward SIGTERM/SIGINT/SIGHUP to the entrypoint child
 *   - Reap zombies; exit with the entrypoint's exit code
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define IDLE_AGENT_PATH "/opt/boilerhouse/idle-agent"

/* PID of the entrypoint child — used by signal handler. */
static volatile pid_t entrypoint_pid = -1;

static void forward_signal(int sig) {
	if (entrypoint_pid > 0) {
		kill(entrypoint_pid, sig);
	}
}

static void mount_fs(const char *source, const char *target,
                     const char *fstype, unsigned long flags) {
	struct stat st;
	if (stat(target, &st) != 0) {
		mkdir(target, 0755);
	}
	if (mount(source, target, fstype, flags, NULL) != 0) {
		fprintf(stderr, "init: mount %s on %s failed: %s\n",
		        fstype, target, strerror(errno));
	}
}

static void setup_console(void) {
	int fd = open("/dev/console", O_RDWR);
	if (fd >= 0) {
		dup2(fd, STDIN_FILENO);
		dup2(fd, STDOUT_FILENO);
		dup2(fd, STDERR_FILENO);
		if (fd > STDERR_FILENO)
			close(fd);
	}
}

static void setup_mounts(void) {
	mount_fs("proc",    "/proc",   "proc",     MS_NOSUID | MS_NODEV | MS_NOEXEC);
	mount_fs("sysfs",   "/sys",    "sysfs",    MS_NOSUID | MS_NODEV | MS_NOEXEC);
	mount_fs("devtmpfs","/dev",    "devtmpfs", MS_NOSUID);
	mount_fs("devpts",  "/dev/pts","devpts",   MS_NOSUID | MS_NOEXEC);
	mount_fs("tmpfs",   "/tmp",    "tmpfs",    MS_NOSUID | MS_NODEV);
}

static pid_t spawn(char *const argv[]) {
	pid_t pid = fork();
	if (pid < 0) {
		fprintf(stderr, "init: fork failed: %s\n", strerror(errno));
		return -1;
	}
	if (pid == 0) {
		/* Create a new session so the child has its own process group. */
		setsid();
		execv(argv[0], argv);
		fprintf(stderr, "init: exec %s failed: %s\n", argv[0], strerror(errno));
		_exit(127);
	}
	return pid;
}

int main(int argc, char *argv[]) {
	/* Only set up mounts and console when running as actual PID 1. */
	if (getpid() == 1) {
		setup_mounts();
		setup_console();
	}

	/* Install signal handlers to forward to entrypoint child. */
	struct sigaction sa;
	memset(&sa, 0, sizeof(sa));
	sa.sa_handler = forward_signal;
	sa.sa_flags = SA_RESTART;
	sigaction(SIGTERM, &sa, NULL);
	sigaction(SIGINT, &sa, NULL);
	sigaction(SIGHUP, &sa, NULL);

	/* Fork idle-agent if it exists. */
	struct stat agent_stat;
	if (stat(IDLE_AGENT_PATH, &agent_stat) == 0) {
		char *agent_argv[] = { IDLE_AGENT_PATH, NULL };
		pid_t agent = spawn(agent_argv);
		if (agent < 0) {
			fprintf(stderr, "init: warning: failed to spawn idle-agent\n");
		}
	}

	/* Build entrypoint argv. */
	char *default_argv[] = { "/bin/sh", NULL };
	char **entry_argv;
	if (argc > 1) {
		entry_argv = &argv[1];
	} else {
		entry_argv = default_argv;
	}

	/* Fork entrypoint. */
	entrypoint_pid = spawn(entry_argv);
	if (entrypoint_pid < 0) {
		fprintf(stderr, "init: failed to spawn entrypoint\n");
		return 1;
	}

	/* Reap loop: wait for all children, track entrypoint exit code. */
	int entrypoint_status = 0;
	int entrypoint_exited = 0;
	while (1) {
		int status;
		pid_t pid = waitpid(-1, &status, 0);
		if (pid < 0) {
			if (errno == ECHILD) {
				break; /* No more children. */
			}
			continue;
		}
		if (pid == entrypoint_pid) {
			if (WIFEXITED(status)) {
				entrypoint_status = WEXITSTATUS(status);
			} else if (WIFSIGNALED(status)) {
				entrypoint_status = 128 + WTERMSIG(status);
			}
			entrypoint_exited = 1;
			/*
			 * Once the entrypoint exits, terminate any remaining children
			 * (e.g., idle-agent) so we can clean up.
			 */
			kill(-1, SIGTERM);
		}
		/* If entrypoint already exited and no children remain, we're done. */
		if (entrypoint_exited) {
			/* Check if there are more children before breaking. */
			pid_t check = waitpid(-1, &status, WNOHANG);
			if (check <= 0) {
				break;
			}
			/* Reap this one too. */
			if (check == entrypoint_pid) {
				/* Shouldn't happen, but handle it. */
			}
		}
	}

	return entrypoint_status;
}
