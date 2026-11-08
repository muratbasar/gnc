import type { Credential, PostContent } from "./domain.js";
import { FetchHttpClient, type HttpClient } from "./http.js";
import type { Site } from "./sites.js";

type JobStatus = "in_progress" | "success" | "failed";

interface CanvaJob<T> {
  job?: {
    error?: { message?: string };
    id?: string;
    result?: T;
    status?: JobStatus;
  };
}

interface UploadResult {
  asset?: { id?: string };
}

interface AutofillResult {
  design?: { id?: string };
}

interface ExportResult {
  urls?: string[];
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class CanvaTemplateRenderer {
  private readonly root = "https://api.canva.com/rest/v1";

  constructor(private readonly http: HttpClient = new FetchHttpClient(30_000)) {}

  private headers(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
  }

  private async waitForJob<T>(
    type: "asset-uploads" | "autofills" | "exports",
    jobId: string,
    token: string,
  ): Promise<T> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await this.http.request<CanvaJob<T>>(
        `${this.root}/${type}/${encodeURIComponent(jobId)}`,
        { method: "GET", headers: this.headers(token) },
      );
      if (response.job?.status === "success" && response.job.result) {
        return response.job.result;
      }
      if (response.job?.status === "failed") {
        throw new Error(
          response.job.error?.message ?? `Canva ${type} işi başarısız oldu.`,
        );
      }
      await sleep(2_000);
    }
    throw new Error(`Canva ${type} işi zaman aşımına uğradı.`);
  }

  private async uploadImage(url: string, token: string): Promise<string> {
    const source = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!source.ok) {
      throw new Error(`Canva kaynak görseli alınamadı: ${source.status}`);
    }
    const body = new Uint8Array(await source.arrayBuffer());
    const uploaded = await this.http.request<CanvaJob<UploadResult>>(
      `${this.root}/asset-uploads`,
      {
        method: "POST",
        headers: {
          ...this.headers(token),
          "Asset-Upload-Metadata": JSON.stringify({
            name: `social-${Date.now()}`,
          }),
          "Content-Type":
            source.headers.get("content-type") ?? "application/octet-stream",
        },
        body,
      },
    );
    const jobId = uploaded.job?.id;
    if (!jobId) throw new Error("Canva yükleme işi kimliği döndürmedi.");
    const result = await this.waitForJob<UploadResult>(
      "asset-uploads",
      jobId,
      token,
    );
    if (!result.asset?.id) throw new Error("Canva asset kimliği döndürmedi.");
    return result.asset.id;
  }

  async render(
    site: Site,
    credential: Credential,
    content: PostContent,
  ): Promise<string> {
    if (!site.canvaTemplateId) {
      throw new Error(`${site.id} için Canva şablon kimliği ayarlanmamış.`);
    }
    const data: Record<string, unknown> = {
      headline: { type: "text", text: content.title ?? site.name },
      website: { type: "text", text: new URL(site.url).hostname },
    };
    if (content.imageUrl) {
      data.photo = {
        type: "image",
        asset_id: await this.uploadImage(
          content.imageUrl,
          credential.accessToken,
        ),
      };
    }

    const autofill = await this.http.request<CanvaJob<AutofillResult>>(
      `${this.root}/autofills`,
      {
        method: "POST",
        headers: {
          ...this.headers(credential.accessToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          brand_template_id: site.canvaTemplateId,
          title: `${site.name} - ${new Date().toISOString().slice(0, 10)}`,
          data,
        }),
      },
    );
    const autofillJobId = autofill.job?.id;
    if (!autofillJobId) throw new Error("Canva autofill işi kimliği döndürmedi.");
    const autofillResult = await this.waitForJob<AutofillResult>(
      "autofills",
      autofillJobId,
      credential.accessToken,
    );
    const designId = autofillResult.design?.id;
    if (!designId) throw new Error("Canva tasarım kimliği döndürmedi.");

    const exported = await this.http.request<CanvaJob<ExportResult>>(
      `${this.root}/exports`,
      {
        method: "POST",
        headers: {
          ...this.headers(credential.accessToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          design_id: designId,
          format: { type: "png" },
        }),
      },
    );
    const exportJobId = exported.job?.id;
    if (!exportJobId) throw new Error("Canva export işi kimliği döndürmedi.");
    const exportResult = await this.waitForJob<ExportResult>(
      "exports",
      exportJobId,
      credential.accessToken,
    );
    const imageUrl = exportResult.urls?.[0];
    if (!imageUrl) throw new Error("Canva dışa aktarma URL'si döndürmedi.");
    return imageUrl;
  }
}
