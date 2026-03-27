/**
 * nftables firewall configuration for the boilerhouse VM.
 * Allows SSH + HTTPS inbound, drops everything else.
 */
export const NFTABLES_CONF = `#!/usr/sbin/nft -f
# Boilerhouse VM firewall — allow SSH + HTTPS inbound, drop everything else.

flush ruleset

table inet filter {
	chain input {
		type filter hook input priority 0; policy drop;

		# Established/related connections
		ct state established,related accept

		# Loopback
		iifname "lo" accept

		# ICMP (ping, path MTU discovery)
		ip protocol icmp accept
		ip6 nexthdr icmpv6 accept

		# SSH
		tcp dport 22 accept

		# HTTPS (Caddy)
		tcp dport 443 accept

		# Drop everything else (implicit via policy)
	}

	chain forward {
		type filter hook forward priority 0; policy drop;
	}

	chain output {
		type filter hook output priority 0; policy accept;
	}
}
`;
