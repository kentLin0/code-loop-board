> 本文件已为 CodeLoop 修改。
# Cloud collaboration

Loop看板 can run as a small shared Cloudflare deployment for trusted collaborators. There is no enforced two-user limit:

- one Worker serves the built UI and the JSON API;
- D1 is the authoritative business database;
- a private R2 bucket stores attachments;
- UI, API, and attachment routes use HTTPS Basic Authentication; `/health` is public;
- open boards poll a global revision every two seconds and refresh after a change.

The example resource names are:

| Resource | Name |
| --- | --- |
| Worker | `codex-taskboard` |
| D1 database | `codex-taskboard-db` |
| R2 bucket | `codex-taskboard-attachments` |

This is a shared-password trust model. The Basic username is only the actor name displayed in task and comment attribution, not a verified identity. Anyone who knows the shared password has full read and write access and can choose any actor name.

Shell examples below use Bash syntax. In PowerShell, join backslash-continued lines into one command and set environment variables separately: `$env:CODEX_TASKBOARD_HOST = "127.0.0.1"`, then `npm start` or `npm run codex`. A Bash prefix such as `NAME=value command` is not PowerShell syntax. Deployment and remote import commands are instructions for an explicitly requested deployment, not steps run automatically by local setup.

## What stays local

The cloud stores project, issue, comment, relation, workflow, board configuration, external issue identity/state, delivery data, and attachments. The companion strips structured project/worktree paths from cloud writes. It does not scrub arbitrary descriptions, comments or attachment contents; text containing local paths remains shared content.

Each collaborator runs the local companion for Codex, Git/worktree scanning, installed Skill/MCP discovery, and project path mapping. The companion keeps the cloud URL, actor name, shared password, and device-specific project mappings in `cloud-companion.json` under its data directory (default `.data/`). The writer requests POSIX mode `0600`; this does not configure or guarantee equivalent Windows ACLs.

When cloud mode is active, the cloud is the only business-data source. A failed cloud request fails visibly. The companion does not fall back to the local SQLite database and does not write to both databases. `clb cloud logout` returns that device to its separate local mode; it does not merge local and cloud data.

## Owner: validate locally

If `wrangler.jsonc` is missing, first copy the repository's `wrangler.example.jsonc` to that local filename. Fill in your resource names and deployment settings according to the deployment section below; do not replace an existing configuration. For AI-assisted setup and a list of files to prepare, use the [setup prompt in README](../README.md#推荐让-ai-帮你配置).

Install dependencies and build the frontend:

```bash
npm ci
npm run build:web
```

Create an ignored `.dev.vars` file with a line `TASKBOARD_SHARED_SECRET=YOUR_LOCAL_SECRET`, replacing the placeholder privately on your device. Apply all pending D1 migrations to Wrangler's local state, and start the Worker:

```bash
npm run cloud:migrate:local
npm run dev:cloud
```

Open the printed loopback URL. The browser shows its native Basic Authentication prompt. Enter any local actor name as the username and the value from `.dev.vars` as the password.

Local Wrangler state lives under `.wrangler/` and is not committed.

The bundled migration scripts target `codex-taskboard-db`. If you changed the database name in `wrangler.jsonc`, use `npx wrangler d1 migrations apply YOUR_DATABASE_NAME --local` instead; replace the placeholder with that configured name. Local Wrangler simulation does not create remote D1/R2 resources.

## Owner: deploy

Authenticate Wrangler first:

```bash
npx wrangler login
npx wrangler whoami
```

Before provisioning, copy `wrangler.example.jsonc` to the ignored local file `wrangler.jsonc`. Choose the Worker name, custom domain, D1 database name, and R2 bucket name for your team, then replace the template D1 database ID after creating the database.

Provision the D1 database and private R2 bucket using the names chosen in your local `wrangler.jsonc`.

```bash
npx wrangler d1 create codex-taskboard-db
npx wrangler r2 bucket create codex-taskboard-attachments
```

`wrangler.example.jsonc` is the committed template. `wrangler.jsonc` is each team's ignored local deployment mapping and identifies the D1 binding by its resource name and `database_id`. A D1 database ID is public metadata, but keeping the active mapping local prevents an accidental deployment to another team's resources. Wrangler local development creates persistent local equivalents under `.wrangler/`; those are local simulations, not additional Cloudflare environments.

Apply the remote D1 migration and validate the deployment bundle:

```bash
npm run cloud:migrate
npm run cloud:deploy:dry-run
```

If you changed the D1 name, replace `npm run cloud:migrate` with `npx wrangler d1 migrations apply YOUR_DATABASE_NAME --remote`. For an existing deployment, compare its migration ledger with `cloud/migrations/` before applying: the current sequence includes `0001_initial.sql`, `0002_release_statuses.sql` and `0003_configurable_board.sql`. A filename change alone does not prove the database needs the same migration again.

Set the shared password through Wrangler's private interactive prompt after the database schema is ready. Do not put the value in `wrangler.jsonc`, a shell command, a log, or a committed file. Then deploy the production Worker:

```bash
npx wrangler secret put TASKBOARD_SHARED_SECRET
npm run cloud:deploy
```

These commands create or update Cloudflare resources. The repository contains only a template, not a team's active D1 database ID, shared password, API token, or OAuth token. Keep all active deployment configuration and credentials out of Git; cloning the repository does not grant access or mean the Worker has already been deployed.

