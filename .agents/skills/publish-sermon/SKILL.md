---
name: publish-sermon
description: Plans, drafts, verifies, publishes, and cleans up sermon audio using durable WordPress publication receipts.
compatibility: Requires Node.js 22.12+, 24.x, or 26+, pnpm 12, WordPress sermon REST resources, and Application Password configuration.
---

# Publish a sermon to WordPress

Use committed CLI commands, not ad-hoc publishing scripts. Never print credentials
or repair unrelated historical posts. Planning Center/QC values alone are not
metadata confirmation or publication approval.

## 1. Plan (read-only)

Obtain processed MP3, matching QC report, and confirmed metadata:

```sh
pnpm publication plan <sermon.mp3> \
  --qc .sermon-qc/<sermon.mp3>.qc.json \
  --receipt .sermon-qc/<sermon.mp3>.publication.json \
  --preacher "<preacher>" --series "<series>" --date <yyyy-mm-dd> \
  --scripture "<reference>" --title "<title>"
```

For a first sermon without existing Series artwork, add `--artwork <local.jpg-or-png>`.
Existing WordPress speaker and Series terms are required; never guess ambiguous
terms. Site timezone must be `America/New_York`. Planning refuses duplicate dates
(including trash) and possible orphan audio attachments.

Present plan before remote mutation: title, scripture, preacher/matched speaker,
Series/artwork ID, exact noon Eastern date, media host, and draft status. Receipts
pin input/QC/artwork bytes and site configuration. Never overwrite a receipt.

## 2. Draft and verify

```sh
pnpm publication draft <receipt.json>
pnpm publication verify <receipt.json>
```

Drafting journals mutation intent/results. Verification checks metadata, Series
artwork, associated audio, HTTPS media host, remote audio SHA-256, and HTTP 404
for equivalent local upload path. Provide edit link:
`<WORDPRESS_URL>/wp-admin/post.php?post=<post-id>&action=edit`.

## 3. Publish only after explicit approval

```sh
pnpm publication publish <receipt.json> --approve
```

This verifies and updates the existing draft with both published status and
`<yyyy-mm-dd>T12:00:00`. It never uploads another MP3. Retries verify existing
publication instead of creating duplicates. Verify public page/title and remote
audio before declaring success.

## 4. Clean up verified local output

```sh
pnpm publication cleanup <receipt.json>
```

User permits routine cleanup after successful publication. Command freshly
verifies public post, remote bytes, and matching local bytes before deletion.
Never delete source AIFF/WAV, artwork, QC, receipt, or preserved diagnostics.
Retain receipt/QC; verification and repeated cleanup still work afterward.

## Interrupted or failed operations

Do not retry uploading, change transport, delete a receipt, or create a new plan
to bypass an error. Explain failure and intended fix before changing code.

```sh
pnpm publication reconcile <receipt.json>
# After inspecting results and explicitly selecting the intended post:
pnpm publication reconcile <receipt.json> --post-id <id>
pnpm publication verify <receipt.json>
```

Reconciliation makes remote GET requests only. Adoption requires explicit post
selection and complete verification. No automatic orphan deletion. Incomplete
uploads without usable posts require inspecting journal/attachments before an
operator decides whether to finish or remove leftovers. Never clean up local
audio while publication is uncertain.

A `.lock` directory means another process may own the receipt. Verify no process
is running before removing a stale lock. Keep receipts/runtime artifacts in
gitignored `.sermon-qc/`; never commit credentials or generated state.
