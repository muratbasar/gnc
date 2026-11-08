import { Firestore, Timestamp } from "@google-cloud/firestore";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import {
  accountSchema,
  credentialSchema,
  type ClaimedJob,
  type CreatePublication,
  type Credential,
  type PublicationJob,
  type SocialAccount,
} from "./domain.js";

function asDate(value: unknown, field: string): Date {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  throw new Error(`Geçersiz Firestore tarih alanı: ${field}`);
}

function readJob(id: string, data: Record<string, unknown>): ClaimedJob {
  return {
    id,
    accountId: String(data.accountId),
    attempt: Number(data.attempt),
    content: data.content as PublicationJob["content"],
    createdAt: asDate(data.createdAt, "createdAt"),
    language: "en",
    scheduledAt: asDate(data.scheduledAt, "scheduledAt"),
    siteId: String(data.siteId),
    status: data.status as PublicationJob["status"],
    updatedAt: asDate(data.updatedAt, "updatedAt"),
    ...(data.externalId ? { externalId: String(data.externalId) } : {}),
    ...(data.lastError ? { lastError: String(data.lastError) } : {}),
    ...(data.leaseUntil
      ? { leaseUntil: asDate(data.leaseUntil, "leaseUntil") }
      : {}),
    ...(data.publishedAt
      ? { publishedAt: asDate(data.publishedAt, "publishedAt") }
      : {}),
  };
}

export class AccountStore {
  constructor(private readonly firestore: Firestore) {}

  async get(accountId: string): Promise<SocialAccount> {
    const snapshot = await this.firestore
      .collection("socialAccounts")
      .doc(accountId)
      .get();
    if (!snapshot.exists) {
      throw new Error(`Sosyal hesap bulunamadı: ${accountId}`);
    }
    return accountSchema.parse(snapshot.data());
  }

  async assertForSite(accountIds: string[], siteId: string): Promise<void> {
    const accounts = await Promise.all(accountIds.map((id) => this.get(id)));
    for (const account of accounts) {
      if (!account.enabled) {
        throw new Error(`Devre dışı sosyal hesap seçildi: ${account.platform}`);
      }
      if (account.siteId !== siteId) {
        throw new Error(
          `Sosyal hesap ${account.siteId} sitesine ait; ${siteId} için kullanılamaz.`,
        );
      }
    }
  }

  async listIdsForSite(siteId: string): Promise<string[]> {
    const snapshot = await this.firestore
      .collection("socialAccounts")
      .where("siteId", "==", siteId)
      .where("enabled", "==", true)
      .get();
    return snapshot.docs.map((document) => document.id);
  }
}

export class CredentialStore {
  private readonly cache = new Map<
    string,
    { expiresAt: number; value: Credential }
  >();

