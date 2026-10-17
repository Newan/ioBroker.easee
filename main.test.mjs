/**
 * This is a dummy JavaScript test file using Chai and Mocha.
 *
 * It is automatically excluded from npm, and its build output is excluded
 * from both Git and npm.
 *
 * Test modules with accompanying *.test.js or *.test.mjs files.
 */

import { describe, it } from "mocha";
import { expect } from "chai";
// import { functionToTest } from "./moduleToTest.js";

describe("module to test => function to test", () => {
  const expected = 5;

  it(`should return ${expected}`, () => {
    const result = 5;
    // const result = functionToTest();

    expect(result).to.equal(expected);
  });
});
