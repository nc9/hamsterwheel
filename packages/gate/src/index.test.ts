import { expect, it } from "bun:test";

import { GATE_TODO } from "./index";

it("gate package is wired into the workspace", () => {
  expect(GATE_TODO).toBe(true);
});
