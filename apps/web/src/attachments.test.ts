import { expect, test } from "bun:test";
import { admit } from "./attachments";

const file = (name: string, type: string, size = 10) => ({ name, type, size });

test("admits supported images up to the per-message limit", () => {
  const result = admit(3, [
    file("a.png", "image/png"),
    file("b.svg", "image/svg+xml"),
    file("c.jpg", "image/jpeg"),
    file("d.webp", "image/webp"),
  ]);

  expect(result.admitted.map(({ name }) => name)).toEqual(["a.png", "c.jpg"]);

  expect(result.problems).toEqual([
    "b.svg isn't a PNG, JPEG, GIF or WebP image.",
    "d.webp wasn't added: a message takes at most 5 images.",
  ]);
});

test("rejects images over 5 MB", () => {
  const result = admit(0, [file("big.png", "image/png", 5 * 1024 * 1024 + 1)]);

  expect(result.admitted).toEqual([]);
  expect(result.problems).toEqual(["big.png is larger than 5 MB."]);
});
