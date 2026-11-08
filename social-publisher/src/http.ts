export class PlatformApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "PlatformApiError";
  }
}

export class AmbiguousPublishError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AmbiguousPublishError";
  }
}

export interface HttpClient {
  request<T>(url: string, init: RequestInit): Promise<T>;
}

function parseResponseBody(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class FetchHttpClient implements HttpClient {
  constructor(private readonly timeoutMs = 20_000) {}

  async request<T>(url: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new AmbiguousPublishError(
        "Platform yanıtı alınamadı; paylaşım gerçekleşmiş olabilir.",
        { cause: error },
      );
    }

    const body = parseResponseBody(await response.text());
    if (!response.ok) {
      throw new PlatformApiError(
        `Platform API isteği ${response.status} durumuyla başarısız oldu.`,
        response.status,
        response.status === 429 || response.status >= 500,
        body,
      );
    }

    return body as T;
  }
}

export function formBody(
  values: Record<string, string | number | boolean | undefined>,
): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) body.set(key, String(value));
  }
  return body;
}
