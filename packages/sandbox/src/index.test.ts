import { expect, it } from "bun:test";

import { SANDBOX_TODO } from "./index";

it("sandbox package is wired into the workspace", () => {
  expect(SANDBOX_TODO).toBe(true);
});
