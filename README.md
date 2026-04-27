# Book Compressor

Book Compressor is a transient EPUB summarization tool.

- Upload an EPUB
- Parse chapters in the browser
- Run chapter-by-chapter 3-pass compression through OpenRouter
- Generate a final book synthesis
- Download all outputs as a ZIP file

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

## API Routes

- `POST /api/summarize-chapter`
  - Input: `apiKey`, `model`, `chapterTitle`, `chapterText`, `chapterIndex`, `totalChapters`, `detailLevel`
  - Output: pass1, pass2, final chapter summary

- `POST /api/synthesize-book`
  - Input: `apiKey`, `model`, `bookTitle`, `chapterSummaries[]`
  - Output: full book compression

## Notes

- OpenRouter requests are sent with provider preferences:
  - `data_collection: "deny"`
  - `zdr: true`
- Chapter inputs are size-limited server-side for reliability.
