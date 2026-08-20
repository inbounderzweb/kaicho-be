export type DetectedFileKind = "jpeg" | "png" | "webp" | "avif" | "pdf";

export interface DetectedFileType {
  kind: DetectedFileKind;
  mediaType: "IMAGE" | "DOCUMENT";
  mimeType: string;
  extension: string;
}

const KIND_INFO: Record<DetectedFileKind, Omit<DetectedFileType, "kind">> = {
  jpeg: { mediaType: "IMAGE", mimeType: "image/jpeg", extension: "jpg" },
  png: { mediaType: "IMAGE", mimeType: "image/png", extension: "png" },
  webp: { mediaType: "IMAGE", mimeType: "image/webp", extension: "webp" },
  avif: { mediaType: "IMAGE", mimeType: "image/avif", extension: "avif" },
  pdf: { mediaType: "DOCUMENT", mimeType: "application/pdf", extension: "pdf" },
};

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

function isPng(buf: Buffer): boolean {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < sig.length) return false;
  return sig.every((byte, i) => buf[i] === byte);
}

function isWebp(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  return (
    buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP"
  );
}

// ISOBMFF-based: a leading box whose type is "ftyp" and whose major/compatible
// brands include "avif"/"avis". Scanning the whole ftyp box for the brand
// (rather than only the major-brand slot) covers encoders that list avif only
// as a compatible brand.
function isAvif(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.toString("ascii", 4, 8) !== "ftyp") return false;
  const boxSize = buf.readUInt32BE(0);
  if (boxSize < 8 || boxSize > buf.length) return false;
  const box = buf.toString("ascii", 8, boxSize);
  return box.includes("avif") || box.includes("avis");
}

function isPdf(buf: Buffer): boolean {
  return buf.length >= 5 && buf.toString("ascii", 0, 5) === "%PDF-";
}

export function detectFileType(buffer: Buffer): DetectedFileType | null {
  let kind: DetectedFileKind | null = null;

  if (isPng(buffer)) kind = "png";
  else if (isJpeg(buffer)) kind = "jpeg";
  else if (isWebp(buffer)) kind = "webp";
  else if (isAvif(buffer)) kind = "avif";
  else if (isPdf(buffer)) kind = "pdf";

  if (!kind) return null;
  return { kind, ...KIND_INFO[kind] };
}

// Basic structural sanity check beyond the header signature — a real PDF
// file has an EOF marker near its tail. Not a full parser; just cheap
// evidence the file isn't a header-only forgery.
export function looksLikeValidPdfStructure(buffer: Buffer): boolean {
  if (!isPdf(buffer)) return false;
  const tail = buffer.subarray(Math.max(0, buffer.length - 1024)).toString("latin1");
  return tail.includes("%%EOF");
}
