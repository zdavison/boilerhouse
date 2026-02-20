/*
 * Boilerhouse idle monitor agent.
 *
 * Runs inside the guest VM, polls watched directories for mtime changes,
 * and reports the latest mtime to the host via vsock and/or HTTP.
 *
 * Configuration (env vars):
 *   BOILERHOUSE_WATCH_DIRS      — colon-separated list of directory paths
 *   BOILERHOUSE_POLL_INTERVAL   — seconds between polls (default: 5)
 *   BOILERHOUSE_VSOCK_PORT      — vsock port for host communication
 *   BOILERHOUSE_HTTP_ENDPOINT   — HTTP URL for mtime POST reports
 *   BOILERHOUSE_DEBUG_LOG       — path to write debug/poll log (optional)
 */

#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

/* vsock definitions — inlined to avoid dependency on linux/vm_sockets.h
 * which may not be available in musl cross-compilation environments. */
#ifndef AF_VSOCK
#define AF_VSOCK 40
#endif
#define VMADDR_CID_HOST 2

struct sockaddr_vm {
	unsigned short svm_family;
	unsigned short svm_reserved1;
	unsigned int svm_port;
	unsigned int svm_cid;
	unsigned char svm_zero[sizeof(struct sockaddr) -
	                       sizeof(unsigned short) -
	                       sizeof(unsigned short) -
	                       sizeof(unsigned int) -
	                       sizeof(unsigned int)];
};

#define MAX_DIRS 64
#define DEFAULT_POLL_INTERVAL 5

static volatile int running = 1;

static void handle_signal(int sig) {
	(void)sig;
	running = 0;
}

/*
 * Parse a colon-separated string into an array of directory paths.
 * Returns the number of directories parsed.
 */
static int parse_dirs(const char *input, char *dirs[], int max) {
	if (!input || !*input) return 0;

	/* Work on a copy since strtok modifies the string. */
	char *copy = strdup(input);
	if (!copy) return 0;

	int count = 0;
	char *token = strtok(copy, ":");
	while (token && count < max) {
		dirs[count] = strdup(token);
		if (!dirs[count]) break;
		count++;
		token = strtok(NULL, ":");
	}
	free(copy);
	return count;
}

/* Find the maximum mtime across all watched directories. */
static time_t poll_dirs(char *dirs[], int dir_count) {
	time_t max_mtime = 0;
	for (int i = 0; i < dir_count; i++) {
		struct stat st;
		if (stat(dirs[i], &st) != 0) {
			/* Directory doesn't exist (yet) — skip. */
			continue;
		}
		if (st.st_mtime > max_mtime) {
			max_mtime = st.st_mtime;
		}
	}
	return max_mtime;
}

/* Report mtime over vsock (AF_VSOCK, CID=2 = host). */
static void report_vsock(unsigned int port, time_t mtime) {
	int fd = socket(AF_VSOCK, SOCK_STREAM, 0);
	if (fd < 0) return;

	struct sockaddr_vm addr;
	memset(&addr, 0, sizeof(addr));
	addr.svm_family = AF_VSOCK;
	addr.svm_cid = VMADDR_CID_HOST;
	addr.svm_port = port;

	if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
		char buf[64];
		int len = snprintf(buf, sizeof(buf), "MTIME %ld\n", (long)mtime);
		if (len > 0) {
			/* Best-effort write. */
			ssize_t written = write(fd, buf, (size_t)len);
			(void)written;
		}
	}
	close(fd);
}

/*
 * Parse a URL like "http://host:port/path" into components.
 * Returns 0 on success, -1 on failure.
 */
static int parse_url(const char *url, char *host, size_t host_len,
                     int *port, char *path, size_t path_len) {
	if (strncmp(url, "http://", 7) != 0) return -1;
	const char *start = url + 7;

	/* Find host:port boundary. */
	const char *colon = strchr(start, ':');
	const char *slash = strchr(start, '/');

	if (colon && (!slash || colon < slash)) {
		size_t hlen = (size_t)(colon - start);
		if (hlen >= host_len) return -1;
		memcpy(host, start, hlen);
		host[hlen] = '\0';
		*port = atoi(colon + 1);
	} else {
		*port = 80;
		size_t hlen = slash ? (size_t)(slash - start) : strlen(start);
		if (hlen >= host_len) return -1;
		memcpy(host, start, hlen);
		host[hlen] = '\0';
	}

	if (slash) {
		size_t plen = strlen(slash);
		if (plen >= path_len) return -1;
		memcpy(path, slash, plen);
		path[plen] = '\0';
	} else {
		path[0] = '/';
		path[1] = '\0';
	}

	return 0;
}

