// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { lastmodByPath } from "./src/lib/lastmod.ts";

const BASE = "/intai-fa";
let lastmod;

// GitHub Pages のプロジェクトページ（https://satory074.github.io/intai-fa/）。
// 独自ドメインにする場合は base を空文字に変更すること。
export default defineConfig({
  site: "https://satory074.github.io",
  base: BASE,
  trailingSlash: "always",
  build: { format: "directory" },
  integrations: [
    sitemap({
      // noindex のページ（404 と、旧 URL /{年度}/teams/{球団}/ の転送）は載せない
      filter: (page) => !page.includes("/404") && !/\/\d{4}\/teams\//.test(page),
      // lastmod はそのページに載っている行の最新の日付（src/lib/lastmod.ts）。取れないページには付けない
      serialize(item) {
        lastmod ??= lastmodByPath();
        const d = lastmod.get(new URL(item.url).pathname.replace(BASE, ""));
        return d ? { ...item, lastmod: d } : item;
      },
    }),
  ],
});
