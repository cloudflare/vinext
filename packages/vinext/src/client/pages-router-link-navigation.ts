type PagesRouterLinkTransitionOptions = {
  scroll?: boolean;
  shallow?: boolean;
  locale?: string | false;
};

type PagesRouterLinkRuntime = {
  push(url: string, as?: string, options?: PagesRouterLinkTransitionOptions): Promise<boolean>;
  replace(url: string, as?: string, options?: PagesRouterLinkTransitionOptions): Promise<boolean>;
};

export async function navigatePagesRouterLink(
  router: PagesRouterLinkRuntime,
  {
    href,
    replace,
    scroll,
    shallow,
    locale,
  }: {
    href: string;
    replace: boolean;
    scroll: boolean;
    shallow?: boolean;
    locale?: string | false;
  },
): Promise<void> {
  const routerOptions: PagesRouterLinkTransitionOptions = { scroll, locale };
  if (shallow !== undefined) routerOptions.shallow = shallow;
  if (replace) {
    await router.replace(href, undefined, routerOptions);
  } else {
    await router.push(href, undefined, routerOptions);
  }
}
