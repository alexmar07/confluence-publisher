# confluence-docs-publisher

`confluence-docs-publisher` is a public, reusable GitHub Action that publishes a folder of
Markdown files from a repository to a Confluence Cloud space, preserving the folder
hierarchy. It is built on the Confluence Cloud REST API, is idempotent with respect to the
published content, and is resilient to single-page errors: the failure of one file does not
stop the publication of the remaining ones.

## Key features

- **Page identity independent of the title.** The link between a file and a Confluence page
  rests on a content property, not on the title: renaming a document's H1 updates the existing
  page instead of creating a new one, and moving a file between folders repositions the page
  instead of duplicating it.
- **Idempotency.** A second run with unchanged content produces no write request and no version
  bump on Confluence.
- **Mirrored hierarchy.** The repository folder structure is reflected in the page structure,
  with container pages created where needed.
- **Errors collected, never aborted.** Execution continues on the remaining files after one of
  them fails; the overall outcome emerges only at the end.
- **`dry-run` mode.** Shows the full publication plan without any write, typically on a pull
  request.
- **No branch or event logic.** The action reads no `github.ref` and applies no rule of its own
  about when to publish: the publication policy belongs entirely to the calling workflow.

## Usage

```yaml
name: Publish Docs to Confluence

on:
  push:
    branches: [main]
    paths: ['docs/**']
  pull_request:
    paths: ['docs/**']
  workflow_dispatch: {}

permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - uses: <owner>/confluence-docs-publisher@v1
        with:
          folder: docs
          base-url: ${{ secrets.CONFLUENCE_BASE_URL }}
          username: ${{ secrets.CONFLUENCE_USERNAME }}
          api-token: ${{ secrets.CONFLUENCE_API_TOKEN }}
          space-key: ${{ secrets.CONFLUENCE_SPACE_KEY }}
          parent-page-id: ${{ secrets.CONFLUENCE_PARENT_PAGE_ID }}
          exclude: |
            drafts/**
            internal/**
          dry-run: ${{ github.event_name == 'pull_request' }}
```

## Inputs

| Name | Required | Default | Description |
|---|---|---|---|
| `folder` | Yes | — | Root folder of the Markdown files, relative to the repository root |
| `base-url` | Yes | — | `https://<tenant>.atlassian.net` |
| `username` | Yes | — | Email address of the Atlassian account |
| `api-token` | Yes | — | Atlassian API token |
| `space-key` | Yes | — | Key of the target Confluence space |
| `parent-page-id` | Yes | — | Id of the root page to publish under |
| `include` | No | `**/*.md` | Globs of files to include, relative to `folder`, newline-separated |
| `exclude` | No | (empty) | Excluded globs, relative to `folder`, newline-separated |
| `title-strategy` | No | `h1` | Title derivation strategy: `h1`, `filename` or `frontmatter` |
| `dry-run` | No | `false` | Runs planning and preflight without performing any write |
| `fail-on-error` | No | `true` | Determines whether `failed > 0` exits with code 1 |
| `orphans` | No | `report` | Policy for orphan and unmanaged pages: `report` or `ignore` |
| `concurrency` | No | `4` | Maximum number of pages processed in parallel; minimum value `1` |
| `request-timeout-ms` | No | `30000` | Timeout of a single HTTP request, in milliseconds; minimum value `1000` |
| `max-retries` | No | `5` | Maximum number of retries on `429`, `502`, `503` and `504` responses, with exponential backoff and jitter |
| `version-message` | No | `Updated by GitHub Actions` | Version message applied to updates on Confluence |
| `add-source-footer` | No | `true` | Appends a footer to each page with a permalink to the source file on GitHub |
| `mermaid-macro` | No | `code` | Macro used for mermaid code blocks: `code` or the name of a marketplace macro |

The `include` and `exclude` globs are always resolved relative to `folder`: with `folder: docs`,
the pattern `integrations/**` in `exclude` excludes `docs/integrations/`, not `integrations/`
from the repository root. The paths stored in the `source-path` content property remain relative
to the repository root instead, so that they stay valid even if the value of `folder` is changed
later.

## Outputs

