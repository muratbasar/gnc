import type {
  Credential,
  Platform,
  PostContent,
  Publisher,
  PublishResult,
  SocialAccount,
} from "./domain.js";
import {
  FetchHttpClient,
  formBody,
  PlatformApiError,
  type HttpClient,
} from "./http.js";

interface IdResponse {
  id?: string;
  post_id?: string;
}

function required(
  value: string | undefined,
  name: string,
  platform: Platform,
): string {
  if (!value) {
    throw new PlatformApiError(
      `${platform} paylaşımı için ${name} gerekli.`,
      400,
      false,
    );
  }
  return value;
}

function externalId(response: IdResponse, platform: Platform): string {
  const id = response.id ?? response.post_id;
  if (!id) {
    throw new PlatformApiError(
      `${platform} başarılı yanıtında paylaşım kimliği bulunamadı.`,
      502,
      false,
      response,
    );
  }
  return id;
}

function hashtagLine(content: PostContent): string {
  return content.hashtags.map((tag) => `#${tag}`).join(" ");
}

function caption(content: PostContent, includeLink = true): string {
  return [
    content.text,
    includeLink ? content.link : undefined,
    hashtagLine(content),
  ]
    .filter(Boolean)
    .join("\n\n");
}

abstract class BasePublisher implements Publisher {
  abstract readonly platform: Platform;

  constructor(protected readonly http: HttpClient) {}

  abstract publish(
    account: SocialAccount,
    credential: Credential,
    content: PostContent,
  ): Promise<PublishResult>;
}

class FacebookPublisher extends BasePublisher {
  readonly platform = "facebook" as const;

  constructor(
    http: HttpClient,
    private readonly graphVersion: string,
  ) {
    super(http);
  }

  async publish(
    account: SocialAccount,
    credential: Credential,
    content: PostContent,
  ): Promise<PublishResult> {
    const edge = content.imageUrl ? "photos" : "feed";
    const body = content.imageUrl
      ? formBody({
          url: content.imageUrl,
          caption: caption(content),
          access_token: credential.accessToken,
        })
      : formBody({
          message: caption(content, false),
          link: content.link,
          access_token: credential.accessToken,
        });
    const response = await this.http.request<IdResponse>(
      `https://graph.facebook.com/${this.graphVersion}/${encodeURIComponent(account.destinationId)}/${edge}`,
      { method: "POST", body },
    );
    return { externalId: externalId(response, this.platform) };
  }
}

class InstagramPublisher extends BasePublisher {
  readonly platform = "instagram" as const;

  constructor(
    http: HttpClient,
    private readonly graphVersion: string,
  ) {
    super(http);
  }

  async publish(
    account: SocialAccount,
    credential: Credential,
    content: PostContent,
  ): Promise<PublishResult> {
    const imageUrl = required(content.imageUrl, "imageUrl", this.platform);
    const root = `https://graph.facebook.com/${this.graphVersion}/${encodeURIComponent(account.destinationId)}`;
    const container = await this.http.request<IdResponse>(`${root}/media`, {
      method: "POST",
      body: formBody({
        image_url: imageUrl,
        caption: caption(content, false),
        access_token: credential.accessToken,
      }),
    });
    const creationId = externalId(container, this.platform);
    const published = await this.http.request<IdResponse>(
      `${root}/media_publish`,
      {
        method: "POST",
        body: formBody({
          creation_id: creationId,
          access_token: credential.accessToken,
        }),
      },
    );
    return { externalId: externalId(published, this.platform) };
  }
}

class ThreadsPublisher extends BasePublisher {
  readonly platform = "threads" as const;

  constructor(
    http: HttpClient,
    private readonly graphVersion: string,
  ) {
    super(http);
  }

  async publish(
    account: SocialAccount,
    credential: Credential,
    content: PostContent,
  ): Promise<PublishResult> {
    const root = `https://graph.threads.net/${this.graphVersion}/${encodeURIComponent(account.destinationId)}`;
    const container = await this.http.request<IdResponse>(`${root}/threads`, {
      method: "POST",
      body: formBody({
        media_type: content.imageUrl ? "IMAGE" : "TEXT",
        text: caption(content),
        image_url: content.imageUrl,
        access_token: credential.accessToken,
      }),
    });
    const creationId = externalId(container, this.platform);
    const published = await this.http.request<IdResponse>(
      `${root}/threads_publish`,
      {
        method: "POST",
        body: formBody({
          creation_id: creationId,
          access_token: credential.accessToken,
        }),
      },
    );
    return { externalId: externalId(published, this.platform) };
  }
}

