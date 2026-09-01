import sharp from "sharp";

/**
 * Re-encodes an image as JPEG, repeatedly lowering quality and then
 * dimensions until it fits under `maxBytes`. Used when an outgoing MMS
 * attachment exceeds the size Google Voice's `sendsms` endpoint accepts
 * (observed: a ~11 MB request body was rejected with
 * `INVALID_ARGUMENT`/`base64_format: "CAU="`, a ~400 KB one succeeded — the
 * exact server-side cutoff is unconfirmed, hence a conservative default).
 *
 * @precondition `data` decodes as an image `sharp` supports (JPEG, PNG,
 *   WebP, GIF, ...); `maxBytes` is large enough to represent the image at
 *   the lowest attempted quality/size (in practice, at least a few KB).
 * @postcondition Resolves to JPEG bytes no larger than `maxBytes`; throws if
 *   no combination of quality and downscaling attempted achieves that.
 */
export async function compressImageToFit(
  data: Uint8Array,
  maxBytes: number,
): Promise<{ data: Uint8Array; mimeType: string }> {
  const qualities = [80, 65, 50, 35, 20];
  const scales = [1, 0.75, 0.5, 0.35, 0.25, 0.15];

  for (const scale of scales) {
    for (const quality of qualities) {
      let pipeline = sharp(data);
      if (scale < 1) {
        const metadata = await sharp(data).metadata();
        const width = metadata.width ? Math.max(1, Math.round(metadata.width * scale)) : undefined;
        pipeline = sharp(data).resize({ width });
      }
      const encoded = await pipeline.jpeg({ quality }).toBuffer();
      if (encoded.byteLength <= maxBytes) {
        return { data: new Uint8Array(encoded), mimeType: "image/jpeg" };
      }
    }
  }
  throw new Error(
    `Could not compress image under ${maxBytes} bytes even at the lowest attempted quality/scale.`,
  );
}
