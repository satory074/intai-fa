// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// GitHub Pages のプロジェクトページ（https://satory074.github.io/intai-fa/）。
// 独自ドメインにする場合は base を空文字に変更すること。
export default defineConfig({
  site: "https://satory074.github.io",
  base: "/intai-fa",
  trailingSlash: "always",
  build: { format: "directory" },
  integrations: [
    sitemap({
      // noindex のページ（なし）以外は全部載せる。lastmod はページ側の更新日を使う
      filter: (page) => !page.includes("/404"),
    }),
  ],
});
