# Book Compressor

Book Compressor is a transient EPUB summarization tool.

- Upload an EPUB
- Parse chapters in the browser
- Run chapter-by-chapter compression through OpenRouter (1, 2, or 3 passes)
- Use Claude Haiku 4.5 as the default baseline model
- Enable optional per-pass model routing (for cheaper early passes)
- Preview chapter count and estimated API call volume before starting
- Stop an in-flight run from the UI
- Restore prior output from local browser checkpoint after refresh
- Edit all prompt modules directly in the UI before each run
- Generate a final book synthesis
- Download all outputs as a ZIP file
- Open `/viewer` to upload a result ZIP and browse chapters in a mobile-friendly reader UI
- Main compressor page includes direct Viewer links and uses matching markdown render principles for output preview

## Core Constraints

- No database
- No Supabase
- No persistent content storage
- BYOK (bring your own OpenRouter API key)

## Privacy Model

Book source files are parsed in-browser.
Only chapter text needed for each request is sent to server routes for inference.
This app is designed for transient processing and does not intentionally persist source book content.

## Legal Model

Users must attest they have rights or permission to process uploaded content.
This project is a utility tool and does not integrate with any piracy site or content acquisition flow.

## Local Development

```bash
npm install
npm run dev
```

Open http://localhost:3000

## Build Check

```bash
npm run build
```

## Deploy to Vercel

### Option A: From GitHub
1. Push this repo to GitHub.
2. Import the repo in Vercel.
3. Deploy.

### Option B: From CLI
```bash
npm i -g vercel
vercel
vercel --prod
```

No environment variables are required for MVP operation.

## Prompt Editing

The setup panel exposes all live prompts used by the pipeline:
- Pass 1 system + user
- Pass 2 system + user
- Pass 3 system + user
- Book synthesis system + user

Users can edit prompts before clicking **Start Compression**.
Reloading the page resets prompt text to default values.

## Run Modes

- 1 pass: fastest and lowest cost
- 2 passes: adds quality review + revision
- 3 passes: deepest quality mode

## Cost / Call Safety

Before each run, the UI shows an estimate for:
- selected chapter count
- expected model call count
- approximate cost (when OpenRouter pricing is available)

Use Max Chapters + Pass Mode to control spend.

Supported placeholders inside user prompts:
- `{{chapter_index}}`
- `{{total_chapters}}`
- `{{chapter_title}}`
- `{{target_length}}`
- `{{chapter_text}}`
- `{{pass_one_output}}`
- `{{pass_two_output}}`
- `{{book_title}}`
- `{{chapter_summaries}}`

## Viewer Route

- `/viewer`
  - Client-side ZIP viewer for Book Compressor outputs
  - Parses ZIP locally (no server upload)
  - Sidebar chapter navigation + responsive mobile chapter drawer

## API Routes

- `POST /api/summarize-chapter`
  - Input: `apiKey`, `model`, `chapterTitle`, `chapterText`, `chapterIndex`, `totalChapters`, `detailLevel`, `passCount`, `promptConfig`, `modelRouting`
  - Output: pass outputs + final chapter summary

- `POST /api/synthesize-book`
  - Input: `apiKey`, `model`, `bookTitle`, `chapterSummaries[]`, `promptConfig`, `modelRouting`
  - Output: full book compression

## Notes

- OpenRouter requests are sent with provider preferences:
  - `data_collection: "deny"`
  - `zdr: true`
- Chapter inputs are size-limited server-side for reliability.
