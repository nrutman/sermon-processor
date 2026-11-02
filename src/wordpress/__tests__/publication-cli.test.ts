import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPublicationCommands } from "../publication-cli.js";
const mocks = vi.hoisted(() => ({
  plan: vi.fn<typeof import("../publication.js").planPublication>(),
  draft: vi.fn<typeof import("../publication.js").draftPublication>(),
  finish: vi.fn<typeof import("../publication.js").finishPublication>(),
  reconcile: vi.fn<typeof import("../publication.js").reconcilePublication>(),
  cleanup: vi.fn<typeof import("../publication.js").cleanupPublication>(),
}));
vi.mock("../publication.js", () => ({
  planPublication: mocks.plan,
  draftPublication: mocks.draft,
  finishPublication: mocks.finish,
  reconcilePublication: mocks.reconcile,
  cleanupPublication: mocks.cleanup,
}));
vi.mock("../../config/wordpress-config.js", () => ({
  loadWordPressConfig: async () => ({
    siteUrl: "https://church.example.org",
    mediaHost: "media.example.org",
    username: "test",
    applicationPassword: "secret",
  }),
}));
vi.mock("../../config/output-config.js", () => ({
  loadSermonConfig: async () => ({ organization: "Church" }),
}));
function program() {
  const cli = new Command();
  registerPublicationCommands(cli);
  return cli;
}
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
describe("publication CLI", () => {
  it("requires explicit approval before publishing", async () => {
    await expect(
      program().parseAsync(["publication", "publish", "receipt.json"], { from: "user" }),
    ).rejects.toThrow("--approve");
    expect(mocks.finish).not.toHaveBeenCalled();
  });
  it("prints the read-only mapped plan", async () => {
    mocks.plan.mockResolvedValue({
      version: 1,
      siteUrl: "https://church.example.org",
      mediaHost: "media.example.org",
      request: {
        input: "sermon.mp3",
        qcReport: "qc.json",
        metadata: {
          organization: "Church",
          preacher: "Alice Smith",
          sermonSeries: "Series",
          date: "2026-11-01",
          scripture: "2 Corinthians 4:1–6",
        },
      },
      audioSha256: "hash",
      qcSha256: "hash",
      durationSeconds: 60,
      speaker: { id: 1, name: "Alice Smith" },
      series: { id: 2, name: "Series" },
      artworkId: 3,
      state: "planned",
      journal: [],
      localAudioRemoved: false,
    });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await program().parseAsync(
      [
        "publication",
        "plan",
        "sermon.mp3",
        "--qc",
        "qc.json",
        "--receipt",
        "receipt.json",
        "--preacher",
        "Alice Smith",
        "--series",
        "Series",
        "--date",
        "2026-11-01",
        "--scripture",
        "2 Corinthians 4:1–6",
        "--title",
        "Gospel",
        "--artwork",
        "art.png",
      ],
      { from: "user" },
    );
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "sermon.mp3",
        artwork: "art.png",
        metadata: expect.objectContaining({ organization: "Church", title: "Gospel" }),
      }),
      expect.stringContaining("receipt.json"),
      expect.anything(),
      expect.anything(),
    );
    expect(output).toHaveBeenCalledWith(expect.stringContaining("planned (read-only)"));
  });
  it.each(["draft", "cleanup", "reconcile", "verify", "publish"] as const)(
    "routes %s without uploading outside draft",
    async (action) => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await program().parseAsync(
        ["publication", action, "receipt.json", ...(action === "publish" ? ["--approve"] : [])],
        { from: "user" },
      );
      const selected =
        action === "draft"
          ? mocks.draft
          : action === "cleanup"
            ? mocks.cleanup
            : action === "reconcile"
              ? mocks.reconcile
              : mocks.finish;
      expect(selected).toHaveBeenCalledOnce();
    },
  );
  it.each(["0", "NaN", "-1"])("rejects invalid adoption post ID %s", async (id) => {
    await expect(
      program().parseAsync(["publication", "reconcile", "receipt.json", "--post-id", id], {
        from: "user",
      }),
    ).rejects.toThrow("positive integer");
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
});
