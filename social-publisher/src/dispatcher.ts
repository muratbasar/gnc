import type { Platform, Publisher } from "./domain.js";
import { AmbiguousPublishError, PlatformApiError } from "./http.js";
import { AccountStore, CredentialStore, JobStore } from "./storage.js";

export interface DispatchSummary {
  claimed: number;
  failed: number;
  needsReview: number;
  published: number;
  recovered: number;
  retried: number;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1_000);
  return "Bilinmeyen paylaşım hatası";
}

export class Dispatcher {
  constructor(
    private readonly accounts: AccountStore,
    private readonly credentials: CredentialStore,
    private readonly jobs: JobStore,
    private readonly publishers: Map<Platform, Publisher>,
    private readonly maxAttempts: number,
  ) {}

  async dispatch(limit: number): Promise<DispatchSummary> {
    const recovered = await this.jobs.recoverExpired(limit);
    const jobs = await this.jobs.claimDue(limit);
    const summary: DispatchSummary = {
      claimed: jobs.length,
      failed: 0,
      needsReview: 0,
      published: 0,
      recovered,
      retried: 0,
    };

    await Promise.all(
      jobs.map(async (job) => {
        try {
          const account = await this.accounts.get(job.accountId);
          if (!account.enabled) {
            throw new PlatformApiError(
              "Sosyal hesap devre dışı.",
              400,
              false,
            );
          }
          if (account.siteId !== job.siteId) {
            throw new PlatformApiError(
              "İş ve sosyal hesap farklı sitelere ait.",
              400,
              false,
            );
          }
          const publisher = this.publishers.get(account.platform);
          if (!publisher) {
            throw new PlatformApiError(
              `Desteklenmeyen platform: ${account.platform}`,
              400,
              false,
            );
          }
          const credential = await this.credentials.get(account.secretId);
          const result = await publisher.publish(
            account,
            credential,
            job.content,
          );
          await this.jobs.markPublished(job.id, result.externalId);
          summary.published += 1;
        } catch (error) {
          const message = safeErrorMessage(error);
          if (error instanceof AmbiguousPublishError) {
            await this.jobs.markNeedsReview(job.id, message);
            summary.needsReview += 1;
            return;
          }

          const retryable =
            !(error instanceof PlatformApiError) || error.retryable;
          if (retryable && job.attempt < this.maxAttempts) {
            const delayMinutes = Math.min(2 ** job.attempt, 60);
            await this.jobs.markRetry(
              job.id,
              message,
              new Date(Date.now() + delayMinutes * 60_000),
            );
            summary.retried += 1;
            return;
          }

          await this.jobs.markFailed(job.id, message);
          summary.failed += 1;
        }
      }),
    );
    return summary;
  }
}
