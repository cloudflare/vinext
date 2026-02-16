import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { sqlite } from "./db";

export const auth = betterAuth({
  database: sqlite,
  secret: "vinext-test-secret-at-least-32-characters-long!!",
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:4403",
  emailAndPassword: {
    enabled: true,
  },
  plugins: [nextCookies()],
});