| Name | Description |
|---|---|
| `created` | Pages created from a source file |
| `updated` | Pages updated from a source file |
| `moved` | Pages repositioned in the hierarchy |
| `skipped` | Unchanged pages |
| `failed` | Failed pages |
| `containers` | Synthetic container pages created, updated or unchanged, counted separately |
| `attachments` | Attachments uploaded or replaced |
| `orphans` | Orphan pages detected |
| `unmanaged` | Pages with no tracking content property |
| `report` | Full JSON report of the outcomes |

`containers` counts every synthetic container page seen in the run, unchanged ones included.
Pages derived from a `README.md` or `index.md` file are not counted here: they are file-derived
pages in every respect and contribute to `created`, `updated`, `moved` or `skipped`.
`attachments` counts the attachments actually uploaded or replaced, not those referenced: an
attachment whose sha256 matches the one already recorded produces no new upload.

## The identity mechanism based on `source-path`

The link between a Markdown file and the corresponding Confluence page does not rest on the
title, but on a set of content properties that the action writes on every managed page:

| Key | Content |
|---|---|
| `confluence-docs-publisher.source-path` | Path of the source file relative to the repository root, for example `docs/integrations/tconnect.md` |
| `confluence-docs-publisher.synthetic` | Boolean; `true` only on container pages with no source file of their own |
| `confluence-docs-publisher.content-hash` | Idempotency hash of the title, the parent and the generated storage XHTML |
| `confluence-docs-publisher.attachment-hashes` | Map `attachment name → sha256`, present only on pages that have attachments |

`source-path` is the sole identity criterion of a page. Synthetic container pages, which have no
source file of their own, set it to the folder path terminated by `/` (for example
`docs/integrations/`) and `synthetic` to `true`: they are thus tracked like every other page and
are never classified as unmanaged.

**Migration from pre-existing pages.** If a page carries the title computed for a file being
published but lacks the `source-path` property, and no other page already claims that file, the
action adopts the page — writing the tracking properties on it — so that subsequent runs no
longer depend on the title. This is the normal case of the first run following a migration from a
previous action without this mechanism. If instead the title is already taken by a page carrying
a different `source-path`, or by a page in `archived` or `trashed` status, or the outcome is
ambiguous because several pages match, the action reports a conflict and stops execution before
any write, indicating the sources involved and the applicable remedy.

**Moved files.** Moving a file between folders is recognised as a relocation, not as a title
conflict: the page is repositioned under the new parent and is never reported as an orphan in the
run that moves it. Recognition requires the title and the body to be unchanged, so moving and
editing a file in the same commit is reported as a conflict — publish the move first, then the
edit. A folder rename is not a move: it changes the container page's title, and the old container
is reported as an orphan.

## Error handling

The action contains no mid-work abort: every file being published produces a typed outcome
(`created`, `updated`, `moved`, `skipped` or `failed`), and execution continues on the remaining
files after a failure. The failure of a container page, whether synthetic or derived from
`README.md`/`index.md`, does however prevent the publication of the entire subtree that depends
on it: each descendant is marked as `failed` with the reason "parent unavailable" and the cause of
the original failure, rather than attempting a creation doomed to fail with a sequence of 404
errors carrying no diagnostic meaning. Unaffected branches proceed normally. Exit code 1 is
returned only at the end, and only if `failed > 0` and the `fail-on-error` input is `true`.

## Troubleshooting

| Symptom | Cause | Remedy |
|---|---|---|
| `parent-page-id "X" is a Folder, not a Page` | The given parent is a content item of type Folder | Provide the id of a Page |
| `HTTP 404` on the parent | Page deleted, trashed, or belonging to another space | Check the id and `space-key` |
| `HTTP 409` on update | Concurrent modification of the page | The action re-reads and retries once; if it persists, repeat the run |
| `HTTP 400` on write | Storage XHTML rejected | Check the message reported in the job summary: it points to the spot |
| `HTTP 403` on write | Insufficient permissions on the space | Grant page creation permission to the token's account |
| `Title preflight failed` | Two sources claim the same title, or the title is taken by another page | Each conflict line names the pages involved and its own remedy |

## Security

The action calls `core.setSecret()` on `api-token` and on `username`, and redacts both from the
HTTP response bodies it logs on error: neither credential is ever written to the job logs. The
action needs no permission beyond `contents: read`.

## License

Distributed under the MIT license. See [`LICENSE`](./LICENSE).
