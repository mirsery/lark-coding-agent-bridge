import { describe, expect, it, vi } from 'vitest';
import { coffeeLogoKey } from '../../../src/card/coffee-logo';

function fakeChannel(create: (params: unknown) => Promise<unknown>) {
  return { rawClient: { im: { v1: { image: { create: vi.fn(create) } } } } } as never as Parameters<
    typeof coffeeLogoKey
  >[0] & { rawClient: { im: { v1: { image: { create: ReturnType<typeof vi.fn> } } } } };
}

describe('coffeeLogoKey', () => {
  it('uploads each brand logo once per channel', async () => {
    const channel = fakeChannel(async () => ({ image_key: 'img_starbucks' }));
    expect(await coffeeLogoKey(channel, 'starbucks')).toBe('img_starbucks');
    expect(await coffeeLogoKey(channel, 'starbucks')).toBe('img_starbucks');
    expect(channel.rawClient.im.v1.image.create).toHaveBeenCalledTimes(1);
    const [params] = channel.rawClient.im.v1.image.create.mock.calls[0]!;
    expect((params as { data: { image_type: string; image: Buffer } }).data.image_type).toBe('message');
    expect(Buffer.isBuffer((params as { data: { image: Buffer } }).data.image)).toBe(true);
  });

  it('falls back and retries later when the upload fails', async () => {
    let fail = true;
    const channel = fakeChannel(async () => {
      if (fail) throw new Error('boom');
      return { data: { image_key: 'img_costa' } };
    });
    expect(await coffeeLogoKey(channel, 'costa')).toBeUndefined();
    fail = false;
    expect(await coffeeLogoKey(channel, 'costa')).toBe('img_costa');
  });

  it('skips brands without a logo file', async () => {
    const channel = fakeChannel(async () => ({ image_key: 'img_x' }));
    expect(await coffeeLogoKey(channel, 'no-such-brand')).toBeUndefined();
    expect(channel.rawClient.im.v1.image.create).not.toHaveBeenCalled();
  });
});
