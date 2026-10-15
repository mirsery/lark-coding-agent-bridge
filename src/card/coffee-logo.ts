import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';
import { bridgeRoot } from '../policy/owner-guard';

type ImageClient = Pick<LarkChannel, 'rawClient'>;

/** A slow upload must not hold the card back; the ☕ fallback is fine. */
const UPLOAD_TIMEOUT_MS = 5_000;

/** `image_key`s are per app, so uploads are cached per channel, per brand.
 * Failures are not cached — the next cup tries again. */
const uploads = new WeakMap<object, Map<string, Promise<string | undefined>>>();

export function coffeeLogoPath(slug: string, root: string = bridgeRoot()): string {
  return join(root, 'assets', 'coffee', `${slug}.png`);
}

/** Uploads the brand logo once per channel and returns its `image_key`, or
 * undefined when the file or the upload is unavailable. */
export function coffeeLogoKey(channel: ImageClient, slug: string): Promise<string | undefined> {
  let byBrand = uploads.get(channel);
  if (!byBrand) {
    byBrand = new Map();
    uploads.set(channel, byBrand);
  }
  const cached = byBrand.get(slug);
  if (cached) return cached;
  const pending = uploadLogo(channel, slug).then((key) => {
    if (!key) byBrand.delete(slug);
    return key;
  });
  byBrand.set(slug, pending);
  return pending;
}

async function uploadLogo(channel: ImageClient, slug: string): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const image = await readFile(coffeeLogoPath(slug));
    const upload = channel.rawClient.im.v1.image.create({ data: { image_type: 'message', image } });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('upload timed out')), UPLOAD_TIMEOUT_MS);
    });
    const res = (await Promise.race([upload, timeout])) as
      | { image_key?: string; data?: { image_key?: string } }
      | null;
    const key = res?.image_key ?? res?.data?.image_key;
    if (!key) throw new Error('image_key missing in upload response');
    return key;
  } catch (err) {
    log.warn('coffee', 'logo-upload-failed', { slug, error: err instanceof Error ? err.message : String(err) });
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
