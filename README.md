# Book Compressor

Book Compressor is a local-first EPUB compression tool.

- Upload an EPUB
- Parse chapters in-browser
- Generate a chapter-by-chapter walkthrough
- Generate a final book synthesis
- Download a viewer-ready ZIP
- Open `/viewer` for sidebar/mobile reading

## Mini-app mode (Tailnet app)

This project is now structured to run as a **local "hosted by you" app**.

Default path:
- `https://<device>.ts.net/bookcompressor`

Default base path in this repo:
- `/bookcompressor`

You can override it at build/start time with:
- `NEXT_PUBLIC_BASE_PATH`
- or `BOOK_COMPRESSOR_BASE_PATH`

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
- No persistent source-book storage
- Transient processing pipeline

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

## Privacy model

Book source files are parsed in-browser.
Only chapter text needed for inference is sent through app routes.

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
