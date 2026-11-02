import type { Command } from "commander";
import { resolve } from "node:path";
import { loadWordPressConfig } from "../config/wordpress-config.js";
import { loadSermonConfig } from "../config/output-config.js";
import { WordPressClient } from "./client.js";
import {
  cleanupPublication,
  draftPublication,
  finishPublication,
  planPublication,
  reconcilePublication,
} from "./publication.js";

/** Registers the receipt-based publication commands. */
export function registerPublicationCommands(program: Command): void {
  const publication = program
    .command("publication")
    .description("Plan, draft, verify, and approve a sermon using a durable receipt");
  publication
    .command("plan")
    .argument("<input>", "verified MP3")
    .requiredOption("--qc <path>", "matching QC report")
    .requiredOption("--receipt <path>", "new receipt file (never overwritten)")
    .requiredOption("--preacher <name>", "confirmed preacher")
    .requiredOption("--series <name>", "confirmed Series")
    .requiredOption("--date <yyyy-mm-dd>", "confirmed sermon date")
    .requiredOption("--scripture <reference>", "confirmed scripture")
    .option("--title <title>", "confirmed title")
    .option("--wordpress-scripture <reference>", "WordPress-only scripture range")
    .option("--artwork <path>", "local artwork for a first sermon in a Series")
    .action(
      async (
        input: string,
        options: {
          qc: string;
          receipt: string;
          preacher: string;
          series: string;
          date: string;
          scripture: string;
          title?: string;
          wordpressScripture?: string;
          artwork?: string;
        },
      ) => {
        const config = await loadWordPressConfig();
        const sermon = await loadSermonConfig();
        const receipt = await planPublication(
          {
            input,
            qcReport: options.qc,
            ...(options.artwork ? { artwork: options.artwork } : {}),
            ...(options.wordpressScripture
              ? { wordpressScripture: options.wordpressScripture }
              : {}),
            metadata: {
              organization: sermon.organization,
              preacher: options.preacher,
              sermonSeries: options.series,
              date: options.date,
              scripture: options.scripture,
              ...(options.title ? { title: options.title } : {}),
            },
          },
          resolve(options.receipt),
          config,
          new WordPressClient(config),
        );
        console.log(
          JSON.stringify(
            {
              status: "planned (read-only)",
              site: receipt.siteUrl,
              intendedPostStatus: "draft",
              date: `${receipt.request.metadata.date}T12:00:00 America/New_York`,
              metadata: receipt.request.metadata,
              speaker: receipt.speaker,
              series: receipt.series,
              artworkId: receipt.artworkId,
              ...(receipt.artworkId === 0 ? { localArtwork: receipt.request.artwork } : {}),
              mediaHost: receipt.mediaHost,
              receipt: resolve(options.receipt),
            },
            null,
            2,
          ),
        );
      },
    );
  for (const action of ["draft", "verify", "publish", "reconcile", "cleanup"] as const) {
    publication
      .command(action)
      .argument("<receipt>", "publication receipt")
      .option("--approve", "explicit approval to publish this verified draft", false)
      .option("--post-id <id>", "explicit post to adopt during reconciliation")
      .action(async (path: string, options: { approve: boolean; postId?: string }) => {
        if (action === "publish" && !options.approve)
          throw new Error("Publication requires --approve");
        const postId = options.postId === undefined ? undefined : Number(options.postId);
        if (
          postId !== undefined &&
          (!Number.isSafeInteger(postId) || postId <= 0 || action !== "reconcile")
        )
          throw new Error("--post-id requires a positive integer and reconcile");
        const config = await loadWordPressConfig();
        const api = new WordPressClient(config);
        const result =
          action === "draft"
            ? await draftPublication(resolve(path), config, api)
            : action === "cleanup"
              ? await cleanupPublication(resolve(path), config, api)
              : action === "reconcile"
                ? await reconcilePublication(resolve(path), config, api, postId)
                : await finishPublication(resolve(path), config, api, action === "publish");
        console.log(JSON.stringify(result, null, 2));
      });
  }
}
