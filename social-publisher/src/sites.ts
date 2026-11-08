import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

export const siteSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.url(),
  language: z.literal("en"),
  canvaTemplateId: z.string().min(1).nullable(),
});

export type Site = z.infer<typeof siteSchema>;

export async function loadSites(
  path = resolve(process.cwd(), "config/sites.json"),
): Promise<Site[]> {
  const data: unknown = JSON.parse(await readFile(path, "utf8"));
  return z.array(siteSchema).min(1).parse(data);
}
