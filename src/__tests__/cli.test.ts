import { afterEach, describe, expect, it, vi } from "vitest";

type LoadSermonConfig = typeof import("../config/output-config.js").loadSermonConfig;
type ProcessSermon = typeof import("../process/process-sermon.js").processSermon;

const mocks = vi.hoisted(() => ({
  loadSermonConfig: vi.fn<LoadSermonConfig>(),
  processSermon: vi.fn<ProcessSermon>(),
}));

vi.mock("../config/output-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/output-config.js")>()),
  loadSermonConfig: mocks.loadSermonConfig,
}));
vi.mock("../process/process-sermon.js", () => ({ processSermon: mocks.processSermon }));

import { createProgram } from "../cli.js";

afterEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("process command", () => {
  it("passes validated metadata and processing options to the pipeline", async () => {
    mocks.loadSermonConfig.mockResolvedValue({
      filenameFormat: "SERMON-YYYY-MM-DD-LAST",
      organization: "Example Church",
      outputDirectory: "/tmp",
    });
    mocks.processSermon.mockResolvedValue({
      outputPath: "/tmp/output.mp3",
      qcReportPath: "/tmp/output.qc.json",
      workDirectory: "/tmp/work",
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const progressOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.processSermon.mockImplementationOnce(async (_request, _runner, reportProgress) => {
      reportProgress?.({ stage: "Decode canonical WAV", status: "started" });
      reportProgress?.({
        durationSeconds: 1.25,
        stage: "Decode canonical WAV",
        status: "completed",
      });
      return {
        outputPath: "/tmp/output.mp3",
        qcReportPath: "/tmp/output.qc.json",
        workDirectory: "/tmp/work",
      };
    });

    await createProgram().parseAsync(
      [
        "process",
        "/tmp/input.aiff",
        "--preacher",
        "Alice Smith",
        "--series",
        "Example Series",
        "--date",
        "2026-01-04",
        "--scripture",
        "Matthew 5:1–12",
        "--artwork",
        "/tmp/artwork.png",
        "--title",
        "Sample Sermon",
        "--output",
        "/tmp/output.mp3",
        "--overwrite",
        "--keep-work-files",
      ],
      { from: "user" },
    );

    expect(mocks.processSermon.mock.calls[0]?.[0]).toMatchObject({
      artwork: "/tmp/artwork.png",
      input: "/tmp/input.aiff",
      keepWorkFiles: true,
      metadata: {
        date: "2026-01-04",
        organization: "Example Church",
        preacher: "Alice Smith",
        scripture: "Matthew 5:1–12",
        sermonSeries: "Example Series",
        title: "Sample Sermon",
      },
      output: "/tmp/output.mp3",
      overwrite: true,
    });
    expect(progressOutput).toHaveBeenCalledWith("→ Decode canonical WAV");
    expect(progressOutput).toHaveBeenCalledWith("✓ Decode canonical WAV (1.3s)");
  });
});

describe("command availability", () => {
  it("rejects direct publishing outside the receipt workflow", async () => {
    const program = createProgram()
      .exitOverride()
      .configureOutput({ writeErr: () => undefined });
    await expect(
      program.parseAsync(["publish", "/tmp/sermon.mp3"], { from: "user" }),
    ).rejects.toThrow("unknown command 'publish'");
  });
});

describe("plan-metadata command", () => {
  it("prints metadata read through the Planning Center client", async () => {
    vi.stubEnv("PLANNING_CENTER_CLIENT_ID", "client");
    vi.stubEnv("PLANNING_CENTER_SECRET", "secret");
    vi.stubEnv("PLANNING_CENTER_USER_AGENT", "Sermon Processor (test@example.com)");
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/plans?")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "plan-1",
                type: "Plan",
                attributes: {
                  planning_center_url: "https://example.com/plan-1",
                  sort_date: "2026-08-30T09:30:00Z",
                  title: "Sample Sermon",
                },
                relationships: { series: { data: { id: "series-1", type: "Series" } } },
              },
            ],
          }),
        );
      }
      if (url.endsWith("/series/series-1")) {
        return new Response(
          JSON.stringify({
            data: {
              id: "series-1",
              type: "Series",
              attributes: {
                artwork_content_type: "image/png",
                artwork_original: "https://example.com/art.png",
                has_artwork: true,
                title: "Sermon on the Mount",
              },
            },
          }),
        );
      }
      if (url.includes("/items?")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "scripture",
                type: "Item",
                attributes: {
                  description: "Matthew 7:13–23",
                  item_type: "item",
                  sequence: 1,
                  title: "Scripture Reading",
                },
              },
            ],
          }),
        );
      }
      if (url.includes("/team_members?")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "preacher",
                type: "PlanPerson",
                attributes: {
                  name: "Robert Parker",
                  status: "confirmed",
                  team_position_name: "Preacher",
                },
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected Planning Center request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createProgram().parseAsync(
      ["plan-metadata", "--date", "2026-08-30", "--service-type", "service-1", "--json"],
      { from: "user" },
    );

    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      artwork: { contentType: "image/png", url: "https://example.com/art.png" },
      date: "2026-08-30",
      preacher: "Robert Parker",
      scripture: "Matthew 7:13–23",
      sermonSeries: "Sermon on the Mount",
      title: "Sample Sermon",
      warnings: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
