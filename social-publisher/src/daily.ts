import { CanvaTemplateRenderer } from "./canva.js";
import { VertexContentGenerator } from "./generation.js";
import type { Site } from "./sites.js";
import { SiteSourceReader } from "./source.js";
import {
  AccountStore,
  CredentialStore,
  DailyRunStore,
  JobStore,
} from "./storage.js";

export interface DailyGenerationSummary {
  completed: Array<{ siteId: string; jobs: number }>;
  failed: Array<{ siteId: string; error: string }>;
  skipped: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown generation error";
}

export class DailyGenerator {
  constructor(
    private readonly sites: Site[],
    private readonly accounts: AccountStore,
    private readonly credentials: CredentialStore,
    private readonly jobs: JobStore,
    private readonly runs: DailyRunStore,
    private readonly sources: SiteSourceReader,
    private readonly content: VertexContentGenerator,
    private readonly canva: CanvaTemplateRenderer,
    private readonly canvaSecretId: string,
  ) {}

  async run(date = new Date()): Promise<DailyGenerationSummary> {
    const day = date.toISOString().slice(0, 10);
    const summary: DailyGenerationSummary = {
      completed: [],
      failed: [],
      skipped: [],
    };

    for (const site of this.sites) {
      if (!(await this.runs.claim(site.id, day))) {
        summary.skipped.push(site.id);
        continue;
      }
      try {
        const accountIds = await this.accounts.listIdsForSite(site.id);
        if (!accountIds.length) {
          throw new Error("Etkin sosyal hesap bulunamadı.");
        }
        const source = await this.sources.pickDailyPage(site, date);
        const generated = await this.content.generate(site, source);
        const canvaCredential = await this.credentials.get(this.canvaSecretId);
        const imageUrl = await this.canva.render(
          site,
          canvaCredential,
          generated,
        );
        const jobIds = await this.jobs.enqueue({
          siteId: site.id,
          language: "en",
          accountIds,
          content: { ...generated, imageUrl },
          scheduledAt: date.toISOString(),
        });
        await this.runs.complete(site.id, day, jobIds);
        summary.completed.push({ siteId: site.id, jobs: jobIds.length });
      } catch (error) {
        const message = errorMessage(error);
        await this.runs.fail(site.id, day, message);
        summary.failed.push({ siteId: site.id, error: message });
      }
    }
    return summary;
  }
}
