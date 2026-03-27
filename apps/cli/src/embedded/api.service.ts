/**
 * Systemd unit template for the boilerhouse API server.
 * The binary path must be an absolute path to the installed boilerhouse binary.
 */
export function apiServiceUnit(binaryPath: string, dataDir: string): string {
	return `[Unit]
Description=Boilerhouse API
After=network-online.target boilerhouse-podmand@boilerhouse.service
Wants=network-online.target
Requires=boilerhouse-podmand@boilerhouse.service

[Service]
Type=simple
User=boilerhouse
Group=boilerhouse
ExecStart=${binaryPath} api start
Restart=on-failure
RestartSec=5

# Environment
EnvironmentFile=/etc/boilerhouse/api.env

# Hardening
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
MemoryDenyWriteExecute=no
ReadWritePaths=${dataDir}/data ${dataDir}

[Install]
WantedBy=multi-user.target
`;
}
