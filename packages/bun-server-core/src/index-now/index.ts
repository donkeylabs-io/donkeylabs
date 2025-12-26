import { logger } from "@donkeylabs/audit-logs";

export class IndexNowAPI {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly keyLocation: string;
  private readonly host: string;

  constructor(apiKey: string, host: string) {
    this.apiKey = apiKey;
    this.host = host;
    this.keyLocation = `https://${host}/${apiKey}.txt`;
    this.apiUrl = "https://api.indexnow.org/indexnow";
  }

  async submitURL(urls: string[]) {
    if (Bun.env.STAGE !== "prod") {
      return;
    }

    const response = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        key: this.apiKey,
        urlList: urls,
        host: this.host,
        keyLocation: this.keyLocation,
      }),
    });

    if (!response.ok) {
      logger.http.error("IndexNow API error:", await response.text());
      throw new Error("Failed to submit URL");
    }

    const data = await response.json();
    logger.http.debug("IndexNow response:", data);
    return data;
  }
}
