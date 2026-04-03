import { createLogger } from "@boilerhouse/o11y";

export interface LeaderElectorConfig {
  leaseName: string;
  leaseNamespace: string;
  identity: string;
  leaseDurationSeconds: number;
  renewDeadlineSeconds: number;
  retryPeriodSeconds: number;
  apiUrl: string;
  headers: Record<string, string>;
  caCert?: string;
  onStartedLeading?: () => void | Promise<void>;
  onStoppedLeading?: () => void | Promise<void>;
}

interface LeaseSpec {
  holderIdentity?: string;
  leaseDurationSeconds?: number;
  acquireTime?: string;
  renewTime?: string;
  leaseTransitions?: number;
}

const log = createLogger("leader-election");

export class LeaderElector {
  private _isLeader = false;
  private stopped = false;
  private lastRenewMs = 0;
  private readonly config: LeaderElectorConfig;
  private readonly tlsOptions: { rejectUnauthorized: boolean; ca?: string };

  constructor(config: LeaderElectorConfig) {
    this.config = config;
    this.tlsOptions = config.caCert
      ? { rejectUnauthorized: true, ca: config.caCert }
      : { rejectUnauthorized: false };
  }

  get isLeader(): boolean {
    return this._isLeader;
  }

  /** Check if the renew deadline has been exceeded and step down if so. */
  checkRenewDeadline(): void {
    if (
      this._isLeader &&
      this.lastRenewMs > 0 &&
      Date.now() - this.lastRenewMs > this.config.renewDeadlineSeconds * 1000
    ) {
      log.warn({ identity: this.config.identity }, "renew deadline exceeded, stepping down");
      this._isLeader = false;
      void this.config.onStoppedLeading?.();
    }
  }

  async start(signal?: AbortSignal): Promise<void> {
    while (!this.stopped && !signal?.aborted) {
      // Enforce renewDeadline before each cycle
      this.checkRenewDeadline();

      try {
        if (this._isLeader) {
          await this.renew();
        } else {
          await this.tryAcquire();
        }
      } catch (err) {
        log.warn({ err }, "leader election cycle error");
        if (this._isLeader) {
          this._isLeader = false;
          await this.config.onStoppedLeading?.();
        }
      }
      await new Promise((r) => setTimeout(r, this.config.retryPeriodSeconds * 1000));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async tryAcquire(): Promise<void> {
    const lease = await this.getLease();

    if (lease) {
      // Check if existing lease has expired
      const renewTime = lease.spec?.renewTime ? new Date(lease.spec.renewTime).getTime() : 0;
      const elapsed = (Date.now() - renewTime) / 1000;
      if (elapsed < (lease.spec?.leaseDurationSeconds ?? this.config.leaseDurationSeconds)) {
        // Lease still held by someone else
        return;
      }
      // Lease expired — take it over, incrementing leaseTransitions
      const prevTransitions = lease.spec?.leaseTransitions ?? 0;
      await this.updateLease(lease.metadata?.resourceVersion, prevTransitions + 1);
    } else {
      // No lease exists — create it
      await this.createLease();
    }
  }

  private async renew(): Promise<void> {
    const lease = await this.getLease();
    if (!lease || lease.spec?.holderIdentity !== this.config.identity) {
      this._isLeader = false;
      await this.config.onStoppedLeading?.();
      return;
    }
    await this.updateLease(lease.metadata?.resourceVersion, lease.spec?.leaseTransitions);
    this.lastRenewMs = Date.now();
  }

  private async getLease(): Promise<any | null> {
    const url = `${this.config.apiUrl}/apis/coordination.k8s.io/v1/namespaces/${this.config.leaseNamespace}/leases/${this.config.leaseName}`;
    const resp = await fetch(url, {
      headers: this.config.headers,
      tls: this.tlsOptions,
    } as RequestInit);
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`GET lease failed: ${resp.status}`);
    return resp.json();
  }

  private async createLease(): Promise<void> {
    const url = `${this.config.apiUrl}/apis/coordination.k8s.io/v1/namespaces/${this.config.leaseNamespace}/leases`;
    const now = new Date().toISOString();
    const resp = await fetch(url, {
      method: "POST",
      headers: { ...this.config.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        apiVersion: "coordination.k8s.io/v1",
        kind: "Lease",
        metadata: { name: this.config.leaseName, namespace: this.config.leaseNamespace },
        spec: {
          holderIdentity: this.config.identity,
          leaseDurationSeconds: this.config.leaseDurationSeconds,
          acquireTime: now,
          renewTime: now,
          leaseTransitions: 0,
        },
      }),
      tls: this.tlsOptions,
    } as RequestInit);
    if (!resp.ok) throw new Error(`Create lease failed: ${resp.status}`);
    this._isLeader = true;
    this.lastRenewMs = Date.now();
    log.info({ identity: this.config.identity }, "acquired leadership");
    await this.config.onStartedLeading?.();
  }

  private async updateLease(resourceVersion?: string, leaseTransitions?: number): Promise<void> {
    const url = `${this.config.apiUrl}/apis/coordination.k8s.io/v1/namespaces/${this.config.leaseNamespace}/leases/${this.config.leaseName}`;
    const now = new Date().toISOString();
    const resp = await fetch(url, {
      method: "PUT",
      headers: { ...this.config.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        apiVersion: "coordination.k8s.io/v1",
        kind: "Lease",
        metadata: {
          name: this.config.leaseName,
          namespace: this.config.leaseNamespace,
          resourceVersion,
        },
        spec: {
          holderIdentity: this.config.identity,
          leaseDurationSeconds: this.config.leaseDurationSeconds,
          renewTime: now,
          leaseTransitions: leaseTransitions ?? 0,
        },
      }),
      tls: this.tlsOptions,
    } as RequestInit);
    if (!resp.ok) throw new Error(`Update lease failed: ${resp.status}`);
    if (!this._isLeader) {
      this._isLeader = true;
      this.lastRenewMs = Date.now();
      log.info({ identity: this.config.identity }, "acquired leadership");
      await this.config.onStartedLeading?.();
    }
  }
}
