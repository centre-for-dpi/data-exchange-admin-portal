import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** What the folder knows about a subscribed user. The portal knows none of it. */
export interface AlertOwner {
  /** The citizen's subject at the identity provider. */
  sub: string;
  email: string;
}

/**
 * The folder's own mapping from the portal's opaque alert id to its user and their email, kept
 * in a small JSON file (a reference app; a real folder has its own database). Also remembers the
 * webhook ids already handled, so a retried notice sends one email.
 */
export class AlertStore {
  private owners = new Map<string, AlertOwner>();
  private readonly seen = new Set<string>();

  constructor(private readonly file: string | null) {
    if (file && existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, AlertOwner>;
      this.owners = new Map(Object.entries(data));
    }
  }

  ownerOf(alertId: string): AlertOwner | undefined {
    return this.owners.get(alertId);
  }

  emailOf(sub: string): string | undefined {
    return [...this.owners.values()].find((o) => o.sub === sub)?.email;
  }

  set(alertId: string, owner: AlertOwner): void {
    this.owners.set(alertId, owner);
    this.save();
  }

  delete(alertId: string): void {
    this.owners.delete(alertId);
    this.save();
  }

  /** True the first time a webhook id is seen. */
  firstTime(webhookId: string): boolean {
    if (this.seen.has(webhookId)) return false;
    this.seen.add(webhookId);
    return true;
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.owners), null, 2));
  }
}
