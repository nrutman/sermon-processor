import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanningCenterClient } from "../client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PlanningCenterClient", () => {
  it("follows pagination and authenticates read-only requests", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "plan-1", type: "Plan", attributes: { sort_date: "2026-08-30" } }],
            links: { next: "https://api.planningcenteronline.com/services/v2/next" },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "plan-2", type: "Plan", attributes: { sort_date: "2026-09-06" } }],
            links: { next: null },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new PlanningCenterClient({
      clientId: "client",
      secret: "secret",
      userAgent: "Sermon Processor (test@example.com)",
    });

    const result = await client.listPlans("service-1", "2026-08-29T00:00:00.000Z");

    expect(result.data.map(({ id }) => id)).toEqual(["plan-1", "plan-2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstRequest = fetchMock.mock.calls[0];
    expect(firstRequest?.[0]).toContain("/service_types/service-1/plans?");
    expect(firstRequest?.[1]).not.toHaveProperty("method");
    expect(new Headers(firstRequest?.[1]?.headers).get("Authorization")).toBe(
      `Basic ${Buffer.from("client:secret").toString("base64")}`,
    );
  });

  it("includes Planning Center error details in request failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("permission denied", { status: 403, statusText: "Forbidden" }),
        ),
    );
    const client = new PlanningCenterClient({
      clientId: "client",
      secret: "secret",
      userAgent: "Sermon Processor (test@example.com)",
    });

    await expect(client.getSeries("series-1")).rejects.toThrow(
      "Planning Center request failed (403 Forbidden): permission denied",
    );
  });
});
