export default {
  // A plain array is applied as afterFiles rewrites. Clients without the
  // passcode cookie are served the login page instead of a member page.
  async rewrites() {
    return [
      {
        source: "/members/:id",
        missing: [{ type: "cookie", key: "passcode", value: "letmein" }],
        destination: "/login",
      },
    ];
  },
};
