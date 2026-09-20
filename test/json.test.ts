import test from "node:test";
import assert from "node:assert/strict";
import { asRecords, isRecord, jsonRecord, parse, recCount, recNum, recObj, recObjs, recStr } from "../src/json.js";

test("isRecord accepts objects and rejects arrays, null and primitives", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord("x"), false);
  assert.equal(isRecord(7), false);
});

test("jsonRecord narrows any parsed payload to an object to read from", () => {
  assert.deepEqual(jsonRecord({ a: 1 }), { a: 1 });
  assert.deepEqual(jsonRecord(null), {});
  assert.deepEqual(jsonRecord([1, 2]), {});
  assert.deepEqual(jsonRecord("text"), {});
  assert.deepEqual(jsonRecord(undefined), {});
});

test("asRecords keeps the object members of an array", () => {
  assert.deepEqual(asRecords([{ a: 1 }, "skip", null, { b: 2 }]), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(asRecords(undefined), []);
  assert.deepEqual(asRecords("not an array"), []);
});

test("string accessors read only their own type", () => {
  const payload = { name: "bash", count: 3, flag: true, missing: null };
  assert.equal(recStr(payload, "name"), "bash");
  assert.equal(recStr(payload, "count"), undefined);
  assert.equal(recStr(payload, "missing"), undefined);
  assert.equal(recStr(undefined, "name"), undefined);
  assert.equal(recNum(payload, "count"), 3);
  assert.equal(recNum(payload, "name"), undefined);
  // A counter is not a number: JSON payloads from several providers carry "123".
  assert.equal(recNum({ count: "123" }, "count"), undefined);
  assert.equal(recCount({ count: "123" }, "count"), 123);
});

test("recCount treats absent, null and non-numeric values as no count", () => {
  assert.equal(recCount({ a: null }, "a"), undefined);
  assert.equal(recCount({ a: "" }, "a"), undefined);
  assert.equal(recCount({ a: "abc" }, "a"), undefined);
  assert.equal(recCount({ a: NaN }, "a"), undefined);
  assert.equal(recCount({}, "a"), undefined);
  assert.equal(recCount({ a: 0 }, "a"), 0);
});

test("object accessors read nested payloads and drop the wrong shapes", () => {
  const payload = { usage: { input_tokens: 5 }, items: [{ id: "a" }, "skip"], list: [1, 2] };
  assert.deepEqual(recObj(payload, "usage"), { input_tokens: 5 });
  assert.equal(recObj(payload, "items"), undefined);
  assert.equal(recObj(payload, "missing"), undefined);
  assert.deepEqual(recObjs(payload, "items"), [{ id: "a" }]);
  assert.deepEqual(recObjs(payload, "list"), []);
  assert.deepEqual(recObjs(payload, "usage"), []);
});

test("parse is best-effort and never throws", () => {
  assert.deepEqual(parse('{"a":1}'), { a: 1 });
  assert.deepEqual(parse({ a: 1 }), { a: 1 });
  assert.deepEqual(parse("not json"), {});
  assert.deepEqual(parse(undefined), {});
});