Give the other collaborator the deployed Worker HTTPS origin and shared password through a trusted channel. Never publish the password in the repository, an issue, or logs.

Current Cloudflare references:

- [Workers Static Assets binding](https://developers.cloudflare.com/workers/static-assets/binding/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Create an R2 bucket](https://developers.cloudflare.com/r2/buckets/create-buckets/)
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## Friend: connect an existing GitHub installation

The owner follows this device setup too, using the owner's own actor name and checkout path. The friend does not need your local database or your filesystem paths. They update their existing clone and build the current UI:

```bash
git pull --ff-only
npm ci
npm run build:web
```

Start the local companion:

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm start
```

In a second terminal, configure cloud mode. Use the deployed HTTPS Worker origin, choose the actor name that should appear on their actions, and enter the shared password only at the private `Shared key:` prompt:

```bash
npm run clb -- cloud login \
  --url https://YOUR-WORKER-ORIGIN \
  --actor-name "FRIEND-DISPLAY-NAME"

npm run clb -- cloud status
npm run clb -- project list
```

The shared password is not part of the command and is not echoed by the prompt.

For every cloud project used with Codex, map its project ID to that friend's own absolute checkout path:

```bash
npm run clb -- project map PROJECT_ID \
  --workspace-path /absolute/path/on/their/device
```

The owner runs the same mapping command with the owner's own path. Mappings are intentionally different on each device and are never synchronized to D1. Choose the existing shared board project ID; matching display names alone do not merge projects with different IDs.

Launch the injected Codex window:

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

`npm run codex` reuses or starts the local companion. With the host setting above it listens on loopback. Keep it running while using the embedded board. The companion supplies local Codex/Git/Skill/MCP capabilities and sends the configured shared password to the Worker in the HTTPS Basic `Authorization` header. The cloud-session response omits the stored password; structured device paths remain local as described above.

Do not point `CODEX_TASKBOARD_URL` directly at the cloud origin for this workflow. `clb` talks to the loopback companion, which applies Basic Authentication and the device's local project mapping. If the companion uses a non-default loopback port, set `CODEX_TASKBOARD_COMPANION_URL` to that loopback origin.

## Browser-only access

Either collaborator can open the deployed HTTPS Worker URL directly. The browser's native Basic Authentication prompt asks for:

- username: the actor display name for that browser;
- password: the shared password.

The browser view supports the shared board and attachments. Device-only Codex, Git/worktree, Skill, and MCP capabilities still require the local companion.

## Rotate or revoke the shared password

The owner rotates the Worker secret using Wrangler's interactive prompt:

```bash
npx wrangler secret put TASKBOARD_SHARED_SECRET
```

After rotation, both devices rerun `clb cloud login` and enter the new password. Browser-only users must authenticate again; closing the authenticated browser session or clearing site authentication may be necessary because browsers cache Basic credentials.

Because collaborators share one password, rotation affects everyone using it. There is no individual-user revocation.

## Advanced: one-time import of existing local data

The migration tool takes a consistent SQLite snapshot with `VACUUM INTO`, removes structured device-only paths, exports attachment hashes, and writes a private bundle. The default local paths are:

```bash
npm run cloud:data -- export \
  --database .data/taskboard.sqlite \
  --attachments .data/attachments \
  --output cloud-migration-exports/initial
```

The output directory contains issue content and attachment bytes. The exporter requests POSIX directory/file modes `0700`/`0600`, which do not establish equivalent Windows ACLs, and the documented output directory is ignored by Git. This export is optional when starting with an empty cloud board.

Before importing, authenticate Wrangler, provision the named D1 and R2 resources, and run `npm run cloud:migrate` so the remote D1 schema exists. The target D1 must contain no projects, and none of the bundle's attachment keys may already exist in R2. Import refuses a non-empty target instead of merging or overwriting it.

Run the one-time Wrangler adapter with an explicit remote-operation acknowledgement:

```bash
TASKBOARD_MIGRATION_REMOTE=1 npm run cloud:data -- import \
  --bundle cloud-migration-exports/initial \
  --adapter ./scripts/wrangler-cloud-adapter.mjs

TASKBOARD_MIGRATION_REMOTE=1 npm run cloud:data -- verify \
  --bundle cloud-migration-exports/initial \
  --adapter ./scripts/wrangler-cloud-adapter.mjs
```

`TASKBOARD_MIGRATION_REMOTE=1` is required for these remote operations. The default adapter uses the current Wrangler login and `wrangler.jsonc`, but its database and bucket arguments default to `codex-taskboard-db` and `codex-taskboard-attachments`; it does not derive custom names from that config. For custom resource names, provide a local adapter module that calls `createWranglerCloudAdapters` with matching `database` and `bucket`, and pass that module through `--adapter`. The commands do not run automatically during deployment.

The bundled adapter directly executes `node_modules/.bin/wrangler`. Its existing integration check fails with ENOENT on the current Windows environment; the import/verify examples above are not verified Windows commands. A Windows adapter needs a working executable invocation through `wranglerExecutable`/`runCommand` before import can be used. No Windows workaround or remote import has been validated by this documentation audit.

The adapter has a local-persistence integration test that does not access remote Cloudflare resources:

```bash
node --test test/cloud-migration.test.mjs
```

