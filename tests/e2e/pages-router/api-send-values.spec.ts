import { expect, test } from "@playwright/test";

// Next.js `sendData` ends a nullish `res.send()` without a body and sends
// numbers and booleans as JSON, like objects.
test.describe("Pages API res.send() scalar values", () => {
  for (const value of ["null", "undefined"]) {
    test(`res.send(${value}) ends without a body`, async ({ request }) => {
      const res = await request.get(`/api/send-value?value=${value}`);
      expect(res.status()).toBe(200);
      expect(await res.text()).toBe("");
      expect(res.headers()["content-type"]).toBeUndefined();

      const typed = await request.get(`/api/send-value?value=${value}&type=text/custom`);
      expect(await typed.text()).toBe("");
      expect(typed.headers()["content-type"]).toBe("text/custom");
    });
  }

  for (const [value, body] of [
    ["zero", "0"],
    ["number", "42"],
    ["false", "false"],
    ["true", "true"],
  ]) {
    test(`res.send(${body}) sends JSON`, async ({ request }) => {
      const res = await request.get(`/api/send-value?value=${value}`);
      expect(res.status()).toBe(200);
      expect(await res.text()).toBe(body);
      expect(res.headers()["content-type"]).toBe("application/json; charset=utf-8");
    });
  }

  // Next.js's sendData() drops the body headers for a value sent on a 204/304,
  // and res.json() goes through it too.
  for (const method of ["send", "json"]) {
    test(`res.${method}(42) on a 204 drops the body headers`, async ({ request }) => {
      const res = await request.get(
        `/api/send-value?value=number&status=204&type=text/custom&method=${method}`,
      );
      expect(res.status()).toBe(204);
      expect(await res.text()).toBe("");
      expect(res.headers()["content-type"]).toBeUndefined();
      expect(res.headers()["content-length"]).toBeUndefined();
    });
  }
});
