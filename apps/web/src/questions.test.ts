import { expect, test } from "bun:test";
import type { Question } from "@pi-cloud/protocol";
import {
  answered,
  answersOf,
  initialState,
  move,
  otherValue,
  pick,
  setNumber,
  summary,
  typeNumber,
  typeOther,
} from "./questions";

const options = ["a", "b", "c"].map((value) => ({
  value,
  label: value.toUpperCase(),
  description: null,
  recommended: value === "c",
}));

const base = { label: "Q", prompt: "Pick", context: null };
const single: Question = { ...base, id: "s", type: "single", options };
const multi: Question = { ...base, id: "m", type: "multi", options };
const rank: Question = { ...base, id: "r", type: "rank", options };
const scale: Question = { ...base, id: "sc", type: "scale", options };

const number: Extract<Question, { type: "number" }> = {
  ...base,
  id: "n",
  type: "number",
  min: 0,
  max: 10,
  step: 1,
  unit: "GB",
  recommended: null,
};

test("a single choice replaces the pick, a multi choice toggles it", () => {
  const once = pick(single, initialState(single), "a");

  expect(pick(single, once, "b").picked).toEqual(["b"]);

  const both = pick(multi, pick(multi, initialState(multi), "a"), "b");

  expect(both.picked).toEqual(["a", "b"]);
  expect(pick(multi, both, "a").picked).toEqual(["b"]);
});

test("typing another answer picks it and only counts when not blank", () => {
  const typed = typeOther(single, pick(single, initialState(single), "a"), " ");

  expect(typed.picked).toEqual([otherValue]);
  expect(answered(single, typed)).toBe(false);
  expect(answered(single, typeOther(single, typed, "mine"))).toBe(true);
});

test("ranks start in option order and move within bounds", () => {
  const start = initialState(rank);

  expect(answered(rank, start)).toBe(false);
  expect(move(start, 2, 0).picked).toEqual(["c", "a", "b"]);
  expect(move(start, 0, -1)).toBe(start);
});

test("a scale starts on the recommended option", () => {
  expect(initialState(scale).picked).toEqual(["c"]);
});

test("numbers start in the middle and clamp to the range", () => {
  expect(initialState(number).value).toBe(5);
  expect(setNumber(number, initialState(number), 42).value).toBe(10);

  expect(setNumber(number, initialState(number), Number.NaN).touched).toBe(
    false,
  );
});

test("the number box keeps what was typed and clamps only the value", () => {
  const ranged = { ...number, min: 10, max: 100 };

  expect(initialState(ranged).text).toBe("55");

  const five = typeNumber(ranged, initialState(ranged), "5");

  expect(five.text).toBe("5");
  expect(five.value).toBe(10);

  const fifty = typeNumber(ranged, five, "50");

  expect(fifty.text).toBe("50");
  expect(fifty.value).toBe(50);

  const cleared = typeNumber(ranged, fifty, "");

  expect(cleared.text).toBe("");
  expect(cleared.value).toBe(50);
  expect(setNumber(ranged, cleared, 70).text).toBe("70");
});

test("answers carry custom picks, notes and the trimmed note", () => {
  const state = {
    ...typeOther(multi, pick(multi, initialState(multi), "b"), " mine "),
    annotations: { b: " because " },
  };

  const result = answersOf([multi], { m: state }, "  ");

  expect(result).toEqual({
    answers: [
      {
        id: "m",
        type: "choice",
        selections: [
          { value: "b", label: "B", custom: false, annotation: "because" },
          { value: "mine", label: "mine", custom: true, annotation: null },
        ],
      },
    ],
    note: null,
  });

  expect(summary(multi, result.answers[0] ?? never())).toBe(
    "B (“because”), mine",
  );
});

test("a summary numbers ranks and adds the unit", () => {
  const ranked = answersOf([rank, number], {}, "").answers;

  expect(summary(rank, ranked[0] ?? never())).toBe("1. A  2. B  3. C");
  expect(summary(number, ranked[1] ?? never())).toBe("5 GB");
});

function never(): never {
  throw new Error("missing answer");
}
