import type { APIRoute } from "astro";
import { feedItems, feedResponse } from "../lib/feed";

export const GET: APIRoute = ({ site }) =>
  feedResponse(site!, "プロ野球去就アーカイブ 新着", "引退・戦力外・FA・移籍・監督コーチ人事の新着", feedItems());
