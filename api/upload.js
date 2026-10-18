import { handleUpload } from '@vercel/blob/client';
import { passOk, rateLimited, tooMany } from './_lib/guard.js';

// Hands the browser a short-lived token to upload a quote's design file
// straight to Vercel Blob (the file never passes through this function, so
// Vercel's 4.5 MB function body limit doesn't apply). The resulting link is
// what gets emailed via FormSubmit, which strips CAD attachments. The quote
// form sends its bot-check pass (api/human.js) as the upload's clientPayload.
const ALLOWED_EXT = /\.(dxf|step|stp|stl|3mf|pdf|zip)$/i;
const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(request) {
  // A quote has at most 10 files; this leaves room for retries.
  if (rateLimited('upload', request, 40, 10)) return tooMany();
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request' }, { status: 400 });
  }
  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        if (!pathname.startsWith('quotes/') || !ALLOWED_EXT.test(pathname)) {
          throw new Error('File type not allowed');
        }
        if (!passOk(clientPayload)) throw new Error('Bot check missing or expired');
        return {
          maximumSizeInBytes: MAX_BYTES,
          addRandomSuffix: true,
          validUntil: Date.now() + 10 * 60 * 1000
        };
      }
    });
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
}
