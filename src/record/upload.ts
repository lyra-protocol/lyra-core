/**
 * Uploading an arbitrary JSON document to Arweave through Irys.
 *
 * `lyra-record` handles trade records, which have a fixed schema and sequence
 * semantics. Reasoning records are a different shape with no sequence, so they
 * go through the same transport but not through that library's write path.
 *
 * Uploads at or below 100 KiB are free, so a reasoning record — a prompt and an
 * answer — costs nothing. Size is checked before the network is touched, so an
 * unusually large prompt fails loudly rather than quietly incurring a charge.
 */

import { MAX_PAYLOAD_BYTES, type OwnerKey } from "@lyra-protocol/record";

export async function uploadJson(
  payload: unknown,
  key: OwnerKey,
  tags: { name: string; value: string }[],
): Promise<string> {
  const body = JSON.stringify(payload);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `reasoning record is ${bytes} bytes, over the ${MAX_PAYLOAD_BYTES} byte free-tier budget. ` +
        `Uploading it would charge the signing key.`,
    );
  }

  const [{ Uploader }, { Solana }] = await Promise.all([
    import("@irys/upload"),
    import("@irys/upload-solana"),
  ]);
  const irys = await Uploader(Solana).withWallet(key.irysWallet).bundlerUrl("https://uploader.irys.xyz");
  const receipt = await (irys as unknown as {
    upload(data: string, opts: { tags: { name: string; value: string }[] }): Promise<{ id: string }>;
  }).upload(body, { tags });
  return receipt.id;
}