  constructor(
    private readonly client: SecretManagerServiceClient,
    private readonly projectId: string,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  async get(secretId: string): Promise<Credential> {
    const cached = this.cache.get(secretId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const name = secretId.startsWith("projects/")
      ? `${secretId}/versions/latest`
      : `projects/${this.projectId}/secrets/${secretId}/versions/latest`;
    const [version] = await this.client.accessSecretVersion({ name });
    const payload = version.payload?.data?.toString();
    if (!payload) throw new Error(`Secret boş: ${secretId}`);

    let value = credentialSchema.parse(JSON.parse(payload));
    if (
      value.expiresAt &&
      new Date(value.expiresAt).getTime() <= Date.now() + 5 * 60_000
    ) {
      value = await this.refresh(secretId, value);
    }
    this.cache.set(secretId, {
      expiresAt: Date.now() + this.ttlMs,
      value,
    });
    return value;
  }

  private async refresh(
    secretId: string,
    credential: Credential,
  ): Promise<Credential> {
    const refresh = credential.refresh;
    if (!refresh) {
      throw new Error(`Süresi dolan secret için yenileme ayarı yok: ${secretId}`);
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh.refreshToken,
      ...refresh.extra,
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (refresh.authStyle === "basic") {
      headers.Authorization = `Basic ${Buffer.from(
        `${refresh.clientId}:${refresh.clientSecret}`,
      ).toString("base64")}`;
    } else {
      body.set("client_id", refresh.clientId);
      body.set("client_secret", refresh.clientSecret);
    }
    const response = await fetch(refresh.tokenUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const result = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
    };
    if (!response.ok || !result.access_token) {
      throw new Error(`OAuth token yenileme başarısız: ${response.status}`);
    }
    const next = credentialSchema.parse({
      ...credential,
      accessToken: result.access_token,
      expiresAt: new Date(
        Date.now() + (result.expires_in ?? 3_600) * 1_000,
      ).toISOString(),
      refresh: {
        ...refresh,
        refreshToken: result.refresh_token ?? refresh.refreshToken,
      },
    });
    const parent = secretId.startsWith("projects/")
      ? secretId
      : `projects/${this.projectId}/secrets/${secretId}`;
    await this.client.addSecretVersion({
      parent,
      payload: { data: Buffer.from(JSON.stringify(next), "utf8") },
    });
    return next;
  }
}

export class JobStore {
  private readonly jobs;

  constructor(private readonly firestore: Firestore) {
    this.jobs = firestore.collection("publicationJobs");
  }

  async enqueue(input: CreatePublication): Promise<string[]> {
    const now = new Date();
    const scheduledAt = input.scheduledAt
      ? new Date(input.scheduledAt)
      : now;
    const batch = this.firestore.batch();
    const ids: string[] = [];

    for (const accountId of [...new Set(input.accountIds)]) {
      const ref = this.jobs.doc();
      ids.push(ref.id);
      batch.create(ref, {
        accountId,
        attempt: 0,
        content: input.content,
        createdAt: Timestamp.fromDate(now),
        language: input.language,
        scheduledAt: Timestamp.fromDate(scheduledAt),
        siteId: input.siteId,
        status: "pending",
        updatedAt: Timestamp.fromDate(now),
      });
    }
    await batch.commit();
    return ids;
  }

  async recoverExpired(limit: number): Promise<number> {
    const now = Timestamp.now();
    const expired = await this.jobs
      .where("status", "==", "processing")
      .where("leaseUntil", "<=", now)
      .limit(limit)
      .get();
    if (expired.empty) return 0;

    const batch = this.firestore.batch();
    for (const document of expired.docs) {
      batch.update(document.ref, {
        status: "pending",
        updatedAt: now,
      });
    }
    await batch.commit();
    return expired.size;
  }

  async claimDue(limit: number): Promise<ClaimedJob[]> {
    const now = Timestamp.now();
    const due = await this.jobs
      .where("status", "==", "pending")
      .where("scheduledAt", "<=", now)
      .orderBy("scheduledAt", "asc")
      .limit(limit)
      .get();
    const claimed: ClaimedJob[] = [];

    for (const snapshot of due.docs) {
      const job = await this.firestore.runTransaction(async (transaction) => {
        const current = await transaction.get(snapshot.ref);
        const data = current.data();
        if (!current.exists || data?.status !== "pending") return undefined;
        const attempt = Number(data.attempt ?? 0) + 1;
        transaction.update(snapshot.ref, {
          attempt,
          leaseUntil: Timestamp.fromMillis(Date.now() + 5 * 60_000),
          status: "processing",
          updatedAt: now,
        });
        return readJob(snapshot.id, {
          ...data,
          attempt,
          leaseUntil: Timestamp.fromMillis(Date.now() + 5 * 60_000),
          status: "processing",
          updatedAt: now,
        });
      });
      if (job) claimed.push(job);
    }
    return claimed;
  }

  async markPublished(
    jobId: string,
    externalId: string,
    publishedAt = new Date(),
  ): Promise<void> {
    await this.jobs.doc(jobId).update({
      externalId,
      leaseUntil: null,
      publishedAt: Timestamp.fromDate(publishedAt),
      status: "published",
      updatedAt: Timestamp.fromDate(publishedAt),
    });
  }

  async markRetry(jobId: string, message: string, scheduledAt: Date) {
    await this.jobs.doc(jobId).update({
      lastError: message,
      leaseUntil: null,
      scheduledAt: Timestamp.fromDate(scheduledAt),
      status: "pending",
      updatedAt: Timestamp.now(),
    });
  }

  async markFailed(jobId: string, message: string): Promise<void> {
    await this.jobs.doc(jobId).update({
      lastError: message,
      leaseUntil: null,
      status: "failed",
      updatedAt: Timestamp.now(),
    });
  }

  async markNeedsReview(jobId: string, message: string): Promise<void> {
    await this.jobs.doc(jobId).update({
      lastError: message,
      leaseUntil: null,
      status: "needs_review",
      updatedAt: Timestamp.now(),
    });
  }

  async get(jobId: string): Promise<ClaimedJob | undefined> {
    const snapshot = await this.jobs.doc(jobId).get();
    if (!snapshot.exists) return undefined;
    return readJob(snapshot.id, snapshot.data() ?? {});
  }
}

export class DailyRunStore {
  private readonly runs;

  constructor(private readonly firestore: Firestore) {
    this.runs = firestore.collection("dailyGenerationRuns");
  }

  async claim(siteId: string, day: string): Promise<boolean> {
    const ref = this.runs.doc(`${day}--${siteId}`);
    return this.firestore.runTransaction(async (transaction) => {
      const current = await transaction.get(ref);
      const status = current.data()?.status;
      if (status === "processing" || status === "completed") return false;
      transaction.set(ref, {
        day,
        siteId,
        status: "processing",
        updatedAt: Timestamp.now(),
      });
      return true;
    });
  }

  async complete(siteId: string, day: string, jobIds: string[]): Promise<void> {
    await this.runs.doc(`${day}--${siteId}`).update({
      jobIds,
      status: "completed",
      updatedAt: Timestamp.now(),
    });
  }

  async fail(siteId: string, day: string, error: string): Promise<void> {
    await this.runs.doc(`${day}--${siteId}`).update({
      error: error.slice(0, 1_000),
      status: "failed",
      updatedAt: Timestamp.now(),
    });
  }
}
