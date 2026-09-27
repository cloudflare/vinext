import { createNavigation } from "next-intl/navigation";

export const { Link } = createNavigation({
  locales: ["en", "de"],
  defaultLocale: "en",
});