class PinterestPublisher extends BasePublisher {
  readonly platform = "pinterest" as const;

  async publish(
    account: SocialAccount,
    credential: Credential,
    content: PostContent,
  ): Promise<PublishResult> {
    const imageUrl = required(content.imageUrl, "imageUrl", this.platform);
    const response = await this.http.request<IdResponse>(
      "https://api.pinterest.com/v5/pins",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          board_id: account.destinationId,
          title: content.title ?? content.text.slice(0, 100),
          description: caption(content, false),
          link: content.link,
          media_source: {
            source_type: "image_url",
            url: imageUrl,
          },
        }),
      },
    );
    return { externalId: externalId(response, this.platform) };
  }
}

interface RedditResponse {
  json?: {
    data?: { id?: string; name?: string; url?: string };
    errors?: unknown[];
  };
}

class RedditPublisher extends BasePublisher {
  readonly platform = "reddit" as const;

  async publish(
    account: SocialAccount,
    credential: Credential,
    content: PostContent,
  ): Promise<PublishResult> {
    const response = await this.http.request<RedditResponse>(
      "https://oauth.reddit.com/api/submit",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent":
            account.options.userAgent ?? "social-publisher/1.0 (self-hosted)",
        },
        body: formBody({
          api_type: "json",
          sr: account.destinationId,
          title: content.title ?? content.text.slice(0, 300),
          kind: content.link ? "link" : "self",
          url: content.link,
          text: content.link ? undefined : content.text,
          resubmit: true,
        }),
      },
    );
    if (response.json?.errors?.length) {
      throw new PlatformApiError(
        "Reddit paylaşımı doğrulama hatası döndürdü.",
        400,
        false,
        response.json.errors,
      );
    }
    const id = response.json?.data?.name ?? response.json?.data?.id;
    if (!id) {
      throw new PlatformApiError(
        "Reddit başarılı yanıtında paylaşım kimliği bulunamadı.",
        502,
        false,
        response,
      );
    }
    return { externalId: id };
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

class BloggerPublisher extends BasePublisher {
  readonly platform = "blogger" as const;

  async publish(
    account: SocialAccount,
    credential: Credential,
    content: PostContent,
  ): Promise<PublishResult> {
    const html = [
      `<p>${escapeHtml(content.text).replaceAll("\n", "<br>")}</p>`,
      content.imageUrl
        ? `<p><img src="${escapeHtml(content.imageUrl)}" alt=""></p>`
        : "",
      content.link
        ? `<p><a href="${escapeHtml(content.link)}">${escapeHtml(content.link)}</a></p>`
        : "",
    ].join("");
    const response = await this.http.request<IdResponse>(
      `https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(account.destinationId)}/posts/`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: content.title ?? content.text.slice(0, 100),
          content: html,
          labels: content.hashtags,
        }),
      },
    );
    return { externalId: externalId(response, this.platform) };
  }
}

interface TumblrResponse {
  response?: { id?: string | number; id_string?: string };
}

class TumblrPublisher extends BasePublisher {
  readonly platform = "tumblr" as const;

  async publish(
    account: SocialAccount,
    credential: Credential,
    content: PostContent,
  ): Promise<PublishResult> {
    const blocks: Record<string, unknown>[] = [
      { type: "text", text: content.text },
    ];
    if (content.imageUrl) {
      blocks.push({ type: "image", media: [{ url: content.imageUrl }] });
    }
    if (content.link) {
      blocks.push({ type: "link", url: content.link });
    }
    const response = await this.http.request<TumblrResponse>(
      `https://api.tumblr.com/v2/blog/${encodeURIComponent(account.destinationId)}/posts`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          state: "published",
          content: blocks,
          tags: content.hashtags,
        }),
      },
    );
    const id = response.response?.id_string ?? response.response?.id;
    if (id === undefined) {
      throw new PlatformApiError(
        "Tumblr başarılı yanıtında paylaşım kimliği bulunamadı.",
        502,
        false,
        response,
      );
    }
    return { externalId: String(id) };
  }
}

export function createPublishers(
  graphVersion: string,
  http: HttpClient = new FetchHttpClient(),
): Map<Platform, Publisher> {
  const publishers: Publisher[] = [
    new FacebookPublisher(http, graphVersion),
    new InstagramPublisher(http, graphVersion),
    new ThreadsPublisher(http, graphVersion),
    new PinterestPublisher(http),
    new RedditPublisher(http),
    new BloggerPublisher(http),
    new TumblrPublisher(http),
  ];
  return new Map(publishers.map((publisher) => [publisher.platform, publisher]));
}