/* Report mtime via raw HTTP/1.0 POST. */
static void report_http(const char *endpoint, time_t mtime) {
	char host[256];
	char path[512];
	int port;

	if (parse_url(endpoint, host, sizeof(host), &port, path, sizeof(path)) != 0) {
		return;
	}

	/* Resolve host. */
	struct sockaddr_in addr;
	memset(&addr, 0, sizeof(addr));
	addr.sin_family = AF_INET;
	addr.sin_port = htons((uint16_t)port);

	if (inet_pton(AF_INET, host, &addr.sin_addr) != 1) {
		struct hostent *he = gethostbyname(host);
		if (!he) return;
		memcpy(&addr.sin_addr, he->h_addr_list[0], (size_t)he->h_length);
	}

	int fd = socket(AF_INET, SOCK_STREAM, 0);
	if (fd < 0) return;

	/* Set a short connect timeout. */
	struct timeval tv = { .tv_sec = 2, .tv_usec = 0 };
	setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

	if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
		close(fd);
		return;
	}

	char body[64];
	int body_len = snprintf(body, sizeof(body), "{\"mtime\":%ld}", (long)mtime);

	char request[1024];
	int req_len = snprintf(request, sizeof(request),
		"POST %s HTTP/1.0\r\n"
		"Host: %s:%d\r\n"
		"Content-Type: application/json\r\n"
		"Content-Length: %d\r\n"
		"Connection: close\r\n"
		"\r\n"
		"%s",
		path, host, port, body_len, body);

	if (req_len > 0) {
		ssize_t written = write(fd, request, (size_t)req_len);
		(void)written;
	}
	close(fd);
}

static void debug_log(const char *log_path, time_t mtime) {
	FILE *f = fopen(log_path, "a");
	if (!f) return;
	fprintf(f, "poll mtime=%ld\n", (long)mtime);
	fclose(f);
}

int main(void) {
	/* Install signal handlers. */
	struct sigaction sa;
	memset(&sa, 0, sizeof(sa));
	sa.sa_handler = handle_signal;
	sa.sa_flags = 0;
	sigaction(SIGTERM, &sa, NULL);
	sigaction(SIGINT, &sa, NULL);

	/* Parse configuration from environment. */
	const char *watch_dirs_env = getenv("BOILERHOUSE_WATCH_DIRS");
	const char *poll_str = getenv("BOILERHOUSE_POLL_INTERVAL");
	const char *vsock_port_str = getenv("BOILERHOUSE_VSOCK_PORT");
	const char *http_endpoint = getenv("BOILERHOUSE_HTTP_ENDPOINT");
	const char *debug_log_path = getenv("BOILERHOUSE_DEBUG_LOG");

	int poll_interval = DEFAULT_POLL_INTERVAL;
	if (poll_str) {
		int v = atoi(poll_str);
		if (v > 0) poll_interval = v;
	}

	unsigned int vsock_port = 0;
	int use_vsock = 0;
	if (vsock_port_str) {
		vsock_port = (unsigned int)atoi(vsock_port_str);
		if (vsock_port > 0) use_vsock = 1;
	}

	char *dirs[MAX_DIRS];
	int dir_count = parse_dirs(watch_dirs_env, dirs, MAX_DIRS);

	if (dir_count == 0) {
		fprintf(stderr, "idle-agent: no watch directories configured\n");
		fprintf(stderr, "idle-agent: set BOILERHOUSE_WATCH_DIRS=/path1:/path2\n");
		return 1;
	}

	/* Main poll loop. */
	while (running) {
		time_t mtime = poll_dirs(dirs, dir_count);

		if (debug_log_path) {
			debug_log(debug_log_path, mtime);
		}

		if (use_vsock) {
			report_vsock(vsock_port, mtime);
		}

		if (http_endpoint) {
			report_http(http_endpoint, mtime);
		}

		/* Sleep in 1-second intervals to allow responsive SIGTERM handling. */
		for (int i = 0; i < poll_interval && running; i++) {
			sleep(1);
		}
	}

	/* Cleanup. */
	for (int i = 0; i < dir_count; i++) {
		free(dirs[i]);
	}

	return 0;
}
