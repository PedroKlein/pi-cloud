import {
  type ImageAttachment,
  imageLimits,
  imageTypes,
} from "@pipoca/protocol";

interface Candidate {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

// Picks the files a message can carry, given how many it already has, and
// says why the others were left out.
export function admit<T extends Candidate>(
  attached: number,
  files: readonly T[],
): { readonly admitted: readonly T[]; readonly problems: readonly string[] } {
  const admitted: T[] = [];
  const problems: string[] = [];

  for (const file of files) {
    if (!imageTypes.some((type) => type === file.type)) {
      problems.push(`${file.name} isn't a PNG, JPEG, GIF or WebP image.`);
    } else if (file.size > imageLimits.bytes) {
      problems.push(
        `${file.name} is larger than ${String(imageLimits.bytes / 1024 / 1024)} MB.`,
      );
    } else if (attached + admitted.length >= imageLimits.count) {
      problems.push(
        `${file.name} wasn't added: a message takes at most ${String(imageLimits.count)} images.`,
      );
    } else {
      admitted.push(file);
    }
  }

  return { admitted, problems };
}

export function dataUrl({ mimeType, data }: ImageAttachment): string {
  return `data:${mimeType};base64,${data}`;
}
