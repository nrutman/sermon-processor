---
name: publish-sermon
description: Uploads a verified sermon MP3 to WordPress, creates a complete draft, and publishes it only after explicit approval.
compatibility: Requires Node.js 22+, pnpm 11, WordPress sermon REST resources, and Application Password configuration.
---

# Publish a sermon to WordPress

## Confirm the inputs

Obtain the processed MP3 and its matching `.sermon-qc/*.qc.json` report. Confirm
the title, preacher, Series, scripture reference, and sermon date with the user.
Do not infer approval merely because Planning Center or the QC report contains
the values.

Before any mutation, present the intended WordPress payload, including:

- Title and scripture reference
- Preacher and matched WordPress speaker
- Matched WordPress Series and artwork attachment
- Sermon date at exactly `12:00:00` Eastern local time
- Expected offloaded media host from `WORDPRESS_MEDIA_HOST`
- Draft or published status

Never print the WordPress username or Application Password. Credentials belong
only in the gitignored `.env.local` file.

## Run read-only preflight checks

Confirm that the MP3 and QC report exist and that the QC report names the same
output file and metadata. Use authenticated GET or OPTIONS requests to confirm
that `sermons`, `sermon-speakers`, and `sermon-series` are available through the
standard WordPress REST API.

Search all statuses for an existing sermon on the requested date. Stop on a
duplicate rather than uploading another attachment. Match the Series
conservatively and require an existing sermon in that Series with artwork to
reuse. Never guess when multiple terms are plausible.

## Create a draft

Draft creation is the default:

```sh
pnpm publish-sermon <sermon.mp3> \
  --qc <sermon.qc.json> \
  --preacher "<preacher>" \
  --series "<series>" \
  --date <yyyy-mm-dd> \
  --scripture "<reference>" \
  --title "<title>"
```

Do not add `--publish` unless the user explicitly requests immediate public
publication. The client uses multipart HTTP/1.1 for compatibility with hosts
that reject raw REST uploads or HTTP/2 upload streams.

The publisher must refuse the operation and delete the attachment when
WordPress does not return an HTTPS media URL whose hostname exactly matches
`WORDPRESS_MEDIA_HOST`. It must also delete the draft and attachment when
post-creation verification fails.

If a request fails, explain the error and intended fix before changing code or
switching transport. Search WordPress for a partial post or orphaned attachment
before retrying.

## Verify the draft

Read the draft and attachment back through authenticated REST requests. Verify:

- Status is `draft`
- Local post date is `<yyyy-mm-dd>T12:00:00`
- Title, speaker, Series, scripture fields, duration, and button text
- Featured media is the existing Series artwork
- Audio metadata equals the uploaded attachment's `source_url`
- Attachment is associated with the sermon post
- Offloaded audio URL returns HTTP 200
- Equivalent local path under `WORDPRESS_URL` returns HTTP 404

Provide the WordPress edit link for review:

```text
<WORDPRESS_URL>/wp-admin/post.php?post=<post-id>&action=edit
```

## Publish only after approval

After the user explicitly approves publication, update the existing draft with
both `status: "publish"` and `date: "<yyyy-mm-dd>T12:00:00"` in the same
authenticated REST request. Resending the date prevents WordPress from
substituting the current publication time.

Verify the resulting status, local date, public permalink, rendered title, and
offloaded audio URL. The public page and media object must return HTTP 200 while
the equivalent local upload path remains unavailable.

Do not repair unrelated historical sermon anomalies during publishing.
