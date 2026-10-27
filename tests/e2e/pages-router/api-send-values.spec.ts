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
      expect(res.headers()["content-type"]).toBe("application/json");
    });
  }
});
