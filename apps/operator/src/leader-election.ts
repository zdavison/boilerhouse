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
  onStartedLeading?: () => void;
  onStoppedLeading?: () => void;
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
  private readonly config: LeaderElectorConfig;

  constructor(config: LeaderElectorConfig) {
    this.config = config;
  }

  get isLeader(): boolean {
    return this._isLeader;
  }

  async start(signal?: AbortSignal): Promise<void> {
    while (!this.stopped && !signal?.aborted) {
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
          this.config.onStoppedLeading?.();
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
      // Lease expired — try to take it
      await this.updateLease(lease.metadata?.resourceVersion);
    } else {
      // No lease exists — create it
      await this.createLease();
    }
  }

  private async renew(): Promise<void> {
    const lease = await this.getLease();
    if (!lease || lease.spec?.holderIdentity !== this.config.identity) {
      this._isLeader = false;
      this.config.onStoppedLeading?.();
      return;
    }
    await this.updateLease(lease.metadata?.resourceVersion);
  }

  private async getLease(): Promise<any | null> {
    const url = `${this.config.apiUrl}/apis/coordination.k8s.io/v1/namespaces/${this.config.leaseNamespace}/leases/${this.config.leaseName}`;
    const resp = await fetch(url, { headers: this.config.headers });
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
    });
    if (!resp.ok) throw new Error(`Create lease failed: ${resp.status}`);
    this._isLeader = true;
    log.info({ identity: this.config.identity }, "acquired leadership");
    this.config.onStartedLeading?.();
  }

  private async updateLease(resourceVersion?: string): Promise<void> {
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
        },
      }),
    });
    if (!resp.ok) throw new Error(`Update lease failed: ${resp.status}`);
    if (!this._isLeader) {
      this._isLeader = true;
      log.info({ identity: this.config.identity }, "acquired leadership");
      this.config.onStartedLeading?.();
    }
  }
}
