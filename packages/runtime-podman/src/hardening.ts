/**
 * Minimal Linux capabilities added back after dropping ALL.
 *
 * This set covers typical server workloads (file ownership, signal
 * delivery, binding privileged ports) without granting dangerous
 * capabilities like CAP_SYS_CHROOT, CAP_SYS_ADMIN, or CAP_NET_RAW.
 */
export const HARDENED_CAP_ADD: string[] = [
	"CAP_CHOWN",
	"CAP_DAC_OVERRIDE",
	"CAP_FOWNER",
	"CAP_FSETID",
	"CAP_KILL",
	"CAP_SETGID",
	"CAP_SETUID",
	"CAP_NET_BIND_SERVICE",
];
