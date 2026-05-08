# Book Compressor

Book Compressor is a local-first EPUB compression tool.

- Chat-first workflow (send EPUB to your AI gateway)
- Local permalink library for completed compressions (`/<id>`)
- Web upload fallback (drag/drop + file picker) for large/direct runs
- Generate chapter-by-chapter walkthroughs + final synthesis
- Download ZIP artifacts per saved book
- Open `/viewer` for ZIP-based sidebar/mobile reading

## Mini-app mode (Tailnet app)

This project is now structured to run as a **local "hosted by you" app**.

Default path:
- `https://<device>.ts.net/bookcompressor`

Default base path in this repo:
- `/bookcompressor`

You can override it at build/start time with:
- `NEXT_PUBLIC_BASE_PATH`
- or `BOOK_COMPRESSOR_BASE_PATH`

PWA note:
- Manifest `id`, `start_url`, and `scope` are scoped to this base path.
- This allows separate installs per app path on the same domain (for example `/bookcompressor` and `/mindfeed`).

## Model access (no key field in UI)

The app no longer asks users to paste an API key in the form.

By default it uses the host's OpenClaw-connected model stack via:
- `openclaw capability model run --gateway`

So if OpenClaw is already configured on the machine, users can run Book Compressor without adding a separate model key here.

Optional fallback mode:
- Set `BOOK_COMPRESSOR_INFERENCE_PROVIDER=openrouter`
- Then provide one of these env vars:
  - `OPENROUTER_API_KEY` (recommended)
  - `OPENROUTER_KEY`
  - `OPENROUTER_API_TOKEN`
  - `AI_API_KEY`
  - `LLM_API_KEY`

## Core constraints

- No database
- No Supabase
- No persistent raw source-book storage by default
- Saved outputs are local JSON records on this machine (`.runtime/books/*.json`)

## Local development

```bash
npm install
export NEXT_PUBLIC_BASE_PATH="/bookcompressor"
npm run dev -- --hostname 127.0.0.1 --port 3000
```

Prerequisite for default mode:
- OpenClaw Gateway is running and usable on this machine

Open:
- `http://localhost:3000/bookcompressor`

Viewer:
- `http://localhost:3000/bookcompressor/viewer`

## Standard lifecycle scripts

```bash
# one-command guided setup (recommended)
./scripts/setup.sh

# prerequisite check (tailscale + openclaw + model smoke + port)
./scripts/prereq-check.sh

# install deps
./scripts/install.sh

# start in prod mode (build + next start)
./scripts/start.sh

# stop
./scripts/stop.sh

# status + recent logs
./scripts/status.sh

# configure tailscale path mapping
./scripts/serve-path.sh

# merge upstream main into your fork branch
./scripts/update-upstream.sh
```

Notes:
- `install.sh` runs `prereq-check.sh` automatically by default.
- To skip the check: `BOOK_COMPRESSOR_SKIP_PREREQ_CHECK=1 ./scripts/install.sh`
- `prereq-check.sh` now prints explicit safe fix hints when a requirement is missing and writes a report to `.runtime/prereq-report.txt`.

### AI-guided resilient setup loop

If prerequisites are missing, use this loop:

1. Run `./scripts/prereq-check.sh`
2. Fix one required issue from the script's "Suggested safe fixes"
3. Re-run `./scripts/prereq-check.sh`
4. Repeat until all required checks pass
5. Run `./scripts/setup.sh`

Safety rule: any `sudo` or package-manager command should be user-approved before running.

Optional runtime env vars:
- `BOOK_COMPRESSOR_MODE=prod|dev` (default `prod`)
- `BOOK_COMPRESSOR_HOST=127.0.0.1` (default `127.0.0.1`)
- `BOOK_COMPRESSOR_PORT=3000` (default `3000`)
- `NEXT_PUBLIC_BASE_PATH=/bookcompressor` (default `/bookcompressor`)
- `BOOK_COMPRESSOR_INFERENCE_PROVIDER=openclaw|openrouter` (default `openclaw`)
- `BOOK_COMPRESSOR_AI_TIMEOUT_MS=300000` (default `300000`)

## API routes

With default base path `/bookcompressor`, the effective routes are:

- `POST /bookcompressor/api/summarize-chapter`
- `POST /bookcompressor/api/synthesize-book`
- `GET /bookcompressor/api/health`
- `GET /bookcompressor/api/books` (list local saved books)
- `POST /bookcompressor/api/books` (save a completed compression)
- `DELETE /bookcompressor/api/books` (clear all saved books)
- `GET /bookcompressor/api/books/:id` (load one saved book)
- `DELETE /bookcompressor/api/books/:id` (delete one saved book)
- `GET /bookcompressor/api/books/:id/zip` (download ZIP artifact)

Permalink pages:
- `/bookcompressor/:id`

## Privacy model

Book processing runs on this machine.

By default:
- raw source-book content is not permanently stored by the app
- completed outputs (chapter summaries + synthesis + metadata) are saved locally in `.runtime/books/`
- no external database is used

## Legal model

Users must have rights or permission to process uploaded content.

## Fork + re-sync workflow

### If you cloned this repo directly (no fork)

```bash
git pull --ff-only origin main
./scripts/start.sh
```

### If you forked and customized

1. Add upstream once:

```bash
git remote add upstream https://github.com/humanitylabs-org/bookcompressor.git
```

2. Re-sync updates anytime:

```bash
./scripts/update-upstream.sh
./scripts/start.sh
```

Customization-safe practice:
- Keep your custom UI changes in your own branch/fork.
- Pull upstream regularly and resolve conflicts in your branch.
- Prefer env-based settings for deploy details (port, base path, provider) so updates stay low-friction.
