// Self-host patch: inline PDF-to-image conversion.
//
// Upstream converts PDFs in a Trigger.dev task (convertPdfToImageRoute).
// Without a Trigger.dev deployment the task never runs, documentVersion
// .hasPages stays false, and the UI shows "Preparing preview..." forever.
// This replicates the task's standard path in-process: the heavy lifting
// already lives in this app's own API routes (/api/mupdf/get-pages and
// /api/mupdf/convert-page run MuPDF locally), so we just drive them.
// Copied in by patches/apply.mjs; wired up in process-document.ts.
import { getFile } from "@/lib/files/get-file";
import prisma from "@/lib/prisma";
import { log } from "@/lib/utils";

const ONE_HOUR = 60 * 60 * 1000;

export function triggerDevConfigured() {
  return !!process.env.TRIGGER_SECRET_KEY;
}

export async function convertPdfToImagesInline({
  documentId,
  documentVersionId,
  teamId,
  versionNumber,
}: {
  documentId: string;
  documentVersionId: string;
  teamId: string;
  versionNumber?: number;
}) {
  const base = process.env.NEXT_PUBLIC_BASE_URL;
  const apiKey = process.env.INTERNAL_API_KEY;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const documentVersion = await prisma.documentVersion.findUnique({
    where: { id: documentVersionId },
    select: { file: true, storageType: true, numPages: true },
  });
  if (!documentVersion) throw new Error("Document version not found");

  const signedUrl = await getFile({
    type: documentVersion.storageType,
    data: documentVersion.file,
    expiresIn: ONE_HOUR,
  });
  if (!signedUrl) throw new Error("Failed to get signed URL for document");

  let numPages = documentVersion.numPages;
  if (!numPages || numPages === 1) {
    const response = await fetch(`${base}/api/mupdf/get-pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: signedUrl }),
    });
    if (!response.ok) {
      throw new Error(`get-pages failed with status ${response.status}`);
    }
    ({ numPages } = (await response.json()) as { numPages: number });
  }
  if (!numPages || numPages < 1) throw new Error("Failed to get page count");

  for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
    const response = await fetch(`${base}/api/mupdf/convert-page`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        documentVersionId,
        pageNumber,
        url: signedUrl,
        teamId,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `convert-page failed on page ${pageNumber} (status: ${response.status})`,
      );
    }
  }

  await prisma.documentVersion.update({
    where: { id: documentVersionId },
    data: { numPages, hasPages: true, isPrimary: true },
  });

  if (versionNumber) {
    await prisma.documentVersion.updateMany({
      where: { documentId, versionNumber: { not: versionNumber } },
      data: { isPrimary: false },
    });
  }

  // revalidate the document's links (same as the Trigger.dev task)
  try {
    await fetch(
      `${process.env.NEXTAUTH_URL}/api/revalidate?secret=${process.env.REVALIDATE_TOKEN}&documentId=${documentId}`,
    );
  } catch {
    // revalidation is best-effort
  }
}

// Fire-and-forget wrapper mirroring task.trigger() semantics: never block or
// fail the upload request on conversion problems.
export function convertPdfToImagesInlineInBackground(payload: {
  documentId: string;
  documentVersionId: string;
  teamId: string;
  versionNumber?: number;
}) {
  void convertPdfToImagesInline(payload).catch((error) => {
    log({
      message: `Inline PDF conversion failed for version ${payload.documentVersionId}: ${error}`,
      type: "error",
    });
  });
}
