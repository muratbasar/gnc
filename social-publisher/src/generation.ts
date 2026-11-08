import { GoogleAuth } from "google-auth-library";
import { z } from "zod";
import type { PostContent } from "./domain.js";
import type { Site } from "./sites.js";
import type { SourcePage } from "./source.js";

const generatedContentSchema = z.object({
  title: z.string().trim().min(10).max(120),
  text: z.string().trim().min(80).max(1_500),
  hashtags: z
    .array(
      z
        .string()
        .trim()
        .regex(/^#?[\p{L}\p{N}_]+$/u)
        .transform((tag) => tag.replace(/^#/, "")),
    )
    .min(3)
    .max(12),
});

interface VertexResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

function vertexHost(location: string): string {
  return location === "global"
    ? "https://aiplatform.googleapis.com"
    : `https://${location}-aiplatform.googleapis.com`;
}

function parseModelJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

export class VertexContentGenerator {
  private readonly auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });

  constructor(
    private readonly projectId: string,
    private readonly location: string,
    private readonly model: string,
  ) {}

  async generate(site: Site, source: SourcePage): Promise<PostContent> {
    const client = await this.auth.getClient();
    const url =
      `${vertexHost(this.location)}/v1/projects/${encodeURIComponent(this.projectId)}` +
      `/locations/${encodeURIComponent(this.location)}/publishers/google/models/` +
      `${encodeURIComponent(this.model)}:generateContent`;
    const prompt = [
      "Write an original English social media post for a travel brand.",
      "Return only valid JSON with keys: title, text, hashtags.",
      "The text must be 80-180 words, useful, natural, and not repetitive.",
      "Use only facts present in SOURCE. Never invent prices, availability, ratings, history, or guarantees.",
      "Use a gentle call to action. Do not put the URL in text; it is added separately.",
      "Provide 5-8 relevant hashtags without the # prefix.",
      `BRAND: ${site.name}`,
      `SOURCE TITLE: ${source.title}`,
      `SOURCE URL: ${source.url}`,
      `SOURCE:\n${source.excerpt}`,
    ].join("\n\n");
    const response = await client.request<VertexResponse>({
      url,
      method: "POST",
      data: {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.8,
          responseMimeType: "application/json",
        },
      },
    });
    const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Vertex AI içerik döndürmedi.");
    const generated = generatedContentSchema.parse(parseModelJson(text));
    return {
      ...generated,
      link: source.url,
      hashtags: [...new Set(generated.hashtags)],
      ...(source.imageUrl ? { imageUrl: source.imageUrl } : {}),
    };
  }
}
