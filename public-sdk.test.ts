import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

test("the plugin uses only public SDK surfaces and package-local imports", () => {
  const scan = experimental_scanPublicSdkOnly(fileURLToPath(new URL(".", import.meta.url)));
  assert.deepEqual(scan.violations, []);
  assert.deepEqual(scan.privateDependencies, []);
});
